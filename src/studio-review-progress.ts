/** Receipt-derived coverage only. Never a quality score or review approval. */
import {studioReviewCoverageProgress} from './studio-review-coverage.mjs'
type Range=[number,number]
function ranges(value:any,duration:number):Range[]{
 if(!Array.isArray(value))return []
 return value.filter((v:any)=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&v[0]>=0&&v[0]<duration&&v[1]>v[0]&&v[1]<=duration+.001).map(([a,b]:Range)=>[a,Math.min(b,duration)])
}
function union(values:Range[]):Range[]{
 const out:Range[]=[]
 for(const [a,b] of values.sort((x,y)=>x[0]-y[0])){const last=out.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b])}
 return out
}
function complement(values:Range[],duration:number):Range[]{
 const missing:Range[]=[];let cursor=0
 for(const [a,b] of values){if(a>cursor)missing.push([cursor,a]);cursor=Math.max(cursor,b)}
 if(cursor<duration)missing.push([cursor,duration]);return missing
}
export function studioReviewProgress(candidate:any,sessionId:string,receipts:any[],speechPlan:any,speechChecks:any[],coverage?:{policy:any;reviewCoveragePlan:any}){
 const duration=candidate?.durationSeconds
 if(!candidate||typeof duration!=='number'||!Number.isFinite(duration)||duration<=0)return null
 const current=receipts.filter(r=>r?.sessionId===sessionId&&r.candidateSha256===candidate.sha256&&/^[a-f0-9]{64}$/i.test(r.sha256??'')&&typeof r.id==='string'&&r.id)
 const spans=(kind:string)=>union(current.filter(r=>r.kind===kind).flatMap(r=>ranges(r.ranges,duration)))
 const audio=spans('audio'),remainingAudio=complement(audio,duration),frameWindows=spans('frames')
 const planAvailable=speechPlan?.candidateSha256===candidate.sha256&&Array.isArray(speechPlan.lines)
 const speech=planAvailable?speechPlan.lines.flatMap((line:any)=>['source','final'].map(stage=>{
  const check=speechChecks.find(c=>c.sessionId===sessionId&&c.candidateSha256===candidate.sha256&&c.planSha256===speechPlan.planSha256&&c.lineId===line.id&&c.stage===stage)
  return {lineId:line.id,stage,status:check?.result?.content_gate==='pass'?'pass':check?'blocked':'pending'}
 })):[]
 const reviewCoverage=studioReviewCoverageProgress({candidate,reviewerSessionId:sessionId,receipts,policy:coverage?.policy,reviewCoveragePlan:coverage?.reviewCoveragePlan})
 return {candidateSha256:candidate.sha256,revision:candidate.revision,sessionId,scope:'observation-coverage-only',qualityApproved:false,
  ...(reviewCoverage?{reviewCoverage}:{}),
  audio:{observedRanges:audio,remainingRanges:remainingAudio,complete:remainingAudio.length===0,nextWindow:remainingAudio.length?[remainingAudio[0][0],Math.min(remainingAudio[0][1],remainingAudio[0][0]+8)]:null},
  frames:{sampledWindows:frameWindows,fullFrameCoverage:false,note:'These windows contain sparse samples, not every frame. Check required shots and transitions separately.'},
  speech:{planAvailable,pending:speech.filter((c:any)=>c.status!=='pass')},
  instruction:'Continue missing observations rather than repeating unchanged intervals without a reason. Coverage does not prove quality. A grounded major/blocker may be submitted as a rejection with unchecked dimensions pending; final acceptance still requires all checks.'}
}
