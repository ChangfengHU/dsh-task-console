import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {assertStudioImageRequest,prepareStudioImageRequest} from '../src/studio-image-request.js'
import {StudioOperations} from '../src/studio-operations.js'
const raw='vyibc-image_generate_image',valid={prompt:'character',referenceImageUrl:'https://cdn.vyibc.com/character.png',wait:false}
test('known invalid references and blocking submission are rejected before dispatch or reservation',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}},ops=new StudioOperations({kernel:{db}})
 ops.configure(input,{imageCalls:6,voiceSegments:40,imageBatches:6});let calls=0
 for(const args of [{prompt:'description only'},{...valid,referenceImageUrl:'https://cdn.vyibc.com/reference.mp4'},{...valid,referenceImageUrl:'/tmp/a.png'},{...valid,referenceImageUrl:'https://user:pass@cdn.vyibc.com/a.png'},{...valid,wait:true},{...valid,prompt:' '}]){
  await assert.rejects(ops.invoke(input,raw,args,async()=>{calls++;return {}},()=>assertStudioImageRequest(raw,args)),/studio-image-/)
 }
 assert.equal(calls,0);assert.equal(ops.snapshot(input).used.imageCalls,0);assert.equal(ops.snapshot(input).unknown,false)
})

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])
test('only the explicitly approved original GitHub reference joins the CDN allowlist',async()=>{
 const approved='https://raw.githubusercontent.com/ChangfengHU/cartoon-video-skills/main/skills/cartoon-xiaban/assets/identity/approved-comic-v1.png'
 let calls=0;const fetcher:any=async()=>{calls++;return new Response(png)}
 assert.equal((await prepareStudioImageRequest(raw,{...valid,referenceImageUrl:approved},fetcher))?.reachable,true)
 for(const url of [approved.replace('ChangfengHU','someone'),approved.replace('cartoon-video-skills','other-repo'),approved.replace('/main/','/other-branch/'),approved.replace('approved-comic-v1.png','other.png'),approved+'?token=secret',approved.replace('raw.githubusercontent.com','raw.githubusercontent.com.evil'),approved.replace('/identity/','/identity/%2e%2e/')])await assert.rejects(prepareStudioImageRequest(raw,{...valid,referenceImageUrl:url},fetcher),/reference-untrusted/)
 assert.equal(calls,1)
})
test('public reference probe rejects untrusted URLs before network and bounds public GET',async()=>{
 let calls=0
 const fetcher:any=async(_:string,options:any)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.method,'GET');assert.ok(options.signal);assert.deepEqual(Object.keys(options.headers),['Accept','User-Agent']);assert.equal(options.headers['User-Agent'],'curl/8.0');return new Response(png)}
 for(const url of ['http://cdn.vyibc.com/a.png','https://localhost/a.png','https://127.0.0.1/a.png','https://cdn.vyibc.com.evil/a.png','https://cdn.vyibc.com/a.png?token=secret','https://cdn.vyibc.com:444/a.png'])await assert.rejects(prepareStudioImageRequest(raw,{...valid,referenceImageUrl:url},fetcher),/studio-image-reference/)
 assert.equal(calls,0);assert.equal((await prepareStudioImageRequest(raw,valid,fetcher))?.qualityApproved,false);assert.equal(calls,1)
 for(const response of [new Response('404',{status:404}),new Response('redirect',{status:302}),new Response('<html>not an image</html>'),new Response(png,{headers:{'content-length':String(17*1024*1024)}})])await assert.rejects(prepareStudioImageRequest(raw,valid,(async()=>response) as any),/reference-unavailable/)
 await assert.rejects(prepareStudioImageRequest(raw,valid,(async()=>{throw Error('https://secret/?token=secret')}) as any),(e:any)=>{assert.doesNotMatch(e.message,/https:|token=secret/);return true})
 let chunks=0;const stream=new ReadableStream({pull(c){chunks++;c.enqueue(new Uint8Array(1024*1024))}})
 await assert.rejects(prepareStudioImageRequest(raw,valid,(async()=>new Response(stream)) as any),/reference-unavailable/);assert.ok(chunks<=19)
})
test('async reference failure and exhausted budget never reserve or dispatch; replay/status skip probe',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}}
 ops.configure(input,{imageCalls:1,voiceSegments:0,imageBatches:1});let calls=0,probes=0
 const submit=async()=>{calls++;return {taskId:'job',status:'done'}},validate=()=>assertStudioImageRequest(raw,valid)
 await assert.rejects(ops.invoke(input,raw,valid,submit,validate,async()=>{probes++;throw Error('404')}),/404/)
 assert.equal(ops.snapshot(input).used.imageCalls,0);assert.equal(calls,0)
 await ops.invoke(input,raw,valid,submit,validate,async()=>{probes++})
 await ops.invoke(input,raw,valid,submit,()=>{throw Error('must replay')},async()=>{throw Error('must not probe')})
 await ops.invoke(input,'vyibc-image_get_task',{taskId:'job'},async()=>({taskId:'job',status:'done'}),undefined,async()=>{throw Error('must not probe')})
 await assert.rejects(ops.invoke(input,raw,{...valid,prompt:'new'},submit,validate,async()=>{probes++}),/batch-limit/)
 assert.equal(calls,1);assert.equal(probes,2)
})
test('parallel prepared identical requests reserve once and stale claims fail after probe',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}}
 ops.configure(input,{imageCalls:3,voiceSegments:0,imageBatches:3});let live=true,calls=0,release!:()=>void
 const gate=new Promise<void>(r=>release=r),validate=()=>{if(!live)throw Error('stale-run')},submit=async()=>{calls++;return {taskId:'job',status:'done'}}
 const stale=ops.invoke(input,raw,valid,submit,validate,()=>gate);live=false;release();await assert.rejects(stale,/stale-run/);assert.equal(calls,0);assert.equal(ops.snapshot(input).used.imageCalls,0)
 live=true;let releaseBoth!:()=>void;const both=new Promise<void>(r=>releaseBoth=r)
 const a=ops.invoke(input,raw,valid,submit,validate,()=>both),b=ops.invoke(input,raw,valid,submit,validate,()=>both);releaseBoth()
 const results=await Promise.allSettled([a,b]);assert.equal(results.filter(r=>r.status==='fulfilled').length>=1,true);assert.equal(calls,1);assert.equal(ops.snapshot(input).used.imageCalls,1)
})
test('image reference check leaves voice and image status reads untouched',()=>{
 assert.doesNotThrow(()=>assertStudioImageRequest('vyibc-image_get_task',{taskId:'j'}))
 assert.doesNotThrow(()=>assertStudioImageRequest('vyibc-voice_synthesize',{}))
 assert.doesNotThrow(()=>assertStudioImageRequest(raw,valid))
})
test('existing receipt replays even when current validation would reject historical no-reference input',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}},ops=new StudioOperations({kernel:{db}})
 ops.configure(input,{imageCalls:6,voiceSegments:0,imageBatches:6});const args={prompt:'historical'},receipt={structuredContent:{taskId:'existing',status:'done'}}
 await ops.invoke(input,raw,args,async()=>receipt)
 const reused=await ops.invoke(input,raw,args,async()=>{throw Error('no repeat')},()=>assertStudioImageRequest(raw,args))
 const {content,...providerReceipt}=reused;assert.deepEqual(providerReceipt,receipt)
 const provenance=JSON.parse(content[0].text).studioOperation;assert.equal(provenance.replayed,true);assert.equal(provenance.dispatched,false)
 assert.equal(ops.snapshot(input).used.imageCalls,1)
})
test('both prompt and prompts are charged like the upstream concatenated request',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}},ops=new StudioOperations({kernel:{db}})
 ops.configure(input,{imageCalls:2,voiceSegments:0,imageBatches:6});let calls=0
 const args={...valid,prompts:['second','third']}
 await assert.rejects(ops.invoke(input,raw,args,async()=>{calls++;return {}},()=>assertStudioImageRequest(raw,args)),/requestedUnits\":3/)
 assert.equal(calls,0);assert.equal(ops.snapshot(input).used.imageCalls,0)
})

test('capacity is rechecked after probe and argument mutation cannot change reserved intent',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}}
 ops.configure(input,{imageCalls:1,voiceSegments:0,imageBatches:1});let release!:()=>void,calls=0
 const waiting=new Promise<void>(r=>release=r),submit=async()=>{calls++;return {taskId:'job',status:'done'}}
 const pending=ops.invoke(input,raw,valid,submit,undefined,()=>waiting)
 await ops.invoke(input,raw,{...valid,prompt:'other'},submit)
 release();await assert.rejects(pending,/batch-limit/);assert.equal(calls,1)
 const args={...valid};const otherInput={...input,batch:{id:'other'}};ops.configure(otherInput,{imageCalls:1,voiceSegments:0,imageBatches:1})
 await assert.rejects(ops.invoke(otherInput,raw,args,submit,undefined,async()=>{args.prompt='mutated'}),/input-changed/)
 assert.equal(ops.snapshot(otherInput).used.imageCalls,0);assert.equal(calls,1)
})
