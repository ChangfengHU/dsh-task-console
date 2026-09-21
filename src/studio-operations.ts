import {createHash} from 'node:crypto'
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
function canonical(v:any):any{return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v}
function unpack(result:any,depth=0):any {
  if(depth>4)return result
  if(result?.structuredContent)return unpack(result.structuredContent,depth+1)
  if(result?.type==='text'&&typeof result.text==='string'){try{return unpack(JSON.parse(result.text),depth+1)}catch{}}
  for(const x of (Array.isArray(result)?result:result?.content??[]))if(x.type==='text'){try{return unpack(JSON.parse(x.text),depth+1)}catch{}}
  return result
}
function job(value:any):string|undefined{return value?.job_id??value?.jobId??value?.task_id??value?.taskId??value?.job?.id??value?.task?.id}
const definition=(name:string,args:any)=>/generate_image$/.test(name)?{kind:'imageCalls',units:Math.max(1,Array.isArray(args?.prompts)?args.prompts.length:1)}:/(?:synthesize|retry_segments)$/.test(name)?{kind:'voiceSegments',units:Math.max(1,Array.isArray(args?.segments)?args.segments.length:1)}:null
const terminal=(value:any):string|undefined=>{const s=value?.status??value?.state??value?.job?.status??value?.task?.status;return typeof s==='string'?s.toLowerCase():undefined}
const done=new Set(['completed','complete','succeeded','success','done'])
const failedStates=new Set(['failed','cancelled','canceled'])
const rejected=(result:any,value:any)=>result?.isError===true||value?.ok===false||!!value?.error
const statusTool=(name:string)=>/(?:vyibc-voice_(?:status|result|cancel)|vyibc-image_get_task)$/.test(name)

/** Paid MCP submissions are reserved before dispatch and replayed by argument digest.
 * An unknown submission is never automatically retried. This is not a shell sandbox.
 */
export class StudioOperations {
  private db:any
  constructor(store:any){this.db=store.kernel.db;this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_limits(task_id TEXT,batch_id TEXT,limits TEXT,PRIMARY KEY(task_id,batch_id));
CREATE TABLE IF NOT EXISTS dsh_studio_operations(task_id TEXT,batch_id TEXT,intent TEXT,tool TEXT,kind TEXT,units INTEGER,state TEXT,job_id TEXT,result TEXT,PRIMARY KEY(task_id,batch_id,intent));`)}
  configure(input:any,limits:Record<string,number>){
    if(!limits||Object.keys(limits).sort().join(',')!=='imageCalls,voiceSegments'||Object.values(limits).some(v=>!Number.isInteger(v)||v<0))throw Error('studio-generation-budget-required')
    const before=this.db.prepare('SELECT limits FROM dsh_studio_limits WHERE task_id=? AND batch_id=?').get(input.task.id,input.batch.id)
    if(before&&hash(canonical(JSON.parse(before.limits)))!==hash(canonical(limits)))throw Error('studio-budget-cannot-change-within-batch')
    this.db.prepare('INSERT OR IGNORE INTO dsh_studio_limits VALUES(?,?,?)').run(input.task.id,input.batch.id,JSON.stringify(limits))
  }
  snapshot(input:any){
    const row=this.db.prepare('SELECT limits FROM dsh_studio_limits WHERE task_id=? AND batch_id=?').get(input.task.id,input.batch.id)
    if(!row)throw Error('studio-generation-budget-required')
    const operations=this.db.prepare('SELECT intent,tool,kind,units,state,job_id FROM dsh_studio_operations WHERE task_id=? AND batch_id=?').all(input.task.id,input.batch.id)
    const used={imageCalls:0,voiceSegments:0};for(const o of operations)used[o.kind as keyof typeof used]+=o.units
    return {used,limits:JSON.parse(row.limits),operations,unknown:operations.some((o:any)=>['dispatching','unknown'].includes(o.state))}
  }
  async invoke(input:any,raw:string,args:any,invoke:(args:any)=>Promise<any>){
    if(/(?:publish_video|post_video|upload_video|register_published_video)$/.test(raw))throw Error('studio-publication-not-authorized')
    const d=definition(raw,args)
    if((d||/vyibc-voice_cancel$/.test(raw))&&input.card?.role!=='executor')throw Error('studio-generation-executor-only')
    // Retrying an unconfirmed upstream outcome may charge twice. No automatic waiver.
    if(/retry_segments$/.test(raw)&&args?.retry_uncertain===true)throw Error('studio-uncertain-retry-not-authorized')
    if(!d){const result=await invoke(args),value=unpack(result),requestedId=job(args),returnedId=job(value),id=requestedId??returnedId,status=terminal(value)
      // Only a recognized read/status endpoint may advance a receipt. A failed poll,
      // mismatched job identity, or unrelated tool result is not job completion.
      if(statusTool(raw)&&id&&(!returnedId||returnedId===id)&&!rejected(result,value)&&status&&(done.has(status)||failedStates.has(status)))this.db.prepare("UPDATE dsh_studio_operations SET state=? WHERE task_id=? AND batch_id=? AND job_id=?").run(failedStates.has(status)?'failed':'completed',input.task.id,input.batch.id,id)
      return result
    }
    const intent=hash({raw,args:canonical(args)}),key=[input.task.id,input.batch.id,intent]
    const replay=this.db.prepare('SELECT * FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND intent=?').get(...key)
    if(replay){if(replay.result)return JSON.parse(replay.result);throw Error('studio-submission-unknown: reconcile original operation; do not resubmit')}
    this.db.transaction(()=>{const s=this.snapshot(input);if(s.unknown)throw Error('studio-prior-submission-unknown');if(s.used[d.kind as keyof typeof s.used]+d.units>s.limits[d.kind])throw Error('studio-generation-budget-exhausted');this.db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run(...key,raw,d.kind,d.units,'dispatching',null,null)})()
    try {
      const result=await invoke(args),value=unpack(result),id=job(value),status=terminal(value),failed=rejected(result,value)||!!status&&failedStates.has(status)
      const encoded=JSON.stringify(result)
      if(!encoded||encoded.length>2000000)throw Error('studio-submission-receipt-too-large')
      if(!failed&&!id)throw Error('studio-submission-missing-job-receipt')
      // Even an explicit upstream rejection consumes the reserved request allowance.
      this.db.prepare('UPDATE dsh_studio_operations SET state=?,job_id=?,result=? WHERE task_id=? AND batch_id=? AND intent=?').run(failed?'failed':status&&done.has(status)?'completed':'submitted',id??null,encoded,...key)
      return result
    } catch {this.db.prepare("UPDATE dsh_studio_operations SET state='unknown' WHERE task_id=? AND batch_id=? AND intent=?").run(...key);throw Error('studio-submission-unknown: host retained reservation; reconcile without retry')}
  }
}
