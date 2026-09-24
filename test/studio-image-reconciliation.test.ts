import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {EventStore} from '../src/tasks.js'
import {StudioOperations} from '../src/studio-operations.js'
import {StudioWorkflow} from '../src/studio-workflow.js'
import {reconcileStudioImageOperation} from '../src/studio-image-reconciliation.js'
async function setup(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'image-reconciliation-')),store=new EventStore(cwd);await store.load()
 t.after(async()=>{store.kernel.close();await rm(cwd,{recursive:true,force:true})})
 const at=new Date().toISOString(),time=Date.now(),task:any={id:'T',title:'test',brief:'test',cwd,trigger:{kind:'once'},participants:[{agentId:'a'}],enabled:true,timeoutSec:60,maxTries:1,onFail:'stop',createdAt:at,design:{evidenceContract:'studio-video-v1',studio:{characterId:'char',referenceSha256:'b'.repeat(64),referenceUrl:'https://cdn.vyibc.com/reference.mp4'}}}
 await store.append({t:'task/created',at,taskId:'T',task})
 await store.createBatch(task,{t:'batch/fired',at,taskId:'T',batch:{id:'B',by:'manual',cards:[{id:'C',agentId:'a',role:'executor',round:1,deps:[]}]}} as any)
 store.kernel.claimTask('C');await store.append({t:'run/claimed',at,taskId:'T',cardId:'C',runId:'R',sessionId:'session',attempt:1})
 const context={task,batch:{id:'B'},card:{role:'executor'},sessionId:'session'},ops=new StudioOperations(store)
 ops.configure(context,{imageCalls:6,voiceSegments:40})
 const request={prompt:'specific background',engine:'mixed',referenceImageUrl:'https://cdn.vyibc.com/reference.mp4',wait:false}
 await assert.rejects(ops.invoke(context,'vyibc-image_generate_image',request,async()=>{throw Error('response lost')}),/submission-unknown/)
 const input={taskId:'T',batchId:'B',expectedRunId:'R',intent:ops.snapshot(context).operations[0].intent,jobId:'dt_one',recoveryId:'reconcile-one',reason:'Match original input and terminal upstream failure',request}
 const session={events:[{type:'tool/call',time,data:{callId:'call',arguments:JSON.stringify(request)}},{type:'tool/result',time:time+60000,data:{message:{source:{callId:'call'},content:[{type:'text',text:'Error: studio-submission-unknown: retained'}]}}}]}
 const proof={ok:true,task:{id:'dt_one',status:'failed',created_at:new Date(time+120000).toISOString().slice(0,19).replace('T',' '),total:1,succeeded:0,failed:1,settings:{workflowIds:['chatgpt-image','gemini-image']}},items:[{idx:0,input:{prompt:request.prompt,sourceImageUrl:request.referenceImageUrl},status:'failed'}]}
 return {store,ops,context,input,session,proof}
}
test('verified operator reconciliation retains spend and task state, records assistance, and replays durably',async t=>{
 const {store,ops,context,input,session,proof}=await setup(t)
 const tasksBefore=JSON.stringify(store.kernel.db.prepare('SELECT * FROM tasks').all())
 let reads=0;const read=async()=>{reads++;return proof}
 const results=await Promise.all([reconcileStudioImageOperation(store,input,async()=>session,read),reconcileStudioImageOperation(store,input,async()=>session,read)])
 assert.equal(results.filter(r=>r.replay).length,1)
 assert.equal(ops.snapshot(context).used.imageCalls,1);assert.equal(ops.snapshot(context).operations[0].state,'failed');assert.equal(ops.snapshot(context).operations[0].job_id,'dt_one')
 assert.equal(JSON.stringify(store.kernel.db.prepare('SELECT * FROM tasks').all()),tasksBefore)
 assert.equal(new StudioWorkflow(store).status(context).interventions.length,1)
 assert.equal(store.all().filter(e=>e.t==='batch/studio_image_reconciled').length,1)
 const reloaded=new EventStore(store.root);await reloaded.load()
 assert.equal((await reconcileStudioImageOperation(reloaded,input,async()=>{throw Error('no reread')},read)).replay,true);reloaded.kernel.close()
 assert.equal(reads,2)
 await assert.rejects(reconcileStudioImageOperation(store,{...input,jobId:'dt_other'},async()=>session,read),/id-conflict/)
})
for(const mode of ['wrong-request','wrong-run','wrong-reference','wrong-time','running-job','wrong-id','no-session','duplicate-submission','transport-failure'])test(`reconciliation refuses ${mode} without changing paid ledger`,async t=>{
 const {store,ops,context,input,session,proof}=await setup(t);const p=structuredClone(proof),r=structuredClone(input),s=structuredClone(session)
 if(mode==='wrong-request')r.request.prompt='another'
 if(mode==='wrong-run')r.expectedRunId='old'
 if(mode==='wrong-reference')p.items[0].input.sourceImageUrl='https://cdn.vyibc.com/another.png'
 if(mode==='wrong-time')p.task.created_at='2020-01-01 00:00:00'
 if(mode==='running-job')p.task.status='running'
 if(mode==='wrong-id')p.task.id='dt_other'
 if(mode==='no-session')s.events=[]
 if(mode==='duplicate-submission')s.events.push(s.events[0])
 const before=JSON.stringify(ops.snapshot(context)),count=store.all().length
 await assert.rejects(reconcileStudioImageOperation(store,r,async()=>s,async()=>{if(mode==='transport-failure')throw Error('network');return p}))
 assert.equal(JSON.stringify(ops.snapshot(context)),before);assert.equal(store.all().length,count)
})
