import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,copyFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {registerStageFiles,verifyStageReceipt} from '../src/studio-stage-files.ts'
import {validateStudioStages,studioStageCardId} from '../src/studio-stages.ts'
const run=promisify(execFile)
async function setup(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'stage-media-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const receipts=new Map<string,any>(),script={sha256:'a'.repeat(64),lines:[{id:'a',text:'你好'}]}
 const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:`video-${id}`,brief:'prepare'})))
 const input=(id:string)=>({task:{cwd,design:{studioStages:stages}},batch:{id:'B'},card:{id:studioStageCardId('B',1,id as any),agentId:`video-${id}`,role:'studio-stage',round:1},sessionId:id})
 const workflow={script:()=>script,stageReceipt:(_:any,id:string)=>receipts.get(id),recordStageReceipt:(_:any,r:any)=>receipts.set(r.stage,r)},db={prepare:()=>({get:()=>({status:'done',tenant:'B',assignee:'video-storyboard'})})}
 const manifest=async(id:string,files:string[])=>{const base=`stages/r1/${id}`,path=`${base}/manifest.json`;await mkdir(join(cwd,base),{recursive:true});await writeFile(join(cwd,path),JSON.stringify({stage:id,round:1,outputs:files.map(f=>`${base}/${f}`),summary:'media test'}));return path}
 const story=await manifest('storyboard',['board.json']);await writeFile(join(cwd,'stages/r1/storyboard/board.json'),JSON.stringify({scriptSha256:script.sha256,script:script.lines,scenes:[]}));await registerStageFiles(input('storyboard'),story,workflow,db)
 const soundPlan=async(extra:any={})=>writeFile(join(cwd,'stages/r1/sound/plan.json'),JSON.stringify({schema:'sound-plan-v1',scriptSha256:script.sha256,lines:[{id:'a',text:'你好',sourcePath:'stages/r1/sound/voice.wav',start:0,end:0.3}],bgm:[],sfx:[],...extra}))
 return {cwd,input,workflow,db,receipts,manifest,soundPlan,script}
}
test('JSON/HTML named audio and bad PNG fail before stage receipt; errors omit server response secrets',async t=>{
 const s=await setup(t)
 for(const [stage,name,body] of [['sound','download.wav','{"error":"unauthorized", "token":"do-not-leak"}'],['sound','download.wav','<!DOCTYPE html><html>Login</html>'],['visual','download.png','not a png']]){
  const path=await s.manifest(stage,[name]);await writeFile(join(s.cwd,`stages/r1/${stage}/${name}`),body)
  await assert.rejects(registerStageFiles(s.input(stage),path,s.workflow,s.db),(error:any)=>{assert.match(error.message,/studio-stage-media-invalid/);assert.match(error.message,/Check the corresponding manifest output/);assert.ok(!error.message.includes('do-not-leak'));assert.ok(!error.message.includes(s.cwd));return true})
  assert.equal(s.receipts.has(stage),false)
 }
})
test('real WAV and PNG metadata bind to host file receipts and recheck without ffprobe',async t=>{
 const s=await setup(t),audio=await s.manifest('sound',['voice.wav','plan.json']),image=await s.manifest('visual',['frame.png'])
 await s.soundPlan()
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','0.3','-y',join(s.cwd,'stages/r1/sound/voice.wav')])
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=32x48','-frames:v','1','-threads','1','-y',join(s.cwd,'stages/r1/visual/frame.png')])
 const ar=await registerStageFiles(s.input('sound'),audio,s.workflow,s.db),ir=await registerStageFiles(s.input('visual'),image,s.workflow,s.db)
 assert.equal(ar.outputs[0].media?.kind,'audio');assert.equal(ar.outputs[0].media?.sampleRate,16000);assert.ok(ar.outputs[0].media!.durationSeconds!>0)
 assert.deepEqual(ir.outputs[0].media,{kind:'image',codecName:'png',width:32,height:48,frames:1});assert.equal(ir.qualityApproved,false)
 const original=process.env.FFPROBE_PATH;try{process.env.FFPROBE_PATH='/nonexistent-probe';await verifyStageReceipt(s.input('sound'),ar,s.workflow);await verifyStageReceipt(s.input('visual'),ir,s.workflow);await assert.rejects(registerStageFiles(s.input('sound'),audio,s.workflow,s.db),/ffprobe_unavailable/);assert.deepEqual(s.receipts.get('sound'),ar)}finally{if(original===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=original}
 const legacy=structuredClone(ar);delete legacy.outputs[0].media;await assert.rejects(verifyStageReceipt(s.input('sound'),legacy,s.workflow),/media_probe_receipt_missing/)
 const old=structuredClone(ar);delete old.stageContractVersion;delete old.soundBinding;await verifyStageReceipt(s.input('sound'),old,s.workflow)
 const stripped=structuredClone(ar);delete stripped.soundBinding;await assert.rejects(verifyStageReceipt(s.input('sound'),stripped,s.workflow),/missing sound binding/)
 const changed=structuredClone(ar);changed.soundBinding.tracks[0].sha256='b'.repeat(64);await assert.rejects(verifyStageReceipt(s.input('sound'),changed,s.workflow),/Sound binding changed/)
 await writeFile(join(s.cwd,ar.outputs[0].path),'changed');await assert.rejects(verifyStageReceipt(s.input('sound'),ar,s.workflow),/file-changed/)
})
test('sound registration rejects the real missing music/effects pattern without replacing a valid receipt',async t=>{
 const s=await setup(t),path=await s.manifest('sound',['voice.wav','plan.json'])
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','0.3','-y',join(s.cwd,'stages/r1/sound/voice.wav')])
 await s.soundPlan();const previous=await registerStageFiles(s.input('sound'),path,s.workflow,s.db)
 for(const kind of ['bgm','sfx']){
  await s.soundPlan({[kind]:[{id:'missing',path:`assets/${kind}/absent.mp3`,start:0,end:1}]})
  await assert.rejects(registerStageFiles(s.input('sound'),path,s.workflow,s.db),/registered, host-probed audio/)
  assert.equal(s.receipts.get('sound'),previous)
 }
 await s.soundPlan({bgm:[{id:'music',sourcePath:'stages/r1/sound/voice.wav',path:'assets/music/future.wav',start:0,end:5}],sfx:[{id:'cue',path:'stages/r1/sound/voice.wav',start:2,end:3}]})
 const r=await registerStageFiles(s.input('sound'),path,s.workflow,s.db)
 assert.equal(r.stageContractVersion,2);assert.equal(r.soundBinding!.tracks.length,3);assert.equal(r.qualityApproved,false)
 s.script.sha256='b'.repeat(64);await assert.rejects(verifyStageReceipt(s.input('sound'),r,s.workflow),/Frozen script differs/)
})
test('new sound registration needs one plan and cannot alias one output twice',async t=>{
 const s=await setup(t),path=await s.manifest('sound',['voice.wav'])
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','0.3','-y',join(s.cwd,'stages/r1/sound/voice.wav')])
 await assert.rejects(registerStageFiles(s.input('sound'),path,s.workflow,s.db),/Exactly one registered/)
 await s.soundPlan();await copyFile(join(s.cwd,'stages/r1/sound/plan.json'),join(s.cwd,'stages/r1/sound/plan2.json'))
 await s.manifest('sound',['voice.wav','plan.json','plan2.json']);await assert.rejects(registerStageFiles(s.input('sound'),path,s.workflow,s.db),/Exactly one registered/)
 await s.manifest('sound',['voice.wav','./voice.wav','plan.json']);await assert.rejects(registerStageFiles(s.input('sound'),path,s.workflow,s.db),/studio-stage-output-invalid/)
 assert.equal(s.receipts.has('sound'),false)
})
test('every listed media file is probed and renamed video cannot masquerade as an image',async t=>{
 const s=await setup(t),manifest=await s.manifest('sound',['good.wav','bad.wav'])
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500','-t','0.2','-y',join(s.cwd,'stages/r1/sound/good.wav')]);await writeFile(join(s.cwd,'stages/r1/sound/bad.wav'),'{}')
 await assert.rejects(registerStageFiles(s.input('sound'),manifest,s.workflow,s.db),/outputIndex":1/);assert.equal(s.receipts.has('sound'),false)
 const visual=await s.manifest('visual',['bad.png']),movie=join(s.cwd,'movie.mp4');await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=32x32:r=10','-t','0.2','-y',movie]);await copyFile(movie,join(s.cwd,'stages/r1/visual/bad.png'))
 await assert.rejects(registerStageFiles(s.input('visual'),visual,s.workflow,s.db),/static_image_codec/);assert.equal(s.receipts.has('visual'),false)
})
