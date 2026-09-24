import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {registerStageFiles,verifyStageReceipt} from '../src/studio-stage-files.ts'
import {registerStudioBoardTools} from '../src/studio-board-tools.ts'
import {validateStudioStages,studioStageCardId,studioStageRows} from '../src/studio-stages.ts'
import {validateStudioPolicy} from '../src/studio-policy.ts'
const run=promisify(execFile),sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex')
const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:`video-${id}`,brief:'prepare actual stage'})))
async function fixture(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'components-integration-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const receipts=new Map<string,any>()
 const lines=[{id:'L1',text:'你好'}],script={lines,sha256:sha(JSON.stringify(lines))}
 const policy=validateStudioPolicy({characterId:'locked-person',visualCoverage:'components-v2',width:1080,height:1920,fps:30,durationMin:1,durationMax:3,maxRepairRounds:1,referenceUrl:'https://cdn.vyibc.com/reference.mp4',referenceSha256:'a'.repeat(64),publish:false})
 const task={cwd,design:{studioStages:stages,studio:policy}},batch={id:'B'}
 const input=(id:string)=>({task,batch,card:{id:studioStageCardId('B',1,id as any),agentId:`video-${id}`,role:'studio-stage',round:1},sessionId:'session-'+id})
 const workflow={script:()=>script,stageReceipt:(_:any,id:string)=>receipts.get(id),recordStageReceipt:(_:any,r:any)=>receipts.set(r.stage,r)},db={prepare:()=>({get:()=>({status:'done',tenant:'B',assignee:'video-storyboard'})})}
 const boardPath='stages/r1/storyboard/storyboard.json',imagePath='stages/r1/visual/composite.png',planPath='stages/r1/visual/visual-plan.json'
 for(const stage of ['storyboard','visual'])await mkdir(join(cwd,'stages/r1',stage),{recursive:true})
 const story={scenes:[{id:'s1'}],scriptSha256:script.sha256,script:lines,visualRequirements:{schema:'components-v2',items:[{id:'person',sceneId:'s1',kind:'character',componentKey:'hero',characterId:'locked-person',purpose:'person visible'},{id:'room',sceneId:'s1',kind:'background',componentKey:'room',purpose:'location'}]}}
 const saveStory=()=>writeFile(join(cwd,boardPath),JSON.stringify(story))
 const manifest=async(stage:string,outputs:string[])=>{const path=`stages/r1/${stage}/manifest.json`;await writeFile(join(cwd,path),JSON.stringify({stage,round:1,outputs,summary:'Declaration coverage only; pixel quality unverified'}));return path}
 await saveStory();await registerStageFiles(input('storyboard'),await manifest('storyboard',[boardPath]),workflow,db)
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=16x16','-frames:v','1','-threads','1','-y',join(cwd,imagePath)])
 const imageSha=sha(await readFile(join(cwd,imagePath)))
 const plan={schema:'visual-plan-v2',storyboardSha256:sha(await readFile(join(cwd,boardPath))),components:[{id:'hero',kind:'character',componentKey:'hero',characterId:'locked-person',path:imagePath,sha256:imageSha},{id:'room',kind:'background',componentKey:'room',path:imagePath,sha256:imageSha}],items:[{requirementId:'person',componentId:'hero',usage:'declared person; pixels unverified'},{requirementId:'room',componentId:'room',usage:'declared location'}],missing:[]}
 const savePlan=()=>writeFile(join(cwd,planPath),JSON.stringify(plan)),visualManifest=await manifest('visual',[planPath,imagePath]);await savePlan()
 const registerVisual=()=>registerStageFiles(input('visual'),visualManifest,workflow,db)
 await registerVisual()
 await writeFile(join(cwd,'gsap.min.js'),'// compile-only fixture');await writeFile(join(cwd,'font.ttf'),'compile-only fixture')
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1','-y',join(cwd,'voice.wav')])
 const board={schema:'studio-board-v1',duration:2,gsap:'gsap.min.js',font:'font.ttf',script:lines,scenes:[{start:0,duration:2,layers:[{type:'image',role:'subject',src:imagePath,width:400,height:600}]}],audio:[{role:'voice',src:'voice.wav',start:0,lineId:'L1',text:'你好'}]}
 const encoded=JSON.stringify(board,null,2);await writeFile(join(cwd,'execution.json'),encoded)
 const sidecar={schema:'studio-execution-components-v2',storyboardSha256:plan.storyboardSha256,visualPlanSha256:sha(await readFile(join(cwd,planPath))),executionBoardSha256:sha(encoded),mappings:[{sceneIndex:0,layerIndex:0,originalSceneId:'s1',requirementId:'person',componentId:'hero'},{sceneIndex:0,layerIndex:0,originalSceneId:'s1',requirementId:'room',componentId:'room'}]}
 const saveSidecar=()=>writeFile(join(cwd,'binding.json'),JSON.stringify(sidecar));await saveSidecar()
 let tool:any,calls=0
 const editor={task,batch,card:{id:'B#e1',agentId:'editor',role:'executor',round:1},sessionId:'editor'}
 const dispose=await registerStudioBoardTools({tools:{register:(v:any)=>{tool=v;return()=>{}}}},{input:editor,workflow,isActive:()=>true,compile:async ({boardPath,outputDirectory})=>{calls++;const r=await run('python3',[resolve('../autonomous-studio/compile_storyboard.py'),'--project-root',cwd,'--board',relative(cwd,boardPath),'--output',outputDirectory]);return JSON.parse(r.stdout)}});t.after(dispose)
 return {cwd,receipts,policy,story,saveStory,plan,savePlan,registerVisual,sidecar,saveSidecar,board,imagePath,workflow,input,editor,tool,calls:()=>calls,execute:(args:any={})=>tool.execute({boardPath:'execution.json',bindingPath:'binding.json',...args})}
}
test('opt-in v2 registers actual media then SDK/Python compiles with frozen sidecar and safe replay',async t=>{
 const s=await fixture(t),r=await s.execute();assert.equal(r.ok,true);assert.equal(r.compositionRelative,relative(s.cwd,r.composition));assert.equal(r.componentBinding.pixelEvidence,'unverified');assert.equal(r.qualityApproved,false);assert.equal(s.calls(),1)
 assert.equal(await readFile(r.boardPath,'utf8'),await readFile(join(s.cwd,'execution.json'),'utf8'))
 assert.equal(await readFile(r.bindingPath,'utf8'),await readFile(join(s.cwd,'binding.json'),'utf8'))
 assert.equal(JSON.parse(await readFile(join(r.composition,'board.json'),'utf8')).visualRequirements,undefined)
 const replay=await s.execute();assert.equal(replay.outputReused,true);assert.equal(replay.compositionRelative,r.compositionRelative);assert.equal(s.calls(),1);assert.deepEqual(replay.componentBinding,r.componentBinding)
 assert.equal(s.receipts.get('visual').visualBinding.pixelEvidence,'unverified')
 const brief=studioStageRows(s.editor.task,'B',1,'planner')[0].brief;assert.match(brief,/components-v2/);assert.match(brief,/visual-plan-v2/);const visualBrief=studioStageRows(s.editor.task,'B',1,'planner')[1].brief,soundBrief=studioStageRows(s.editor.task,'B',1,'planner')[2].brief;assert.match(visualBrief,/剩余图片项数和批次数/);assert.match(visualBrief,/真正导出裁切/);assert.match(soundBrief,/不把第N句机械套入第N场/);assert.match(soundBrief,/sourcePolicy/)
})
test('new stage rejects background-to-character false coverage and replay detects changed actual bytes',async t=>{
 const s=await fixture(t);s.plan.items[0].componentId='room';await s.savePlan()
 await assert.rejects(s.registerVisual(),/component-does-not-fulfill-required-kind-or-identity/)
 s.plan.items[0].componentId='hero';await s.savePlan();await s.registerVisual()
 await writeFile(join(s.cwd,s.imagePath),'changed actual image')
 await assert.rejects(verifyStageReceipt(s.editor,s.receipts.get('visual'),s.workflow),/stage-file-changed/)
 await assert.rejects(s.execute(),/stage-file-changed/);assert.equal(s.calls(),0)
})
test('v2 requires sidecar and rejects omissions, substitutions and stale plan before compiler dispatch',async t=>{
 const s=await fixture(t)
 await assert.rejects(s.tool.execute({boardPath:'execution.json'}),/components-binding-required/)
 s.sidecar.mappings.pop();await s.saveSidecar();await assert.rejects(s.execute(),/required-component-not-rendered/)
 assert.equal(s.calls(),0);assert.ok(!(await readdir(s.cwd)).includes('.studio-boards'))
})
test('execution source substitution and changed frozen sidecar cannot be reused',async t=>{
 const s=await fixture(t),result=await s.execute()
 await writeFile(result.bindingPath,'{}');await assert.rejects(s.execute(),/output-exists/);assert.equal(s.calls(),1)
 const other=await fixture(t);other.board.scenes[0].layers[0].src='voice.wav';const encoded=JSON.stringify(other.board);await writeFile(join(other.cwd,'execution.json'),encoded);other.sidecar.executionBoardSha256=sha(encoded);await other.saveSidecar()
 await assert.rejects(other.execute(),/execution-image-source-substituted/);assert.equal(other.calls(),0)
})
test('v2 storyboard validates typed requirements before visual production and old policy stays opt-in',async t=>{
 const s=await fixture(t);s.story.visualRequirements.items[0].characterId='not-locked';await s.saveStory()
 await assert.rejects(registerStageFiles(s.input('storyboard'),'stages/r1/storyboard/manifest.json',s.workflow,{prepare:()=>({get:()=>null})}),/character-not-in-host-lock/)
 s.story.visualRequirements.items[0].kind='background';delete (s.story.visualRequirements.items[0] as any).characterId;await s.saveStory()
 await assert.rejects(registerStageFiles(s.input('storyboard'),'stages/r1/storyboard/manifest.json',s.workflow,{prepare:()=>({get:()=>null})}),/studio-storyboard-character-required/)
 const legacy={...s.policy,visualCoverage:'requirements-v1'};assert.equal(validateStudioPolicy(legacy).visualCoverage,'requirements-v1')
 assert.throws(()=>validateStudioPolicy({...legacy,visualCoverage:'unknown'}),/visualCoverage/)
 s.editor.task.design.studio.visualCoverage='requirements-v1';await assert.rejects(s.execute(),/components-contract-required/);assert.equal(s.calls(),0)
})
