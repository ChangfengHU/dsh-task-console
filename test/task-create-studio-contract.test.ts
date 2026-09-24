import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore,validateTask} from '../src/tasks.ts'
import {TaskCreator} from '../src/task-create.ts'
import {validateDesign} from '../src/task-design.ts'
const roleIds=['director','editor','reviewer','storyboard','visual','sound']
const exec=(id:string)=>({agent:{session:{id,deriveMessages:()=>[{role:'user',content:'Create a character video preview; do not publish.'}]}}})
async function setup(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'studio-creator-contract-')),store=new EventStore(join(cwd,'store'));await store.load()
 t.after(async()=>{if(store.kernel.db.open)store.kernel.db.close();await rm(cwd,{recursive:true,force:true})})
 const creator=new TaskCreator({store} as any,async()=>roleIds.map(id=>({id,name:id,tools:[],mcpTools:{},skills:[]})))
 const context=await creator.context(),contract=context.studioCreationContract
 const design=validateDesign({scope:'Fixture-only video',branches:[{id:'prepare',when:'current valid references',action:'prepare actual assets',evidence:'stage receipts'}],coordination:'director, storyboard, visual and sound, editor, independent reviewer',failurePolicy:{isolateItems:true,maxAttempts:3,stopConditions:['missing authorization']},acceptance:['actual preview and independent evidence'],evidenceContract:contract.design.evidenceContract,executionBinding:contract.design.executionBinding,studioStages:contract.design.studioStages.map(id=>({id,agentId:id,brief:'Prepare and register actual '+id+' evidence'})),studio:{...contract.studio.defaults,...contract.studio.recommendedContracts,characterId:'test-character',referenceUrl:'https://cdn.vyibc.com/test-reference.mp4',referenceSha256:'a'.repeat(64),generationLimits:{imageCalls:0,imageBatches:0,voiceSegments:0},publish:contract.studio.publish}})
 const proposal:any={decision:'create',reason:'explicit request',title:'Fixture video',brief:'Produce the scoped fixture video',graphMode:'dynamic-rounds',participants:roleIds.slice(0,3).map(agentId=>({agentId})),design}
 return {cwd,store,creator,context,proposal}
}
test('Studio discovery exposes host composition without private defaults or automatic execution',async t=>{
 const s=await setup(t),c=s.context.studioCreationContract
 assert.equal(c.kind,'host-composed-draft');assert.equal(c.executableRecipe,false);assert.equal(c.automaticallyStarts,false)
 assert.equal(c.design.executionBinding,'agent-runtime-v1');assert.equal(c.studio.publish,false)
 assert.deepEqual(c.studio.requiredInputs,['characterId','referenceUrl','referenceSha256','generationLimits'])
 for(const privateField of ['characterId','referenceUrl','referenceSha256'])assert.equal(privateField in c.studio.defaults,false)
 assert.match(c.studio.generationLimits,/imageCalls counts generated image\/prompt items/);assert.match(c.studio.generationLimits,/imageBatches counts submissions/)
 assert.match(c.roles.selection,/six different installed agent IDs/);assert.match(c.quality,/do not approve quality/)
 assert.equal(validateTask({...s.proposal,cwd:s.cwd},new Set(roleIds)).design?.studioStages?.length,3)
 const p:any=await s.creator.prepare(s.proposal,exec('valid'),s.cwd)
 assert.equal(p.state,'pending');assert.equal(p.definition.design.executionBinding,'agent-runtime-v1');assert.equal(p.definition.design.studioStages.length,3)
 assert.equal(s.store.tasks.size,0);assert.equal(s.store.s.batches.size,0)
})
test('Creator rejects unknown specialists and main-role collisions before any plan or task write',async t=>{
 const s=await setup(t)
 for(const [agentId,expected] of [['uninstalled',/没有这个 Agent/],['director',/specialists must be separate/i]] as const){
  const p=structuredClone(s.proposal);p.design.studioStages[1].agentId=agentId
  await assert.rejects(s.creator.prepare(p,exec('invalid-'+agentId),s.cwd),expected)
  assert.equal(s.creator.plans().total,0);assert.equal(s.store.tasks.size,0);assert.equal(s.store.s.batches.size,0);assert.equal(s.store.all().length,0)
 }
 const staticPlan={...s.proposal,graphMode:'static-chain'}
 await assert.rejects(s.creator.prepare(staticPlan,exec('static'),s.cwd),/studio-video-v1 需要/)
 assert.equal(s.creator.plans().total,0)
})
test('final validation of legitimate reuse preserves the existing task lifecycle and definition',async t=>{
 const s=await setup(t),task={...validateTask({...s.proposal,cwd:s.cwd},new Set(roleIds)),id:'existing',createdAt:'2026-01-01T00:00:00.000Z',origin:{source:'task-chat',signalId:'original-signal',intakeSessionId:'original-session',decision:'create' as const,reason:'already reviewed'}}
 await s.store.append({t:'task/created',taskId:task.id,at:task.createdAt,task})
 const before=structuredClone(s.store.tasks.get(task.id)),events=s.store.all().length
 const plan:any=await s.creator.prepare({decision:'reuse',taskId:task.id,reason:'new preview using same policy',design:s.proposal.design},exec('reuse'),s.cwd)
 assert.equal(plan.state,'pending');assert.deepEqual(s.store.tasks.get(task.id),before);assert.equal(s.store.all().length,events);assert.equal(s.store.s.batches.size,0)
 const row=s.store.kernel.db.prepare('SELECT payload FROM dsh_task_plans WHERE id=?').get(plan.id) as any
 const pending=JSON.parse(row.payload).task;assert.equal(pending.createdAt,task.createdAt);assert.deepEqual(pending.origin,task.origin);assert.equal(pending.enabled,true)
})
