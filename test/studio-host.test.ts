import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,mkdir,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {refreshStudioCapabilities,observeStudioAudio,observeStudioVision,checkStudioSpeech} from '../src/studio-host.ts'
import {fileSha256} from '../src/studio-tools.ts'
async function setup(t:any){const cwd=await realpath(await mkdtemp(join(tmpdir(),'studio-host-test-')));t.after(()=>rm(cwd,{recursive:true,force:true}));const path=join(cwd,'asset'),proofPath=join(cwd,'proof.json');await writeFile(path,'asset');await writeFile(proofPath,'{}');await mkdir(join(cwd,'.studio-host'));const profilePath=join(cwd,'.studio-host/character.json');await writeFile(profilePath,JSON.stringify({character_id:'c',profile_version:3,profile:{personality:['真实'],scene_design_plan:['宿舍']},voice_recommendation:{voice_id:'approved-voice'}}));const profileSha=await fileSha256(profilePath);const sha256=await fileSha256(path),task={id:cwd,cwd,design:{studio:{referenceSha256:sha256,characterId:'c'}}},records:any[]=[],workflow:any={recordCapability:(_:any,v:any)=>records.push(v)};return {cwd,path,sha256,task,records,workflow,proofPath,profilePath,profileSha}}
test('actual dependency proofs map HyperFrames, freeze reference and character paths',async t=>{const s=await setup(t),p={ok:true,path:s.path,sha256:s.sha256,proofPath:s.proofPath};let calls=0;const runtime=await runtimeProof(s);const opts={config:{preflightScript:'fake'},execute:async()=>{calls++;return {capabilities:{...runtime,reference:p,frames:p,hyperframes:{...runtime.hyperframes,...p,hyperframes_verified:true,scope:'actual_hyperframes_smoke_render'},character:{...p,characterId:'c',imagePath:s.path,imageSha256:s.sha256,profilePath:s.profilePath,sha256:s.profileSha,profileVersion:3,profileAssetId:'profile'}}}}};const result=await refreshStudioCapabilities(s.workflow,s.task,opts);assert.equal(result.reference.sha256,s.sha256);assert.equal(result.characterReferences[0].id,'profile');assert.equal(result.characterProfile?.profileVersion,3);assert.equal(result.characterProfile?.sha256,s.profileSha);assert.equal(s.records.find(v=>v.name==='render').status,'passed');await refreshStudioCapabilities(s.workflow,s.task,opts);assert.equal(calls,1);await writeFile(s.path,'tampered');s.records.length=0;await refreshStudioCapabilities(s.workflow,s.task,opts);assert.equal(s.records.find(v=>v.name==='reference').status,'failed')})
test('FFmpeg-only smoke never satisfies HyperFrames render capability',async t=>{const s=await setup(t);await refreshStudioCapabilities(s.workflow,s.task,{config:{preflightScript:'fake'},execute:async()=>({capabilities:{render:{ok:true,path:s.path,sha256:s.sha256,proofPath:s.proofPath}}})});assert.equal(s.records.find(v=>v.name==='render').status,'failed')})
test('actual saved calibration grants bounded capability for its explicitly selected model, never performance approval',async t=>{
 const s=await setup(t),calibrationPath=process.env.STUDIO_TEST_CALIBRATION_PATH??resolve('../autonomous-studio/evidence/speech-calibration.json')
 const saved=JSON.parse(await readFile(calibrationPath,'utf8')),audioObserverModel=saved.results.find((v:any)=>v.sample==='clean')?.observation?.requested_model
 await refreshStudioCapabilities(s.workflow,s.task,{config:{calibrationPath,audioObserverModel,audioScript:'script',vaultTokenFile:'file'}})
 const r=s.records.find(v=>v.name==='audio_calibration');assert.equal(r.status,'passed');assert.match(r.reason,/performance_calibrated=false/);assert.match(r.reason,/retrospective/);assert.equal(s.records.find(v=>v.name==='audio').status,'passed')
})
test('all four audio calibration observations must match the active host model; absent or mixed identities fail closed',async t=>{
 const s=await setup(t),model='qwen3.8-omni-flash'
 const row=(sample:string,content_gate:string,code?:string)=>({sample,ok:true,audio_sha256:s.sha256,content_gate,issues:code?[{code}]:[],observation:{input_modality:'input_audio',finish_reason:'stop',audio_sha256:s.sha256,requested_model:model}})
 const calibration={schema:'studio-speech-calibration-v1',speech_calibration_pass:true,results:[row('clean','pass'),row('missing','blocked','no_audible_signal')]}
 const regression={results:[row('silence','blocked','speech_delete'),row('noise','blocked')]}
 const calibrationPath=join(s.cwd,'calibration.json'),calibrationRegressionPath=join(s.cwd,'regression.json')
 const config={calibrationPath,calibrationRegressionPath,audioObserverModel:model,audioScript:'script',vaultTokenFile:'file'}
 const check=async(c:any,r:any,selected:any=config)=>{await writeFile(calibrationPath,JSON.stringify(c));await writeFile(calibrationRegressionPath,JSON.stringify(r));s.records.length=0;await refreshStudioCapabilities(s.workflow,s.task,{config:selected});return s.records.find(v=>v.name==='audio_calibration').status}
 assert.equal(await check(calibration,regression),'passed')
 for(const sample of ['clean','missing','silence','noise'])for(const wrong of ['qwen3-omni-flash',undefined]){
  const c=structuredClone(calibration),r=structuredClone(regression),target=[...c.results,...r.results].find(v=>v.sample===sample)!
  if(wrong===undefined)delete (target.observation as any).requested_model;else target.observation.requested_model=wrong
  assert.equal(await check(c,r),'unknown',sample)
 }
 assert.equal(await check(calibration,regression,{...config,audioObserverModel:undefined}),'unknown','legacy host cannot claim another model calibration')
 assert.equal(s.records.find(v=>v.name==='audio').status,'unknown')
 const bad=structuredClone(calibration);bad.results[0].content_gate='blocked';assert.equal(await check(bad,regression),'unknown','model selection cannot lower clean gate')
})
test('audio host rejects wrong digest and accepts genuine complete observation',async t=>{const s=await setup(t),args={wavPath:s.path,start:0,end:1},config={audioScript:'audio',vaultTokenFile:'file'};await assert.rejects(observeStudioAudio(s.task,args,{config,execute:async()=>({ok:true,input_modality:'input_audio',finish_reason:'stop',audio_sha256:'wrong'})}),/invalid/);const r=await observeStudioAudio(s.task,args,{config,execute:async()=>({ok:true,input_modality:'input_audio',finish_reason:'stop',audio_sha256:s.sha256})});assert.equal(r.audio_sha256,s.sha256)})
test('speech host accepts blocked content as evidence, never treats it as execution failure',async t=>{const s=await setup(t),args={wavPath:s.path,start:0,end:1,expectedText:'你好',stage:'final' as const},config={speechScript:'speech',vaultTokenFile:'file'};const result=await checkStudioSpeech(s.task,args,{config,execute:async()=>({ok:true,audio_sha256:s.sha256,expected_text_sha256:createHash('sha256').update('你好').digest('hex'),content_gate:'blocked'})});assert.equal(result.content_gate,'blocked')})
test('audio failure reports safe stage and HTTP code without secrets or provider body',async t=>{const s=await setup(t),args={wavPath:s.path,start:0,end:1},config={audioScript:'audio',vaultTokenFile:'file'};await assert.rejects(observeStudioAudio(s.task,args,{config,execute:async()=>({ok:false,error_stage:'vault',error_type:'HTTPError',http_status:403,body:'secret'})}),{message:'studio-audio-failed:vault:HTTPError-http-403'});await assert.rejects(observeStudioAudio(s.task,args,{config,execute:async()=>({ok:false,error_stage:'secret',error_type:'secret',http_status:'token'})}),{message:'studio-audio-failed:unknown:Error'})})

test('vision host binds observations to exact ordered hashes and rejects provider failure',async t=>{const s=await setup(t),args={images:[{path:s.path,sha256:s.sha256,time:1}],purpose:'preview' as const},config={visionScript:'vision',vaultTokenFile:'file'};const valid={ok:true,input_modality:'input_image',finish_reason:'stop',images:[{sha256:s.sha256,time:1}],observation:'visible'};assert.equal((await observeStudioVision(s.task,args,{config,execute:async()=>valid})).observation,'visible');for(const bad of [{...valid,images:[{sha256:s.sha256,time:2}]},{...valid,input_modality:'text'},{...valid,finish_reason:'length'},{ok:false,error_type:'HTTPError',http_status:400,error_stage:'provider'}])await assert.rejects(observeStudioVision(s.task,args,{config,execute:async()=>bad}));await writeFile(s.path,'changed');await assert.rejects(observeStudioVision(s.task,args,{config,execute:async()=>valid}),/invalid/)})


test('parallel stage refresh shares one host probe without caching a failed outcome',async t=>{
 const s=await setup(t);let calls=0,release!:()=>void,started!:()=>void
 const barrier=new Promise<void>(resolve=>{release=resolve})
 const executing=new Promise<void>(resolve=>{started=resolve})
 const opts={config:{preflightScript:'parallel'},execute:async()=>{calls++;started();await barrier;return {ok:false,capabilities:{}}}}
 const pending=[refreshStudioCapabilities(s.workflow,s.task,opts),refreshStudioCapabilities(s.workflow,s.task,opts)]
 await executing;assert.equal(calls,1);release();await Promise.all(pending)
 await refreshStudioCapabilities(s.workflow,s.task,opts);assert.equal(calls,2)
})
test('host configuration changes invalidate probe reuse and a thrown probe can be retried',async t=>{
 const s=await setup(t);let calls=0
 const p={ok:true,path:s.path,sha256:s.sha256,proofPath:s.proofPath},runtime=await runtimeProof(s)
 const execute=async()=>{calls++;if(calls===1)throw Error('temporary');return {ok:true,capabilities:{...runtime,reference:p,frames:p,hyperframes:{...runtime.hyperframes,...p,hyperframes_verified:true,scope:'actual_hyperframes_smoke_render'},character:{...p,characterId:'c',imagePath:s.path,imageSha256:s.sha256,profilePath:s.profilePath,sha256:s.profileSha,profileVersion:3}}}}
 const config={preflightScript:'changing',renderRuntime:'/runtime-a'}
 await refreshStudioCapabilities(s.workflow,s.task,{config,execute});await refreshStudioCapabilities(s.workflow,s.task,{config,execute});assert.equal(calls,2)
 await refreshStudioCapabilities(s.workflow,s.task,{config,execute});assert.equal(calls,2)
 await refreshStudioCapabilities(s.workflow,s.task,{config:{...config,renderRuntime:'/runtime-b'},execute});assert.equal(calls,3)
})

test('real host subprocess gets task scope and opt-in cache only from host config',async t=>{
 const s=await setup(t),script=join(s.cwd,'scope.py')
 await writeFile(script,`import os,json\nprint(json.dumps({'ok':True,'input_modality':'input_audio','finish_reason':'stop','audio_sha256':'${s.sha256}','scope':{k:os.environ.get(k) for k in ['STUDIO_TASK_ID','STUDIO_OBSERVATION_CACHE_ROOT','STUDIO_OBSERVATION_CACHE_EPOCH']}}))\n`)
 const config={audioScript:script,vaultTokenFile:'fixture',observationCacheRoot:join(s.cwd,'cache'),observationCacheEpoch:'v2'}
 const args={wavPath:s.path,start:0,end:1}
 const result=await observeStudioAudio({...s.task,observationCacheRoot:'/model-controlled'},args,{config})
 assert.deepEqual(result.scope,{STUDIO_TASK_ID:s.task.id,STUDIO_OBSERVATION_CACHE_ROOT:config.observationCacheRoot,STUDIO_OBSERVATION_CACHE_EPOCH:'v2'})
 const disabled=await observeStudioAudio(s.task,args,{config:{audioScript:script,vaultTokenFile:'fixture'}})
 assert.equal(disabled.scope.STUDIO_OBSERVATION_CACHE_ROOT,'')
})

test('observer error exposes bounded stream completion diagnostics and correction guidance',async t=>{
 const s=await setup(t),args={images:[{path:s.path,sha256:s.sha256,time:1}],purpose:'preview' as const},config={visionScript:'vision',vaultTokenFile:'file'}
 await assert.rejects(observeStudioVision(s.task,args,{config,execute:async()=>({ok:false,error_type:'VisionError',error_stage:'provider',error_code:'finish_reason_not_stop',diagnostics:{done:true,finish_reason:'length',received_chars:100,received_bytes:500,body:'private-secret'},body:'private-secret'})}),(e:any)=>{
  assert.match(e.message,/studio-vision-failed:provider:VisionError/)
  const detail=JSON.parse(e.message.slice(e.message.indexOf('; ')+2));assert.equal(detail.code,'finish_reason_not_stop');assert.equal(detail.finishReason,'length');assert.equal(detail.receivedChars,100);assert.match(detail.nextAction,/truncated.*Do not use partial evidence/);assert.ok(!e.message.includes('private-secret'));return true
 })
})
test('observer network diagnostic preserves DNS and TLS classes but drops arbitrary data',async t=>{
 const s=await setup(t),args={wavPath:s.path,start:0,end:1},config={audioScript:'audio',vaultTokenFile:'file'}
 for(const reason of ['gaierror','SSLCertVerificationError'])await assert.rejects(observeStudioAudio(s.task,args,{config,execute:async()=>({ok:false,error_stage:'provider',error_type:'URLError',reason_type:reason,reason_errno:-3,error_code:'secret-url',diagnostics:{done:'secret',finish_reason:'secret',received_bytes:-1},body:'secret'})}),(e:any)=>{
  const detail=JSON.parse(e.message.slice(e.message.indexOf('; ')+2));assert.equal(detail.reasonType,reason);assert.equal(detail.errno,-3);assert.equal(detail.receivedBytes,undefined);assert.ok(!e.message.includes('secret'))
  assert.match(detail.nextAction,reason==='gaierror'?/at most once/:/never disable certificate verification/);return true
 })
})

test('character preflight propagates exact safe source and fails changed source identity',async t=>{
 const s=await setup(t),sourceUrl='https://cdn.vyibc.com/existing/reference.png'
 const p={ok:true,path:s.path,proofPath:s.proofPath,characterId:'c',imagePath:s.path,imageSha256:s.sha256,profilePath:s.profilePath,sha256:s.profileSha,profileVersion:3,profileAssetId:'profile',sourceUrl,sourceSha256:s.sha256}
 const result=await refreshStudioCapabilities(s.workflow,s.task,{config:{preflightScript:'source-fixture'},execute:async()=>({capabilities:{character:p}})})
 assert.equal(result.characterReferences[0].sourceUrl,sourceUrl);assert.equal(result.characterReferences[0].sourceSha256,s.sha256);assert.equal(result.characterReferences[0].assetId,'profile')
 const bad=await refreshStudioCapabilities(s.workflow,s.task,{config:{preflightScript:'bad-source-fixture'},execute:async()=>({capabilities:{character:{...p,sourceUrl:sourceUrl+'?token=SECRET'}}})})
 assert.deepEqual(bad.characterReferences,[]);assert.ok(!JSON.stringify(bad.characterReferences).includes('SECRET'))
})

async function runtimeProof(s:any){
 const paths=['assets/vendor/gsap.min.js','assets/Chinese.ttf','assets/licenses/GSAP-LICENSE.txt','assets/licenses/DROID-NOTICE.txt','assets/licenses/GSAP-STANDARD-LICENSE.html','assets/licenses/SOURCES.json','assets/licenses/runtime-assets-manifest.json'],files=[]
 for(const path of paths){const absolutePath=join(s.cwd,path);await mkdir(join(absolutePath,'..'),{recursive:true});await writeFile(absolutePath,'fixture');files.push({path,absolutePath,bytes:7,sha256:await fileSha256(absolutePath)})}
 const bundleManifestSha256=files[6].sha256
 return {execution_assets:{ok:true,schema:'studio-execution-assets-v1',proofPath:s.proofPath,files,bundleManifestSha256},hyperframes:{timeline_verified:true,font_loaded_verified:true,runtimeAssetsManifestSha256:bundleManifestSha256}}
}
test('static smoke or changed font cannot grant render capability or cached reuse',async t=>{
 const s=await setup(t),runtime=await runtimeProof(s),p={ok:true,path:s.path,sha256:s.sha256,proofPath:s.proofPath,hyperframes_verified:true,scope:'actual_hyperframes_smoke_render'}
 const opts={config:{preflightScript:'asset-negative'},execute:async()=>({capabilities:{...runtime,hyperframes:{...runtime.hyperframes,...p}}})}
 await refreshStudioCapabilities(s.workflow,s.task,opts);assert.equal(s.records.find(v=>v.name==='render').status,'passed')
 await writeFile(join(s.cwd,'assets/Chinese.ttf'),'changed');s.records.length=0
 await refreshStudioCapabilities(s.workflow,s.task,opts);assert.equal(s.records.find(v=>v.name==='render').status,'failed')
 s.records.length=0;await refreshStudioCapabilities(s.workflow,s.task,{...opts,execute:async()=>({capabilities:{hyperframes:p}})});assert.equal(s.records.find(v=>v.name==='render').status,'failed')
})
