import {randomUUID} from 'node:crypto'
import {studioOperationInStage} from './studio-stage-operations.js'
import {studioProgressPending} from './studio-progress.js'
import {preparationBarrier} from './studio-preparation.js'
export const PROGRESS_POLL_LIMITS=Object.freeze({attempts:12,intervalMs:30_000,leaseMs:90_000,jobsPerTick:2})
/** Only future, confirmed, failure-counted progress stops acquire this marker. */
export class StudioProgressReconcile {
 constructor(readonly store:any){store.kernel.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_progress_reconcile(card_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,stop_event INTEGER NOT NULL,fence_event INTEGER,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,token TEXT);`)}
 get db(){return this.store.kernel.db}
 latest(id:string){return this.db.prepare('SELECT id,kind FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1').get(id)}
 arm(cardId:string,runId:number){
  const stopped=this.db.prepare("SELECT id,payload FROM task_events WHERE task_id=? AND run_id=? AND kind='studio_progress_stopped' ORDER BY id DESC LIMIT 1").get(cardId,runId)
  if(!stopped)return
  const fact=JSON.parse(stopped.payload),run=this.db.prepare('SELECT outcome FROM task_runs WHERE id=? AND task_id=?').get(runId,cardId),task=this.store.kernel.getTask(cardId)
  if(!['model-step-limit','tool-call-limit','repeated-tool-failure','asset-search-without-acquisition'].includes(fact.reason)||fact.reconciliationVersion!==1||fact.stopConfirmed!==true||!fact.blocked||run?.outcome!=='failed'||task?.current_run_id!==null||task?.status!=='ready')return
  this.db.prepare("INSERT INTO dsh_studio_progress_reconcile(card_id,run_id,stop_event,state) VALUES(?,?,?,'armed') ON CONFLICT(card_id) DO UPDATE SET run_id=excluded.run_id,stop_event=excluded.stop_event,fence_event=NULL,state='armed',attempts=0,next_at=0,lease_until=0,token=NULL").run(cardId,runId,stopped.id)
 }
 bind(cardId:string){
  const row=this.row(cardId),last=this.latest(cardId)
  if(row?.state!=='armed'||last?.kind!=='blocked')return
  // No later run/manual transition may adopt a marker left by an old stop.
  const intervening=this.db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND id>? AND id<? AND kind NOT IN ('failed') LIMIT 1").get(cardId,row.stop_event,last.id)
  if(intervening)return
  this.db.prepare("UPDATE dsh_studio_progress_reconcile SET fence_event=?,state='waiting' WHERE card_id=? AND run_id=? AND state='armed'").run(last.id,cardId,row.run_id)
 }
 row(id:string){return this.db.prepare('SELECT * FROM dsh_studio_progress_reconcile WHERE card_id=?').get(id)}
 eligible(input:any,row:any):boolean{
  if(!row||row.state!=='waiting'||row.fence_event!==this.latest(row.card_id)?.id)return false
  const liveTask=this.store.tasks.get(input.task.id),liveBatch=this.store.s.batches.get(input.batch.id),liveCard=this.store.s.cards.get(row.card_id)
  if(!liveTask||!liveBatch||!liveCard||liveCard.taskId!==input.task.id||liveCard.batchId!==input.batch.id||liveTask.archivedAt||liveTask.enabled===false||liveBatch.archivedAt||liveBatch.settled)return false
  const core=this.store.kernel.getTask(row.card_id),run=this.db.prepare('SELECT outcome FROM task_runs WHERE id=? AND task_id=?').get(row.run_id,row.card_id)
  const stopped=this.db.prepare("SELECT payload FROM task_events WHERE id=? AND task_id=? AND run_id=? AND kind='studio_progress_stopped'").get(row.stop_event,row.card_id,row.run_id)
  if(!stopped)return false
  let fact:any;try{fact=JSON.parse(stopped.payload)}catch{return false}
  return fact.stopConfirmed===true&&fact.reconciliationVersion===1&&run?.outcome==='failed'&&core?.status==='blocked'&&core.current_run_id===null&&!core.claim_lock&&!core.claim_expires&&!core.worker_pid&&!preparationBarrier(this.db,row.card_id)&&input.task.enabled!==false&&input.task.onFail==='retry'&&core.consecutive_failures>0&&core.consecutive_failures<input.task.maxTries&&!input.task.archivedAt&&!input.batch.archivedAt&&!input.batch.settled
 }
 operations(input:any){
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_operations'").get())return []
  if(!this.db.prepare('PRAGMA table_info(dsh_studio_operations)').all().some((r:any)=>r.name==='kind'))return []
  return this.db.prepare("SELECT * FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND state NOT IN ('completed','failed') ORDER BY intent").all(input.task.id,input.batch.id).filter((r:any)=>studioOperationInStage(input,r))
 }
 due(now:number){return this.db.prepare("SELECT * FROM dsh_studio_progress_reconcile WHERE state='waiting' AND next_at<=? AND lease_until<=? ORDER BY next_at,card_id LIMIT 1").all(now,now)}
 reserve(input:any,row:any,now:number){
  if(!this.eligible(input,row)){this.db.prepare("UPDATE dsh_studio_progress_reconcile SET state='invalidated' WHERE card_id=? AND run_id=? AND stop_event=? AND state='waiting' AND attempts=?").run(row.card_id,row.run_id,row.stop_event,row.attempts);return}
  if(row.attempts>=PROGRESS_POLL_LIMITS.attempts){this.db.prepare("UPDATE dsh_studio_progress_reconcile SET state='exhausted' WHERE card_id=? AND run_id=? AND stop_event=? AND state='waiting' AND attempts=?").run(row.card_id,row.run_id,row.stop_event,row.attempts);return}
  const token=randomUUID()
  const changed=this.db.prepare("UPDATE dsh_studio_progress_reconcile SET attempts=attempts+1,next_at=?,lease_until=?,token=? WHERE card_id=? AND run_id=? AND stop_event=? AND state='waiting' AND attempts=? AND lease_until<=?").run(now+PROGRESS_POLL_LIMITS.intervalMs,now+PROGRESS_POLL_LIMITS.leaseMs,token,row.card_id,row.run_id,row.stop_event,row.attempts,now)
  return changed.changes?token:undefined
 }
 current(input:any,token:string,now=Date.now()){const row=this.row(input.card.id);return row?.token===token&&row.lease_until>now&&this.eligible(input,row)}
 release(input:any,token:string){this.db.prepare('UPDATE dsh_studio_progress_reconcile SET lease_until=0 WHERE card_id=? AND token=?').run(input.card.id,token)}
 resume(input:any,token:string,now=Date.now()){
  if(!this.current(input,token,now)||studioProgressPending(this.db,input))return false
  if(!this.store.kernel.unblockTask(input.card.id))return false
  this.db.prepare("UPDATE dsh_studio_progress_reconcile SET state='resumed',lease_until=0 WHERE card_id=? AND token=?").run(input.card.id,token)
  this.store.kernel.recordEvent(input.card.id,'studio_progress_auto_reconciled',{schemaVersion:1,runId:this.row(input.card.id).run_id,attempts:this.row(input.card.id).attempts,humanIntervention:false,qualityApproved:false})
  return true
 }
}
