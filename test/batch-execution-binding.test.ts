import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {captureExecutionBinding,verifyExecutionBinding,withBoundPreset,executionRuntimeIdentity} from '../src/batch-execution-binding.ts'
import {renderComposition,validateSpec} from '../src/presets.ts'
import {TaskRunner} from '../src/runner.ts'
import {EventStore} from '../src/tasks.ts'
import {validateDesign} from '../src/task-design.ts'

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'batch-binding-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const specs=new Map<string,any>()
 const save=async(id:string,patch:any={})=>{
  const dir=join(root,'presets',id);await mkdir(dir,{recursive:true})
  const spec=validateSpec({...specs.get(id),id,name:id,model:'provider/model',tools:[],skills:['sample'],...patch});specs.set(id,spec)
  const rendered=renderComposition(spec,[],[])
  await writeFile(join(dir,'task-console.json'),JSON.stringify(spec));await writeFile(join(dir,'agent.cordis.yml'),rendered.yml);await writeFile(join(dir,'capabilities.lock.json'),JSON.stringify(rendered.capabilities))
  await mkdir(join(dir,'skills/sample'),{recursive:true});await writeFile(join(dir,'skills/sample/SKILL.md'),'original skill')
 }
 for(const id of ['a','b'])await save(id)
 let model={provider:'default-provider',model:'default-model'},runtime='a'.repeat(64),mount:((id:string)=>Promise<void>)|undefined
 const sessions:any[]=[]
 const presets={resolve:async(id:string)=>({id,path:join(root,'presets',id,'agent.cordis.yml')}),mount:async(_:any,id:string)=>mount?.(id)}
 const ctx:any={on:()=>()=>{},effect:()=>{},get:(name:string)=>name==='agentPresets'?presets:name==='agentDefaultModel'?{currentSelection:()=>({...model})}:name==='permissionPresets'?{set:()=>{}}:undefined,
  agents:{create:async(opts:any)=>{await opts.setup({});const session:any={options:opts,disposed:false,prompts:[],agent:{session:{id:opts.sessionId},ctx:{tools:{register:()=>()=>{}}},followup:(message:any)=>session.prompts.push(message)}};sessions.push(session);return {agent:session.agent,dispose:async()=>{session.disposed=true}}}}}
 const task:any={id:'task',title:'Task',brief:'objective',participants:[{agentId:'a'},{agentId:'b'}],trigger:{kind:'once'},cwd:root,timeoutSec:60,onFail:'retry',maxTries:2,enabled:true,createdAt:'2026-09-24T00:00:00Z',design:validateDesign({executionBinding:'agent-runtime-v1',scope:'scope',branches:[{id:'work',when:'ready',action:'work',evidence:'output'}],coordination:'sequence',failurePolicy:{isolateItems:false,maxAttempts:2,stopConditions:['failure']},acceptance:['done']})}
 return {root,ctx,task,save,sessions,runtime:async()=>runtime,setRuntime:(value:string)=>runtime=value,setModel:(value:any)=>model=value,setMount:(value:any)=>mount=value}
}
test('host binding captures resolved identity and rejects model/default/permission/tool/skill/runtime drift',async t=>{
 for(const change of ['model','default','permission','tool','skill','runtime'])await t.test(change,async t=>{
  const s=await fixture(t);if(change==='default')await s.save('a',{model:''})
  const binding=await captureExecutionBinding(s.ctx,s.task,'batch',undefined,s.runtime)
  assert.equal(binding.agents.length,2);assert.equal(binding.agents[0].selection.provider,change==='default'?'default-provider':'provider')
  if(change==='model')await s.save('a',{model:'provider/new-model'})
  if(change==='default')s.setModel({provider:'default-provider',model:'changed'})
  if(change==='permission')await s.save('a',{permissionPreset:'danger-full-access'})
  if(change==='tool')await s.save('a',{tools:['web']})
  if(change==='skill')await writeFile(join(s.root,'presets/a/skills/sample/SKILL.md'),'changed bytes')
  if(change==='runtime')s.setRuntime('b'.repeat(64))
  await assert.rejects(verifyExecutionBinding(s.ctx,binding,s.task.id,'batch','a',s.runtime),/binding-(agent|runtime)-drift/)
 })
})
test('new batch captures new settings; original cannot be rebound, assigned outside roster, or tampered',async t=>{
 const s=await fixture(t),first=await captureExecutionBinding(s.ctx,s.task,'one',undefined,s.runtime)
 await s.save('a',{model:'provider/new'});const second=await captureExecutionBinding(s.ctx,s.task,'two',undefined,s.runtime)
 assert.notEqual(first.sha256,second.sha256);assert.equal(first.agents[0].selection.model,'model')
 await assert.rejects(verifyExecutionBinding(s.ctx,first,'task','two','a',s.runtime),/binding-invalid/)
 await assert.rejects(verifyExecutionBinding(s.ctx,first,'task','one','foreign',s.runtime),/assignee-unbound/)
 const altered=structuredClone(second);altered.agents[0].permission='danger-full-access'
 await assert.rejects(verifyExecutionBinding(s.ctx,altered,'task','two','a',s.runtime),/binding-invalid/)
})
test('mount interval mutation is rejected; credential-bearing preset bodies never enter binding',async t=>{
 const s=await fixture(t);await s.save('a',{persona:'private prompt SECRET_BEARER',mcpPolicy:{}})
 const binding=await captureExecutionBinding(s.ctx,s.task,'batch',{fromProvider:'provider',provider:'fallback',model:'fallback-model'},s.runtime)
 assert.ok(!JSON.stringify(binding).includes('SECRET_BEARER'));assert.deepEqual(binding.fallback,{fromProvider:'provider',provider:'fallback',model:'fallback-model'})
 await assert.rejects(withBoundPreset(s.ctx,binding,'task','batch','a',()=>s.save('a',{model:'provider/new'}),s.runtime),/agent-drift/)
})
test('runtime digest detects changed source bytes and invalid installed manifest coverage',async t=>{
 const s=await fixture(t),root=join(s.root,'runtime');await mkdir(join(root,'src'),{recursive:true});await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'src/tool.ts'),'old')
 const before=await executionRuntimeIdentity(root);await writeFile(join(root,'src/tool.ts'),'new');assert.notEqual(await executionRuntimeIdentity(root),before)
 await writeFile(join(root,'DEPLOY_MANIFEST.json'),JSON.stringify({'src/tool.ts':'0'.repeat(64)}));await assert.rejects(executionRuntimeIdentity(root),/manifest-changed/)
 for(const malformed of [null,[],{},'string',{'src/tool.ts':'not-a-digest'}]){
  await writeFile(join(root,'DEPLOY_MANIFEST.json'),JSON.stringify(malformed));await assert.rejects(executionRuntimeIdentity(root),/manifest-invalid/)
 }
 const rows={'package.json':createHash('sha256').update('{}').digest('hex'),'src/tool.ts':createHash('sha256').update('new').digest('hex')}
 await writeFile(join(root,'DEPLOY_MANIFEST.json'),JSON.stringify(rows));const installed=await executionRuntimeIdentity(root)
 assert.match(installed,/^[a-f0-9]{64}$/);await writeFile(join(root,'src/tool.ts'),'mutated');await assert.rejects(executionRuntimeIdentity(root),/manifest-changed/)
})
async function runnerFixture(t:any,options:any={}){
 const s=await fixture(t),store=new EventStore(join(s.root,'store')),runner=new TaskRunner(s.ctx,store,{maxInProgress:1,executionRuntimeIdentity:s.runtime,...options})
 t.after(()=>{runner.stop();if(store.kernel.db.open)store.kernel.db.close()})
 await runner.start()
 await store.append({t:'task/created',at:'2026-09-24T00:00:00Z',taskId:s.task.id,task:s.task})
 return {...s,store,runner}
}
test('new opted-in fire atomically persists binding; later stage drift blocks without creating a session',async t=>{
 const s=await runnerFixture(t);const batch=await s.runner.fire('task','manual',{batchId:'batch'})
 assert.ok(batch.turn?.executionBinding);assert.equal(s.sessions.length,1)
 const frozen=s.store.kernel.db.prepare('SELECT turn_json FROM dsh_batches WHERE id=?').get('batch').turn_json
  await s.save('b',{model:'provider/changed'})
  const first=s.store.kernel.getTask(batch.cardIds[0]);s.store.kernel.completeTask(batch.cardIds[0],{expectedRunId:first.current_run_id})
 const card=s.store.s.cards.get(batch.cardIds[1])!;s.store.kernel.db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(card.id)
 await (s.runner as any).startRun(s.task,batch,card)
 assert.equal(s.sessions.length,1);assert.equal(s.store.kernel.getTask(card.id).status,'blocked')
 assert.equal(s.store.kernel.db.prepare('SELECT turn_json FROM dsh_batches WHERE id=?').get('batch').turn_json,frozen)
 assert.equal(s.sessions[0].options.agentOptions.model,'model')
 assert.ok(s.store.kernel.listEvents(batch.cardIds[0]).some((e:any)=>e.kind==='execution_binding_verified'))
})
test('binding drift during beforeStart blocks before mount and cannot be supplied by the caller',async t=>{
 const s=await runnerFixture(t);(s.runner as any).beforeStart=async()=>{await s.save('a',{model:'provider/changed'})}
 const batch=await s.runner.fire('task','manual',{batchId:'batch'});assert.equal(s.sessions.length,0);assert.equal(s.store.kernel.getTask(batch.cardIds[0]).status,'blocked')
 await assert.rejects(s.runner.fire('task','manual',{batchId:'forged',turn:batch.turn}),/host-created-only/)
 const again=await s.runner.fire('task','manual',{batchId:'batch'});assert.equal(again.turn?.executionBinding?.sha256,batch.turn?.executionBinding?.sha256)
})
test('legacy fire remains live and does not capture a runtime identity',async t=>{
 const s=await runnerFixture(t,{executionRuntimeIdentity:async()=>{throw Error('legacy must not capture')}})
 const legacy={...s.task,design:undefined};await s.store.append({t:'task/created',at:'2026-09-24T00:00:00Z',taskId:s.task.id,task:legacy})
 const batch=await s.runner.fire('task','manual');assert.equal(batch.turn?.executionBinding,undefined);assert.equal(s.sessions.length,1)
})

test('bound startup fallback retains captured selection even when global fallback changes',async t=>{
 const s=await runnerFixture(t),resolved:any[]=[]
 const get=s.ctx.get;s.ctx.get=(key:string)=>key==='llm'?{resolveCallConfig:async(value:any)=>{resolved.push(value);return value}}:get(key)
 s.runner.modelFallback={fromProvider:'provider',provider:'frozen-fallback',model:'frozen-model'}
 await s.runner.fire('task','manual',{batchId:'batch'})
 s.runner.modelFallback={fromProvider:'provider',provider:'changed-global',model:'changed-model'}
 const flight=[...(s.runner as any).flights.values()][0] as any
 flight.handle.agent.ctx.on=()=>()=>{}
 await (s.runner as any).onTurnEnd(flight,{kind:'error',error:{code:'TRANSPORT'}})
 assert.deepEqual(resolved,[{provider:'frozen-fallback',model:'frozen-model'}])
 assert.ok(s.store.kernel.listEvents(flight.cardId).some((e:any)=>e.kind==='model_fallback'))
})

test('preset mutation during mounting creates no prompt and blocks the bound run',async t=>{
 const s=await runnerFixture(t);s.setMount(async()=>s.save('a',{model:'provider/changed-during-mount'}))
 const batch=await s.runner.fire('task','manual',{batchId:'batch'})
 assert.equal(s.sessions.length,1);assert.ok(s.sessions.every(v=>v.prompts.length===0&&v.disposed));assert.equal((s.runner as any).flights.size,0);assert.equal(s.store.kernel.getTask(batch.cardIds[0]).status,'blocked')
})

test('bound mount failure disposes the returned session and records only a safe reason',async t=>{
 const s=await runnerFixture(t);s.setMount(async()=>{throw Error('private transport SECRET')})
 const batch=await s.runner.fire('task','manual',{batchId:'batch'})
 assert.equal(s.sessions.length,1);assert.ok(s.sessions[0].disposed);assert.equal(s.sessions[0].prompts.length,0);assert.equal((s.runner as any).flights.size,0)
 assert.equal(s.store.kernel.getTask(batch.cardIds[0]).status,'blocked')
 const events=JSON.stringify(s.store.kernel.listEvents(batch.cardIds[0]));assert.match(events,/binding-mount-unavailable/);assert.ok(!events.includes('SECRET'))
})

test('binding drift after session creation disposes the session before dispatch',async t=>{
 const s=await runnerFixture(t);(s.runner as any).onSessionCreated=async()=>s.setRuntime('b'.repeat(64))
 const batch=await s.runner.fire('task','manual',{batchId:'batch'})
 assert.equal(s.sessions.length,1);assert.ok(s.sessions[0].disposed);assert.equal(s.sessions[0].prompts.length,0);assert.equal((s.runner as any).flights.size,0)
 assert.equal(s.store.kernel.getTask(batch.cardIds[0]).status,'blocked');assert.ok(s.store.kernel.listEvents(batch.cardIds[0]).some((e:any)=>e.kind==='execution_binding_rejected'))
})

test('retry after a terminal attempt rechecks the same binding without silently recapturing',async t=>{
 const s=await runnerFixture(t),batch=await s.runner.fire('task','manual',{batchId:'batch'})
 const first=s.store.kernel.getTask(batch.cardIds[0]);s.store.kernel.failRun(first.id,{expectedRunId:first.current_run_id,outcome:'failed',error:'fixture'})
 const previous=batch.turn!.executionBinding!.sha256
 await s.save('a',{model:'provider/new-before-retry'})
 s.store.kernel.db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(first.id)
 await (s.runner as any).startRun(s.task,batch,s.store.s.cards.get(first.id))
 assert.equal(s.sessions.length,1);assert.equal(s.store.kernel.getTask(first.id).status,'blocked');assert.equal(s.store.s.batches.get(batch.id)!.turn!.executionBinding!.sha256,previous)
})

test('binding persists on reload, and preparation specialists are captured with the full selected roster',async t=>{
 const s=await runnerFixture(t)
 await s.save('specialist');await s.save('notifier');await s.save('proxy')
 const task={...s.task,design:{...s.task.design,studioStages:[{id:'sound',agentId:'specialist'}],notifications:{agentId:'notifier'},proxy:{agentId:'proxy'}}}
 const full=await captureExecutionBinding(s.ctx,task,'all-roles',undefined,s.runtime)
 assert.deepEqual(full.agents.map(a=>a.id),['a','b','specialist','notifier','proxy'])
 const batch=await s.runner.fire('task','manual',{batchId:'batch'}),before=batch.turn!.executionBinding!.sha256
 s.runner.stop();s.store.kernel.db.close()
 const loaded=new EventStore(join(s.root,'store'));await loaded.load();t.after(()=>loaded.kernel.db.close())
 assert.equal(loaded.s.batches.get('batch')!.turn!.executionBinding!.sha256,before)
 await s.save('a',{model:'provider/changed-after-reload'})
 await assert.rejects(verifyExecutionBinding(s.ctx,loaded.s.batches.get('batch')!.turn!.executionBinding!,'task','batch','a',s.runtime),/agent-drift/)
})
