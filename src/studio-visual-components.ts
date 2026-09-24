/** Opt-in components-v2 declarations only. No filesystem, provider, pixel or quality approval. */
import {createHash} from 'node:crypto'
const HASH=/^[a-f0-9]{64}$/
const KINDS=['character','background','prop','subject'] as const
export type VisualComponentKind=typeof KINDS[number]
export interface ComponentDocument {bytes:Uint8Array;sha256:string}
export interface RegisteredComponentImage {path:string;sha256:string;media:{kind:string}}
export interface VisualComponentInputs {
 storyboard:ComponentDocument;visualPlan:ComponentDocument;outputs:RegisteredComponentImage[];
 /** Exact allowed identities supplied by the host's task/profile lock, not discovered here. */
 characterIds:string[]
}
interface Requirement {id:string;sceneId:string;kind:VisualComponentKind;componentKey:string;characterId?:string;purpose:string}
interface Component {id:string;kind:VisualComponentKind;componentKey:string;characterId?:string;path:string;sha256:string}
const fail=(field:string,reason:string,action:string):never=>{throw Error('studio-visual-components-invalid: '+JSON.stringify({error_code:'studio-visual-components-invalid',field,reason,action,retryAfterRepair:true,requiresNewGeneration:false,qualityApproved:false,pixelEvidence:'unverified'}))}
const text=(v:any,field:string):string=>{if(typeof v!=='string'||!v.trim())fail(field,'nonempty-string-required','Supply the documented identifier or description. Do not remove the associated requirement.');return v}
const obj=(v:any,field:string,required:string[],optional:string[]=[])=>{
 if(!v||typeof v!=='object'||Array.isArray(v))fail(field,'object-required','Use the documented JSON object shape.')
 for(const key of required)if(!(key in v))fail(field+'.'+key,'required-field-missing','Supply this field using the frozen upstream document or an actual registered file.')
 if(Object.keys(v).some(k=>![...required,...optional].includes(k)))fail(field,'unsupported-fields','Only these fields are supported: '+[...required,...optional].join(', ')+'. Preserve unsupported creative intent in the source document; do not invent rendering parameters.')
}
const path=(value:any,field:string)=>{const p=text(value,field);if(p.startsWith('/')||p.includes('\\')||p.split('/').some(v=>!v||v==='.'||v==='..'))fail(field,'project-relative-exact-path-required','Use the exact registered project-relative image path, without aliases or traversal.');return p}
const hash=(v:any,field:string)=>{if(typeof v!=='string'||!HASH.test(v))fail(field,'sha256-required','Use the actual SHA256 of the referenced bytes.');return v as string}
const document=(d:ComponentDocument,field:string):any=>{
 if(!d||!(d.bytes instanceof Uint8Array)||!d.bytes.length||d.bytes.length>8*1024*1024)fail(field,'bounded-json-bytes-required','Pass the original nonempty JSON file bytes, at most 8 MiB, and its verified SHA256.')
 hash(d.sha256,field+'.sha256')
 if(createHash('sha256').update(d.bytes).digest('hex')!==d.sha256)fail(field+'.sha256','document-hash-mismatch','Reload the exact original document and SHA. Do not substitute a reserialized document under the old hash.')
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(d.bytes))}catch{fail(field,'invalid-utf8-json','Repair the authored JSON in a new revision, preserving the previous document; hash the actual new bytes.')}
}
const list=(v:any,field:string,max=800):any[]=>{if(!Array.isArray(v)||!v.length||v.length>max)fail(field,'nonempty-bounded-array-required','Supply the complete documented entries (maximum '+max+'); do not fill an empty placeholder.');return v}
const kind=(v:any,field:string):VisualComponentKind=>{if(!KINDS.includes(v))fail(field,'unsupported-component-kind','Use character, background, prop, or subject; these are declarations, not proof of image contents.');return v}
function identity(value:any,field:string,allowed:Set<string>){
 const k=kind(value.kind,field+'.kind');text(value.componentKey,field+'.componentKey')
 if(k==='character'){
  const id=text(value.characterId,field+'.characterId');if(!allowed.has(id))fail(field+'.characterId','character-not-in-host-lock','Use an actual character identity supplied by the host task/profile lock; do not guess an ID.')
 }else if(value.characterId!==undefined)fail(field+'.characterId','character-id-on-noncharacter','Keep character identity on a character component; do not relabel a background as a person.')
 return k
}
/** Storyboard-only validation before any visual plan or generated image exists. */
export function validateVisualComponentRequirements(input:Pick<VisualComponentInputs,'storyboard'|'characterIds'>){
 const board=document(input.storyboard,'storyboard')
 if(!Array.isArray(input.characterIds)||input.characterIds.some(v=>typeof v!=='string'||!v.trim())||new Set(input.characterIds).size!==input.characterIds.length)fail('characterIds','host-identity-inventory-required','Supply the exact known host character identities; an empty list is valid only for noncharacter requirements.')
 const allowed=new Set(input.characterIds),scenes=list(board?.scenes,'storyboard.scenes',60),sceneIds=new Set<string>()
 scenes.forEach((s:any,i:number)=>{const id=text(s?.id,`storyboard.scenes[${i}].id`);if(sceneIds.has(id))fail(`storyboard.scenes[${i}].id`,'duplicate-scene-id','Keep distinct stable original scene IDs.');sceneIds.add(id)})
 obj(board?.visualRequirements,'storyboard.visualRequirements',['schema','items'])
 if(board.visualRequirements.schema!=='components-v2')fail('storyboard.visualRequirements.schema','components-v2-opt-in-required','This validator only accepts explicit components-v2. Legacy requirements-v1 is not reinterpreted or upgraded automatically.')
 const reqIds=new Set<string>(),identities=new Map<string,string>()
 const requirements:Requirement[]=list(board.visualRequirements.items,'storyboard.visualRequirements.items',200).map((r:any,i:number)=>{
  const f=`storyboard.visualRequirements.items[${i}]`;obj(r,f,['id','sceneId','kind','componentKey','purpose'],['characterId'])
  const id=text(r.id,f+'.id'),sceneId=text(r.sceneId,f+'.sceneId');if(reqIds.has(id))fail(f+'.id','duplicate-requirement-id','Use one stable unique ID per logical requirement.');reqIds.add(id)
  if(!sceneIds.has(sceneId))fail(f+'.sceneId','unknown-original-scene','Bind this requirement to an existing original scene ID.')
  const k=identity(r,f,allowed),key=r.componentKey,signature=JSON.stringify([k,r.characterId??null])
  if(identities.has(key)&&identities.get(key)!==signature)fail(f+'.componentKey','inconsistent-component-identity','Keep kind and character identity stable for the same component key across scenes.')
  identities.set(key,signature)
  return {id,sceneId,kind:k,componentKey:key,...(r.characterId?{characterId:r.characterId}:{}),purpose:text(r.purpose,f+'.purpose')}
 })
 for(const id of sceneIds)if(!requirements.some(r=>r.sceneId===id))fail('storyboard.visualRequirements.items','original-scene-without-requirements','Declare the actual required components for every original scene; background-only scenes are allowed.')
 return {requirements,originalSceneIds:[...sceneIds],qualityApproved:false as const,pixelEvidence:'unverified' as const}
}
/** Validates file/declaration handoff. A returned binding never proves pixels or acting. */
export function bindVisualComponents(input:VisualComponentInputs){
 const {requirements,originalSceneIds}=validateVisualComponentRequirements(input),allowed=new Set(input.characterIds),plan=document(input.visualPlan,'visualPlan')
 obj(plan,'visualPlan',['schema','storyboardSha256','components','items','missing'])
 if(plan.schema!=='visual-plan-v2')fail('visualPlan.schema','visual-plan-v2-required','Use visual-plan-v2 with typed components. Existing v1 remains a separate contract.')
 if(plan.storyboardSha256!==input.storyboard.sha256)fail('visualPlan.storyboardSha256','stale-storyboard-binding','Bind the exact registered storyboard SHA; review changed requirements before rebinding.')
 if(!Array.isArray(plan.missing)||plan.missing.length)fail('visualPlan.missing','unresolved-requirements','Supply the genuinely missing components through legal reuse or current-budget work, or request preparation revision. An empty list alone does not prove coverage.')
 const files=new Map<string,string>()
 if(!Array.isArray(input.outputs))fail('outputs','registered-images-required','Pass the host-verified registered image outputs.')
 input.outputs.forEach((f,i)=>{if(!f||typeof f!=='object')fail(`outputs[${i}]`,'registered-image-object-required','Pass a verified registered image record with path, SHA256 and media.kind.');path(f.path,`outputs[${i}].path`);hash(f.sha256,`outputs[${i}].sha256`);if(f.media?.kind!=='image')fail(`outputs[${i}].media.kind`,'registered-image-required','Use the verified image subset of the stage outputs.');if(files.has(f.path))fail(`outputs[${i}].path`,'duplicate-registered-path','Pass each verified path once.');files.set(f.path,f.sha256)})
 const components:Component[]=[],componentIds=new Map<string,Component>()
 list(plan.components,'visualPlan.components').forEach((c:any,i:number)=>{
  const f=`visualPlan.components[${i}]`;obj(c,f,['id','kind','componentKey','path','sha256'],['characterId']);const id=text(c.id,f+'.id'),k=identity(c,f,allowed)
  if(componentIds.has(id))fail(f+'.id','duplicate-component-id','Use one unique component ID; reuse it in multiple requirement bindings.')
  const p=path(c.path,f+'.path'),sha=hash(c.sha256,f+'.sha256')
  if(files.get(p)!==sha)fail(f+'.path','registered-path-hash-mismatch','Use the exact registered image path and hash. Register a real crop/composite derivative before referring to it; merely declaring a crop does not create pixels.')
  const component={id,kind:k,componentKey:c.componentKey,...(c.characterId?{characterId:c.characterId}:{}),path:p,sha256:sha};components.push(component);componentIds.set(id,component)
 })
 const seen=new Set<string>()
 const items=list(plan.items,'visualPlan.items',200).map((item:any,i:number)=>{
  const f=`visualPlan.items[${i}]`;obj(item,f,['requirementId','componentId','usage']);const r=requirements.find(r=>r.id===item.requirementId),c=componentIds.get(item.componentId)
  if(!r||seen.has(item.requirementId))fail(f+'.requirementId','unknown-or-duplicate-requirement','Bind each original requirement exactly once, using its immutable ID. Reuse components, not duplicate requirement rows.')
  if(!c)fail(f+'.componentId','unknown-component','Reference a component declared with an actual registered image path/hash.')
  if(c.kind!==r.kind||c.componentKey!==r.componentKey||c.characterId!==r.characterId)fail(f+'.componentId','component-does-not-fulfill-required-kind-or-identity','Supply the required logical component. A background cannot fill a character requirement; a genuine composite may declare multiple distinct components on the same registered image.')
  seen.add(r.id);return {requirementId:r.id,componentId:c.id,usage:text(item.usage,f+'.usage')}
 })
 if(requirements.some(r=>!seen.has(r.id)))fail('visualPlan.items','unfulfilled-required-components','Bind all original requirement IDs; keep missing work explicit instead of deleting requirements or claiming missing:[].')
 return {schema:'studio-visual-components-binding-v2' as const,storyboardSha256:input.storyboard.sha256,visualPlanSha256:input.visualPlan.sha256,originalSceneIds,requirements,components,items,qualityApproved:false as const,pixelEvidence:'unverified' as const}
}
/** Revalidates original source bytes, then checks the execution mapping. No visual approval. */
export function validateExecutionComponents(input:VisualComponentInputs&{executionBoard:ComponentDocument;sidecar:ComponentDocument}){
 const coverage=bindVisualComponents(input),board=document(input.executionBoard,'executionBoard'),sidecar=document(input.sidecar,'sidecar')
 obj(sidecar,'sidecar',['schema','storyboardSha256','visualPlanSha256','executionBoardSha256','mappings'])
 if(sidecar.schema!=='studio-execution-components-v2')fail('sidecar.schema','execution-components-v2-required','Use the explicit execution sidecar schema; do not add unsupported fields to the rendering board.')
 for(const [key,expected] of [['storyboardSha256',coverage.storyboardSha256],['visualPlanSha256',coverage.visualPlanSha256],['executionBoardSha256',input.executionBoard.sha256]])if(sidecar[key]!==expected)fail('sidecar.'+key,'stale-source-binding','Recheck the exact changed source and its layer mapping before producing a new sidecar hash.')
 if(board?.schema!=='studio-board-v1')fail('executionBoard.schema','execution-board-required','Use the actual structured execution board; this sidecar does not convert planning JSON into rendering instructions.')
 const scenes=list(board.scenes,'executionBoard.scenes',60),seenRequirements=new Set<string>(),mappedImages=new Set<string>(),seenMappings=new Set<string>(),originalByScene=new Map<number,string>()
 const mappings=list(sidecar.mappings,'sidecar.mappings').map((m:any,i:number)=>{
  const f=`sidecar.mappings[${i}]`;obj(m,f,['sceneIndex','layerIndex','originalSceneId','requirementId','componentId'])
  if(!Number.isInteger(m.sceneIndex)||m.sceneIndex<0||m.sceneIndex>=scenes.length)fail(f+'.sceneIndex','invalid-execution-scene-index','Use the zero-based index of the actual execution scene.')
  const layers=scenes[m.sceneIndex]?.layers
  if(!Array.isArray(layers)||!Number.isInteger(m.layerIndex)||m.layerIndex<0||m.layerIndex>=layers.length)fail(f+'.layerIndex','invalid-execution-layer-index','Use the zero-based index of the actual image layer in that scene.')
  const req=coverage.requirements.find(r=>r.id===m.requirementId),binding=coverage.items.find(r=>r.requirementId===m.requirementId),component=coverage.components.find(c=>c.id===m.componentId)
  if(!req||req.sceneId!==m.originalSceneId)fail(f+'.requirementId','requirement-original-scene-mismatch','Use a requirement belonging to this original storyboard scene. Split execution scenes may keep the same originalSceneId.')
  if(!component||binding?.componentId!==m.componentId)fail(f+'.componentId','changed-visual-component-binding','Use the component bound by the registered visual plan; substitutions require a new explicit handoff.')
  const layer=layers[m.layerIndex]
  if(layer?.type!=='image'||layer.src!==component.path)fail(f+'.layerIndex','execution-image-source-substituted-or-missing','Map to an image layer using the exact registered component path. Do not relabel or replace the source; register a real derivative if needed.')
  if(originalByScene.has(m.sceneIndex)&&originalByScene.get(m.sceneIndex)!==m.originalSceneId)fail(f+'.originalSceneId','mixed-original-scenes','Each execution scene maps to one original scene; use separate scenes for a declared split.')
  const key=JSON.stringify([m.sceneIndex,m.layerIndex,m.requirementId]);if(seenMappings.has(key))fail(f,'duplicate-mapping','List each execution layer/requirement binding once. One composite layer may satisfy distinct requirements.')
  seenMappings.add(key);originalByScene.set(m.sceneIndex,m.originalSceneId);seenRequirements.add(req.id);mappedImages.add(`${m.sceneIndex}:${m.layerIndex}`)
  return {...m,path:component.path,sha256:component.sha256}
 })
 scenes.forEach((s:any,si:number)=>{
  if(!originalByScene.has(si))fail(`executionBoard.scenes[${si}]`,'unmapped-execution-scene','Bind each execution scene to its original scene requirements; do not silently add or replace content.')
  if(!Array.isArray(s.layers))fail(`executionBoard.scenes[${si}].layers`,'layers-required','Supply actual execution layers.')
  s.layers.forEach((l:any,li:number)=>{if(l?.type==='image'&&!mappedImages.has(`${si}:${li}`))fail(`executionBoard.scenes[${si}].layers[${li}]`,'unmapped-image-layer','Bind this actual image layer to a registered required component; text/caption layers are outside this check.')})
 })
 if(coverage.requirements.some(r=>!seenRequirements.has(r.id)))fail('sidecar.mappings','required-component-not-rendered','Restore the missing original requirements in actual image layers and mappings; do not remove the upstream requirements.')
 return {schema:'studio-execution-components-binding-v2' as const,storyboardSha256:coverage.storyboardSha256,visualPlanSha256:coverage.visualPlanSha256,executionBoardSha256:input.executionBoard.sha256,sidecarSha256:input.sidecar.sha256,mappings,qualityApproved:false as const,pixelEvidence:'unverified' as const}
}
