import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {registerStudioSpeechTools,STUDIO_SPEECH_TOOL_NAMES} from '../src/studio-speech-tools.ts'
import {fileSha256} from '../src/studio-tools.ts'

// Real PCM WAV, independent of ffmpeg and provider services.
function wav(seconds:number){const size=16000*2*seconds,b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);return b}
async function setup(t:any,options:any={}){
 const cwd=await mkdtemp(join(tmpdir(),'studio-source-probe-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await writeFile(join(cwd,'one.wav'),wav(1));await writeFile(join(cwd,'two.wav'),wav(2))
 let active=true,calls=0;const records:any[]=[],tools:any={}
 const input={task:{cwd,design:{studio:{durationMax:options.durationMax??25,generationLimits:{voiceSegments:options.voiceSegments??0}}}},card:{role:options.role??'planner'},sessionId:'session'}
 const runCommand=options.real?undefined:async(file:string,args:string[])=>{calls++;assert.equal(file,process.env.FFPROBE_PATH??'ffprobe');assert.deepEqual(args.slice(0,-1),['-v','error','-show_streams','-show_format','-of','json']);await options.duringProbe?.({cwd,stop:()=>active=false,calls});return {stdout:JSON.stringify(options.probe??{format:{duration:options.duration??'1'},streams:[{codec_type:'audio'}]})}}
 await registerStudioSpeechTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input,workflow:{recordScript:(_:any,v:any)=>{if(options.rejectRecord)throw Error('existing-script-policy');records.push(v)}},isActive:()=>active,speechCheck:async()=>assert.fail('no speech provider call'),...(runCommand?{runCommand}:{})})
 return {cwd,tools,records,stop:()=>active=false,calls:()=>calls}
}
const sources=[{id:'a',path:'one.wav'},{id:'b',path:'two.wav'}],lines=[{id:'a',text:'一句'},{id:'b',text:'两句'}]

test('real WAV ffprobe reports hashes, durations and technical fit without recording',async t=>{
 const s=await setup(t,{real:true,durationMax:3});const out=await s.tools.studio_probe_audio_sources.execute({sources})
 assert.deepEqual(out.sources.map((x:any)=>x.durationSeconds),[1,2]);assert.equal(out.totalDurationSeconds,3);assert.equal(out.durationMax,3);assert.equal(out.fits,true);assert.equal(out.qualityApproved,false);assert.equal(out.sources[0].sha256,await fileSha256(join(s.cwd,'one.wav')));assert.equal(s.records.length,0)
 assert.ok(STUDIO_SPEECH_TOOL_NAMES.includes('studio_probe_audio_sources'))
 await s.tools.studio_freeze_script.execute({sources,lines});assert.equal(s.records.length,1)
})
test('actual 34.686667-second sources cannot freeze into a 25-second task',async t=>{
 const s=await setup(t,{duration:'34.686667'}),one=[sources[0]]
 const out=await s.tools.studio_probe_audio_sources.execute({sources:one});assert.equal(out.totalDurationSeconds,34.686667);assert.equal(out.fits,false)
 await assert.rejects(s.tools.studio_freeze_script.execute({lines:[lines[0]],sources:one}),/duration-exceeds-max/);assert.equal(s.records.length,0)
})
test('zero voice budget requires sources; legacy synthesis remains compatible and policy still owns rewriting',async t=>{
 const required=await setup(t);await assert.rejects(required.tools.studio_freeze_script.execute({lines}),/sources-required/);assert.equal(required.records.length,0);assert.equal(required.calls(),0)
 const legacy=await setup(t,{voiceSegments:80});const result=await legacy.tools.studio_freeze_script.execute({lines});assert.deepEqual(result.lines,lines);assert.equal(legacy.records.length,1);assert.equal(legacy.calls(),0)
 const policy=await setup(t,{rejectRecord:true});await assert.rejects(policy.tools.studio_freeze_script.execute({lines,sources}),/existing-script-policy/);assert.equal(policy.records.length,0)
})
test('sources must match line ids and order before probing; bounds and duplicate ids reject',async t=>{
 const s=await setup(t)
 for(const bad of [[sources[1],sources[0]],[sources[0]],[{...sources[0],id:'wrong'},sources[1]]])await assert.rejects(s.tools.studio_freeze_script.execute({lines,sources:bad}),/sources-mismatch/)
 for(const bad of [[],[sources[0],sources[0]],Array.from({length:81},(_,i)=>({id:String(i),path:'one.wav'})),[{id:'a',path:''}]])await assert.rejects(s.tools.studio_probe_audio_sources.execute({sources:bad}),/sources-invalid/)
 assert.equal(s.calls(),0);assert.equal(s.records.length,0)
})
test('only studio roles can inspect, and only planner can freeze',async t=>{
 for(const role of ['planner','executor','reviewer']){const s=await setup(t,{role});assert.equal((await s.tools.studio_probe_audio_sources.execute({sources})).fits,true);if(role!=='planner')await assert.rejects(s.tools.studio_freeze_script.execute({sources,lines}),/role-denied/)}
 const s=await setup(t,{role:'notifier'});await assert.rejects(s.tools.studio_probe_audio_sources.execute({sources}),/role-denied/)
})
test('absolute and symlink escape never reach ffprobe',async t=>{
 const s=await setup(t);await symlink('/etc/hosts',join(s.cwd,'escape.wav'))
 for(const path of ['/etc/hosts','escape.wav','../outside.wav'])await assert.rejects(s.tools.studio_probe_audio_sources.execute({sources:[{id:'a',path}]}),/outside-project|ENOENT/)
 assert.equal(s.calls(),0);assert.equal(s.records.length,0)
})
test('stale session before or during probe prevents script recording',async t=>{
 const stopped=await setup(t);stopped.stop();await assert.rejects(stopped.tools.studio_probe_audio_sources.execute({sources}),/stale/);assert.equal(stopped.calls(),0)
 const mismatch=await setup(t);await assert.rejects(mismatch.tools.studio_probe_audio_sources.execute({sources},{agent:{session:{id:'other'}}}),/session-mismatch/)
 const during=await setup(t,{duringProbe:({stop}:any)=>stop()});await assert.rejects(during.tools.studio_freeze_script.execute({sources,lines}),/stale/);assert.equal(during.records.length,0)
})
test('audio mutation during its probe or a later probe is rejected without recording',async t=>{
 for(const trigger of [1,2]){const s=await setup(t,{duringProbe:async({cwd,calls}:any)=>{if(calls===trigger)await writeFile(join(cwd,'one.wav'),'mutated')}});await assert.rejects(s.tools.studio_freeze_script.execute({sources,lines}),/source-file-changed/);assert.equal(s.records.length,0)}
})
test('missing audio stream and invalid duration cannot create a script',async t=>{
 for(const probe of [{format:{duration:'1'},streams:[]},{format:{duration:'NaN'},streams:[{codec_type:'audio'}]},{format:{duration:'0'},streams:[{codec_type:'audio'}]}]){const s=await setup(t,{probe});await assert.rejects(s.tools.studio_freeze_script.execute({sources,lines}),/source-audio-invalid/);assert.equal(s.records.length,0)}
})
