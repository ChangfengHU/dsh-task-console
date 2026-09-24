import {StudioOperations} from './studio-operations.js'
import {readFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {studioStageFor} from './studio-stages.js'
const processIdentity=(pid:number)=>{try{return `${pid}:${readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19]}`}catch(e:any){if(e?.code==='ENOENT')return undefined;throw Error('studio-preparation-process-state-unknown')}}
export const preparationProcessIdentity=processIdentity(process.pid)
export const preparationOriginExited=(identity:string)=>{const pid=Number(identity.split(':')[0]);return Number.isInteger(pid)&&pid>0&&processIdentity(pid)!==identity}
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const exists=(db:any)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_preparation'").get()
export function preparationBarrier(db:any,cardId:string){
 if(!cardId||!exists(db))return undefined
 const row=db.prepare('SELECT p.payload FROM dsh_studio_preparation p JOIN dsh_studio_preparation_members m ON m.request_id=p.id WHERE m.card_id=? ORDER BY p.rowid DESC LIMIT 1').get(cardId)
 if(!row)return undefined
 const r=JSON.parse(row.payload)
 return cardId===r.plannerId&&r.state==='released'?undefined:r
}
export function assertPreparationWritable(db:any,input:any){
 const r=preparationBarrier(db,input.card?.id)
 if(r)throw Error('studio-preparation-revision-pending: '+JSON.stringify({requestId:r.id,state:r.state,round:r.round,nextPlanner:r.plannerId,action:'Old preparation is fenced. Do not submit new paid work, edit the frozen script, register stage outputs or render. Query only original operation IDs until terminal; the host returns the evidence to the next planner without resetting budgets.'}))
}
export class StudioPreparation {
 readonly db:any
 constructor(private store:any){this.db=store.kernel.db;this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_preparation(id TEXT PRIMARY KEY,task_id TEXT,batch_id TEXT,round INTEGER,state TEXT,payload TEXT,UNIQUE(task_id,batch_id,round)); CREATE TABLE IF NOT EXISTS dsh_studio_preparation_members(card_id TEXT,request_id TEXT,PRIMARY KEY(card_id,request_id)); CREATE TABLE IF NOT EXISTS dsh_studio_session_stops(session_id TEXT PRIMARY KEY,core_run_id INTEGER,method TEXT,stopped_at TEXT);`)}
 rows(batchId?:string){return this.db.prepare('SELECT payload FROM dsh_studio_preparation'+(batchId?' WHERE batch_id=?':'')+' ORDER BY rowid').all(...(batchId?[batchId]:[])).map((r:any)=>JSON.parse(r.payload))}
 publicRows(batchId:string){return this.rows(batchId).map(({id,round,state,reason,evidence,scriptSha256,plannerId,sourceCardId,createdAt,releasedAt,budgetAtRelease}:any)=>({id,round,state,reason,evidence,scriptSha256,plannerId,sourceCardId,createdAt,releasedAt,...(budgetAtRelease?{budgetAtRelease}:{})}))}
 private save(r:any){this.db.prepare('INSERT INTO dsh_studio_preparation VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload').run(r.id,r.taskId,r.batchId,r.round,r.state,JSON.stringify(r))}
 private currentScript(i:any){const r=this.db.prepare("SELECT payload FROM dsh_studio_state WHERE task_id=? AND batch_id=? AND kind='script'").get(i.task.id,i.batch.id);return r&&JSON.parse(r.payload)}
 private live(i:any){
  const c=this.store.kernel.getTask(i.card.id),binding=this.db.prepare('SELECT core_run_id FROM dsh_run_bindings WHERE session_id=? ORDER BY core_run_id DESC LIMIT 1').get(i.sessionId)
  if(c?.status!=='running'||!binding||c.current_run_id!==binding.core_run_id||c.claim_expires<=Math.floor(Date.now()/1000))throw Error('studio-preparation-stale-run')
  return binding.core_run_id
 }
 async request(i:any,value:{reason:string;evidence:{path:string;sha256:string};scriptSha256:string}){
  const stage=studioStageFor(i)
  if(!stage||i.task.design?.evidenceContract!=='studio-video-v1'||i.task.graphMode!=='dynamic-rounds')throw Error('studio-preparation-stage-required')
  if(typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>4000||!value.evidence?.path||!/^([a-f0-9]{64})$/.test(value.evidence.sha256))throw Error('studio-preparation-evidence-required')
  return this.store.transition(()=>{
   const coreRunId=this.live(i),previous=this.rows(i.batch.id).find((r:any)=>r.round===i.card.round)
   if(previous)return {...previous,replayed:true}
   const current=this.currentScript(i)
   if(!current||current.sha256!==value.scriptSha256)throw Error('studio-preparation-script-changed')
   if(i.card.round>=i.task.design.failurePolicy.maxAttempts)throw Error('studio-preparation-round-limit: cumulative production/preparation rounds exhausted; retain evidence and task_block, do not reset budget')
   const batch=this.db.prepare('SELECT settled_at,archived_at FROM dsh_batches WHERE id=? AND spec_id=?').get(i.batch.id,i.task.id)
   if(!batch||batch.settled_at||batch.archived_at)throw Error('studio-preparation-batch-not-active')
   const plannerId=`${i.batch.id}#p${i.card.round+1}`,planner=this.store.kernel.getTask(plannerId)
   if(!planner||planner.status!=='todo'||this.store.kernel.listRuns(plannerId).length)throw Error('studio-preparation-next-planner-already-started')
   for(const suffix of ['e','r'])if(this.store.kernel.listRuns(`${i.batch.id}#${suffix}${i.card.round}`).length)throw Error('studio-preparation-production-already-started: use independent candidate review')
   const cardIds=[...i.task.design.studioStages.map((s:any)=>`${i.batch.id}#s${i.card.round}-${s.id}`),`${i.batch.id}#g${i.card.round}`,`${i.batch.id}#e${i.card.round}`,`${i.batch.id}#r${i.card.round}`]
   for(const id of cardIds)if(this.store.kernel.getTask(id)?.tenant!==i.batch.id)throw Error('studio-preparation-graph-mismatch')
   const r={id:randomUUID(),taskId:i.task.id,batchId:i.batch.id,round:i.card.round,plannerId,cardIds,state:'draining',reason:value.reason,evidence:value.evidence,scriptSha256:current.sha256,policySha256:hash(i.task.design.studio),sourceCardId:i.card.id,sourceSessionId:i.sessionId,sourceCoreRunId:coreRunId,hostProcess:preparationProcessIdentity,sessionsToStop:cardIds.flatMap((id:string)=>{const c=this.store.kernel.getTask(id);if(c.current_run_id===null)return [];const b=this.db.prepare('SELECT session_id FROM dsh_run_bindings WHERE core_run_id=?').get(c.current_run_id);if(!b)throw Error('studio-preparation-run-binding-required');return [b.session_id]}),stoppedSessions:[],createdAt:new Date().toISOString()}
   r.stoppedSessions=r.sessionsToStop.filter((sid:string)=>!!this.db.prepare('SELECT 1 FROM dsh_studio_session_stops z JOIN dsh_run_bindings b ON b.session_id=z.session_id AND b.core_run_id=z.core_run_id WHERE z.session_id=?').get(sid))
   this.save(r);for(const id of [...cardIds,plannerId])this.db.prepare('INSERT INTO dsh_studio_preparation_members VALUES(?,?)').run(id,r.id)
   this.store.kernel.recordEvent(i.card.id,'studio_preparation_revision_requested',{requestId:r.id,round:r.round,scriptSha256:r.scriptSha256,reason:r.reason,evidence:r.evidence,nextPlanner:plannerId},coreRunId)
   return r
  },(r:any)=>r.replayed?undefined:{t:'studio/preparation-requested',at:r.createdAt,taskId:r.taskId,batchId:r.batchId,cardId:r.sourceCardId,requestId:r.id,reason:r.reason})
 }
 pending(r:any){
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_operations'").get())return []
  return this.db.prepare("SELECT intent,tool,state,job_id FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND state NOT IN ('completed','failed')").all(r.taskId,r.batchId)
 }
 recordStoppedSession(sessionId:string,method:'disposed'|'not-created'|'origin-process-exited'='disposed'){
  // Trusted runner only. Record even before a revision exists: a sibling may
  // request one while this normal completion's disposal/DB commit is in flight.
  this.db.transaction(()=>{
   const run=this.db.prepare('SELECT core_run_id FROM dsh_run_bindings WHERE session_id=? ORDER BY core_run_id DESC LIMIT 1').get(sessionId)
   if(!run)throw Error('studio-preparation-stop-run-missing')
   this.db.prepare('INSERT INTO dsh_studio_session_stops VALUES(?,?,?,?) ON CONFLICT(session_id) DO NOTHING').run(sessionId,run.core_run_id,method,new Date().toISOString())
   for(const r of this.rows())if(r.sessionsToStop.includes(sessionId)&&!r.stoppedSessions.includes(sessionId)){r.stoppedSessions.push(sessionId);this.save(r)}
  })()
 }
 markStopped(requestId:string,sessionId:string,method:'disposed'|'not-created'|'origin-process-exited'='disposed'){
  const r=this.rows().find((r:any)=>r.id===requestId)
  if(!r?.sessionsToStop.includes(sessionId))throw Error('studio-preparation-stop-owner-mismatch')
  this.recordStoppedSession(sessionId,method)
 }
 allowsScript(i:any,oldSha:string){return this.rows(i.batch.id).some((r:any)=>r.state==='released'&&r.plannerId===i.card.id&&r.scriptSha256===oldSha&&r.policySha256===hash(i.task.design.studio))}
 async release(requestId:string){
  return this.store.transition(()=>{
   const raw=this.db.prepare('SELECT payload FROM dsh_studio_preparation WHERE id=?').get(requestId);if(!raw)throw Error('studio-preparation-request-missing')
   const r=JSON.parse(raw.payload);if(r.state==='released')return {...r,replayed:true}
   if(this.pending(r).length)throw Error('studio-preparation-operations-unsettled')
   const batch=this.db.prepare('SELECT settled_at,archived_at FROM dsh_batches WHERE id=? AND spec_id=?').get(r.batchId,r.taskId)
   if(!batch||batch.settled_at||batch.archived_at)throw Error('studio-preparation-batch-not-active')
   const current=this.currentScript({task:{id:r.taskId},batch:{id:r.batchId}})
   if(current?.sha256!==r.scriptSha256)throw Error('studio-preparation-script-changed')
   const planner=this.store.kernel.getTask(r.plannerId)
   if(!planner||planner.status!=='todo'||this.store.kernel.listRuns(r.plannerId).length)throw Error('studio-preparation-next-planner-already-started')
   if(r.sessionsToStop.some((sid:string)=>!r.stoppedSessions.includes(sid)))throw Error('studio-preparation-session-not-stopped')
   const cancelledCards:string[]=[],cancelledRuns:string[]=[]
   for(const id of r.cardIds){
    const c=this.store.kernel.getTask(id);if(!c||c.tenant!==r.batchId)throw Error('studio-preparation-graph-mismatch')
    if(c.current_run_id!==null){
     const binding=this.db.prepare('SELECT external_run_id,session_id FROM dsh_run_bindings WHERE core_run_id=?').get(c.current_run_id)
     if(!binding||!r.stoppedSessions.includes(binding.session_id))throw Error('studio-preparation-session-not-stopped')
     if(!this.store.kernel.failRun(id,{expectedRunId:c.current_run_id,outcome:'cancelled',error:'Preparation replaced: '+r.id}).ok)throw Error('studio-preparation-run-changed')
     cancelledRuns.push(binding.external_run_id)
    }
    if(c.status!=='done'){
     if(c.status!=='archived'&&!this.store.kernel.cancelTask(id,'Preparation replaced: '+r.id))throw Error('studio-preparation-cancel-failed')
     cancelledCards.push(id)
    }
   }
   // Archived parents satisfy kernel dependencies; the durable barrier remains
   // active throughout this transaction and is released only with the new edge.
   this.db.prepare("DELETE FROM task_links WHERE child_id=? AND kind='dependency'").run(r.plannerId)
   const deps=[`${r.batchId}#p${r.round}`],at=Math.floor(Date.now()/1000)
   if(this.store.kernel.getTask(deps[0])?.status!=='done')throw Error('studio-preparation-original-planner-not-done')
   this.db.prepare("INSERT INTO task_links(parent_id,child_id,kind,created_at) VALUES(?,?,'dependency',?)").run(deps[0],r.plannerId,at)
   const actualBudget=new StudioOperations(this.store).snapshot({task:{id:r.taskId},batch:{id:r.batchId}})
   r.budgetAtRelease={source:'host-operation-ledger',used:actualBudget.used,limits:actualBudget.limits,remaining:Object.fromEntries(Object.entries(actualBudget.limits).map(([key,limit])=>[key,Math.max(0,Number(limit)-Number((actualBudget.used as any)[key]??0))])),budgetReset:false}
   const handoff=`[PREPARATION REVISION ${r.id}]\nAuthoritative host generation ledger at release: ${JSON.stringify(r.budgetAtRelease)}. Query studio_status for current counters before deciding new work. Failed submissions stay charged; downloaded/reused assets are not new generation calls. Revision NEVER adds allowance.\nAgent-reported reason (not host-verified budget/diagnosis): ${r.reason}\nEvidence: ${r.evidence.path} SHA256=${r.evidence.sha256}\nOriginal script SHA256=${r.scriptSha256}. Revise with studio_freeze_script; create new round ${r.round+1} through task_plan_round. Same batch and remaining generation allowance. Old outputs require explicit revalidation; do not delete history.`
   this.db.prepare('UPDATE tasks SET body=body||? WHERE id=?').run('\n\n'+handoff,r.plannerId)
   this.store.kernel.recordEvent(r.plannerId,'studio_preparation_revision_released',{requestId:r.id,parents:deps,reason:r.reason,supersededCards:r.cardIds})
   r.state='released';r.releasedAt=new Date().toISOString();this.save(r)
   return {...r,cancelledCards,cancelledRuns,deps,handoff}
  },(r:any)=>r.replayed?undefined:{t:'studio/preparation-released',at:r.releasedAt,taskId:r.taskId,batchId:r.batchId,requestId:r.id,plannerId:r.plannerId,supersededCards:r.cardIds,cancelledCards:r.cancelledCards,cancelledRuns:r.cancelledRuns,deps:r.deps,handoff:r.handoff})
 }
}
