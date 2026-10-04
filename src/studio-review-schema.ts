import {DEFAULT_DIMENSIONS} from './studio-evidence.mjs'
/** The model receives the same required fields that the evidence gate checks. */
export const STUDIO_REVIEW_PARAMETERS={
 checks:{type:'array',required:true,description:'One check for every baseline dimension. Use only your actual same-candidate receipt IDs. Unchecked dimensions are pending, never invented pass.',items:{type:'object',properties:{
  dimension:{type:'string',required:true,enum:[...DEFAULT_DIMENSIONS],description:'Required evidence: technical=probe; editorial/identity/composition/motion/captions/reference=frames; intelligibility/performance/mix=audio; ending=frames AND audio over the SAME stated ranges; source_records=source. Performance here means vocal expression; facial/body acting belongs in motion. Source metadata or another session\'s IDs cannot replace observations. Use pending for unchecked dimensions on a grounded rejection.'},
  status:{type:'string',required:true,enum:['pass','fail','pending'],description:'Severity belongs in issues; blocker/major/partial are not check statuses.'},
  finding:{type:'string',required:true,description:'What the observations actually establish, including limits; do not infer whole-film coverage.'},
  ranges:{type:'array',required:true,items:{type:'array',items:{type:'number'}},description:'[[startSeconds,endSeconds],...], each covered by the supplied evidence for this dimension. Pending still states its intended unchecked range.'},
  evidenceReceiptIds:{type:'array',required:true,items:{type:'string'},description:'Exact IDs returned by your inspection tools. May be [] for pending dimensions on a grounded rejection.'},
 },additionalProperties:true}},
 issues:{type:'array',required:true,description:'Explicit list, including time, cause, repair and verification details. No issues means [].',items:{type:'object',properties:{
  id:{type:'string',required:true},severity:{type:'string',required:true,enum:['blocker','major','minor','info']},
  status:{type:'string',required:true,enum:['open','pending','resolved','verified']},
 },additionalProperties:true}},
}
const REPAIR_STAGES=['planner','storyboard','visual','sound','executor'] as const
const VERIFICATION_METHODS=['frames','audio','probe','source','frames+audio'] as const
const HASH=/^[a-f0-9]{64}$/i
const object=(v:any)=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:any)=>typeof v==='string'&&!!v.trim()&&!/^(?:pending|todo|tbd|n\/?a|none|unknown|待定|待补充|未填写)$/i.test(v.trim())
const ranges=(v:any)=>Array.isArray(v)&&v.length>0&&v.every((r:any)=>Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&r[0]>=0&&r[1]>r[0])
/** Additive, opt-in contract. Existing frozen Tasks retain the legacy tool schema. */
export function studioReviewParameters(structuredRepairs=false){
 if(!structuredRepairs)return STUDIO_REVIEW_PARAMETERS
 return {...STUDIO_REVIEW_PARAMETERS,issues:{...STUDIO_REVIEW_PARAMETERS.issues,description:'Localized repair issues. State actual time, scene/line, cause, responsible stage, concrete repair and verification plan. Never silently drop a prior unresolved issue. Resolved/verified requires a changed MP4 and fresh reviewer evidence.',items:{...STUDIO_REVIEW_PARAMETERS.issues.items,properties:{
  ...STUDIO_REVIEW_PARAMETERS.issues.items.properties,
  dimension:{type:'string',required:true,enum:[...DEFAULT_DIMENSIONS]},
  ranges:{type:'array',required:true,items:{type:'array',items:{type:'number'}},description:'Original affected [[startSeconds,endSeconds],...] in fromCandidateSha256. Preserve the host-recorded location on subsequent reports; use verification.location for a moved/replaced scene in the current film.'},
  sceneId:{type:'string',description:'Exact original planned scene ID; supply this or lineId and preserve it on subsequent reports.'},lineId:{type:'string',description:'Exact original frozen speech line ID; supply this or sceneId and preserve it on subsequent reports.'},
  responsibleStage:{type:'string',required:true,enum:[...REPAIR_STAGES]},cause:{type:'string',required:true,description:'Specific observed cause, not pending/TBD.'},
  repair:{type:'object',required:true,properties:{action:{type:'string',required:true},target:{type:'string',required:true},fromCandidateSha256:{type:'string',required:true,description:'Original candidate where this issue was observed. A repaired film must have different bytes.'}},additionalProperties:false},
  verification:{type:'object',required:true,properties:{method:{type:'string',required:true,enum:[...VERIFICATION_METHODS]},finding:{type:'string',required:true,description:'Concrete planned check while open; actual new observation once resolved/verified.'},evidenceReceiptIds:{type:'array',required:true,items:{type:'string'},description:'Fresh current-candidate reviewer receipts; [] only while open/pending.'},location:{type:'object',description:'Explicit current-candidate verification location when the original scene/line was removed, replaced or retimed. Supply a current host-known sceneId or lineId and ranges covered by fresh evidence; never rewrite the historical issue location.',properties:{sceneId:{type:'string'},lineId:{type:'string'},ranges:{type:'array',required:true,items:{type:'array',items:{type:'number'}}}},additionalProperties:false}},additionalProperties:false},
 }}}}
}
/** Fail before storing a malformed report, even when a native caller bypasses schema validation. */
export function validateReviewShape(args:any,options:{structuredRepairs?:boolean}={}){
 const issues:{path:string;expected:string}[]=[]
 const add=(path:string,expected:string)=>{if(issues.length<32)issues.push({path,expected})}
 for(const key of ['checks','issues'])if(!Array.isArray(args?.[key]))add(key,'array')
 if(Array.isArray(args?.checks))for(const [i,c] of args.checks.entries()){
  const p=`checks[${i}]`
  if(!c||typeof c!=='object'||Array.isArray(c)){add(p,'object');continue}
  if(!DEFAULT_DIMENSIONS.includes(c.dimension))add(p+'.dimension',DEFAULT_DIMENSIONS.join('|'))
  if(!['pass','fail','pending'].includes(c.status))add(p+'.status','pass|fail|pending; severity belongs in issues')
  if(typeof c.finding!=='string'||!c.finding.trim())add(p+'.finding','nonempty observation text, not an evidence field')
  if(!Array.isArray(c.ranges)||!c.ranges.length||c.ranges.some((r:any)=>!Array.isArray(r)||r.length!==2||!r.every(Number.isFinite)||r[0]<0||r[1]<=r[0]))add(p+'.ranges','nonempty [[startSeconds,endSeconds],...] within actual evidence coverage')
  if(!Array.isArray(c.evidenceReceiptIds)||c.evidenceReceiptIds.some((id:any)=>typeof id!=='string'||!id))add(p+'.evidenceReceiptIds','array of actual receipt IDs; [] only for pending dimensions on a grounded rejection')
 }
 if(Array.isArray(args?.issues))for(const [i,v] of args.issues.entries()){
  const p=`issues[${i}]`
  if(!v||typeof v!=='object'||Array.isArray(v)){add(p,'object');continue}
  if(typeof v.id!=='string'||!v.id.trim())add(p+'.id','nonempty issue ID')
  if(!['blocker','major','minor','info'].includes(v.severity))add(p+'.severity','blocker|major|minor|info')
  if(!['open','pending','resolved','verified'].includes(v.status))add(p+'.status','open|pending|resolved|verified')
  if(options.structuredRepairs){
   if(!DEFAULT_DIMENSIONS.includes(v.dimension))add(p+'.dimension',DEFAULT_DIMENSIONS.join('|'))
   if(!ranges(v.ranges))add(p+'.ranges','nonempty affected [[startSeconds,endSeconds],...]')
   if(!text(v.sceneId)&&!text(v.lineId))add(p+'.sceneId|lineId','actual nonempty scene or frozen line ID')
   for(const key of ['sceneId','lineId'])if(v[key]!==undefined&&!text(v[key]))add(p+'.'+key,'actual nonempty ID, not a placeholder')
   if(!REPAIR_STAGES.includes(v.responsibleStage))add(p+'.responsibleStage',REPAIR_STAGES.join('|'))
   if(!text(v.cause))add(p+'.cause','specific observed cause, not an empty or placeholder field')
   if(!object(v.repair))add(p+'.repair','concrete repair object')
   else{
    for(const key of ['action','target'])if(!text(v.repair[key]))add(p+'.repair.'+key,'specific nonempty repair '+key)
    if(!HASH.test(v.repair.fromCandidateSha256??''))add(p+'.repair.fromCandidateSha256','original observed candidate SHA-256')
   }
   if(!object(v.verification))add(p+'.verification','concrete verification object')
   else{
    if(!VERIFICATION_METHODS.includes(v.verification.method))add(p+'.verification.method',VERIFICATION_METHODS.join('|'))
    if(!text(v.verification.finding))add(p+'.verification.finding','specific verification plan or actual observation')
    const ids=v.verification.evidenceReceiptIds
    if(!Array.isArray(ids)||ids.some((id:any)=>!text(id))||new Set(ids).size!==ids.length||(['resolved','verified'].includes(v.status)&&!ids.length))add(p+'.verification.evidenceReceiptIds','unique actual receipt IDs; nonempty once resolved/verified')
    const location=v.verification.location
    if(location!==undefined){
     if(!object(location))add(p+'.verification.location','current verification location object')
     else{
      if(Object.keys(location).some(key=>!['sceneId','lineId','ranges'].includes(key)))add(p+'.verification.location','only sceneId, lineId and ranges are supported')
      if(!text(location.sceneId)&&!text(location.lineId))add(p+'.verification.location.sceneId|lineId','actual current scene or frozen line ID')
      for(const key of ['sceneId','lineId'])if(location[key]!==undefined&&!text(location[key]))add(p+'.verification.location.'+key,'actual current nonempty ID, not a placeholder')
      if(!ranges(location.ranges))add(p+'.verification.location.ranges','nonempty current [[startSeconds,endSeconds],...]')
     }
    }
   }
  }
 }
 if(issues.length)throw Error('studio-review-shape-invalid: '+JSON.stringify({stored:false,issues,action:'Correct the listed fields together using this tool schema. Keep actual findings and receipt IDs; do not repeat observations merely to fix report format. No report was stored. Evidence integrity is checked separately.'}))
}

/** Host-only evidence validation; fields describe a repair but cannot certify one. */
export function validateStructuredRepairEvidence(context:{review:any;candidate:{sha256:string;durationSeconds:number};reviewerSessionId:string;receipts:any[];previousReview?:any;sceneIds?:string[];lineIds?:string[];sceneRanges?:Record<string,number[][]>;lineRanges?:Record<string,number[][]>}){
 const {review,candidate,reviewerSessionId,receipts,previousReview,sceneIds,lineIds,sceneRanges,lineRanges}=context
 validateReviewShape(review,{structuredRepairs:true})
 const errors:string[]=[],fail=(s:string)=>errors.push(s),same=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase()
 const seen=new Set<string>(),prior=Array.isArray(previousReview?.issues)?previousReview.issues:[],byId=new Map(receipts.map(r=>[r.id,r]))
 const covered=(wanted:any[],actual:any[])=>{let at=wanted[0];for(const [start,end] of actual.sort((a,b)=>a[0]-b[0])){if(end<=at||start>=wanted[1])continue;if(start>at+.001)break;at=Math.max(at,end);if(at>=wanted[1]-.001)return true}return false}
 const dimensions:Record<string,string[]>={technical:['probe'],intelligibility:['audio'],performance:['audio'],mix:['audio'],ending:['frames','audio'],source_records:['source']}
 for(const issue of review.issues){
  const label='issue.'+issue.id
  if(seen.has(issue.id))fail(label+': duplicate ID');seen.add(issue.id)
  const previous=prior.find((i:any)=>i.id===issue.id),original=previous?.repair?.fromCandidateSha256??previousReview?.candidateSha256
  if(previous){
   if(!same(issue.repair.fromCandidateSha256,original))fail(label+': original candidate changed')
   if(previous.dimension!==undefined&&previous.dimension!==issue.dimension)fail(label+': original dimension changed')
   if(previous.severity!==issue.severity)fail(label+': original severity changed')
   for(const key of ['sceneId','lineId'])if(previous[key]!==issue[key])fail(label+': original '+key+' changed')
   if(previous.ranges!==undefined&&JSON.stringify(previous.ranges)!==JSON.stringify(issue.ranges))fail(label+': original ranges changed')
  }
  else if(!same(issue.repair.fromCandidateSha256,candidate.sha256))fail(label+': new issue must bind current candidate')
  // Historical IDs/ranges may no longer exist after a legitimate source rewrite,
  // but only the exact issue already stored by the host can use that exception.
  // A current/new issue cannot borrow an arbitrary historical-looking location.
  const historical=!!previous&&!same(issue.repair.fromCandidateSha256,candidate.sha256)&&
   same(issue.repair.fromCandidateSha256,original)&&previous.dimension===issue.dimension&&previous.severity===issue.severity&&
   ['sceneId','lineId'].every(key=>previous[key]===issue[key])&&ranges(previous.ranges)&&JSON.stringify(previous.ranges)===JSON.stringify(issue.ranges)
  const rangeCurrent=!issue.ranges.some((r:any)=>r[1]>candidate.durationSeconds+.001)
  const sceneCurrent=issue.sceneId===undefined||!sceneIds||sceneIds.includes(issue.sceneId)
  const lineCurrent=issue.lineId===undefined||!lineIds||lineIds.includes(issue.lineId)
  if(!rangeCurrent&&!historical)fail(label+': range outside current candidate')
  if(!sceneCurrent&&!historical)fail(label+': unknown scene ID')
  if(!lineCurrent&&!historical)fail(label+': unknown line ID')
  const location=issue.verification.location
  if(location){
   if(location.ranges.some((r:any)=>r[1]>candidate.durationSeconds+.001))fail(label+': verification range outside current candidate')
   if(location.sceneId!==undefined&&(!sceneIds||!sceneIds.includes(location.sceneId)))fail(label+': unknown verification scene ID')
   if(location.lineId!==undefined&&(!lineIds||!lineIds.includes(location.lineId)))fail(label+': unknown verification line ID')
   for(const [key,hostRanges] of [['sceneId',sceneRanges],['lineId',lineRanges]] as const){
    const id=location[key]
    if(id===undefined)continue
    const allowed=hostRanges&&Object.hasOwn(hostRanges,id)?hostRanges[id]:undefined
    if(!ranges(allowed)||allowed.some((r:any)=>r[1]>candidate.durationSeconds+.001))fail(label+': host verification '+key+' ranges required')
    else if(!location.ranges.every((r:any)=>covered(r,allowed.map((v:any)=>[...v]))))fail(label+': verification ranges outside current '+key)
   }
  }
  if(!['resolved','verified'].includes(issue.status))continue
  if(!previous||!['open','pending','resolved','verified'].includes(previous.status))fail(label+': no previously observed issue')
  if(same(issue.repair.fromCandidateSha256,candidate.sha256))fail(label+': unchanged candidate cannot verify repair')
  if((!rangeCurrent||!sceneCurrent||!lineCurrent)&&!location)fail(label+': explicit current verification location required')
  const verificationRanges=location?.ranges??issue.ranges
  const check=review.checks.find((c:any)=>c.dimension===issue.dimension)
  if(check?.status!=='pass')fail(label+': matching dimension is not passed')
  if(!check||!verificationRanges.every((r:any)=>covered(r,check.ranges.map((v:any)=>[...v]))))fail(label+': affected ranges exceed matching passed check')
  const methods=issue.verification.method==='frames+audio'?['frames','audio']:[issue.verification.method]
  const required=dimensions[issue.dimension]??['frames']
  if(required.some(kind=>!methods.includes(kind)))fail(label+': verification method does not cover dimension')
  const valid:any[]=[]
  for(const id of issue.verification.evidenceReceiptIds){
   const receipt=byId.get(id)
   if(!receipt||receipt.sessionId!==reviewerSessionId||!same(receipt.candidateSha256,candidate.sha256)||!HASH.test(receipt.sha256??'')||!ranges(receipt.ranges)||receipt.ranges.some((r:any)=>r[1]>candidate.durationSeconds+.001)){fail(label+': stale, foreign or invalid verification receipt '+id);continue}
   if(!check?.evidenceReceiptIds.includes(id))fail(label+': verification receipt missing from matching check')
   valid.push(receipt)
  }
  for(const kind of methods)if(!verificationRanges.every((r:any)=>covered(r,valid.filter(v=>v.kind===kind).flatMap(v=>v.ranges))))fail(label+': affected ranges exceed '+kind+' verification coverage')
 }
 for(const issue of prior)if(['open','pending'].includes(issue.status)&&!seen.has(issue.id))fail('issue.'+issue.id+': prior unresolved issue omitted')
 if(errors.length)throw Error('studio-structured-repair-evidence-invalid: '+errors.join('; '))
}
