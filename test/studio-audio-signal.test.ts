import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {inspectAudioSignal} from '../src/studio-audio-signal.ts'
const run=promisify(execFile),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
async function fixture(t:any){const root=await mkdtemp(join(tmpdir(),'decoded-audio-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
async function audio(root:string,name:string,source:string,duration='0.5'){
 const path=join(root,name+'.wav')
 await run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',source,'-t',duration,'-c:a','pcm_f32le','-y',path])
 return {path,hash:sha(await readFile(path))}
}

test('real FFmpeg silence is exactly zero; short/very quiet clips, internal pauses and phase-opposed stereo stay nonzero',async t=>{
 const root=await fixture(t)
 for(const [name,source,silent,duration] of [
  ['silence','anullsrc=r=16000:cl=stereo',true,'0.5'],
  ['quiet','aevalsrc=1e-15*sin(2*PI*440*t):s=16000',false,'0.5'],
  ['pauses',"aevalsrc='if(between(t,0.2,0.3),0.01*sin(2*PI*440*t),0)':s=16000",false,'0.5'],
  ['opposed','aevalsrc=0.1*sin(2*PI*440*t)|-0.1*sin(2*PI*440*t):s=16000',false,'0.5'],
  ['short','sine=frequency=800:sample_rate=16000',false,'0.01'],
 ] as const){
  const f=await audio(root,name,source,duration),r=await inspectAudioSignal(f.path,f.hash)
  assert.equal(r.allSilent,silent,name);assert.equal(r.sha256,f.hash);assert.ok(r.decodedSamples>0);assert.equal(r.qualityApproved,false)
 }
})

test('hash-keyed cache cannot accept changed silent bytes as the previous nonzero source',async t=>{
 const root=await fixture(t),before=await audio(root,'same','sine=frequency=450:sample_rate=16000')
 assert.equal((await inspectAudioSignal(before.path,before.hash)).allSilent,false)
 const after=await audio(root,'same','anullsrc=r=16000:cl=mono')
 assert.notEqual(after.hash,before.hash);assert.equal((await inspectAudioSignal(after.path,after.hash)).allSilent,true)
})

test('timeout kills decoder before rejecting, errors are not cached and no decoder diagnostic leaks',async t=>{
 const root=await fixture(t),file=await audio(root,'source','anullsrc=r=16000:cl=mono'),binary=join(root,'decoder'),pidPath=join(root,'pid')
 const prior=process.env.FFMPEG_PATH;t.after(()=>{if(prior===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=prior})
 // macOS may delay executing a freshly created shebang script. Launch this
 // synthetic decoder through Python explicitly; the child, timeout and SIGKILL
 // remain real, and all non-fixture subprocess launches are unchanged.
 const spawn=childProcess.spawn
 t.mock.method(childProcess,'spawn',((file:any,args:any,options:any)=>file===binary?spawn('python3',[binary,...args],options):spawn(file,args,options)) as typeof spawn)
 syncBuiltinESMExports()
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
 await writeFile(binary,`#!/usr/bin/env python3\nimport os,time,signal,sys\nopen(${JSON.stringify(pidPath)},'w').write(str(os.getpid()))\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsys.stderr.write('PRIVATE_FAKE_DIAGNOSTIC')\nsys.stderr.flush()\ntime.sleep(30)\n`,{mode:0o700});process.env.FFMPEG_PATH=binary
 const started=Date.now();await assert.rejects(inspectAudioSignal(file.path,file.hash,{timeoutMs:250}),e=>{assert.equal((e as Error).message,'studio-audio-signal-timeout');return true})
 assert.ok(Date.now()-started<3000)
 const pid=Number(await readFile(pidPath,'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH')
 await writeFile(binary,"#!/usr/bin/env python3\nimport sys,struct\nsys.stdout.buffer.write(struct.pack('<d',1.0))\n",{mode:0o700})
 const r=await inspectAudioSignal(file.path,file.hash,{timeoutMs:1000});assert.equal(r.allSilent,false,'previous failed probe was not cached')
})
