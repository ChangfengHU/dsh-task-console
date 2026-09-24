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
 for(const item of plan.items){
  if(!requirements.some(r=>r.id===item?.requirementId)||seen.has(item.requirementId)||!files.has(item.path))fail('Every visual item must bind one unique requirement to an actual registered image file.')
  if(typeof item.usage!=='string'||!item.usage.trim())fail('State each item usage/crop/action; reused files need shot-specific intent.')
  seen.add(item.requirementId)
 }
 const missing=requirements.filter(r=>!seen.has(r.id))
 if(missing.length)fail('Unfulfilled requirement ids: '+missing.map(r=>r.id).join(', '))
 return {storyboardSha256:boardSha256,requirements,items:plan.items.map((x:any)=>({requirementId:x.requirementId,path:x.path,sha256:files.get(x.path).sha256,usage:x.usage})),qualityApproved:false}
}
