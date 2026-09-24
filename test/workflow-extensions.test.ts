import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkflowExtensions,type WorkflowExtension,validateWorkflowSelection} from '../src/workflow-extensions.js'
import {validateDesign} from '../src/task-design.js'
import {workflowDefinition} from '../src/workflow-plan.js'
import {taskForTurn} from '../src/tasks.js'
const hash=(c:string)=>c.repeat(64)
const selection={id:'release-audit',version:'1.0.0',policy:{archive:'candidate.tgz'}}
const definition=(extra:Partial<WorkflowExtension>={}):WorkflowExtension=>({
 ...selection,hostApi:1,implementationSha256:hash('a'),
 validatePolicy(value:any){if(value.archive!=='candidate.tgz')throw Error('archive-required');return {archive:value.archive}},
 beforeComplete:async()=>({summary:'Verified by host adapter',metadata:{scope:'fixture-only'}}),...extra,
})
const input=(extension:any):any=>({task:{id:'T',design:{extension}},batch:{id:'B'},card:{role:'executor'},sessionId:'S',profileId:'executor'})
test('missing extension and unbound requests fail rather than dropping the completion gate',async()=>{
 const registry=new WorkflowExtensions()
 assert.throws(()=>registry.bind(selection),/version-unavailable/)
 registry.register(definition())
 await assert.rejects(registry.beforeComplete(input(selection)),/host-binding-required/)
 const binding=registry.bind(selection)
 assert.equal(binding.implementationSha256,hash('a'))
 assert.match(binding.policySha256,/^[a-f0-9]{64}$/)
 assert.equal((await registry.beforeComplete(input(binding))).metadata.scope,'fixture-only')
 await assert.rejects(registry.beforeComplete(input({...binding,version:'9.0.0'})),/version-unavailable/)
})
test('exact versions coexist; changed policy or replacement bytes cannot reuse a frozen binding',async()=>{
 const registry=new WorkflowExtensions(),dispose=registry.register(definition())
 const first=registry.bind(selection)
 assert.throws(()=>registry.register(definition()),/already-registered/)
 registry.register(definition({version:'2.0.0',implementationSha256:hash('b')}))
 assert.equal(registry.bind(first).implementationSha256,hash('a'))
 assert.throws(()=>registry.bind({...first,policy:{archive:'candidate.tgz',silentOverride:true}}),/binding-mismatch/)
 dispose();registry.register(definition({implementationSha256:hash('c')}))
 await assert.rejects(registry.beforeComplete(input(first)),/binding-mismatch/)
})
test('a frozen batch keeps the old extension despite subsequent template changes and missing rollback code blocks',async()=>{
 const registry=new WorkflowExtensions();registry.register(definition())
 const task:any={id:'T',title:'audit',brief:'audit bytes',participants:[{agentId:'p'}],graphMode:'dynamic-rounds',timeoutSec:60,onFail:'stop',maxTries:1,trigger:{kind:'once'},design:{extension:registry.bind(selection)}}
 const frozen=workflowDefinition(task)
 task.design.extension.version='2.0.0'
 const restored=taskForTurn(task,{objective:'same input',participants:task.participants,workflow:{id:'frozen',definition:frozen}} as any)
 assert.equal(restored.design?.extension?.version,'1.0.0')
 assert.equal((await registry.beforeComplete({...input(null),task:restored})).metadata.scope,'fixture-only')
 const missing=new WorkflowExtensions()
 await assert.rejects(missing.beforeComplete({...input(null),task:restored}),/version-unavailable/)
})
test('disposal respects both unsettled batch ownership and in-flight hooks',async()=>{
 let used=true,finish:()=>void=()=>{}
 const registry=new WorkflowExtensions(()=>used)
 const dispose=registry.register(definition({beforeComplete:async()=>{await new Promise<void>(r=>finish=r);return {summary:'finished',metadata:{}}}}))
 const binding=registry.bind(selection)
 assert.throws(dispose,/in-use/);used=false
 const running=registry.beforeComplete(input(binding));assert.throws(dispose,/in-use/)
 finish();await running;dispose();dispose()
 await assert.rejects(registry.beforeStart(input(binding)),/version-unavailable/)
})
test('empty completion cannot become generic success and thrown evidence failures stay failures',async()=>{
 for(const beforeComplete of [async()=>undefined,async()=>({summary:'',metadata:{}}),async()=>({summary:'ok',metadata:null})] as any[]){
  const registry=new WorkflowExtensions();registry.register(definition({beforeComplete}))
  await assert.rejects(registry.beforeComplete(input(registry.bind(selection))),/completion-evidence-required|policy-object-required/)
 }
 const registry=new WorkflowExtensions();registry.register(definition({beforeComplete:async()=>{throw Error('actual-hash-mismatch')}}))
 await assert.rejects(registry.beforeComplete(input(registry.bind(selection))),/actual-hash-mismatch/)
})
test('syntax stays JSON only; unsupported API and partial bindings are rejected',()=>{
 for(const value of [{...selection,implementationSha256:hash('a')},{...selection,extra:true},{...selection,policy:{bad:NaN}},{...selection,policy:{bad:()=>{}}},{...selection,policy:JSON.parse('{"__proto__":{}}')}])assert.throws(()=>validateWorkflowSelection(value),/workflow-/)
 assert.throws(()=>new WorkflowExtensions().register(definition({hostApi:3 as any})),/definition-invalid/)
})
test('new extension syntax cannot mix legacy business fields and does not alter ordinary designs',()=>{
 const design={scope:'audit',branches:[{id:'bytes',when:'input exists',action:'verify',evidence:'hashes'}],coordination:'independent review',failurePolicy:{isolateItems:false,maxAttempts:2,stopConditions:['invalid input']},acceptance:['actual checks']}
 assert.deepEqual(validateDesign(design),design)
 assert.deepEqual(validateDesign({...design,extension:selection}).extension,selection)
 assert.throws(()=>validateDesign({...design,extension:selection,evidenceContract:'studio-video-v1'}),/cannot-mix/)
})
