import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises'
import {join,dirname,isAbsolute} from 'node:path'
import {tmpdir} from 'node:os'
import {TaskConsoleService} from '../src/service.ts'
import {TaskRunner} from '../src/runner.ts'
import {EventStore} from '../src/tasks.ts'
import {StudioWorkflow} from '../src/studio-workflow.ts'
import {StudioOperations} from '../src/studio-operations.ts'
import {refreshStudioCapabilities} from '../src/studio-host.ts'
import {fileSha256} from '../src/studio-tools.ts'
import {DEFAULT_DIMENSIONS} from '../src/studio-evidence.mjs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const h=(v:string)=>v.repeat(64)
const PYTHON=process.env.STUDIO_TEST_PYTHON??'python3'

/** Test-only host receipts; files/hashes and subprocess are real, no media/provider calls. */
async function fixture(t:any){
 const root=await realpath(await mkdtemp(join(tmpdir(),'studio-completion-test-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const asset=join(root,'fixture-asset'),proofPath=join(root,'fixture-proof.json'),profilePath=join(root,'.studio-host/character.json')
 await writeFile(asset,'fixture asset');await writeFile(proofPath,'{"fixture":true}')
 await mkdir(dirname(profilePath),{recursive:true})
 await writeFile(profilePath,JSON.stringify({character_id:'c',profile_version:3,profile:{personality:['test-only']},voice_recommendation:null}))
 const sha256=await fileSha256(asset),profileSha=await fileSha256(profilePath)
 const runtimePaths=['assets/vendor/gsap.min.js','assets/Chinese.ttf','assets/licenses/GSAP-LICENSE.txt','assets/licenses/DROID-NOTICE.txt','assets/licenses/GSAP-STANDARD-LICENSE.html','assets/licenses/SOURCES.json','assets/licenses/runtime-assets-manifest.json']
 const files=[]
 for(const path of runtimePaths){const absolutePath=join(root,path);await mkdir(dirname(absolutePath),{recursive:true});await writeFile(absolutePath,'fixture');files.push({path,absolutePath,bytes:7,sha256:await fileSha256(absolutePath)})}
 const bundleManifestSha256=files[6].sha256,p={ok:true,path:asset,sha256,proofPath}
 const preflight={ok:true,capabilities:{
  execution_assets:{ok:true,schema:'studio-execution-assets-v1',proofPath,files,bundleManifestSha256},
  reference:p,frames:p,
  character:{...p,characterId:'c',imagePath:asset,imageSha256:sha256,profilePath,sha256:profileSha,profileVersion:3,profileAssetId:'profile'},
  hyperframes:{...p,hyperframes_verified:true,scope:'actual_hyperframes_smoke_render',timeline_verified:true,font_loaded_verified:true,runtimeAssetsManifestSha256:bundleManifestSha256},
 }}
 const script=join(root,'fixture-preflight.py')
 await writeFile(script,'import json\nprint(json.dumps(json.loads('+JSON.stringify(JSON.stringify(preflight))+')))\n')
 assert.deepEqual(JSON.parse((await promisify(execFile)(PYTHON,['-B',script])).stdout),preflight)
 const model='qwen3.8-omni-flash',calibrationPath=join(root,'calibration.json'),calibrationRegressionPath=join(root,'regression.json')
 const row=(sample:string,content_gate:string,code?:string)=>({sample,ok:true,audio_sha256:sha256,content_gate,issues:code?[{code}]:[],observation:{input_modality:'input_audio',finish_reason:'stop',audio_sha256:sha256,requested_model:model}})
 const calibration={schema:'studio-speech-calibration-v1',speech_calibration_pass:true,results:[row('clean','pass'),row('missing','blocked','no_audible_signal')]}
 const regression={results:[row('silence','blocked','speech_delete'),row('noise','blocked')]}
 await writeFile(calibrationPath,JSON.stringify(calibration));await writeFile(calibrationRegressionPath,JSON.stringify(regression))
 const configPath=join(root,'host-config.json')
 const config={...(isAbsolute(PYTHON)?{pythonExecutable:await realpath(PYTHON)}:{}),preflightScript:script,calibrationPath,calibrationRegressionPath,audioObserverModel:model,audioScript:script,vaultTokenFile:join(root,'unused-fixture-reference')}
 await writeFile(configPath,JSON.stringify(config))
 const loading:Promise<void>[]=[]
 t.mock.method(TaskRunner.prototype,'start',async function(this:TaskRunner){
  ;(this as any).store=new EventStore(join(root,'fixture-store'));loading.push(this.store.load())
  return new Promise<void>(()=>{}) // no runner boot, model session, dispatch or live store
 })
 const service=new TaskConsoleService(new Context(),{studioConfigPath:configPath})
 await Promise.all(loading);const store=service.runner.store,db=store.kernel.db
 t.after(()=>db.close())
 const task:any={id:root,cwd:root,design:{evidenceContract:'studio-video-v1',studio:{characterId:'c',referenceSha256:sha256,referenceUrl:'https://cdn.vyibc.com/fixture-reference.mp4'}}}
 const producer:any={task,batch:{id:'fixture-batch'},card:{id:'fixture-executor',role:'executor',round:1},sessionId:'producer'}
 const workflow=new StudioWorkflow(store)
 const operations=new StudioOperations(store);operations.configure(producer,{imageCalls:0,voiceSegments:0})
 await refreshStudioCapabilities(workflow,task,{configPath});const first=workflow.preflight(task);assert.equal(first.ok,true,first.reason)
 workflow.recordCandidate(producer,{sha256:h('a'),manifestSha256:h('c'),referenceSha256:sha256,revision:1,durationSeconds:100,width:1080,height:1920,fps:30})
 workflow.recordBudget(producer,{repairRounds:0})
 const complete=(input:any=producer)=>(service.runner as any).beforeComplete(input)
 const preflightRow=()=>db.prepare('SELECT payload FROM dsh_studio_preflight WHERE task_id=?').get(task.id)
 return {root,asset,profilePath,calibrationPath,calibrationRegressionPath,calibration,regression,configPath,workflow,producer,complete,preflightRow,db,config,operations}
}

function review(s:any,negative=false){
 const reviewer={...s.producer,card:{id:'fixture-reviewer',role:'reviewer',round:1},sessionId:'reviewer'}
 const receipts=['frames','audio','probe','source'].map(kind=>s.workflow.recordReceipt(reviewer,{candidateSha256:h('a'),kind,ranges:[[0,100]],sha256:h('d')}))
 s.workflow.recordValidatedReview(reviewer,{candidateSha256:h('a'),referenceSha256:s.producer.task.design.studio.referenceSha256,revision:1,
  checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:negative&&dimension==='motion'?'fail':'pass',finding:'Test-only observed fixture.',ranges:[[0,100]],evidenceReceiptIds:receipts.map((r:any)=>r.id)})),
  issues:negative?[{id:'fixture-motion',severity:'major',status:'open'}]:[]})
 return reviewer
}

test('actual refresh removes SQLite preflight and completion rebuilds it without approving the candidate',async t=>{
 const s=await fixture(t)
 assert.ok(s.preflightRow())
 await refreshStudioCapabilities(s.workflow,s.producer.task,{configPath:s.configPath})
 assert.equal(s.preflightRow(),undefined)
 assert.throws(()=>s.workflow.complete(s.producer),/studio-preflight-required/)
 const result=await s.complete()
 assert.equal(result.metadata.workflowOutcome,'candidate_handoff')
 assert.notEqual(result.metadata.qualityPassed,true)
 assert.match(result.summary,/quality is not approved/)
 assert.equal(JSON.parse(s.preflightRow().payload).ok,true)
 assert.equal(s.operations.snapshot(s.producer).operations.length,0)
 assert.equal((await s.complete()).metadata.workflowOutcome,'candidate_handoff')
 assert.equal(s.operations.snapshot(s.producer).operations.length,0)
})
test('completion rebuilds failed fresh evidence and rejects changed character/reference bytes',async t=>{
 const s=await fixture(t);await writeFile(s.asset,'tampered')
 await assert.rejects(s.complete(),/blocked_quality_capability.*character=failed/)
 const snapshot=JSON.parse(s.preflightRow().payload)
 assert.equal(snapshot.ok,false);assert.ok(snapshot.reason.includes('reference=failed'))
 assert.equal(s.operations.snapshot(s.producer).operations.length,0)
})
test('corrupted runtime asset remains a render failure rather than a missing-snapshot error',async t=>{
 const s=await fixture(t);await writeFile(join(s.root,'assets/Chinese.ttf'),'tampered')
 await assert.rejects(s.complete(),/blocked_quality_capability.*render=failed/)
 assert.equal(JSON.parse(s.preflightRow().payload).ok,false)
})
test('missing or differently calibrated host audio cannot be accepted after refresh',async t=>{
 const s=await fixture(t)
 const bad=structuredClone(s.regression);bad.results[0].observation.requested_model='qwen3-omni-flash'
 await writeFile(s.calibrationRegressionPath,JSON.stringify(bad))
 await assert.rejects(s.complete(),/blocked_quality_capability.*audio_calibration=unknown/)
 assert.equal(JSON.parse(s.preflightRow().payload).ok,false)
})
test('grounded independent rejection still hands back repair findings during host outage',async t=>{
 const s=await fixture(t),reviewer=review(s,true)
 await writeFile(s.configPath,'{invalid-host-config')
 const result=await s.complete(reviewer)
 assert.equal(result.metadata.workflowOutcome,'review_needs_changes')
 assert.equal(result.metadata.qualityPassed,false)
 await assert.rejects(s.complete(),/studio-host-config-unavailable/)
})
test('a positive review cannot use grounded-rejection outage exception',async t=>{
 const s=await fixture(t),reviewer=review(s)
 await writeFile(s.configPath,'{invalid-host-config')
 await assert.rejects(s.complete(reviewer),/studio-host-config-unavailable/)
})
test('unbound or stale reviewer cannot bypass actual completion gates',async t=>{
 const s=await fixture(t),reviewer=review(s,true)
 const invalid={...reviewer,sessionId:'other-reviewer'}
 assert.equal(s.workflow.hasRejection(invalid),false)
 await writeFile(s.asset,'tampered')
 await assert.rejects(s.complete(invalid),/blocked_quality_capability/)
 assert.equal(s.workflow.status(s.producer).candidate.sha256,h('a'))
})
test('fresh passing preflight does not waive producer identity or review integrity',async t=>{
 const s=await fixture(t)
 await assert.rejects(s.complete({...s.producer,sessionId:'another-producer'}),/producer-session-mismatch/)
 const reviewer=review(s)
 s.db.prepare("DELETE FROM dsh_studio_receipts WHERE json_extract(payload,'$.kind')='audio'").run()
 await assert.rejects(s.complete(reviewer),/review-integrity-failed/)
 assert.equal(JSON.parse(s.preflightRow().payload).ok,true)
})
