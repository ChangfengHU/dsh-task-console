import {DEFAULT_DIMENSIONS} from './studio-evidence.mjs'
/** The model receives the same required fields that the evidence gate checks. */
export const STUDIO_REVIEW_PARAMETERS={
 checks:{type:'array',required:true,description:'One check for every baseline dimension. Use only your actual same-candidate receipt IDs. Unchecked dimensions are pending, never invented pass.',items:{type:'object',properties:{
  dimension:{type:'string',required:true,enum:[...DEFAULT_DIMENSIONS]},
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
/** Fail before storing a malformed report, even when a native caller bypasses schema validation. */
export function validateReviewShape(args:any){
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
 }
 if(issues.length)throw Error('studio-review-shape-invalid: '+JSON.stringify({stored:false,issues,action:'Correct the listed fields together using this tool schema. Keep actual findings and receipt IDs; do not repeat observations merely to fix report format. No report was stored. Evidence integrity is checked separately.'}))
}
