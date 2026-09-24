/** Host render provenance. It is not an OS sandbox against same-user processes. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const HEX=/^[a-f0-9]{64}$/
const pathOk=(s:any)=>typeof s==='string'&&s.length>0&&!s.startsWith('/')&&!s.includes('\\')&&!s.includes('\0')&&!s.split('/').some(x=>!x||x==='..'||x.startsWith('.'))
export class StudioRenderLedger {
 private db:any
 constructor(private store:any){this.db=store.kernel.db;this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_render_jobs(intent_id TEXT PRIMARY KEY,task_id TEXT,batch_id TEXT,card_id TEXT,round INTEGER,policy_sha TEXT,job_id TEXT,payload TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS dsh_studio_render_job_identity ON dsh_studio_render_jobs(job_id) WHERE job_id IS NOT NULL;`)}
 private identity(i:any){
  if(i.card?.role!=='executor'||!i.task?.id||!i.batch?.id||!i.card?.id||!Number.isInteger(i.card.round)||!i.sessionId)throw Error('studio-render-owner-required')
  return {taskId:i.task.id,batchId:i.batch.id,cardId:i.card.id,round:i.card.round,policySha256:hash(i.task.design.studio)}
 }
 private assertOwner(i:any,row:any){const scope=this.identity(i);if(!row||Object.keys(scope).some(k=>scope[k]!==row[k]))throw Error('studio-render-job-not-owned-by-current-round: query studio_status renderJobs; never adopt another round jobId')}
 rows(i:any){return this.db.prepare('SELECT payload FROM dsh_studio_render_jobs WHERE task_id=? AND batch_id=? ORDER BY rowid').all(i.task.id,i.batch.id).map((x:any)=>JSON.parse(x.payload))}
 publicRows(i:any){return this.rows(i).map(({intentId,jobId,cardId,round,composition,output,state,inputSha256,outputSha256,originSessionId,errorCode}:any)=>({intentId,jobId,cardId,round,composition,output,state,inputSha256,outputSha256,originSessionId,errorCode}))}
 private save(row:any){this.db.prepare('INSERT INTO dsh_studio_render_jobs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(intent_id) DO UPDATE SET job_id=excluded.job_id,payload=excluded.payload').run(row.intentId,row.taskId,row.batchId,row.cardId,row.round,row.policySha256,row.jobId??null,JSON.stringify(row))}
 prepare(i:any,action:'start'|'status',args:any,config?:any){
  const scope=this.identity(i),rows=this.rows(i)
  if(action==='status'){
   const row=rows.find((r:any)=>r.jobId===args.jobId);this.assertOwner(i,row);return row
  }
  if(!pathOk(args.composition)||!pathOk(args.output)||!args.output.endsWith('.mp4'))throw Error('studio-render-path-invalid')
  const intentId=hash({...scope,composition:args.composition,output:args.output}),existing=rows.find((r:any)=>r.intentId===intentId)
  if(existing){this.assertOwner(i,existing);return existing}
  const pending=rows.find((r:any)=>r.cardId===scope.cardId&&r.round===scope.round&&!['completed','failed','rejected'].includes(r.state))
  if(pending)throw Error('studio-render-prior-job-pending: '+JSON.stringify({jobId:pending.jobId??null,composition:pending.composition,output:pending.output,state:pending.state,nextAction:pending.jobId?'Query the original studio_render_status jobId; do not start a replacement.':'Repeat studio_render_start with EXACT original composition/output to reconcile the persisted intent; do not edit inputs or create another job.'}))
  if(!HEX.test(config?.renderJobSha256??'')||typeof config?.renderJobScript!=='string'||typeof config?.renderRuntime!=='string')throw Error('studio-render-origin-helper-required')
  const run=[...this.store.s.runs.values()].find((r:any)=>r.sessionId===i.sessionId&&r.cardId===i.card.id&&r.status==='running') as any
  if(!run)throw Error('studio-render-live-run-required')
  const row={...scope,intentId,helperSha256:config.renderJobSha256,helperPath:config.renderJobScript,runtimePath:config.renderRuntime,originRunId:run.id,originSessionId:i.sessionId,composition:args.composition,output:args.output,state:'submitting',createdAt:new Date().toISOString()}
  this.save(row);return row
 }
 record(i:any,intent:any,result:any){return this.db.transaction(()=>{
  const raw=this.db.prepare('SELECT payload FROM dsh_studio_render_jobs WHERE intent_id=?').get(intent.intentId);const row=raw&&JSON.parse(raw.payload);this.assertOwner(i,row)
  if(result?.ok!==true){
   // A generic failure or reserved output does NOT prove no job was dispatched.
   // Keep ownership/pending protection; retry only this original intent.
   if(!row.jobId){row.state='unknown';row.errorCode=result?.errorCode??'render_host_failed';this.save(row)}
   return row
  }
  if(result.intentId!==row.intentId||!HEX.test(result.jobId??'')||!HEX.test(result.inputSha256??'')||result.composition!==row.composition||result.output!==row.output||row.jobId&&row.jobId!==result.jobId||row.inputSha256&&row.inputSha256!==result.inputSha256)throw Error('studio-render-provenance-mismatch')
  if(!HEX.test(result.helperSha256??'')||typeof result.helperPath!=='string'||typeof result.runtimePath!=='string')throw Error('studio-render-helper-provenance-required')
  if(row.helperSha256!==result.helperSha256||row.helperPath!==result.helperPath||row.runtimePath!==result.runtimePath)throw Error('studio-render-helper-version-changed')
  const next={...row,...result,originRunId:row.originRunId,originSessionId:row.originSessionId,lastObservedSessionId:i.sessionId,updatedAt:new Date().toISOString()}
  this.save(next);return next
 })()}
 requireCandidate(i:any,candidate:any,actualPath:string){
  const scope=this.identity(i),rows=this.rows(i)
  if(rows.some((r:any)=>Object.keys(scope).every(k=>scope[k]===r[k])&&!['completed','failed','rejected'].includes(r.state)))throw Error('studio-candidate-render-still-pending: reconcile the original render before handing off any candidate')
  const proof=rows.find((r:any)=>Object.keys(scope).every(k=>scope[k]===r[k])&&r.state==='completed'&&resolve(i.task.cwd,r.output)===actualPath&&r.outputSha256===candidate.sha256&&r.width===candidate.width&&r.height===candidate.height&&Math.abs(r.fps-candidate.fps)<.001&&Math.abs(r.durationSeconds-candidate.durationSeconds)<.05)
  if(!proof)throw Error('studio-candidate-current-render-required: actual MP4 path/SHA/spec must match a completed HOST render owned by this production card and round. Query studio_status renderJobs, reconcile the original job, and register its output. Another round or an Agent-provided jobId is not proof.')
  return {intentId:proof.intentId,jobId:proof.jobId,inputSha256:proof.inputSha256,outputSha256:proof.outputSha256,helperSha256:proof.helperSha256,originRunId:proof.originRunId,originSessionId:proof.originSessionId}
 }
}
