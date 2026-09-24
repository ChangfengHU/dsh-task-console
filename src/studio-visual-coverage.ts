/** File/requirement coverage only. Actual expression, identity and motion need review. */
const fail=(detail:string):never=>{throw Error('studio-visual-coverage-required: '+detail+' Repair the matching storyboard/visual plan; if requirements cannot be met within the original budget, request studio_request_preparation_revision with real evidence. Do not mark missing assets complete or erase requirements to pass.')}
export function visualRequirements(board:any){
 const scenes=board?.scenes,items=board?.visualRequirements
 if(!Array.isArray(scenes)||!scenes.length||scenes.some(s=>typeof s?.id!=='string'||!s.id)||new Set(scenes.map(s=>s.id)).size!==scenes.length)fail('Storyboard scenes need unique nonempty ids.')
 if(!Array.isArray(items)||!items.length||items.length>200)fail('Storyboard needs visualRequirements:[{id,sceneId,purpose}].')
 const sceneIds=new Set(scenes.map(s=>s.id)),ids=new Set<string>()
 for(const item of items){
  if(typeof item?.id!=='string'||!item.id||ids.has(item.id)||!sceneIds.has(item.sceneId)||typeof item.purpose!=='string'||!item.purpose.trim())fail('Invalid, duplicate or unbound visual requirement.')
  ids.add(item.id)
 }
 for(const id of sceneIds)if(!items.some(x=>x.sceneId===id))fail('Scene '+id+' has no visual requirement.')
 return items.map(({id,sceneId,purpose}:any)=>({id,sceneId,purpose}))
}
export function bindVisualCoverage(board:any,plan:any,outputs:any[],boardSha256:string){
 const requirements=visualRequirements(board)
 if(plan?.schema!=='visual-plan-v1'||plan.storyboardSha256!==boardSha256||!Array.isArray(plan.items))fail('visual-plan-v1 must bind the actual registered storyboard SHA and items.')
 if(!Array.isArray(plan.missing)||plan.missing.length)fail('An explicit empty missing list is required; missing assets prevent completed handoff.')
 const files=new Map(outputs.filter(f=>f.media?.kind==='image'||/\.(png|jpe?g|webp)$/i.test(f.path)).map(f=>[f.path,f])),seen=new Set<string>()
 const issues:{field:string;reason:string}[]=[]
 plan.items.forEach((item:any,index:number)=>{
  const field=`items[${index}]`
  if(!requirements.some(r=>r.id===item?.requirementId))issues.push({field:field+'.requirementId',reason:'Unknown requirement; use an id from the registered storyboard. Extra background/prop files may stay in manifest.outputs and the asset index without inventing requirement IDs.'})
  else if(seen.has(item.requirementId))issues.push({field:field+'.requirementId',reason:'Duplicate; one unique requirement binding is required.'})
  else seen.add(item.requirementId)
  if(!files.has(item?.path))issues.push({field:field+'.path',reason:'No exact registered image path match. Paths are project-relative, not relative to the visual plan directory; use the full registered output path.'})
  if(typeof item?.usage!=='string'||!item.usage.trim())issues.push({field:field+'.usage',reason:'State actual item usage/crop/action; reuse is allowed with shot-specific intent.'})
 })
 const missing=requirements.filter(r=>!seen.has(r.id))
 if(missing.length)issues.push({field:'items',reason:'Unfulfilled requirement ids: '+missing.map(r=>r.id).join(', ')})
 if(issues.length)fail(JSON.stringify({error_code:'studio-visual-binding-invalid',issues:issues.slice(0,32),totalIssues:issues.length,expectedRequirementIds:requirements.map(r=>r.id),registeredImagePaths:[...files.keys()].slice(0,24),requiresNewGeneration:false,requiresHuman:false,retryAfterRepair:true,instruction:'These are binding diagnostics, not proof that new generation or extra budget is needed. Reuse and actual crops are allowed. Repair the listed fields against registered files, while preserving required content. Copied contact sheets are not already-extracted poses; any claimed crop/adaptation must actually exist or be reproducibly specified for composition. Preparation revision preserves the original budget; it cannot grant extra image calls.'}))
 return {storyboardSha256:boardSha256,requirements,items:plan.items.map((x:any)=>({requirementId:x.requirementId,path:x.path,sha256:files.get(x.path).sha256,usage:x.usage})),qualityApproved:false}
}
