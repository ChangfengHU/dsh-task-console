/** Presentation only: no ledger writes, provider calls, policy checks or quality decisions. */
import {isDeepStrictEqual} from 'node:util'
export type StudioStatusView='compact'|'full'
export interface StudioStatusAudience {role?:string;stageId?:string}
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const fullRead={tool:'studio_status',arguments:{view:'full'}} as const
function mediaIndex(media:any){
 if(!object(media))return media
 const index={...media}
 // Preserve kind, durations, dimensions, every identity/hash, silence finding and
 // unknown future fields. Only these known technical detail fields are omitted.
 for(const key of ['codecName','sampleRate','channels'])delete index[key]
 if(object(index.signalEvidence)){index.signalEvidence={...index.signalEvidence};delete index.signalEvidence.decodedSamples}
 return index
}
function stageIndex(receipt:any){
 if(!object(receipt)||!Array.isArray(receipt.outputs))return receipt
 const result=structuredClone(receipt)
 delete result.summary
 // Binding tracks often repeat the complete probe object already on outputs.
 // Remove it only when the exact path, SHA and complete media object agree.
 if(Array.isArray(result.soundBinding?.tracks))for(const track of result.soundBinding.tracks){
  const output=receipt.outputs.find((o:any)=>o.path===track.path&&o.sha256===track.sha256)
  if(output&&track.media!==undefined&&isDeepStrictEqual(track.media,output.media))delete track.media
 }
 result.outputs=result.outputs.map((output:any)=>object(output)&&object(output.media)?{...output,media:mediaIndex(output.media)}:output)
 // Typed component identities and mappings remain intact; descriptions stay in
 // the canonical registered plan and are available through the full view.
 if(object(result.visualBinding)){
  if(Array.isArray(result.visualBinding.requirements))result.visualBinding.requirements=result.visualBinding.requirements.map((r:any)=>{if(!object(r))return r;const value={...r};delete value.purpose;return value})
  if(Array.isArray(result.visualBinding.items))result.visualBinding.items=result.visualBinding.items.map((r:any)=>{if(!object(r))return r;const value={...r};delete value.usage;return value})
 }
 return result
}
/** Full view is byte-for-byte structurally equivalent to the previous tool value.
 * Compact never trims strings/arrays or removes jobs, source IDs, frozen speech,
 * locks, global budgets, assisted facts, candidate or QA evidence indices.
 */
export function projectStudioStatus(full:any,audience:StudioStatusAudience={},view:StudioStatusView='compact'){
 if(view!=='compact'&&view!=='full')throw Error('studio-status-view-invalid: use compact or full')
 const result=structuredClone(full)
 if(view==='full')return result
 if(!object(result))throw Error('studio-status-value-invalid')
 const state=result.state,aliases:Record<string,string>={},summarizedStages:string[]=[]
 if(object(state)){
  // Do not collapse conflicting snapshots; a mismatch must remain observable.
  for(const key of ['preflight','generationAllowance'])if(Object.hasOwn(result,key)&&Object.hasOwn(state,key)&&isDeepStrictEqual(result[key],state[key])){delete state[key];aliases['state.'+key]=key}
  if(object(state.autonomy)&&Array.isArray(state.interventions)&&Array.isArray(state.autonomy.records)&&isDeepStrictEqual(state.autonomy.records,state.interventions)){
   delete state.autonomy.records;aliases['state.autonomy.records']='state.interventions'
  }
  // A malformed/unknown audience cannot accidentally suppress production/QA data.
  if(audience.role==='studio-stage'&&['storyboard','visual','sound'].includes(audience.stageId??'')&&Array.isArray(state.stages)){
   state.stages=state.stages.map((stage:any)=>{
    if(!object(stage)||stage.id===audience.stageId||!['storyboard','visual','sound'].includes(stage.id)||!object(stage.receipt))return stage
    summarizedStages.push(stage.id)
    return {...stage,receipt:stageIndex(stage.receipt)}
   })
  }
 }
 result.statusProjection={schema:'studio-status-compact-v1',view:'compact',fullRead,aliases,summarizedStages,
  notice:'Presentation index only, not a new verification receipt or quality approval. All files, IDs, hashes, original jobs/nextCalls, frozen speech, locks, budgets, assisted facts and QA state are retained. Other-stage receipt summaries omit prose and selected probe details; sound track media refers to the exact matching outputs[path,sha256].media. Request view:full for complete receipt details. Editor/reviewer receipts remain complete.'}
 return result
}
