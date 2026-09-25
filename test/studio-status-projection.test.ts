import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {projectStudioStatus} from '../src/studio-status-projection.ts'
import {registerStudioTools} from '../src/studio-tools.ts'
const sha='a'.repeat(64)
function fixture(){
 const media={kind:'audio',codecName:'pcm_s16le',durationSeconds:1.75,sampleRate:24000,channels:1,signalEvidence:{schema:'decoded-audio-signal-v1',sha256:sha,allSilent:false,decodedSamples:42000,qualityApproved:false},futureVoiceId:'voice-lock-kept'}
 const sound={stage:'sound',round:1,sessionId:'original-sound',cardId:'sound-card',configSha256:sha,manifest:{path:'stages/r1/sound/manifest.json',sha256:sha},outputs:[{path:'stages/r1/sound/source.wav',sha256:sha,bytes:1234,assetId:'source-asset',media}],summary:'complete original prose',qualityApproved:false,soundBinding:{schema:'studio-sound-binding-v1',scriptSha256:sha,plan:{path:'stages/r1/sound/plan.json',sha256:sha},tracks:[{role:'lines',index:0,id:'line1',path:'stages/r1/sound/source.wav',sha256:sha,media,start:5,end:6.75,text:'完整台词，不可以省略。',voiceId:'authorized-voice'}],audioRequirements:{status:'verified',requiredIds:{bgm:['bgm-01'],sfx:['door']},matches:[{kind:'bgm',requirementId:'bgm-01',cueIndexes:[0]}]}}}
 const visual={stage:'visual',round:1,outputs:[{path:'stages/r1/visual/frame.png',sha256:sha,bytes:600,media:{kind:'image',codecName:'png',width:1080,height:1920,frames:1}}],summary:'visual prose',visualBinding:{storyboardSha256:sha,requirements:[{id:'req1',sceneId:'scene1',kind:'character',componentKey:'face',characterId:'existing',purpose:'full purpose'}],components:[{id:'component1',kind:'character',characterId:'existing',componentKey:'face',path:'stages/r1/visual/frame.png',sha256:sha}],items:[{requirementId:'req1',componentId:'component1',usage:'full usage'}]}}
 const preflight={ok:false,checks:[{name:'audio',status:'unknown'}]},allowance={imageItems:{limit:6,used:5,remaining:1},imageSubmissions:{limit:2,used:2,remaining:0},canSubmitImages:false},interventions=[{id:'assist1',kind:'operator-assistance',reason:'Exact recovery reason',sourceRunId:'old-run',occurredAt:'2026-09-25'}]
 return {preflight,generationAllowance:allowance,reference:{sha256:sha},characterReferences:[{id:'primary-asset',assetId:'primary-asset',sha256:sha}],characterProfile:{frozen:true,sha256:sha,read:{tool:'studio_character_profile',arguments:{}}},voiceLock:{voiceId:'voice-id',sha256:sha},state:{preflight,generationAllowance:allowance,interventions,autonomy:{status:'assisted',autonomousVerified:false,interventionIds:['assist1'],records:interventions},stages:[{id:'storyboard',receipt:{stage:'storyboard',outputs:[],scriptBinding:{scriptSha256:sha,boards:['stages/r1/storyboard/board.json']}}},{id:'visual',receipt:visual},{id:'sound',receipt:sound}],mediaOperations:{providerPolled:false,operations:[{jobId:'image-job',state:'completed',nextCalls:[{tool:'vyibc-image_get_task',arguments:{taskId:'image-job'}}]},{jobId:'voice-job',state:'unknown',nextCalls:[{tool:'vyibc-voice_status',arguments:{job_id:'voice-job'}}]}]},renderJobs:[{jobId:'render-job',state:'running'}],script:{sha256:sha,lines:[{id:'line1',text:'完整台词，不可以省略。'}]},candidate:{sha256:sha,revision:2},reviewProgress:{receiptIndex:[{id:'qa1',kind:'frames',ranges:[[0,3]]}]},review:{issues:[{id:'issue1',severity:'major',text:'unresolved'}]},speechPlan:{voiceId:'voice-id',lines:[{lineId:'line1',start:5,end:6.75}]},speechChecks:[{id:'speech-check',sha256:sha}],referenceReceipts:[{id:'reference-receipt',sha256:sha}],skillLoads:[{name:'studio-music',sessionId:'prior',sha256:sha}],futureRecovery:{originalOperation:'keep-me'}}}
}
test('compact status removes only equal duplicates and retains complete frozen speech, locks, global jobs and assisted facts',()=>{
 const source=fixture(),before=structuredClone(source),compact=projectStudioStatus(source,{role:'studio-stage',stageId:'visual'})
 assert.deepEqual(source,before);assert.equal(compact.state.preflight,undefined);assert.equal(compact.state.generationAllowance,undefined);assert.equal(compact.state.autonomy.records,undefined)
 assert.deepEqual(compact.preflight,source.preflight);assert.deepEqual(compact.generationAllowance,source.generationAllowance);assert.deepEqual(compact.state.interventions,source.state.interventions);assert.equal(compact.state.autonomy.status,'assisted');assert.equal(compact.state.autonomy.autonomousVerified,false)
 for(const key of ['script','mediaOperations','renderJobs','candidate','reviewProgress','review','speechPlan','speechChecks','referenceReceipts','skillLoads','futureRecovery'])assert.deepEqual(compact.state[key],(source.state as any)[key])
 for(const key of ['characterProfile','characterReferences','voiceLock','reference'])assert.deepEqual(compact[key],(source as any)[key])
 assert.deepEqual(compact.statusProjection.fullRead,{tool:'studio_status',arguments:{view:'full'}})
})
test('other-stage index keeps every file/ID/SHA and timing; original stage and editor/reviewer retain complete receipts',()=>{
 const source=fixture(),compact=projectStudioStatus(source,{role:'studio-stage',stageId:'visual'})
 const sound:any=compact.state.stages[2].receipt,original:any=source.state.stages[2].receipt
 assert.equal(sound.soundBinding.tracks[0].media,undefined);assert.equal(sound.soundBinding.tracks[0].start,5);assert.equal(sound.soundBinding.tracks[0].end,6.75);assert.equal(sound.soundBinding.tracks[0].text,'完整台词，不可以省略。')
 assert.equal(sound.soundBinding.tracks[0].voiceId,'authorized-voice');assert.deepEqual(sound.soundBinding.audioRequirements,original.soundBinding.audioRequirements)
 assert.deepEqual(sound.outputs.map((o:any)=>[o.path,o.sha256,o.assetId]),original.outputs.map((o:any)=>[o.path,o.sha256,o.assetId]));assert.equal(sound.outputs[0].media.durationSeconds,1.75);assert.equal(sound.outputs[0].media.futureVoiceId,'voice-lock-kept');assert.equal(sound.outputs[0].media.signalEvidence.sha256,sha);assert.equal(sound.outputs[0].media.signalEvidence.allSilent,false)
 assert.deepEqual(compact.state.stages[1],source.state.stages[1])
 for(const audience of [{role:'executor'},{role:'reviewer'},{role:'planner'},{role:'studio-stage',stageId:'unknown'},{}])assert.deepEqual(projectStudioStatus(source,audience).state.stages,source.state.stages)
 const soundView=projectStudioStatus(source,{role:'studio-stage',stageId:'sound'}),visual=soundView.state.stages[1].receipt.visualBinding
 assert.equal(visual.requirements[0].purpose,undefined);assert.equal(visual.requirements[0].characterId,'existing');assert.deepEqual(visual.components,(source.state.stages[1].receipt as any).visualBinding.components);assert.deepEqual(visual.items,[{requirementId:'req1',componentId:'component1'}])
})
test('full view returns original data without mutation; conflicting snapshots or track probes are never silently merged',()=>{
 const source=fixture(),full=projectStudioStatus(source,{role:'studio-stage',stageId:'visual'},'full');assert.deepEqual(full,source);assert.equal(full.statusProjection,undefined)
 full.state.script.lines[0].text='changed';assert.notEqual(source.state.script.lines[0].text,'changed')
 source.state.preflight={ok:true,checks:[]};source.state.autonomy.records=[{...source.state.interventions[0],reason:'different'}]
 ;(source.state.stages[2].receipt as any).soundBinding.tracks[0].media={kind:'audio',sha256:'different'}
 const compact=projectStudioStatus(source,{role:'studio-stage',stageId:'visual'})
 assert.deepEqual(compact.state.preflight,source.state.preflight);assert.deepEqual(compact.state.autonomy.records,source.state.autonomy.records);assert.deepEqual(compact.state.stages[2].receipt.soundBinding.tracks[0].media,{kind:'audio',sha256:'different'})
 assert.throws(()=>projectStudioStatus(source,{},'invalid' as any),/view-invalid/)
})
test('long strings and arrays of source IDs are never silently shortened',()=>{
 const source=fixture(),ids=Array.from({length:500},(_,i)=>({jobId:'job-'+i,state:'completed',nextCalls:[{tool:'vyibc-image_get_task',arguments:{taskId:'job-'+i}}]}))
 source.state.mediaOperations.operations=ids as any;source.state.script.lines[0].text='全文'.repeat(10000)
 const compact=projectStudioStatus(source,{role:'studio-stage',stageId:'visual'})
 assert.deepEqual(compact.state.mediaOperations.operations,ids);assert.equal(compact.state.script.lines[0].text,source.state.script.lines[0].text)
})
test('actual native SDK exposes compact default/full opt-in and validates view while preserving session gates',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'status-projection-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const require=createRequire(import.meta.url),{Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx:any=new Context();ctx.provide('systemPrompt',{tools:()=>{}});const runtime=new ToolRuntime(ctx),register=runtime.register.bind(runtime)
 runtime.register=(spec:any)=>register(process.env.NODE_ENV==='test'&&spec.parameters?.type!=='object'?defineTool(spec):spec)
 const source=fixture();source.state.candidate=null as any;const before=structuredClone(source.state);let active=true,reads=0
 const input={task:{cwd,design:{studioStages:[{id:'visual',agentId:'visual-agent'}]}},batch:{id:'B'},card:{role:'studio-stage',id:'B#s1-visual',round:1,agentId:'visual-agent'},sessionId:'s'}
 const stop=await registerStudioTools(ctx,{input,isActive:()=>active,workflow:{preflight:()=>({ok:true}),status:()=>{reads++;return source.state}}});t.after(stop)
 const call=(args:any,sid='s')=>runtime.execute({name:'studio_status',arguments:args,agent:{ctx,session:{id:sid}},callId:'status-view',signal:new AbortController().signal} as any)
 const compact:any=await call({});assert.equal(compact.isError,false);assert.equal(compact.value.statusProjection.view,'compact');assert.equal(compact.value.state.stages[2].receipt.soundBinding.tracks[0].media,undefined)
 const full:any=await call({view:'full'});assert.equal(full.isError,false);assert.equal(full.value.statusProjection,undefined);assert.deepEqual(full.value.state.stages,source.state.stages);assert.deepEqual(full.value.preflight,full.value.state.preflight);assert.deepEqual(source.state,before)
 const readsBefore=reads,invalid:any=await call({view:'typo'});assert.equal(invalid.isError,true);assert.equal(reads,readsBefore)
 const wrong:any=await call({view:'full'},'other');assert.equal(wrong.isError,true);active=false;assert.equal((await call({view:'full'}) as any).isError,true)
})
