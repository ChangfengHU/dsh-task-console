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
 const p:any=plan();p.bgm=[{id:'loop',path:source,start:0,end:100}];p.sfx=[{id:'hit',path:'./'+source,start:0,end:1},{id:'hit',path:source,start:3,end:4}]
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
