import type {FrozenDialogue} from './studio-storyboard-script.js'
const synthesize='vyibc-voice_synthesize',retry='vyibc-voice_retry_segments'
const fail=(missing:string,indices:number[]=[])=>{throw Error('studio-voice-script-mismatch: '+JSON.stringify({error_code:'studio-voice-script-mismatch',missing,segmentIndices:indices,retryable:false,retryAfterRepair:true,tool:'studio_status',action:'Read studio_status.state.script. Production segments[].text must exactly match complete frozen dialogue lines; local remakes may submit any subset. Preserve punctuation and wording. Do not add lineId or scriptSha256 to MCP arguments: the voice service schema does not accept them. For retry_segments, explicit text changes must also match frozen lines; index-only retries retain upstream text and need separate job-lineage verification. Use the dedicated audition tool for voice trials, not production synthesize.'}))}
/** Actual voice tools/list observed 2026-09-24: synthesize has text/voice_type/
 * speech_rate only. Retry segments require index and may optionally replace text.
 * No provider protocol fields are invented, and no arguments are mutated.
 * Call only for a NEW dispatch after operation replay, before budget reservation.
 */
export function assertFrozenVoiceSynthesis(raw:string,args:any,script:FrozenDialogue|null|undefined){
 if(raw!==synthesize&&raw!==retry)return {checked:false,reason:'not-production-synthesis' as const}
 if(!Array.isArray(args?.segments)||args.segments.length<1)fail('segments')
 const supplied=args.segments.map((segment:any,index:number)=>({segment,index})).filter(({segment}:any)=>raw===synthesize||Object.prototype.hasOwnProperty.call(segment??{},'text'))
 if(!supplied.length)return {checked:false,reason:'retry-retains-upstream-text' as const}
 if(!script||!/^[a-f0-9]{64}$/i.test(script.sha256??'')||!Array.isArray(script.lines)||!script.lines.length||script.lines.some(line=>!line||typeof line.id!=='string'||typeof line.text!=='string'||!line.text.trim()))fail('frozen_script')
 const mismatched=supplied.filter(({segment}:any)=>typeof segment?.text!=='string'||!script!.lines.some(line=>line.text===segment.text)).map(({index}:any)=>index)
 if(mismatched.length)fail('exact_frozen_dialogue_text',mismatched)
 return {checked:true,scriptSha256:script.sha256,bindings:supplied.map(({segment,index}:any)=>({segmentIndex:index,lineIds:script!.lines.filter(line=>line.text===segment.text).map(line=>line.id)})),qualityApproved:false}
}
