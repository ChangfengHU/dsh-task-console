import {createHash} from 'node:crypto'
import {classifyStudioTool} from './studio-progress-fingerprint.js'
import {readStudioOperationStatus} from './studio-operations.js'

export const STUDIO_PROGRESS_LIMITS=Object.freeze({modelSteps:80,tools:160,repeatedFailures:4,searches:8})
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface Snapshot {
 schemaVersion:1; policy:'studio-bounded-v1'; steps:string[]; calls:string[]; results:string[]; acquisitions:string[];
 failures:Record<string,number>; searches:number; reason?:string;
 lastFailure?:{tool:string;inputSha256:string;errorFingerprint:string;error:string}
}

/** Counters belong to a kernel run, not an LLM turn. Only hashes and bounded
 * diagnostics enter telemetry. Native tools, including nested calls, share it. */
export class StudioProgress {
 state:Snapshot
 constructor(private kernel:any,readonly cardId:string,readonly runId:number){
  const row=kernel.db.prepare("SELECT payload FROM task_events WHERE task_id=? AND run_id=? AND kind='studio_progress' ORDER BY id DESC LIMIT 1").get(cardId,runId)
  this.state={schemaVersion:1,policy:'studio-bounded-v1',steps:[],calls:[],results:[],acquisitions:[],failures:{},searches:0}
  if(row){
   try{
    const value=JSON.parse(row.payload),hashes=(xs:any,max:number)=>Array.isArray(xs)&&xs.length<=max&&xs.every((x:any)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))
    if(value?.schemaVersion!==1||value.policy!=='studio-bounded-v1'||!hashes(value.steps,80)||!hashes(value.calls,160)||!hashes(value.results,160)||!hashes(value.acquisitions,160)||!Number.isInteger(value.searches)||value.searches<0||value.searches>8||!value.failures||Array.isArray(value.failures)||Object.entries(value.failures).some(([k,v])=>!/^.{1,200}:[a-f0-9]{64}$/.test(k)||!Number.isInteger(v)||Number(v)<1||Number(v)>4)||value.reason!==undefined&&!['model-step-limit','tool-call-limit','repeated-tool-failure','asset-search-without-acquisition','progress-persistence-unavailable','progress-event-invalid','progress-snapshot-invalid'].includes(value.reason))throw Error('invalid')
    if(value.lastFailure&&(!/^[a-f0-9]{64}$/.test(value.lastFailure.inputSha256)||!/^[a-f0-9]{64}$/.test(value.lastFailure.errorFingerprint)||typeof value.lastFailure.tool!=='string'||value.lastFailure.tool.length>200||typeof value.lastFailure.error!=='string'||value.lastFailure.error.length>200))throw Error('invalid')
    this.state=value
   }catch{this.state.reason='progress-snapshot-invalid'}
  }
 }
 private active(){return this.kernel.getTask(this.cardId)?.current_run_id===this.runId}
 private save(){
  if(!this.active())return
  try{this.kernel.recordEvent(this.cardId,'studio_progress',this.state,this.runId)}
  catch{this.state.reason='progress-persistence-unavailable';throw Error('studio-progress-persistence-unavailable')}
 }
 step(turn:number,step:number){
  if(!this.active())return 'stale-run'
  if(this.state.reason)return this.state.reason
  if(!Number.isInteger(turn)||turn<0||!Number.isInteger(step)||step<0){this.state.reason='progress-event-invalid';this.save();return this.state.reason}
  const key=digest([turn,step]);if(this.state.steps.includes(key))return
  if(this.state.steps.length>=STUDIO_PROGRESS_LIMITS.modelSteps)this.state.reason='model-step-limit'
  else this.state.steps.push(key)
  this.save();return this.state.reason
 }
 dispatch(exec:any){
  if(!this.active())return 'stale-run'
  if(this.state.reason)return this.state.reason
  if(typeof exec.callId!=='string'||!exec.callId){this.state.reason='progress-event-invalid';this.save();return this.state.reason}
  const id=digest(exec.callId)
  if(this.state.calls.includes(id))return
  if(this.state.calls.length>=STUDIO_PROGRESS_LIMITS.tools)this.state.reason='tool-call-limit'
  else this.state.calls.push(id)
  this.save();return this.state.reason
 }
 result(exec:any,result:any){
  if(!this.active()||this.state.reason)return
  if(typeof exec.callId!=='string'||!exec.callId){this.state.reason='progress-event-invalid';this.save();return}
  const id=digest(exec.callId);if(this.state.results.includes(id))return
  // Validation failures can produce a result before the dispatch guard runs.
  if(!this.state.calls.includes(id))this.dispatch(exec)
  if(this.state.reason)return
  this.state.results.push(id)
  const fact=classifyStudioTool(exec,result)
  if(!fact.poll&&fact.errorFingerprint){
   const key=fact.tool+':'+fact.errorFingerprint
   const count=(this.state.failures[key]??0)+1;this.state.failures[key]=count
   this.state.lastFailure={tool:fact.tool,inputSha256:fact.inputSha256,errorFingerprint:fact.errorFingerprint,error:fact.errorSummary??'Tool failed; inspect the original tool result.'}
   if(count>=STUDIO_PROGRESS_LIMITS.repeatedFailures)this.state.reason='repeated-tool-failure'
  }
  if(fact.repaired)for(const key of Object.keys(this.state.failures))if(key.startsWith(fact.tool+':'))delete this.state.failures[key]
  const acquisition=digest([fact.tool,fact.inputSha256])
  if(fact.acquired&&!this.state.acquisitions.includes(acquisition)){this.state.acquisitions.push(acquisition);this.state.searches=0}
  else if(fact.search&&++this.state.searches>=STUDIO_PROGRESS_LIMITS.searches)this.state.reason='asset-search-without-acquisition'
  this.save()
 }
 summary(cwd:string){return JSON.stringify({policy:this.state.policy,reason:this.state.reason,modelSteps:this.state.steps.length,toolCalls:this.state.calls.length,searchesWithoutAcquisition:this.state.searches,lastFailure:this.state.lastFailure??null,workspace:cwd,notice:'Observed run limits, not proof of completion. Inspect existing files and original job receipts; do not repeat paid submissions.'})}
}

/** Same native boundaries as the standard chat guard; result listeners only
 * record. The pre-step exception really stops the next model request. */
export function registerStudioProgress(ctx:any,progress:StudioProgress,sessionId:string,isActive:()=>boolean){
 if(typeof ctx.on!=='function'||typeof ctx.tools?.guard!=='function')throw Error('studio-progress-hooks-unavailable')
 const same=(exec:any)=>exec.agent?.session?.id===sessionId
 const guard=ctx.tools.guard((exec:any)=>{
  if(!same(exec))return
  if(!isActive())return 'studio-progress-stale-run'
  try{const reason=progress.dispatch(exec);if(reason)return `STUDIO_PROGRESS_GUARD: ${reason}`}catch{return 'STUDIO_PROGRESS_GUARD: persistence-unavailable'}
 })
 const observe=ctx.on('tools/result',(exec:any,result:any)=>{if(same(exec)&&isActive())progress.result(exec,result)})
 const step=ctx.on('agent/pre-step',async(input:any,next:any)=>{
  const decision=await next();if(!same(input)||decision.kind==='reject')return decision
  if(!isActive())throw Error('STUDIO_PROGRESS_GUARD: stale-run')
  const reason=progress.step(input.turn,input.step)
  if(reason)throw Error(`STUDIO_PROGRESS_GUARD: ${reason}`)
  return decision
 },{prepend:true})
 return()=>{step();observe();guard()}
}

/** Read-only reconciliation pointers; no network, budget changes, or completion. */
export function studioProgressPending(db:any,input:any):string|undefined{
 const media=readStudioOperationStatus(db,input).operations.filter((r:any)=>!['completed','failed'].includes(r.state))
 const render=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_render_jobs'").get()
  ?db.prepare('SELECT payload FROM dsh_studio_render_jobs WHERE task_id=? AND batch_id=?').all(input.task.id,input.batch.id).map((r:any)=>JSON.parse(r.payload)).filter((r:any)=>!['completed','failed','rejected'].includes(r.state)).map((r:any)=>({state:r.state,jobId:r.jobId??null,nextCalls:r.jobId?[{tool:'studio_render_status',arguments:{jobId:r.jobId}}]:[]})):[]
 if(media.length||render.length)return JSON.stringify({reason:'original-operations-require-reconciliation',media,render,automaticRecovery:false,notice:'Recorded states may be stale. Reconcile original jobs before unblocking; do not resubmit, clear reservations, or infer completion.'})
}

export function studioProgressResume(kernel:any,cardId:string,cwd:string){
 const row=kernel.db.prepare("SELECT payload FROM task_events WHERE task_id=? AND kind='studio_progress_stopped' ORDER BY id DESC LIMIT 1").get(cardId)
 return row?JSON.stringify({previousStop:JSON.parse(row.payload),workspace:cwd,notice:'Continue from actual existing files and original receipts. These are facts, not a replacement plan or permission to regenerate.'}):undefined
}

/** Re-check immediately before a paid side effect after asynchronous probes. */
export function assertStudioProgressWritable(db:any,input:any,runId:number|undefined){
 if(input.task.design?.progressPolicy!=='studio-bounded-v1')return
 if(!Number.isInteger(runId))throw Error('studio-progress-run-required')
 const stopped=db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND run_id=? AND kind='studio_progress_stopped' LIMIT 1").get(input.card.id,runId)
 const row=db.prepare("SELECT payload FROM task_events WHERE task_id=? AND run_id=? AND kind='studio_progress' ORDER BY id DESC LIMIT 1").get(input.card.id,runId)
 let blocked=!!stopped
 try{if(row)blocked ||= !!JSON.parse(row.payload).reason}catch{blocked=true}
 if(blocked)throw Error('studio-progress-stop-requested: no new side effect; reconcile existing jobs')
}
