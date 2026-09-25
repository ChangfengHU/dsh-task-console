import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore} from '../src/tasks.js'
import {StudioOperations} from '../src/studio-operations.js'
import {StudioInterventions} from '../src/studio-interventions.js'
import {reconcileStudioKnownOperation} from '../src/studio-known-operation-reconciliation.js'
async function fixture(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'known-reconcile-')),store=new EventStore(cwd);await store.load()
 t.after(async()=>{store.kernel.close();await rm(cwd,{recursive:true,force:true})})
 const at=new Date().toISOString(),task:any={id:'T',title:'test',brief:'test',cwd,trigger:{kind:'once'},participants:[{agentId:'a'}],enabled:true,timeoutSec:60,maxTries:3,onFail:'retry',createdAt:at,design:{evidenceContract:'studio-video-v1'}}
 await store.append({t:'task/created',at,taskId:'T',task})
 await store.createBatch(task,{t:'batch/fired',at,taskId:'T',batch:{id:'B',by:'manual',cards:[{id:'C',agentId:'a',role:'executor',round:1,deps:[]}]}} as any)
 store.kernel.claimTask('C');await store.append({t:'run/claimed',at,taskId:'T',cardId:'C',runId:'R',sessionId:'S',attempt:1})
 const context={task,batch:{id:'B'},card:{role:'executor'}},ops=new StudioOperations(store);ops.configure(context,{imageCalls:6,imageBatches:2,voiceSegments:40})
 await ops.invoke(context,'vyibc-image_generate_image',{prompts:['existing image']},async()=>({structuredContent:{taskId:'dt_saved',status:'queued'}}))
 await store.transition(()=>store.kernel.blockTask('C',{expectedRunId:store.kernel.getTask('C')!.current_run_id!,kind:'capability',reason:'original operation pending'}),()=>({t:'run/blocked',at,taskId:'T',runId:'R',kind:'capability',reason:'original operation pending',terminal:true} as any))
 const input={taskId:'T',batchId:'B',cardId:'C',expectedRunId:'R',intent:ops.snapshot(context).operations[0].intent,requestId:'op-1',reason:'Repair historical known operation through host status query'}
 const poll=async()=>({name:'vyibc-image_get_task',args:{taskId:'dt_saved'},result:{structuredContent:{taskId:'dt_saved',status:'done',images:['PRIVATE_RESULT']}}})
 return {store,ops,context,input,poll}
}
test('host status reconciliation retains spend and block, records assistance, terminal replay avoids network',async t=>{
 const f=await fixture(t),before=f.ops.snapshot(f.context),tasks=JSON.stringify(f.store.kernel.db.prepare('SELECT * FROM tasks').all())
 const result=await reconcileStudioKnownOperation(f.store,f.input,f.poll)
 assert.equal(result.state,'completed');assert.equal(result.resumed,false);assert.equal(result.assisted,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_RESULT/)
 assert.deepEqual(f.ops.snapshot(f.context).used,before.used);assert.deepEqual(f.ops.snapshot(f.context).limits,before.limits)
 assert.equal(JSON.stringify(f.store.kernel.db.prepare('SELECT * FROM tasks').all()),tasks)
 assert.equal(new StudioInterventions(f.store).list({taskId:'T',batchId:'B'}).length,1)
 assert.equal((await reconcileStudioKnownOperation(f.store,f.input,async()=>{throw Error('must not poll')})).alreadyTerminal,true)
})
for(const mode of ['unknown-id','wrong-run','injected-result','active-run','wrong-job','transport','late-transition'])test('operator reconciliation safely handles '+mode,async t=>{
 const f=await fixture(t);let calls=0,input:any={...f.input},poll=async()=>{calls++;return f.poll()}
 if(mode==='unknown-id')f.store.kernel.db.prepare('UPDATE dsh_studio_operations SET job_id=NULL,state=?').run('unknown')
 if(mode==='wrong-run')input.expectedRunId='other'
 if(mode==='injected-result')input.result={status:'done'}
 if(mode==='active-run')(f.store.s.runs.get('R') as any).status='running'
 if(mode==='wrong-job')poll=async()=>{calls++;return {name:'vyibc-image_get_task',args:{taskId:'dt_other'},result:{structuredContent:{taskId:'dt_other',status:'done'}}} as any}
 if(mode==='transport')poll=async()=>{calls++;throw Error('PRIVATE_TOKEN')}
 if(mode==='late-transition')poll=async()=>{calls++;f.store.kernel.unblockTask('C');return f.poll()}
 const before=JSON.stringify(f.ops.snapshot(f.context))
 if(mode==='wrong-job')assert.equal((await reconcileStudioKnownOperation(f.store,input,poll)).terminal,false)
 else await assert.rejects(reconcileStudioKnownOperation(f.store,input,poll),error=>!/PRIVATE_TOKEN/.test(String(error)))
 assert.equal(JSON.stringify(f.ops.snapshot(f.context)),before)
 if(['unknown-id','wrong-run','injected-result','active-run'].includes(mode))assert.equal(calls,0)
 else assert.equal(calls,1)
})
