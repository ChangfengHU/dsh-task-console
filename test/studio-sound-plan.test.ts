import test from 'node:test'
import assert from 'node:assert/strict'
import {bindSoundPlan} from '../src/studio-sound-plan.ts'
const hash='a'.repeat(64),source='stages/r2/sound/a.wav'
const script={sha256:hash,lines:[{id:'a',text:'你好'}]}
const output={path:source,sha256:hash,media:{kind:'audio',durationSeconds:0.3,sampleRate:16000,channels:1,codecName:'pcm_s16le'}}
const planFile={path:'stages/r2/sound/plan.json',sha256:hash}
const plan=()=>({schema:'sound-plan-v1',scriptSha256:hash,lines:[{id:'a',text:'你好',sourcePath:source,sourceSha256:hash,sourceDurationSeconds:0.3,start:0,end:0.3}],bgm:[],sfx:[]})
const bind=(p:any,outputs:any[]=[output])=>bindSoundPlan(p,script,outputs,planFile)
test('all track roles bind host metadata; repeated sources and cues are valid',()=>{
 const p:any=plan();p.bgm=[{id:'music',path:source,start:0,end:0.3}];p.sfx=[{id:'hit',path:'./'+source,start:0,end:1},{id:'hit',path:source,start:3,end:4}]
 const r=bind(p);assert.equal(r.tracks.length,4);assert.equal(r.qualityApproved,false);assert.deepEqual(r.tracks.map(t=>t.path),Array(4).fill(source));assert.equal(r.tracks[0].media,output.media)
})
test('rejects unregistered, external, traversal and cross-round sources without reflecting their contents',()=>{
 for(const sourcePath of ['../secret','https://secret.example/token','/tmp/secret','stages/r1/sound/a.wav','stages/r2/sound/absent.wav','stages\\r2\\sound\\a.wav']){
  const p=plan();p.lines[0].sourcePath=sourcePath
  assert.throws(()=>bind(p),(e:any)=>{assert.match(e.message,/studio-sound-plan-invalid/);assert.ok(!e.message.includes(sourcePath));return true})
 }
 assert.throws(()=>bind(plan(),[{...output,media:{kind:'image'}}]),/host-probed audio/)
})
test('rejects stale script, altered dialogue, malformed cues, false source claims and missing arrays',()=>{
 const cases:[string,(p:any)=>void][]=[
  ['Frozen script',p=>p.scriptSha256='b'.repeat(64)],['Frozen line',p=>p.lines=[]],['Frozen line',p=>p.lines[0].text='改写'],
  ['Explicit array',p=>delete p.bgm],['finite',p=>p.lines[0].end=Infinity],['finite',p=>p.lines[0].start=-1],['finite',p=>p.lines[0].end=0],
  ['source hash',p=>p.lines[0].sourceSha256='b'.repeat(64)],['duration',p=>p.lines[0].sourceDurationSeconds=3],['duration',p=>p.lines[0].sourceDurationSeconds='0.3'],
  ['cue id',p=>p.sfx=[{path:source,start:0,end:1}]],['schema',p=>p.schema='sound-plan-v9']]
 for(const [error,change] of cases){const p=plan();change(p);assert.throws(()=>bind(p),new RegExp(error))}
 const p=plan();p.lines[0].sourceDurationSeconds=0.32;assert.equal(bind(p).tracks.length,1)
})

test('complete speech accepts 8.605 and 10 seconds but refuses longer source or span',()=>{
 for(const duration of [8.605,10]){const p=plan();p.lines[0].end=duration;p.lines[0].sourceDurationSeconds=duration;assert.equal(bind(p,[{...output,media:{...output.media,durationSeconds:duration}}]).tracks.length,1)}
 for(const [sourceDuration,end] of [[10.001,10],[10,10.001]]){const p=plan();p.lines[0].end=end;p.lines[0].sourceDurationSeconds=sourceDuration;assert.throws(()=>bind(p,[{...output,media:{...output.media,durationSeconds:sourceDuration}}]),/<= 10 seconds/)}
})

test('100-second BGM cannot silently expand a 0.3-second source, including sourcePath aliases',()=>{
 for(const loop of [undefined,false])for(const paths of [{path:source},{sourcePath:source,path:'future-music.wav'}]){
  const p:any=plan();p.bgm=[{id:'bgm-01',...paths,start:0,end:100,...(loop===undefined?{}:{loop})}]
  assert.throws(()=>bind(p),(error:any)=>{const detail=JSON.parse(error.message.split(': ').slice(1).join(': '));assert.equal(detail.field,'bgm[0].end');assert.match(detail.reason,/Prepare a real music file/);assert.match(detail.reason,/Do not relabel a short SFX/);assert.match(detail.reason,/studio_download_asset/);assert.match(detail.reason,/source-only/);assert.match(detail.reason,/task_block/);return true})
 }
})
test('unimplemented loop flags cannot stand in for rendered music coverage',()=>{
 const p:any=plan();p.bgm=[{id:'music-loop',path:source,start:10,end:110}]
 for(const loop of [true,'true',1,{},null]){p.bgm[0].loop=loop;assert.throws(()=>bind(p),/Implicit looping is not supported/)}
 p.bgm[0].loop=false;assert.throws(()=>bind(p),/exceeds the actual source duration/)
 const extended={...output,path:'stages/r2/sound/extended-music.wav',media:{...output.media,durationSeconds:100}};p.bgm[0].path=extended.path
 const result=bind(p,[output,extended]);assert.equal(result.tracks[1].media.durationSeconds,100);assert.equal(result.qualityApproved,false)
})
test('BGM uses relative span with probe rounding, permits brief musical stings and shared SFX sources',()=>{
 const p:any=plan();p.bgm=[{id:'sting',path:source,start:10,end:10.3}];p.sfx=[{id:'same-sting',path:source,start:20,end:20.3}]
 assert.equal(bind(p).tracks.length,3)
 p.bgm[0].start=0;p.bgm[0].end=0.35;assert.equal(bind(p).tracks.length,3)
 p.bgm[0].end=0.351;assert.throws(()=>bind(p),/exceeds the actual source duration/)
})
