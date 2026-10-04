/** Operator-only recovery for a lost image submission receipt.
 * Matching inputs is an audited operator decision, not provider idempotency.
 * No generation, refund, task restart, or direct model access.
 */
import {createHash} from 'node:crypto'
import {EventStore,taskForBatch} from './tasks.js'
import {StudioWorkflow} from './studio-workflow.js'
import {canonical} from './capability-contract.js'

const digest=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex')
export interface ImageReconciliation {
 taskId:string;batchId:string;expectedRunId:string;intent:string;jobId:string;
 recoveryId:string;reason:string;request:Record<string,any>
}
async function upstreamProof(id:string){
 const response=await fetch('https://fleet.vyibc.com/api/dispatch/'+encodeURIComponent(id),{redirect:'error',signal:AbortSignal.timeout(20000)})
 if(!response.ok)throw Error('studio-image-reconcile-upstream-unavailable')
 const text=await response.text()
 if(text.length>2_000_000)throw Error('studio-image-reconcile-proof-too-large')
 return JSON.parse(text)
}
export async function reconcileStudioImageOperation(store:EventStore,input:ImageReconciliation,readSession:(id:string)=>Promise<any>,readProof=upstreamProof){
 if(!input||['taskId','batchId','expectedRunId','intent','jobId','recoveryId','reason'].some(k=>typeof(input as any)[k]!=='string'||!(input as any)[k].trim()||(input as any)[k].length>2000)
  ||!/^[a-f0-9]{64}$/.test(input.intent)||!/^dt_[a-zA-Z0-9]+$/.test(input.jobId)||!input.request||Array.isArray(input.request)||JSON.stringify(input.request).length>100000)throw Error('studio-image-reconcile-invalid-input')
 const requestHash=digest(input.request),identity={taskId:input.taskId,batchId:input.batchId,expectedRunId:input.expectedRunId,intent:input.intent,jobId:input.jobId,recoveryId:input.recoveryId,reason:input.reason,requestHash}
 const previous=()=>{
  const row=store.all().find(e=>e.t==='batch/studio_image_reconciled'&&e.recoveryId===input.recoveryId) as any
  if(row&&Object.entries(identity).some(([k,v])=>row[k]!==v))throw Error('studio-image-reconcile-id-conflict')
  return row
 }
 const replay=previous();if(replay)return {ok:true,replay:true,jobId:replay.jobId,state:replay.state,assisted:true}
 const context=()=>{
  const task=store.tasks.get(input.taskId),batch=store.s.batches.get(input.batchId),run=store.s.runs.get(input.expectedRunId)
  if(!task||task.archivedAt||!batch||batch.taskId!==task.id||batch.archivedAt||!run||run.taskId!==task.id||run.batchId!==batch.id||taskForBatch(task,batch).design?.evidenceContract!=='studio-video-v1')throw Error('studio-image-reconcile-context-mismatch')
  const card=store.s.cards.get(run.cardId)
  if(!card||card.runIds.at(-1)!==run.id||!['executor','studio-stage'].includes(card.role))throw Error('studio-image-reconcile-run-changed')
  const op=store.kernel.db.prepare('SELECT * FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND intent=?').get(task.id,batch.id,input.intent) as any
  if(!op||op.state!=='unknown'||op.job_id!==null||!/generate_image$/.test(op.tool))throw Error('studio-image-reconcile-operation-changed')
  // StudioOperations hashes insertion-ordered {raw,args}, with canonical args.
  const intent=createHash('sha256').update(JSON.stringify({raw:op.tool,args:JSON.parse(canonical(input.request))})).digest('hex')
  if(intent!==input.intent)throw Error('studio-image-reconcile-request-digest-mismatch')
  return {task:taskForBatch(task,batch),batch,run,card,op,sessionId:run.sessionId}
 }
 const before=context(),session=await readSession(before.sessionId),events=session?.events
 if(!Array.isArray(events))throw Error('studio-image-reconcile-original-session-required')
 const submissions=events.filter((event:any)=>{
  if(event.type!=='tool/call')return false
  let args=event.data?.arguments
  try{if(typeof args==='string')args=JSON.parse(args);if(!args||digest(args)!==requestHash)return false}catch{return false}
  return events.some((result:any)=>result.type==='tool/result'&&result.data?.message?.source?.callId===event.data.callId&&JSON.stringify(result.data.message.content).includes('studio-submission-unknown'))
 })
 if(submissions.length!==1||!Number.isFinite(submissions[0].time))throw Error('studio-image-reconcile-original-submission-ambiguous')
 const proof=await readProof(input.jobId),task=proof?.task,items=proof?.items
 if(proof?.ok!==true||task?.id!==input.jobId||!['done','failed','cancelled'].includes(task.status)||!Array.isArray(items))throw Error('studio-image-reconcile-terminal-proof-required')
 const createdAt=Date.parse(String(task.created_at).replace(' ','T')+'Z'),submittedAt=submissions[0].time
 if(!Number.isFinite(createdAt)||createdAt<submittedAt-5000||createdAt>submittedAt+15*60*1000)throw Error('studio-image-reconcile-upstream-time-mismatch')
 const prompts=[...(input.request.prompts??[]),...(input.request.prompt?[input.request.prompt]:[])].map(p=>String(p||'').trim()).filter(Boolean)
 const workflowIds=input.request.engine==='chatgpt'?['chatgpt-image']:input.request.engine==='gemini'?['gemini-image']:['chatgpt-image','gemini-image']
 const settings=typeof task.settings==='string'?JSON.parse(task.settings):task.settings
 if(!prompts.length||task.total!==prompts.length||items.length!==prompts.length||before.op.units!==prompts.length
  ||canonical([...(settings?.workflowIds??[])].sort())!==canonical(workflowIds.sort())
  ||(settings?.enginePriority??'balanced')!==(input.request.enginePriority??'balanced')
  ||canonical([...(settings?.pin?.nodeIds??[])].sort())!==canonical([...(input.request.nodes??[])].sort())
  ||!Number.isInteger(task.succeeded)||!Number.isInteger(task.failed)||task.succeeded+task.failed!==task.total
  ||items.filter((item:any)=>item.status==='succeeded').length!==task.succeeded
  ||items.some((item:any,i:number)=>item.idx!==i||item.input?.prompt!==prompts[i]||(item.input?.sourceImageUrl??null)!==(input.request.referenceImageUrl||null)||!['succeeded','failed','cancelled'].includes(item.status)))throw Error('studio-image-reconcile-upstream-input-mismatch')
 const state=task.status==='done'?'completed':'failed',proofSha256=digest(proof)
 return store.transition(()=>{
  const old=previous();if(old)return {ok:true,replay:true,jobId:old.jobId,state:old.state,assisted:true}
  const current=context(),result={structuredContent:{taskId:input.jobId,status:task.status,total:task.total,succeeded:task.succeeded,failed:task.failed,operatorReconciled:true,proofSha256}}
  const updated=store.kernel.db.prepare("UPDATE dsh_studio_operations SET job_id=?,state=?,result=? WHERE task_id=? AND batch_id=? AND intent=? AND state='unknown' AND job_id IS NULL").run(input.jobId,state,JSON.stringify(result),input.taskId,input.batchId,input.intent)
  if(updated.changes!==1)throw Error('studio-image-reconcile-operation-changed')
  new StudioWorkflow(store).recordIntervention(current,'Operator reconciled an unknown image submission against terminal upstream inputs: '+input.recoveryId)
  return {ok:true,replay:false,jobId:input.jobId,state,assisted:true}
 },result=>result.replay?undefined:{t:'batch/studio_image_reconciled',at:new Date().toISOString(),...identity,proofSha256,state,assisted:true,method:'operator-exact-input-match'})
}
