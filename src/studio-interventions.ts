import {createHash} from 'node:crypto'

export interface StudioInterventionInput {
  id:string; taskId:string; batchId:string; cardId?:string; sourceRunId?:string
  kind:string; reason:string; occurredAt?:string
}
export interface StudioIntervention extends StudioInterventionInput {
  occurredAt:string; registeredAt:string; source:'host'|'legacy'
}
/** Keep operator explanations useful without persisting common credential forms. */
export const sanitizeInterventionReason=(reason:string)=>reason
  .replace(/https?:\/\/[^\s]+/gi,'[url]')
  .replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
  .replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[credential redacted]')
  .replace(/[A-Za-z0-9_+/=-]{32,}/g,'[opaque]')
  .slice(0,4000)
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Host audit, not an OS security boundary. record() joins the caller's SQLite
 * transaction; it must be called inside the same transition as a recovery. */
export class StudioInterventions {
  readonly db:any
  constructor(storeOrDb:any){
    this.db=storeOrDb?.kernel?.db??storeOrDb
    this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_interventions(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,batch_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,payload TEXT NOT NULL)`)
  }
  record(input:StudioInterventionInput):{record:StudioIntervention;replay:boolean}{
    for(const key of ['id','taskId','batchId','kind','reason'] as const)
      if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>(key==='reason'?16000:2000))throw Error('studio-intervention-invalid:'+key)
    for(const key of ['cardId','sourceRunId'] as const)
      if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key]!.trim()||input[key]!.length>2000))throw Error('studio-intervention-invalid:'+key)
    if(input.occurredAt!==undefined&&(typeof input.occurredAt!=='string'||!Number.isFinite(Date.parse(input.occurredAt))))throw Error('studio-intervention-invalid:occurredAt')
    const value={id:input.id,taskId:input.taskId,batchId:input.batchId,cardId:input.cardId??null,sourceRunId:input.sourceRunId??null,kind:input.kind,reason:sanitizeInterventionReason(input.reason),occurredAt:input.occurredAt===undefined?null:new Date(input.occurredAt).toISOString()}
    const requestHash=digest(value)
    const write=()=>{
      const previous=this.db.prepare('SELECT request_sha256,payload FROM dsh_studio_interventions WHERE id=?').get(input.id)
      if(previous){if(previous.request_sha256!==requestHash)throw Error('studio-intervention-id-conflict');return {record:JSON.parse(previous.payload),replay:true}}
      const now=new Date().toISOString()
      const record:StudioIntervention={id:value.id,taskId:value.taskId,batchId:value.batchId,...(value.cardId?{cardId:value.cardId}:{}),...(value.sourceRunId?{sourceRunId:value.sourceRunId}:{}),kind:value.kind,reason:value.reason,occurredAt:value.occurredAt??now,registeredAt:now,source:'host'}
      this.db.prepare('INSERT INTO dsh_studio_interventions VALUES(?,?,?,?,?)').run(input.id,input.taskId,input.batchId,requestHash,JSON.stringify(record))
      return {record,replay:false}
    }
    return this.db.inTransaction?write():this.db.transaction(write)()
  }
  list(context:{taskId:string;batchId:string}):StudioIntervention[]{
    const records:StudioIntervention[]=this.db.prepare('SELECT payload FROM dsh_studio_interventions WHERE task_id=? AND batch_id=? ORDER BY rowid').all(context.taskId,context.batchId).map((r:any)=>JSON.parse(r.payload))
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_state'").get())return records
    const row=this.db.prepare("SELECT payload FROM dsh_studio_state WHERE task_id=? AND batch_id=? AND kind='interventions'").get(context.taskId,context.batchId)
    if(!row)return records
    const legacy=JSON.parse(row.payload)
    if(!Array.isArray(legacy))throw Error('studio-intervention-legacy-ledger-invalid')
    legacy.forEach((value:any,index:number)=>{
      if(typeof value?.reason!=='string'||!value.reason.trim())throw Error('studio-intervention-legacy-ledger-invalid')
      const at=typeof value.at==='string'?value.at:''
      records.push({id:'legacy:'+digest([context.taskId,context.batchId,index,value]),...context,kind:'legacy-manual-intervention',reason:sanitizeInterventionReason(value.reason),occurredAt:at,registeredAt:'',source:'legacy'})
    })
    return records
  }
  assessment(context:{taskId:string;batchId:string}){
    const records=this.list(context)
    return {status:records.length?'assisted' as const:'no_recorded_intervention' as const,interventionIds:records.map(r=>r.id),autonomousVerified:false as const,records}
  }
}
