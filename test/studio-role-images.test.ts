import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,writeFile,rm,readFile,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {registerStudioTools,fileSha256} from '../src/studio-tools.ts'
import {registerStudioSpeechTools} from '../src/studio-speech-tools.ts'
import {registerStudioBoardTools} from '../src/studio-board-tools.ts'
import {studioRoleToolNames,studioRoleGuidance} from '../src/studio-tool-policy.ts'
import {studioGuide} from '../src/studio-guides.ts'
import {appServerToolResults} from '/Users/vyibc/Developer/vyibc-dsh-local/repos/dsh-codex-claude-cli/src/protocol.ts'
import {NativeImageBridge} from '/Users/vyibc/Developer/vyibc-dsh-local/repos/dsh-codex-claude-cli/src/images.ts'
import {validateTurnRequest} from '/Users/vyibc/Developer/vyibc-dsh-local/repos/dsh-codex-claude-cli/src/thread.ts'
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
const JPEG=Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAFBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AI4Av4p//9k=','base64')
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
async function fixture(t:any,role='studio-stage'){
 const cwd=await realpath(await mkdtemp(join(tmpdir(),'studio-native-image-')));t.after(()=>rm(cwd,{recursive:true,force:true}))
 await writeFile(join(cwd,'source.png'),PNG);await writeFile(join(cwd,'film.mp4'),'fixture film');await writeFile(join(cwd,'manifest.json'),'{}')
 const require=createRequire(import.meta.url),{Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx:any=new Context();ctx.provide('systemPrompt',{tools:()=>{}});const runtime=new ToolRuntime(ctx),stored=new Map<string,any>(),receipts:any[]=[],observations:any[]=[],routes:any[]=[]
 let active=true,mode='ok',modalities=['text','image'],storedCount=0,route={provider:'codex-local',model:'exact-image-model'},attachmentMutation=false,jpegDimensions=[16,16]
 const store={imageLimits:{maxImageBytes:20*1024*1024,maxImagesPerMessage:8,maxMessageImageBytes:32*1024*1024,maxImagePixels:20000000,maxImageDimension:10000,mediaTypes:['image/png','image/jpeg']},saveImage:async(value:any)=>{
  const [width,height]=value.mediaType==='image/jpeg'?jpegDimensions:[1,1],ref={attachmentId:'sha256:'+sha(value.data),mediaType:value.mediaType,bytes:value.data.length,width,height,name:value.name};stored.set(ref.attachmentId,{ref,data:Buffer.from(value.data)});storedCount++;if(attachmentMutation)await writeFile(join(cwd,'source.png'),Buffer.concat([PNG,Buffer.from('changed')]));return ref
 },readImage:async(ref:any)=>{const data=stored.get(ref.attachmentId);assert.ok(data);return data}}
 const input={task:{cwd,design:{studio:{referenceSha256:sha('fixture film')}}},card:{role},sessionId:'image-session'}
 const agent:any={ctx,options:{provider:'wrong-options-provider',model:'wrong-options-model'},session:{id:input.sessionId,requestHeader:()=>({config:route})}}
 const facade={tools:{register:(definition:any)=>runtime.register(definition)},get:(name:string)=>name==='attachments'?store:name==='llm'?{resolveModelInfo:async(provider:string,model:string)=>{routes.push({provider,model});if(mode==='route-error')throw Error('offline route unavailable');return {inputModalities:modalities}}}:undefined}
 const workflow={preflight:()=>({ok:true}),status:()=>({candidate:{sha256:sha('fixture film'),manifestSha256:sha('{}'),durationSeconds:10}}),candidateLocation:()=>({path:join(cwd,'film.mp4'),manifestPath:join(cwd,'manifest.json')}),recordReceipt:(_:any,r:any)=>{receipts.push(r);return {...r,id:'independent-fixture-receipt'}}}
 let command=async(file:string,args:string[])=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'video'}],format:{duration:10}})};await writeFile(args.at(-1)!,JPEG);return {stdout:''}}
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='development';let dispose:any
 try{dispose=await registerStudioTools(facade,{input,workflow,isActive:()=>active,runCommand:(file,args)=>command(file,args),reference:{path:join(cwd,'film.mp4'),sha256:sha('fixture film')},characterReferences:[{id:'locked-character',path:join(cwd,'source.png'),sha256:sha(PNG)}],visionObserve:async(value)=>{
  observations.push(value);if(mode==='stale')active=false;if(mode==='mutated')await writeFile(value.images[0].path,'changed');return {ok:true,input_modality:mode==='bad-modality'?'text':'input_image',finish_reason:'stop',images:value.images.map(({path,...v})=>({...v,sha256:mode==='wrong-hash'?'f'.repeat(64):v.sha256})),observation:'Offline observer fixture only; no quality approval.'}
 }})}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous}
 t.after(dispose)
 const call=(name:string,args:any={},sid=input.sessionId,signal=new AbortController().signal)=>runtime.execute({name,arguments:args,agent:{...agent,session:{...agent.session,id:sid}},callId:'fixture-'+name,signal} as any)
 return {cwd,runtime,input,agent,facade,workflow,call,store,stored,observations,receipts,routes,storedCount:()=>storedCount,mode:(v:string)=>mode=v,modalities:(v:string[])=>modalities=v,deactivate:()=>active=false,route:(v:any)=>route=v,command:(v:typeof command)=>command=v,jpegDimensions:(v:number[])=>jpegDimensions=v,mutateDuringStorage:()=>attachmentMutation=true}
}
test('actual SDK advertises exactly the shared Studio role matrix, never producer or QA tools to unrelated roles',async t=>{
 for(const role of ['planner','executor','studio-stage','reviewer','notifier','unknown']){
  const f=await fixture(t,role),disposeSpeech=await registerStudioSpeechTools(f.facade,{input:f.input,workflow:{},isActive:()=>true,speechCheck:async()=>{throw Error('no provider')}}),disposeBoard=await registerStudioBoardTools(f.facade,{input:f.input,workflow:{},isActive:()=>true,compile:async()=>{throw Error('no compiler')}} as any)
  t.after(disposeSpeech);t.after(disposeBoard)
  assert.deepEqual(f.runtime.schemas().map(v=>v.name).sort(),studioRoleToolNames(role).sort(),role)
 }
})
test('hidden Studio registrations still retain a runtime role guard if a formerly authorized input changes',async t=>{
 const f=await fixture(t);f.input.card.role='planner'
 const out=await f.call('studio_preview_image',{path:'source.png'});assert.equal(out.isError,true);assert.match(JSON.stringify(out),/studio-role-denied/);assert.equal(f.observations.length,0)
})
test('role guidance preserves full packaged contract SHA and clearly bounds planner image access',async t=>{
 const f=await fixture(t,'planner'),out:any=await f.call('studio_read_guide',{id:'execution'})
 assert.equal(out.isError,false);assert.equal(out.value.sha256,studioGuide('execution').sha256);assert.equal(out.value.text,studioGuide('execution').text)
 assert.match(out.value.roleGuidance,/no arbitrary preparation-image read grant/);assert.equal(out.value.roleTools.includes('studio_preview_image'),false)
 assert.equal(f.runtime.schemas().some(v=>v.name==='studio_preview_image'),false);assert.match(studioRoleGuidance('reviewer'),/do not replace host-bound review receipts/)
})
test('actual SDK producer preview returns same PNG bytes as an image block plus independent observer metadata',async t=>{
 const f=await fixture(t),out:any=await f.call('studio_preview_image',{path:'source.png'})
 assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.value.sha256,sha(PNG));assert.equal(out.value.mainModelImage.admitted,true)
 assert.deepEqual(f.routes,[{provider:'codex-local',model:'exact-image-model'}]);assert.equal(f.observations[0].images[0].sha256,sha(PNG))
 const images=out.content.filter((v:any)=>v.type==='image');assert.equal(images.length,1);assert.ok(f.stored.get(images[0].attachment.attachmentId).data.equals(PNG))
 const text=out.content.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('');assert.match(text,/Offline observer fixture/);assert.ok(!text.includes(PNG.toString('base64')))
 assert.equal(out.value.independentReview,false);assert.equal(out.value.qualityApproved,false);assert.equal(out.value.receipt,undefined);assert.equal(f.receipts.length,0)
})
test('actual SDK image result reaches actual Codex native bridge as inputImage, not a JSON path or base64 text',async t=>{
 const f=await fixture(t),out:any=await f.call('studio_preview_image',{path:'source.png'});assert.equal(out.isError,false)
 const callback=appServerToolResults({messages:[{role:'user',content:[{type:'tool-result',toolCallId:'fixture-studio_preview_image',content:out.content,isError:false}]}]} as any)[0]
 const native=await new NativeImageBridge(()=>f.store as any).hydrateToolResult(callback);validateTurnRequest({toolResult:native})
 assert.deepEqual(native.contentItems.map((v:any)=>v.type),['inputText','inputImage'])
 const item:any=native.contentItems[1];assert.ok(Buffer.from(item.imageUrl.split(',')[1],'base64').equals(PNG))
})
test('text-only and unknown exact routes retain host visual observations without emitting native images',async t=>{
 for(const mode of ['text-only','route-error','no-route']){
  const f=await fixture(t);if(mode==='text-only')f.modalities(['text']);if(mode==='route-error')f.mode(mode);if(mode==='no-route'){f.route({});f.agent.options={}}
  const out:any=await f.call('studio_preview_image',{path:'source.png'});assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.value.mainModelImage.admitted,false);assert.equal(f.observations.length,1);assert.equal(f.storedCount(),0);assert.equal(out.content.some((v:any)=>v.type==='image'),false);assert.match(JSON.stringify(out.content),/Offline observer fixture/)
 }
})
test('host-locked character and reference frames attach actual images only to image-capable production routes',async t=>{
 for(const role of ['planner','executor','studio-stage']){
  const f=await fixture(t,role)
  for(const [name,args,count] of [['studio_character_image',{id:'locked-character'},1],['studio_reference_overview',{},8],['studio_reference_frames',{start:0,end:2},8]] as const){const out:any=await f.call(name,args);assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.content.filter((v:any)=>v.type==='image').length,count);assert.equal(out.value.qualityApproved===true,false);assert.equal(out.value.receipt,undefined)}
 }
})
test('preview frame attachment order and source SHA match actual sampled bytes, never create independent receipts',async t=>{
 const f=await fixture(t),out:any=await f.call('studio_preview_frames',{path:'film.mp4',start:1,end:3})
 assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.value.frames.length,8);assert.equal(out.content.filter((v:any)=>v.type==='image').length,8)
 assert.deepEqual(out.value.frames.map((v:any)=>v.time),Array.from({length:8},(_,i)=>1+i/4));assert.ok(out.value.frames.every((v:any)=>v.sha256===sha(JPEG)));assert.equal(out.value.sourceSha256,sha('fixture film'));assert.equal(out.value.independentReview,false);assert.equal(f.receipts.length,0)
})
test('independent reviewer keeps mediated Qwen result and unchanged host receipts, never receives producer-image self-check grants',async t=>{
 const f=await fixture(t,'reviewer')
 for(const [name,args] of [['studio_character_image',{id:'locked-character'}],['studio_reference_overview',{}],['studio_inspect_frames',{start:0,end:2}]] as const){const out:any=await f.call(name,args);assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.content.some((v:any)=>v.type==='image'),false);assert.equal(out.value.mainModelImage.admitted,false);assert.match(JSON.stringify(out.content),/Offline observer fixture/)}
 assert.equal(f.receipts.length,1);assert.equal(f.receipts[0].kind,'frames');assert.equal(f.receipts[0].candidateSha256,sha('fixture film'));assert.deepEqual(f.receipts[0].ranges,[[0,2]]);assert.equal(f.routes.length,0)
 assert.equal(f.runtime.schemas().some(v=>v.name==='studio_preview_image'),false)
})
test('native preview rejects non-image/media spoof, oversize, sensitive and symlink escape before observer or storage',async t=>{
 const f=await fixture(t);await writeFile(join(f.cwd,'spoof.png'),'text is not an image');await writeFile(join(f.cwd,'big.png'),Buffer.concat([PNG,Buffer.alloc(20*1024*1024)]));await writeFile(join(f.cwd,'.secret.png'),PNG);await symlink('/etc/hosts',join(f.cwd,'escape.png'))
 for(const path of ['spoof.png','big.png','.secret.png','escape.png','/etc/hosts']){const out:any=await f.call('studio_preview_image',{path});assert.equal(out.isError,true,path);assert.equal(out.content.some((v:any)=>v.type==='image'),false)}
 assert.equal(f.observations.length,0);assert.equal(f.storedCount(),0)
})
test('source mutation, mismatched observer SHA, modality and stale runs fail closed without projected image blocks',async t=>{
 for(const mode of ['mutated','wrong-hash','bad-modality','stale']){
  const f=await fixture(t);f.mode(mode);const out:any=await f.call('studio_preview_image',{path:'source.png'});assert.equal(out.isError,true,mode);assert.equal(out.content.some((v:any)=>v.type==='image'),false);assert.equal(f.receipts.length,0)
 }
 const f=await fixture(t);f.mutateDuringStorage();const out:any=await f.call('studio_preview_image',{path:'source.png'});assert.equal(out.isError,true);assert.match(JSON.stringify(out),/studio-vision-file-changed/);assert.equal(out.content.some((v:any)=>v.type==='image'),false)
})
test('cross-session and already canceled native image calls cannot observe or store files',async t=>{
 const f=await fixture(t);assert.equal((await f.call('studio_preview_image',{path:'source.png'},'other')).isError,true)
 const controller=new AbortController();controller.abort();assert.equal((await f.call('studio_preview_image',{path:'source.png'},'image-session',controller.signal)).isError,true)
 assert.equal(f.observations.length,0);assert.equal(f.storedCount(),0)
})
test('real FFmpeg pilot yields eight actual JPEG native attachments with exact ordered seek SHA, without candidate registration',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile)
 const f=await fixture(t);await run('/opt/homebrew/bin/ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=108x192:r=30','-t','1','-pix_fmt','yuv420p','-y',join(f.cwd,'film.mp4')])
 f.jpegDimensions([108,192])
 f.command(async(file,args)=>({stdout:String((await run(file.includes('ffprobe')?'/opt/homebrew/bin/ffprobe':'/opt/homebrew/bin/ffmpeg',args)).stdout)}))
 const out:any=await f.call('studio_preview_frames',{path:'film.mp4',start:0,end:.8});assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.value.sourceSha256,await fileSha256(join(f.cwd,'film.mp4')))
 const images=out.content.filter((v:any)=>v.type==='image');assert.equal(images.length,8)
 for(let i=0;i<8;i++){const data=f.stored.get(images[i].attachment.attachmentId).data;assert.equal(data[0],255);assert.equal(data[1],216);assert.equal(data[2],255);assert.equal(sha(data),out.value.frames[i].sha256);assert.equal(images[i].attachment.mediaType,'image/jpeg');assert.equal(out.value.frames[i].time,.8*i/8);assert.equal(f.observations[0].images[i].sha256,sha(data))}
 const native=await new NativeImageBridge(()=>f.store as any).hydrateToolResult(appServerToolResults({messages:[{role:'user',content:[{type:'tool-result',toolCallId:'fixture-studio_preview_frames',content:out.content}]}]} as any)[0]);validateTurnRequest({toolResult:native});assert.equal(native.contentItems.filter((v:any)=>v.type==='inputImage').length,8);assert.equal(f.receipts.length,0);assert.equal(out.value.independentReview,false)
})
test('native projection respects host attachment batch count/byte/media limits without weakening observer or review gates',async t=>{
 for(const key of ['maxImagesPerMessage','maxMessageImageBytes','maxImageBytes','mediaTypes']){
  const f=await fixture(t);(f.store.imageLimits as any)[key]=key==='mediaTypes'?['image/png']:key==='maxImagesPerMessage'?7:1
  const out:any=await f.call('studio_preview_frames',{path:'film.mp4',start:0,end:2});assert.equal(out.isError,true,key);assert.equal(out.content.some((v:any)=>v.type==='image'),false);assert.match(JSON.stringify(out),/studio-image-attachment-batch-invalid/);assert.equal(f.receipts.length,0)
 }
})
