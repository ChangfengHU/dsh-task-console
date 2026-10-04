import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {sampleOrderedStudioFrames,type StudioFrameSamplingOptions} from '../src/studio-frame-sampling.ts'
const run=promisify(execFile),sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const times=Array.from({length:8},(_,i)=>1+2*i/8)
async function setup(t:any){const root=await mkdtemp(join(tmpdir(),'studio-frame-sampling-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
function options(root:string,command:StudioFrameSamplingOptions['command'],extra:Partial<StudioFrameSamplingOptions>={}):StudioFrameSamplingOptions{
 return {videoPath:join(root,'film.mp4'),outputDirectory:root,durationSeconds:3,times,command,...extra}
}
test('two-worker scheduling preserves exact original input seeks and ordered files despite completion order',async t=>{
 const root=await setup(t),started:any[]=[],completed:number[]=[];let inFlight=0,max=0
 const result=await sampleOrderedStudioFrames(options(root,async(file,args)=>{
  const time=Number(args[4]),index=times.indexOf(time);started.push({file,args});inFlight++;max=Math.max(max,inFlight)
  await sleep(index%2===0?8:1);await writeFile(args.at(-1)!,String(time));completed.push(index);inFlight--;return {stdout:''}
 }))
 assert.equal(max,2);assert.equal(inFlight,0);assert.equal(started.length,8)
 assert.notDeepEqual(completed,[0,1,2,3,4,5,6,7])
 assert.deepEqual(result.map(s=>s.requestedTime),times)
 assert.deepEqual(result.map(s=>s.path),times.map((_,i)=>join(root,`${i}.jpg`)))
 for(let i=0;i<8;i++){
  assert.deepEqual(started[i],{file:'ffmpeg',args:['-nostdin','-v','error','-ss',String(times[i]),'-i',join(root,'film.mp4'),'-frames:v','1','-vf','scale=540:-2','-y',join(root,`${i}.jpg`)]})
  assert.equal(await readFile(result[i].path,'utf8'),String(times[i]))
 }
})
test('explicit serial fallback uses identical eight requests, named prefixes and no additional work',async t=>{
 const root=await setup(t);let inFlight=0,max=0,calls=0
 const samples=await sampleOrderedStudioFrames(options(root,async(_,args)=>{calls++;inFlight++;max=Math.max(max,inFlight);await sleep(1);await writeFile(args.at(-1)!,'sample');inFlight--;return {stdout:''}},{concurrency:1,filePrefix:'reference-'}))
 assert.equal(max,1);assert.equal(calls,8);assert.equal(samples[0].path,join(root,'reference-0.jpg'))
})
test('a failed seek drains its started sibling and dispatches no later sample',async t=>{
 const root=await setup(t);let calls=0,completed=0
 await assert.rejects(sampleOrderedStudioFrames(options(root,async(_,args)=>{
  const index=calls++
  if(index===0){await sleep(1);throw Error('decoder-failed')}
  await sleep(15);await writeFile(args.at(-1)!,'sample');completed++;return {stdout:''}
 })),/decoder-failed/)
 assert.equal(calls,2);assert.equal(completed,1)
 await sleep(10);assert.equal(calls,2,'no processes start after rejection')
})
test('run becoming stale cannot complete sampling or keep dispatching after the in-flight pair',async t=>{
 const root=await setup(t);let active=true,calls=0,completed=0
 await assert.rejects(sampleOrderedStudioFrames(options(root,async(_,args)=>{
  calls++;await sleep(calls===1?1:10);await writeFile(args.at(-1)!,'sample');active=false;completed++;return {stdout:''}
 },{assertActive:()=>{if(!active)throw Error('studio-stale-run')}})),/studio-stale-run/)
 assert.equal(calls,2);assert.equal(completed,2)
})
test('zero-frame successful CLI exit and oversized output are failures, not valid observations',async t=>{
 const root=await setup(t)
 await assert.rejects(sampleOrderedStudioFrames(options(root,async()=>({stdout:''}))),/sample-missing-or-invalid/)
 await assert.rejects(sampleOrderedStudioFrames(options(root,async(_,args)=>{await writeFile(args.at(-1)!,Buffer.alloc(4*1024*1024+1));return {stdout:''}})),/sample-missing-or-invalid/)
})
test('invalid count, order, EOF and parallelism reject before any decoder command',async t=>{
 const root=await setup(t);let calls=0;const command=async()=>{calls++;return {stdout:''}}
 for(const extra of [{times:times.slice(1)},{times:[...times].reverse()},{times:[...times.slice(0,7),3]},{times:[0,0,...times.slice(2)]},{times:[NaN,...times.slice(1)]},{durationSeconds:0},{concurrency:3 as any},{filePrefix:'../escape-'},{outputDirectory:'relative'}])await assert.rejects(sampleOrderedStudioFrames(options(root,command,extra)),/studio-frame-sampling-/)
 assert.equal(calls,0)
})
test('real FFmpeg serial and bounded-two produce byte-identical ordered images at the original seek times',async t=>{
 try{await run('ffmpeg',['-version']);await run('ffprobe',['-version'])}catch{t.skip('FFmpeg/ffprobe unavailable');return}
 const root=await setup(t),source=join(root,'film.mp4')
 await run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=540x960:r=30','-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y',source])
 const duration=Number(JSON.parse((await run('ffprobe',['-v','error','-show_format','-of','json',source])).stdout).format.duration)
 const dirs=[join(root,'serial'),join(root,'parallel')];for(const dir of dirs)await mkdir(dir)
 const command=async(file:string,args:string[])=>({stdout:(await run(file,args,{timeout:60000,maxBuffer:1024*1024})).stdout})
 const serialStart=performance.now(),serial=await sampleOrderedStudioFrames(options(root,command,{outputDirectory:dirs[0],durationSeconds:duration,concurrency:1})),serialMs=performance.now()-serialStart
 const parallelStart=performance.now(),parallel=await sampleOrderedStudioFrames(options(root,command,{outputDirectory:dirs[1],durationSeconds:duration,concurrency:2})),parallelMs=performance.now()-parallelStart
 const hashes:string[]=[]
 for(let i=0;i<8;i++){
  const a=await readFile(serial[i].path),b=await readFile(parallel[i].path)
  assert.equal(a[0],255);assert.equal(a[1],216);assert.ok(a.equals(b),'same JPEG bytes at requested time '+times[i])
  assert.equal(parallel[i].requestedTime,times[i]);assert.ok(parallel[i].requestedTime<duration)
  hashes.push(createHash('sha256').update(a).digest('hex'))
 }
 assert.equal(new Set(hashes).size,8,'dynamic fixture gives eight distinct actual images')
 t.diagnostic(JSON.stringify({ffmpegBenchmark:'original-eight-input-seeks',source:'local testsrc2 540x960 30fps 3s',serialMs:Math.round(serialMs),boundedTwoMs:Math.round(parallelMs),speedup:Number((serialMs/parallelMs).toFixed(2)),byteIdentical:true,decodedPtsMeasured:false}))
})
test('real low-FPS source can have no decoded frame before nominal EOF; it must not become a successful observation',async t=>{
 try{await run('ffmpeg',['-version'])}catch{t.skip('FFmpeg unavailable');return}
 const root=await setup(t),source=join(root,'film.mp4')
 await run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=108x192:r=1','-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y',source])
 // Encoded PTS are 0, 1, 2. Seeking to 2.9 is before the container duration
 // but cannot decode an actual frame at/after that requested position.
 const requests=[0,.1,.2,.3,.4,.5,.6,2.9]
 const command=async(file:string,args:string[])=>({stdout:(await run(file,args,{timeout:60000,maxBuffer:1024*1024})).stdout})
 // Depending on the FFmpeg release, an empty seek either exits successfully
 // without an image or reports that the encoder received no packet before EOF.
 await assert.rejects(sampleOrderedStudioFrames(options(root,command,{times:requests})),/studio-frame-sample-missing-or-invalid|Could not open encoder before EOF|Nothing was written/)
 const output=await lstat(join(root,'7.jpg')).catch(()=>null)
 assert.ok(!output||output.size===0,'a nonexistent decoded tail frame is not returned as an observation')
})
