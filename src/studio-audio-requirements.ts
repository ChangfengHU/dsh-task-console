/** Pure declared-requirement coverage. IDs bind intent; they do not prove audible semantics. */
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)
const kinds=['bgm','sfx'] as const
const id=(v:any)=>typeof v==='string'&&v.length<=200&&v.trim().length>0&&v===v.trim()
function fail(field:string,reason:string,missing?:string[]):never{
 throw Error('studio-audio-requirements-invalid: '+JSON.stringify({error_code:'studio-audio-requirements-invalid',field,reason,...(missing?{missingRequirementIds:missing}:{}),retryAfterRepair:true,action:'Read the original registered storyboard audioRequirements. Preserve each BGM/SFX requirement id and kind; bind a real source cue using requirementId (or the same exact cue id). Obtain the missing source or request preparation revision with real evidence. Do not erase requirements/cues, replace IDs with purpose text, or claim a source is suitable solely because it is registered. No requirement is inferred from prose.',qualityApproved:false}))
}
export function bindAudioRequirements(board:any,storyboardSha256:string,plan:any){
 if(!object(board)||!/^[a-f0-9]{64}$/.test(storyboardSha256))fail('storyboard','A hash-verified registered storyboard is required.')
 const base={schema:'studio-audio-requirements-binding-v1',storyboardSha256,qualityApproved:false,semanticSuitability:'unverified'} as const
 if(!Object.hasOwn(board,'audioRequirements'))return {...base,status:'unverified' as const,reason:'storyboard-audio-requirements-absent',requiredIds:null,matches:[]}
 const requirements=board.audioRequirements
 if(!object(requirements))fail('audioRequirements','Expected an object with explicit bgm and sfx arrays; use empty arrays for intentionally absent music/effects.')
 const requiredIds:{bgm:string[];sfx:string[]}={bgm:[],sfx:[]},matches:{kind:'bgm'|'sfx';requirementId:string;cueIndexes:number[]}[]=[]
 for(const kind of kinds){
  const rows=requirements[kind],cues=plan?.[kind]
  if(!Array.isArray(rows)||rows.length>1000)fail('audioRequirements.'+kind,'Expected an array of at most 1000 requirements; an empty array explicitly requires none.')
  const seen=new Set<string>()
  for(let i=0;i<rows.length;i++){
   const r=rows[i]
   if(!object(r)||!id(r.id)||seen.has(r.id)||r.purpose!==undefined&&(typeof r.purpose!=='string'||!r.purpose.trim()))fail(`audioRequirements.${kind}[${i}]`,'Each declared requirement needs a unique nonempty id within its kind; purpose, if supplied, must be text and is never a matching key.')
   seen.add(r.id);requiredIds[kind].push(r.id)
  }
  if(!Array.isArray(cues))fail(kind,'The sound plan must retain explicit cue arrays.')
  const covered=new Map<string,number[]>()
  for(let i=0;i<cues.length;i++){
   const cue=cues[i],key=cue?.requirementId??cue?.id
   if(cue?.requirementId!==undefined&&(!id(cue.requirementId)||!seen.has(cue.requirementId)))fail(`${kind}[${i}].requirementId`,'Explicit requirementId must reference an original requirement of this exact audio kind.')
   if(seen.has(key))covered.set(key,[...(covered.get(key)??[]),i])
  }
  const missing=requiredIds[kind].filter(key=>!covered.has(key))
  if(missing.length)fail(kind,'Required original storyboard audio has no delivered cue.',missing)
  for(const key of requiredIds[kind])matches.push({kind,requirementId:key,cueIndexes:covered.get(key)!})
 }
 return {...base,status:'verified' as const,requiredIds,matches}
}

/** Evidence label only, after verifyStageReceipt succeeds; this accessor does not verify files.
 * Legacy v2 retains its original replay algorithm and has no original-requirement proof. */
export function soundReceiptRequirementEvidence(receipt:any){
 if(receipt?.stage==='sound'&&receipt.stageContractVersion===3&&receipt.soundBinding?.audioRequirements)return receipt.soundBinding.audioRequirements
 return {status:'unverified',reason:'legacy-sound-receipt-no-requirements-binding',qualityApproved:false} as const
}
