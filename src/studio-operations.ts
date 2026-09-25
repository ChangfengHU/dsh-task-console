import {studioStageFor} from './studio-stages.js'
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
const definition=(name:string,args:any)=>/generate_image$/.test(name)?{kind:'imageCalls',units:Math.max(1,(Array.isArray(args?.prompts)?args.prompts.length:0)+(args?.prompt?1:0))}:/(?:synthesize|retry_segments)$/.test(name)?{kind:'voiceSegments',units:Math.max(1,Array.isArray(args?.segments)?args.segments.length:1)}:null
const terminal=(value:any):string|undefined=>{const s=value?.status??value?.state??value?.job?.status??value?.task?.status;return typeof s==='string'?s.toLowerCase():undefined}
const done=new Set(['completed','complete','succeeded','success','done'])
const failedStates=new Set(['failed','cancelled','canceled'])
const rejected=(result:any,value:any)=>result?.isError===true||value?.ok===false||!!value?.error
const statusTool=(name:string)=>/(?:vyibc-voice_(?:status|result|cancel)|vyibc-image_get_task)$/.test(name)

/** Read existing submission metadata only. Never poll, replay provider bodies,
 * create tables, reserve budget, or change paid-operation state from status. */
export function readStudioOperationStatus(db:any,input:any){
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_operations'").get()
  const hasKind=exists&&db.prepare('PRAGMA table_info(dsh_studio_operations)').all().some((r:any)=>r.name==='kind')
  const rows=exists?db.prepare(`SELECT tool,state,job_id,${hasKind?'kind':'NULL AS kind'} FROM dsh_studio_operations WHERE task_id=? AND batch_id=? ORDER BY intent`).all(input.task.id,input.batch.id):[]
  const unrecognizedOperations:{kind:string|null;state:string}[]=[]
  const operations=rows.flatMap((row:any)=>{
    const tool=typeof row.tool==='string'?row.tool.match(/(?:vyibc-image_generate_image|vyibc-voice_(?:synthesize|retry_segments))$/)?.[0]:undefined
    const kind=['imageCalls','voiceSegments'].includes(row.kind)?row.kind:null
    if(!tool){unrecognizedOperations.push({kind,state:['completed','failed'].includes(row.state)?row.state:'unknown'});return []}
    const jobId=typeof row.job_id==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(row.job_id)?row.job_id:null
    const state=['dispatching','unknown','submitted','completed','failed'].includes(row.state)?row.state:'unknown'
    const voice=tool.startsWith('vyibc-voice_')
    const nextCalls=jobId?(voice?[
      {tool:'vyibc-voice_status',arguments:{job_id:jobId}},
      {tool:'vyibc-voice_result',arguments:{job_id:jobId}},
    ]:[{tool:'vyibc-image_get_task',arguments:{taskId:jobId}}]):[]
    return [{tool,kind,jobId,state,nextCalls,
      action:!jobId?'The submission has no usable job ID. Reconcile the original operation; do not invent an ID or submit again.':voice?
        'Poll the original job with voice_status for fresh state, then voice_result for completed segment metadata. A queued receipt or a missing local WAV does not establish current synthesis status. Download and verify completed segment files before registering them; preserve every frozen dialogue line.':
        'Read the original image job with get_task. Use only its succeeded items by index, then download and verify their files. Do not substitute the global latest-results feed.'}]
  })
  return {scope:'current-task-and-batch',source:'studio-operation-ledger',providerPolled:false,
    stateFreshness:'Recorded ledger states may be stale; this read does not query providers. No last-provider-check timestamp is stored.',
    instruction:'These calls only inspect existing jobs. Do not resubmit generation, infer provider failure from missing local files, or treat job completion as downloaded files or quality approval.',
    operations,unrecognizedOperations,qualityApproved:false}
}

/** Current allowance, read directly from immutable limits and reservations.
 * Status must not rely on a previous stage's cached budget report. */
export function readStudioGenerationAllowance(db:any,input:any){
 const unavailable={available:false,source:'studio-operation-ledger',canSubmitImages:false,canSubmitVoice:false,reason:'No valid frozen generation limits are available; do not infer permission from a Task brief.',qualityApproved:false}
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dsh_studio_limits','dsh_studio_operations')").all()
 if(tables.length!==2)return unavailable
 const row=db.prepare('SELECT limits FROM dsh_studio_limits WHERE task_id=? AND batch_id=?').get(input.task.id,input.batch.id)
 if(!row)return unavailable
 let limits:any;try{limits=JSON.parse(row.limits)}catch{return unavailable}
 if(!limits||Object.keys(limits).some(k=>!['imageCalls','imageBatches','voiceSegments'].includes(k))||!['imageCalls','voiceSegments'].every(k=>Number.isInteger(limits[k])&&limits[k]>=0)||limits.imageBatches!==undefined&&(!Number.isInteger(limits.imageBatches)||limits.imageBatches<0))return unavailable
 const rows=db.prepare('SELECT kind,units,state FROM dsh_studio_operations WHERE task_id=? AND batch_id=?').all(input.task.id,input.batch.id)
 if(rows.some((r:any)=>!['imageCalls','voiceSegments'].includes(r.kind)||!Number.isInteger(r.units)||r.units<1))return unavailable
 const remaining=(limit:number,used:number)=>({limit,used,remaining:Math.max(0,limit-used)})
 const imageItems=remaining(limits.imageCalls,rows.filter((r:any)=>r.kind==='imageCalls').reduce((n:number,r:any)=>n+r.units,0))
 const imageSubmissions=limits.imageBatches===undefined?null:remaining(limits.imageBatches,rows.filter((r:any)=>r.kind==='imageCalls').length)
 const voiceSegments=remaining(limits.voiceSegments,rows.filter((r:any)=>r.kind==='voiceSegments').reduce((n:number,r:any)=>n+r.units,0))
 const submissionUnknown=rows.some((r:any)=>['dispatching','unknown'].includes(r.state))
 const canSubmitImages=!submissionUnknown&&imageItems.remaining>0&&!!imageSubmissions&&imageSubmissions.remaining>0
 return {available:true,source:'studio-operation-ledger',scope:'current-task-and-batch',imageItems,imageSubmissions,voiceSegments,submissionUnknown,canSubmitImages,canSubmitVoice:!submissionUnknown&&voiceSegments.remaining>0,
  imageAction:submissionUnknown?'Reconcile the original uncertain submission before any new paid work.':!imageSubmissions?'Legacy batch has no frozen submission limit; new image generation is not authorized.':!canSubmitImages?'No new image generation is available. Reuse or derive verified existing images; do not plan new image calls, reset budget, or mark missing visuals complete.':'Plan against BOTH item and submission allowances. Multiple prompts[] in one generate_image call use one submission; each prompt uses one image item. A single-image call also uses one whole submission.',
  notice:'All reserved, failed and completed submissions retain their charge. This is current budget availability, not role permission, a provider call or quality approval.',qualityApproved:false}
}

/** Add host provenance without rewriting the saved provider receipt or its schema.
 * A historical queued response is not a newly queued job or a fresh status poll.
 */
function replayResult(result:any,row:any):any {
  const provenance={source:'studio-operation-ledger',replayed:true,dispatched:false,newReservedUnits:0,
    jobId:row.job_id??null,ledgerState:row.state,qualityApproved:false,
    instruction:'Reused the original submission receipt; no new generation or provider request occurred. Its provider status is historical. Poll the original job if needed. Do not report this as newly generated or improved audio/images; verify the actual reused files.'}
  const note={type:'text',text:JSON.stringify({studioOperation:provenance})}
  if(result?.type==='text'&&typeof result.text==='string'){
    try{return {...result,text:JSON.stringify(replayResult(JSON.parse(result.text),row))}}catch{
      return {...result,text:result.text+'\n'+note.text}
    }
  }
  if(Array.isArray(result))return [...result,note]
  if(result&&typeof result==='object'&&Array.isArray(result.content))return {...result,content:[...result.content,note]}
  if(result&&typeof result==='object'&&result.structuredContent)return {...result,content:[note]}
  return result&&typeof result==='object'?{...result,studioOperation:provenance}:{providerReceipt:result,studioOperation:provenance}
}

/** Append a host note to the delivered result, never the persisted provider
 * receipt. Preserve error flags, structured content and provider text. */
function imageBudgetResult(result:any,snapshot:any):any {
  const items={limit:snapshot.limits.imageCalls,used:snapshot.used.imageCalls,remaining:Math.max(0,snapshot.limits.imageCalls-snapshot.used.imageCalls)}
  const submissions={limit:snapshot.limits.imageBatches,used:snapshot.used.imageBatches,remaining:Math.max(0,snapshot.limits.imageBatches-snapshot.used.imageBatches)}
  const budget={source:'studio-operation-ledger',scope:'current-task-and-batch',recordedAfterSubmission:true,items,submissions,qualityApproved:false,
    instruction:'Image items and submission batches are separate allowances. One generate_image call consumes one submission batch; every prompt in prompts[] (plus prompt if supplied) consumes one image item. If several required images share the reference/settings, prompts:["image 1 instructions","image 2 instructions",...] can request them in one call within the remaining item allowance. A one-prompt call still consumes a whole submission batch. No minimum batch size is required. Failed and unknown submissions also retain their allowance. Poll the original taskId; do not repeat this submission. '+(submissions.remaining===0?'No new image submission remains, even if item allowance is positive. Reuse verified assets and report missing coverage; never reset the ledger.':'Plan any genuinely needed remaining images against BOTH allowances before another call. This note does not authorize extra generation.')}
  const note={type:'text',text:JSON.stringify({studioImageBudget:budget})}
  if(result?.type==='text'&&typeof result.text==='string'){
    try{return {...result,text:JSON.stringify(imageBudgetResult(JSON.parse(result.text),snapshot))}}catch{return {...result,text:result.text+'\n'+note.text}}
  }
  if(Array.isArray(result))return [...result,note]
  if(result&&typeof result==='object'&&Array.isArray(result.content))return {...result,content:[...result.content,note]}
  if(result&&typeof result==='object'&&result.structuredContent)return {...result,content:[note]}
  if(result&&typeof result==='object')return 'studioImageBudget' in result?{...result,content:[note]}:{...result,studioImageBudget:budget}
  return {providerReceipt:result,studioImageBudget:budget}
}

/** Paid MCP submissions are reserved before dispatch and replayed by argument digest.
 * An unknown submission is never automatically retried. This is not a shell sandbox.
 */
export class StudioOperations {
  private db:any
  constructor(store:any){this.db=store.kernel.db;this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_limits(task_id TEXT,batch_id TEXT,limits TEXT,PRIMARY KEY(task_id,batch_id));
CREATE TABLE IF NOT EXISTS dsh_studio_operations(task_id TEXT,batch_id TEXT,intent TEXT,tool TEXT,kind TEXT,units INTEGER,state TEXT,job_id TEXT,result TEXT,PRIMARY KEY(task_id,batch_id,intent));`)}
  configure(input:any,limits:Record<string,number>){
    if(!limits||!['imageCalls,voiceSegments','imageBatches,imageCalls,voiceSegments'].includes(Object.keys(limits).sort().join(','))||Object.values(limits).some(v=>!Number.isInteger(v)||v<0))throw Error('studio-generation-budget-required')
    const before=this.db.prepare('SELECT limits FROM dsh_studio_limits WHERE task_id=? AND batch_id=?').get(input.task.id,input.batch.id)
    if(before&&hash(canonical(JSON.parse(before.limits)))!==hash(canonical(limits)))throw Error('studio-budget-cannot-change-within-batch')
    this.db.prepare('INSERT OR IGNORE INTO dsh_studio_limits VALUES(?,?,?)').run(input.task.id,input.batch.id,JSON.stringify(limits))
  }
  snapshot(input:any){
    const row=this.db.prepare('SELECT limits FROM dsh_studio_limits WHERE task_id=? AND batch_id=?').get(input.task.id,input.batch.id)
    if(!row)throw Error('studio-generation-budget-required')
    const operations=this.db.prepare('SELECT intent,tool,kind,units,state,job_id FROM dsh_studio_operations WHERE task_id=? AND batch_id=?').all(input.task.id,input.batch.id)
    const used={imageCalls:0,voiceSegments:0};for(const o of operations)used[o.kind as keyof typeof used]+=o.units
    const limits=JSON.parse(row.limits)
    if(limits.imageBatches!==undefined)(used as any).imageBatches=operations.filter((o:any)=>o.kind==='imageCalls').length
    return {used,limits,operations,unknown:operations.some((o:any)=>['dispatching','unknown'].includes(o.state))}
  }
  async invoke(input:any,raw:string,args:any,invoke:(args:any)=>Promise<any>,beforeDispatch?:()=>unknown,prepareDispatch?:()=>Promise<unknown>,reconcile?:{operation:any;canApply:()=>boolean}){
    if(/(?:publish_video|post_video|upload_video|register_published_video)$/.test(raw))throw Error('studio-publication-not-authorized')
    if(/vyibc-image_list_results$/.test(raw))throw Error('studio-image-global-results-not-a-job-receipt: poll get_task with the original submitted taskId and use only its succeeded items by idx. A running item is not completed. The global latest-results feed can contain other tasks; use the asset library for intentional reuse instead.')
    const d=definition(raw,args)
    const stage=studioStageFor(input)
    const specialistAllowed=!!d&&((stage?.id==='visual'&&d.kind==='imageCalls')||(stage?.id==='sound'&&d.kind==='voiceSegments'))
    if((d||/vyibc-voice_cancel$/.test(raw))&&input.card?.role!=='executor'&&!specialistAllowed)throw Error('studio-generation-executor-only')
    // Retrying an unconfirmed upstream outcome may charge twice. No automatic waiver.
    if(/retry_segments$/.test(raw)&&args?.retry_uncertain===true)throw Error('studio-uncertain-retry-not-authorized')
    if(!d){const result=await invoke(args),value=unpack(result),requestedId=job(args),returnedId=job(value),id=requestedId??returnedId,status=terminal(value)
      // Only a recognized read/status endpoint may advance a receipt. A failed poll,
      // mismatched job identity, or unrelated tool result is not job completion.
      if(statusTool(raw)&&id&&(!returnedId||returnedId===id)&&!rejected(result,value)&&status&&(done.has(status)||failedStates.has(status))){
        const next=failedStates.has(status)?'failed':'completed'
        if(reconcile)this.db.transaction(()=>{
          const op=reconcile.operation,expected=op.kind==='imageCalls'?'vyibc-image_get_task':op.kind==='voiceSegments'?'vyibc-voice_status':null
          if(!expected||raw!==expected||id!==op.job_id||!['dispatching','unknown','submitted'].includes(op.state)||!reconcile.canApply())return
          this.db.prepare('UPDATE dsh_studio_operations SET state=? WHERE task_id=? AND batch_id=? AND intent=? AND kind=? AND tool=? AND job_id=? AND state=?').run(next,input.task.id,input.batch.id,op.intent,op.kind,op.tool,op.job_id,op.state)
        })()
        else this.db.prepare("UPDATE dsh_studio_operations SET state=? WHERE task_id=? AND batch_id=? AND job_id=?").run(next,input.task.id,input.batch.id,id)
      }
      return result
    }
    const intent=hash({raw,args:canonical(args)}),key=[input.task.id,input.batch.id,intent]
    const replay=this.db.prepare('SELECT * FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND intent=?').get(...key)
    if(replay){if(replay.result)return replayResult(JSON.parse(replay.result),replay);throw Error('studio-submission-unknown: reconcile original operation; do not resubmit')}
    // Semantic checks apply only to new work: never block saved receipts or polling,
    // and reject before reserving budget so local validation cannot become unknown.
    const validate=()=>{
      const s=this.snapshot(input)
      if(s.unknown)throw Error('studio-prior-submission-unknown')
      if(d.kind==='imageCalls'&&s.limits.imageBatches===undefined)throw Error('studio-image-batch-budget-missing: '+JSON.stringify({
        error_code:'studio-image-batch-budget-missing',dispatched:false,reservedUnits:0,retryable:false,
        usedBatches:s.operations.filter((o:any)=>o.kind==='imageCalls').length,
        action:'This legacy frozen task has no structured image batch allowance. New image submissions are disabled; remaining image units do not authorize another batch. Existing job polling and receipt replay remain available. Reuse verified assets. Set an explicit imageBatches allowance when creating future tasks; never rewrite this batch or reset its paid history.',
      }))
      if(d.kind==='imageCalls'&&s.limits.imageBatches!==undefined&&(s.used as any).imageBatches>=s.limits.imageBatches)throw Error('studio-generation-batch-limit: '+JSON.stringify({
        error_code:'studio-generation-batch-limit',usedBatches:(s.used as any).imageBatches,limitBatches:s.limits.imageBatches,remainingBatches:0,
        remainingImageUnits:Math.max(0,s.limits.imageCalls-s.used.imageCalls),dispatched:false,reservedUnits:0,
        action:'The image submission batch allowance is exhausted even if image units remain. Failed and unknown submissions consume a batch. Reuse verified existing assets and report missing coverage; do not submit a new request or reset task limits.',
      }))
      const used=s.used[d.kind as keyof typeof s.used],limit=s.limits[d.kind],remaining=Math.max(0,limit-used)
      if(d.units>remaining)throw Error('studio-generation-budget-exhausted: '+JSON.stringify({
        error_code:remaining>0?'studio-generation-request-exceeds-remaining':'studio-generation-budget-exhausted',
        kind:d.kind,requestedUnits:d.units,usedUnits:used,limitUnits:limit,remainingUnits:remaining,
        dispatched:false,reservedUnits:0,retryable:false,retryAfterRepair:remaining>0,
        action:remaining>0?'This request is too large; the remaining allowance is not zero. Each image prompt or voice segment counts as one unit, even in a single batch call. Reuse valid assets, then submit only necessary units within the remaining allowance. Do not repeat the same oversized request or create another task to reset the budget.':'No allowance remains for new generation. Reuse verified existing assets and report unmet requirements. Do not reset the task budget or retry paid work under another ID.',
      }))
      // An exhausted or absent allowance cannot be repaired by fetching another
      // reference or tweaking prompts. Report that first; validate new input
      // only when this request can actually reserve its required units.
      const checked=beforeDispatch?.()
      if(checked&&typeof (checked as any).then==='function')throw Error('studio-dispatch-validator-must-be-synchronous')
    }
    if(prepareDispatch){
      this.db.transaction(validate)()
      await prepareDispatch()
      if(intent!==hash({raw,args:canonical(args)}))throw Error('studio-submission-input-changed')
    }
    const raced=this.db.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND intent=?').get(...key)
      if(previous)return previous
      validate()
      this.db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run(...key,raw,d.kind,d.units,'dispatching',null,null)
      return undefined
    })()
    if(raced){if(raced.result)return replayResult(JSON.parse(raced.result),raced);throw Error('studio-submission-unknown: reconcile original operation; do not resubmit')}
    let providerResult:any
    try {
      const result=await invoke(args),value=unpack(result),id=job(value),status=terminal(value),failed=rejected(result,value)||!!status&&failedStates.has(status)
      const encoded=JSON.stringify(result)
      if(!encoded||encoded.length>2000000)throw Error('studio-submission-receipt-too-large')
      if(!failed&&!id)throw Error('studio-submission-missing-job-receipt')
      // Even an explicit upstream rejection consumes the reserved request allowance.
      this.db.prepare('UPDATE dsh_studio_operations SET state=?,job_id=?,result=? WHERE task_id=? AND batch_id=? AND intent=?').run(failed?'failed':status&&done.has(status)?'completed':'submitted',id??null,encoded,...key)
      providerResult=result
    } catch {this.db.prepare("UPDATE dsh_studio_operations SET state='unknown' WHERE task_id=? AND batch_id=? AND intent=?").run(...key);throw Error('studio-submission-unknown: host retained reservation; reconcile without retry')}
    return d.kind==='imageCalls'?imageBudgetResult(providerResult,this.snapshot(input)):providerResult
  }
}
