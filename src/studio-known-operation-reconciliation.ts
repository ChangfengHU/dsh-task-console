import {StudioOperations} from './studio-operations.js'
import {StudioInterventions} from './studio-interventions.js'
import {taskForBatch} from './tasks.js'
import {studioOperationInStage} from './studio-stage-operations.js'

/** Explicit operator maintenance for historical blocks. Reads a persisted job;
 * never accepts a supplied provider result, resumes a card, or refunds spend. */
export async function reconcileStudioKnownOperation(store:any,value:any,poll:(operation:any)=>Promise<{name:string;args:any;result:any}>){
 const keys=['taskId','batchId','cardId','expectedRunId','intent','requestId','reason']
 if(!value||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>typeof value[k]!=='string'||!value[k].trim()||value[k].length>(k==='reason'?2000:200))||!/^[a-f0-9]{64}$/.test(value.intent))throw Error('studio-known-reconcile-invalid-input')
 const db=store.kernel.db,ops=new StudioOperations(store),audit=new StudioInterventions(store)
 const context=()=>{
  const base=store.tasks.get(value.taskId),batch=store.s.batches.get(value.batchId),card=store.s.cards.get(value.cardId),run=store.s.runs.get(value.expectedRunId)
  const core=store.kernel.getTask(value.cardId)
  if(!base||base.archivedAt||!batch||batch.taskId!==base.id||batch.archivedAt||batch.settled||!card||card.taskId!==base.id||card.batchId!==batch.id||card.runIds.at(-1)!==value.expectedRunId||card.status!=='blocked'||!run||run.cardId!==card.id||run.status!=='blocked'||core?.status!=='blocked'||core.current_run_id!==null||core.claim_lock||core.claim_expires)throw Error('studio-known-reconcile-context-changed')
  if([...store.s.runs.values()].some((r:any)=>r.batchId===batch.id&&r.status==='running'))throw Error('studio-known-reconcile-active-batch')
  const task=taskForBatch(base,batch)
  if(task.design?.evidenceContract!=='studio-video-v1'||!['executor','studio-stage'].includes(card.role))throw Error('studio-known-reconcile-context-changed')
  const input={task,batch,card,sessionId:run.sessionId}
  const op=db.prepare('SELECT * FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND intent=?').get(task.id,batch.id,value.intent)
  if(!op||!studioOperationInStage(input,op)||!['imageCalls','voiceSegments'].includes(op.kind)||typeof op.job_id!=='string'||!op.job_id||!['submitted','dispatching','unknown','completed','failed'].includes(op.state))throw Error('studio-known-reconcile-original-job-required')
  return {input,op}
 }
 const before=context(),identity={id:'known-operation:'+value.requestId+':'+value.intent,taskId:value.taskId,batchId:value.batchId,cardId:value.cardId,sourceRunId:value.expectedRunId,kind:'operator-operation-reconciliation',reason:value.reason}
 // Record operator involvement even when the subsequent network read fails.
 await store.transition(()=>{context();return audit.record(identity)},()=>undefined)
 if(['completed','failed'].includes(before.op.state))return {ok:true,alreadyTerminal:true,state:before.op.state,assisted:true,resumed:false,qualityApproved:false}
 let observation
 try{observation=await poll(before.op)}catch{throw Error('studio-known-reconcile-poll-unavailable: original reservation retained; no retry or resume performed')}
 const same=()=>{try{const now=context();return ['intent','kind','tool','job_id','state'].every(k=>now.op[k]===before.op[k])}catch{return false}}
 if(!same())throw Error('studio-known-reconcile-context-changed')
 await ops.invoke(before.input,observation.name,observation.args,async()=>observation.result,undefined,undefined,{operation:before.op,canApply:same})
 const after=context()
 return {ok:true,alreadyTerminal:false,state:after.op.state,terminal:['completed','failed'].includes(after.op.state),assisted:true,resumed:false,qualityApproved:false}
}
