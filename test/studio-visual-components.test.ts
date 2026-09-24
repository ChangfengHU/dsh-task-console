import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {bindVisualComponents,validateExecutionComponents,type ComponentDocument} from '../src/studio-visual-components.ts'
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
const doc=(v:any):ComponentDocument=>{const bytes=Buffer.from(JSON.stringify(v));return {bytes,sha256:sha(bytes)}}
const parse=(d:ComponentDocument)=>JSON.parse(Buffer.from(d.bytes).toString())
function fixture(){
 const requirements=[{id:'person-1',sceneId:'scene-1',kind:'character',componentKey:'hero',characterId:'locked-person',purpose:'character visible'}, {id:'room-1',sceneId:'scene-1',kind:'background',componentKey:'room',purpose:'room visible'}, {id:'person-2',sceneId:'scene-2',kind:'character',componentKey:'hero',characterId:'locked-person',purpose:'reaction'}]
 const storyboard=doc({scenes:[{id:'scene-1'},{id:'scene-2'}],visualRequirements:{schema:'components-v2',items:requirements}})
 const path='stages/r1/visual/composite.png',digest=sha('host-verified-image-bytes')
 const components=[{id:'hero-component',kind:'character',componentKey:'hero',characterId:'locked-person',path,sha256:digest},{id:'room-component',kind:'background',componentKey:'room',path,sha256:digest}]
 const visualPlan=doc({schema:'visual-plan-v2',storyboardSha256:storyboard.sha256,components,items:requirements.map(r=>({requirementId:r.id,componentId:r.kind==='character'?'hero-component':'room-component',usage:'declared use, not pixel approval'})),missing:[]})
 const executionBoard=doc({schema:'studio-board-v1',scenes:[{layers:[{type:'image',src:path}]},{layers:[{type:'image',src:path}]},{layers:[{type:'image',src:path},{type:'text',text:'caption'}]}]})
 const mappings=[{sceneIndex:0,layerIndex:0,originalSceneId:'scene-1',requirementId:'person-1',componentId:'hero-component'},{sceneIndex:0,layerIndex:0,originalSceneId:'scene-1',requirementId:'room-1',componentId:'room-component'},{sceneIndex:1,layerIndex:0,originalSceneId:'scene-1',requirementId:'person-1',componentId:'hero-component'},{sceneIndex:2,layerIndex:0,originalSceneId:'scene-2',requirementId:'person-2',componentId:'hero-component'}]
 return {storyboard,visualPlan,outputs:[{path,sha256:digest,media:{kind:'image'}}],characterIds:['locked-person'],executionBoard,sidecar:doc({schema:'studio-execution-components-v2',storyboardSha256:storyboard.sha256,visualPlanSha256:visualPlan.sha256,executionBoardSha256:executionBoard.sha256,mappings})}
}
function error(field:string,reason:string){return (e:any)=>{assert.match(e.message,/^studio-visual-components-invalid:/);const body=JSON.parse(e.message.slice(e.message.indexOf(': ')+2));assert.equal(body.field,field);assert.equal(body.reason,reason);assert.equal(body.qualityApproved,false);assert.equal(body.pixelEvidence,'unverified');assert.equal(body.requiresNewGeneration,false);assert.ok(body.action.length>20);return true}}
test('composite components, reuse and split scenes bind without claiming pixel or quality approval',()=>{
 const input=fixture(),before=JSON.stringify(input),coverage=bindVisualComponents(input),execution=validateExecutionComponents(input)
 assert.equal(coverage.components.length,2);assert.equal(new Set(coverage.components.map(c=>c.path)).size,1)
 assert.equal(coverage.items.length,3);assert.equal(execution.mappings.length,4);assert.equal(execution.sidecarSha256,input.sidecar.sha256)
 assert.equal(coverage.qualityApproved,false);assert.equal(execution.pixelEvidence,'unverified');assert.equal(JSON.stringify(input),before)
})
test('background binding cannot silently satisfy character requirement',()=>{
 const input=fixture(),plan=parse(input.visualPlan);plan.items[0].componentId='room-component';input.visualPlan=doc(plan)
 assert.throws(()=>bindVisualComponents(input),error('visualPlan.items[0].componentId','component-does-not-fulfill-required-kind-or-identity'))
})
test('missing required components, unapproved identity, unknown paths and hash changes refuse handoff',()=>{
 for(const kind of ['missing','identity','path','hash','stale','duplicate','no-pixels']){
  const input=fixture(),plan=parse(input.visualPlan)
  if(kind==='missing')plan.items.pop()
  if(kind==='identity')plan.components[0].characterId='unlocked'
  if(kind==='path')plan.components[0].path='not-registered.png'
  if(kind==='hash')plan.components[0].sha256='f'.repeat(64)
  if(kind==='stale')plan.storyboardSha256='f'.repeat(64)
  if(kind==='duplicate')plan.items.push(plan.items[0])
  if(kind==='no-pixels')input.outputs[0].media.kind='audio'
  input.visualPlan=doc(plan);assert.throws(()=>bindVisualComponents(input),/studio-visual-components-invalid/,kind)
 }
})
test('raw original JSON hashes bind whitespace and reject malformed UTF8; v1 is not upgraded',()=>{
 const input=fixture();input.visualPlan={bytes:Buffer.concat([Buffer.from(input.visualPlan.bytes),Buffer.from(' ')]),sha256:input.visualPlan.sha256}
 assert.throws(()=>bindVisualComponents(input),error('visualPlan.sha256','document-hash-mismatch'))
 const bad=Buffer.from([255]);input.visualPlan={bytes:bad,sha256:sha(bad)};assert.throws(()=>bindVisualComponents(input),error('visualPlan','invalid-utf8-json'))
 const legacy=fixture(),board=parse(legacy.storyboard);board.visualRequirements=board.visualRequirements.items;legacy.storyboard=doc(board);assert.throws(()=>bindVisualComponents(legacy),/studio-visual-components-invalid/)
})
test('actual registered crop derivative is supported but imaginary crop fields are not implemented',()=>{
 const input=fixture(),plan=parse(input.visualPlan),crop={path:'stages/r1/visual/crop.png',sha256:sha('actual-registered-crop'),media:{kind:'image'}}
 input.outputs.push(crop);Object.assign(plan.components[0],{path:crop.path,sha256:crop.sha256});input.visualPlan=doc(plan)
 assert.equal(bindVisualComponents(input).components[0].path,crop.path)
 plan.components[0].crop={x:0,y:0,width:1,height:1};input.visualPlan=doc(plan)
 assert.throws(()=>bindVisualComponents(input),error('visualPlan.components[0]','unsupported-fields'))
})
test('execution rejects omitted original requirements and source/layer substitution despite valid sidecar hash',()=>{
 for(const kind of ['missing','substitution','missing-layer','wrong-component','wrong-scene','unmapped-image','stale-plan','stale-board','duplicate']){
  const input=fixture(),sidecar=parse(input.sidecar),board=parse(input.executionBoard)
  if(kind==='missing')sidecar.mappings=sidecar.mappings.filter((m:any)=>m.requirementId!=='room-1')
  if(kind==='substitution')board.scenes[0].layers[0].src='other.png'
  if(kind==='missing-layer')sidecar.mappings[0].layerIndex=5
  if(kind==='wrong-component')sidecar.mappings[0].componentId='room-component'
  if(kind==='wrong-scene')sidecar.mappings[0].originalSceneId='scene-2'
  if(kind==='unmapped-image')board.scenes[2].layers.push({type:'image',src:input.outputs[0].path})
  if(kind==='duplicate')sidecar.mappings.push(sidecar.mappings[0])
  input.executionBoard=doc(board);sidecar.executionBoardSha256=input.executionBoard.sha256
  if(kind==='stale-plan')sidecar.visualPlanSha256='e'.repeat(64)
  if(kind==='stale-board')sidecar.executionBoardSha256='e'.repeat(64)
  input.sidecar=doc(sidecar);assert.throws(()=>validateExecutionComponents(input),/studio-visual-components-invalid/,kind)
 }
})
test('background-only original scenes are legal and diagnostics do not reveal input content or credentials',()=>{
 const input=fixture(),board=parse(input.storyboard),plan=parse(input.visualPlan)
 board.scenes=[{id:'scene-1'}];board.visualRequirements.items=board.visualRequirements.items.filter((r:any)=>r.kind==='background');input.storyboard=doc(board)
 plan.storyboardSha256=input.storyboard.sha256;plan.components=plan.components.filter((c:any)=>c.kind==='background');plan.items=plan.items.filter((m:any)=>m.requirementId==='room-1');input.visualPlan=doc(plan);input.characterIds=[]
 assert.equal(bindVisualComponents(input).requirements[0].kind,'background')
 plan.components[0].path='SECRET_PRIVATE_PATH';input.visualPlan=doc(plan)
 assert.throws(()=>bindVisualComponents(input),(e:any)=>{assert.doesNotMatch(e.message,/SECRET_PRIVATE_PATH/);return true})
})
