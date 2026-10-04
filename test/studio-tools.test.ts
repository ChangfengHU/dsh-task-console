import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,symlink,rm,mkdir,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {registerStudioTools,studioPath,fileSha256} from '../src/studio-tools.ts'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const jpegFixture=(v:string)=>Buffer.concat([Buffer.from([255,216,255]),Buffer.from(v)])
async function setup(t:any,role='reviewer'){
 const cwd=await realpath(await mkdtemp(join(tmpdir(),'studio-tools-')));t.after(()=>rm(cwd,{recursive:true,force:true}));await writeFile(join(cwd,'film.mp4'),'video');await writeFile(join(cwd,'manifest.json'),'{}')
 const tools:any={},receipts:any[]=[],reviews:any[]=[];let candidate:any={sha256:hash('video'),manifestSha256:hash('{}'),referenceSha256:'a'.repeat(64),durationSeconds:100,revision:1},location:any={path:join(cwd,'film.mp4'),manifestPath:join(cwd,'manifest.json')},active=true
 const workflow={preflight:()=>({ok:true}),status:()=>({candidate:{candidate}}),candidateLocation:()=>location,recordCandidate:(_:any,c:any)=>candidate=c,recordCandidateLocation:(_:any,l:any)=>location=l,recordReceipt:(_:any,r:any)=>{receipts.push(r);return {...r,id:'host-id'}},recordValidatedReview:(_:any,r:any)=>reviews.push(r)}
 const input={task:{cwd,design:{studio:{referenceSha256:'a'.repeat(64)}}},card:{role},sessionId:'s'},agentCtx={tools:{register:(s:any)=>{tools[s.name]=s;return()=>delete tools[s.name]}},attachments:{saveImage:async({data}:any)=>({attachmentId:hash(data.toString()),mediaType:'image/jpeg',bytes:data.length,width:540,height:960})}}
 const runCommand=async(file:string,args:string[])=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'video',width:1080,height:1920,avg_frame_rate:'30/1'},{codec_type:'audio'}],format:{duration:'100'}})};if(args.includes('null'))return {stdout:''};await writeFile(args.at(-1)!,`actual-frame-${args[4]}`);return {stdout:''}}
 const dispose=await registerStudioTools(agentCtx,{input,workflow,isActive:()=>active,runCommand,audioObserve:async({wavPath})=>({observation:'actual audio',calibrated:false,input_modality:'input_audio',audio_sha256:await fileSha256(wavPath)})})
 return {cwd,tools,receipts,reviews,dispose,deactivate:()=>active=false,getCandidate:()=>candidate}
}
test('realpath confines symlinks and traversal; text rejects hidden/sensitive',async t=>{const s=await setup(t);await symlink('/etc/hosts',join(s.cwd,'escape'));await assert.rejects(studioPath(s.cwd,'escape'),/outside/);await assert.rejects(studioPath(s.cwd,'../../../etc/hosts'));await writeFile(join(s.cwd,'.env'),'secret');await assert.rejects(studioPath(s.cwd,'.env',true),/sensitive/);await writeFile(join(s.cwd,'credentials.json'),'{}');await assert.rejects(studioPath(s.cwd,'credentials.json',true),/sensitive/)})
test('producer registers actual hashes and probe dimensions',async t=>{const s=await setup(t,'executor');await s.tools.studio_register_candidate.execute({path:'film.mp4',manifestPath:'manifest.json',revision:2});assert.equal(s.getCandidate().sha256,hash('video'));assert.equal(s.getCandidate().manifestSha256,hash('{}'));assert.equal(s.getCandidate().fps,30);assert.equal(await fileSha256(join(s.cwd,'film.mp4')),hash('video'))})
test('role-hidden registration and stale session reject before work',async t=>{const s=await setup(t,'planner');assert.equal(s.tools.studio_register_candidate,undefined);await assert.rejects(s.tools.studio_status.execute({}, {agent:{session:{id:'other'}}}),/session/);s.deactivate();await assert.rejects(s.tools.studio_status.execute({}),/stale/)})
test('read text is bounded and binaries rejected',async t=>{const s=await setup(t);assert.equal((await s.tools.studio_read_text.execute({path:'manifest.json'})).text,'{}');await writeFile(join(s.cwd,'large.txt'),'x'.repeat(65537));assert.equal((await s.tools.studio_read_text.execute({path:'large.txt'})).nextOffset,16384);await writeFile(join(s.cwd,'binary.txt'),Buffer.from([0,1]));await assert.rejects(s.tools.studio_read_text.execute({path:'binary.txt'}),/invalid/)})
test('text discovery distinguishes context manifests and changed source from candidate evidence',async t=>{
 const s=await setup(t)
 await writeFile(join(s.cwd,'stage-manifest.json'),'{}')
 const context=await s.tools.studio_read_text.execute({path:'stage-manifest.json'})
 assert.equal(context.receipt,undefined);assert.match(context.scope,/no candidate source receipt/);assert.equal(s.receipts.length,0)
 const source=await s.tools.studio_read_text.execute({path:'manifest.json'})
 assert.equal(source.receipt.kind,'source');assert.equal(s.receipts.length,1)
 await writeFile(join(s.cwd,'manifest.json'),'{"changed":true}')
 await assert.rejects(s.tools.studio_read_text.execute({path:'manifest.json'}),/studio-manifest-file-changed:.*pending.*immutable candidate revision/)
 assert.equal(s.receipts.length,1)
})
test('ordered actual frames return durable image blocks and trusted receipt',async t=>{const s=await setup(t),tool=s.tools.studio_inspect_frames,result=await tool.execute({start:0,end:2}),content=tool.output.render({},result);assert.equal(content.filter((b:any)=>b.type==='image').length,8);assert.equal(result.frames.length,8);assert.equal(s.receipts[0].kind,'frames');assert.equal(s.receipts[0].candidateSha256,hash('video'));assert.match(s.receipts[0].sha256,/^[a-f0-9]{64}$/);await assert.rejects(tool.execute({start:0,end:4}),/range/)})
test('changed candidate refused and no receipt minted',async t=>{const s=await setup(t);await writeFile(join(s.cwd,'film.mp4'),'altered');await assert.rejects(s.tools.studio_inspect_frames.execute({start:0,end:1}),/changed/);assert.equal(s.receipts.length,0)})
test('review identity and version supplied by host; not acceptance',async t=>{const s=await setup(t),r=await s.tools.studio_submit_review.execute({checks:[],issues:[],candidateSha256:'fake',revision:900});assert.equal(s.reviews[0].candidateSha256,hash('video'));assert.equal(s.reviews[0].revision,1);assert.equal(r.qualityApproved,false)})
test('structured review invokes guarded handoff; rejected evidence remains editable',async t=>{
 const s=await setup(t),tools:any={};let active=true,valid=false,submissions=0
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordValidatedReview:()=>{}},isActive:()=>active,submitReview:async()=>{submissions++;if(!valid)throw Error('host-evidence-invalid');active=false}})
 await assert.rejects(tools.studio_submit_review.execute({checks:[],issues:[]}),/host-evidence-invalid/)
 assert.equal(active,true);valid=true
 const r=await tools.studio_submit_review.execute({checks:[],issues:[]});assert.equal(r.taskHandoff,true);assert.equal(r.qualityApproved,false);assert.match(r.nextAction,/already completed.*do not call task_complete/);assert.equal(submissions,2)
 await assert.rejects(tools.studio_submit_review.execute({checks:[],issues:[]}),/stale-run/)
})
test('audio actual host wav hash recorded with calibration result intact',async t=>{const s=await setup(t),r=await s.tools.studio_inspect_audio.execute({start:1,end:3});assert.equal(r.observation.calibrated,false);assert.equal(r.receipt.kind,'audio');assert.equal(r.qualityApproved,false);await assert.rejects(s.tools.studio_inspect_audio.execute({start:0,end:9}),/range/)})
test('disposer removes registered tools',async t=>{const s=await setup(t);s.dispose();assert.equal(Object.keys(s.tools).length,0)})
test('real FFmpeg MP4 probe and frame extraction integration',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile)
 try{await run('ffmpeg',['-version']);await run('ffprobe',['-version'])}catch{t.skip('FFmpeg/ffprobe unavailable');return}
 const s=await setup(t,'executor');await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=108x192:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-pix_fmt','yuv420p','-y',join(s.cwd,'film.mp4')])
 let candidate:any,location:any;const receipts:any[]=[],tools:any={};const workflow={status:()=>({candidate:{candidate}}),candidateLocation:()=>location,recordCandidate:(_:any,v:any)=>candidate=v,recordCandidateLocation:(_:any,v:any)=>location=v,recordReceipt:(_:any,v:any)=>{receipts.push(v);return {...v,id:'real-frame-receipt'}}},input={task:{cwd:s.cwd,design:{studio:{referenceSha256:'a'.repeat(64)}}},card:{role:'executor'},sessionId:'s'}
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async({data}:any)=>{assert.equal(data[0],255);assert.equal(data[1],216);return {attachmentId:hash(data.toString('base64')),bytes:data.length,mediaType:'image/jpeg',width:540,height:960}}}},{input,workflow,isActive:()=>true})
 await tools.studio_register_candidate.execute({path:'film.mp4',manifestPath:'manifest.json',revision:1});assert.equal(candidate.fps,30);assert.equal(candidate.width,108)
 input.card.role='reviewer'
 const reviewTools:any={};await registerStudioTools({tools:{register:(v:any)=>{reviewTools[v.name]=v;return()=>{}}},attachments:{saveImage:async({data}:any)=>{assert.equal(data[0],255);assert.equal(data[1],216);return {attachmentId:hash(data.toString('base64')),bytes:data.length,mediaType:'image/jpeg',width:540,height:960}}}},{input,workflow,isActive:()=>true})
 const result=await reviewTools.studio_inspect_frames.execute({start:0,end:.8});assert.equal(result.images.length,8);assert.equal(receipts.length,1);assert.equal(receipts[0].candidateSha256,await fileSha256(join(s.cwd,'film.mp4')))
})

test('probe returns actual metadata and host-bound receipt',async t=>{const s=await setup(t),r=await s.tools.studio_inspect_probe.execute({});assert.equal(r.probe.streams[0].width,1080);assert.equal(r.receipt.kind,'probe');assert.equal(r.receipt.candidateSha256,hash('video'))})

test('registered manifest read mints source-read evidence and rejects changed manifest',async t=>{const s=await setup(t),r=await s.tools.studio_read_text.execute({path:'manifest.json'});assert.equal(r.receipt.kind,'source');assert.equal(r.receipt.sha256,hash('{}'));await writeFile(join(s.cwd,'manifest.json'),'{"changed":true}');await assert.rejects(s.tools.studio_read_text.execute({path:'manifest.json'}),/manifest-file-changed/)})

test('real reference observations return images and separate receipts; planner cannot inspect candidate',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile)
 try{await run('ffmpeg',['-version'])}catch{t.skip('FFmpeg unavailable');return}
 const s=await setup(t,'planner'),ref=join(s.cwd,'reference.mp4');await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=108x192:r=30','-f','lavfi','-i','sine=frequency=600:sample_rate=16000','-t','1','-pix_fmt','yuv420p','-c:a','aac','-y',ref]);const sha256=await fileSha256(ref),tools:any={},referenceReceipts:any[]=[],candidateReceipts:any[]=[]
 const input={task:{cwd:s.cwd,design:{studio:{referenceSha256:sha256}}},card:{role:'planner'},sessionId:'s'},workflow={recordReceipt:(_:any,v:any)=>candidateReceipts.push(v)}
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async({data}:any)=>{assert.equal(data[0],255);return {attachmentId:hash(data.toString('base64'))}}}},{input,workflow,isActive:()=>true,reference:{path:ref,sha256},referenceReceipt:v=>{referenceReceipts.push(v);return {...v,id:'reference-only'}},audioObserve:async({wavPath})=>({input_modality:'input_audio',audio_sha256:await fileSha256(wavPath),observation:'fixture audio'})})
 const overview=await tools.studio_reference_overview.execute({});assert.equal(overview.images.length,8);assert.equal(overview.frames[0].time,0);assert.ok(overview.frames.at(-1).time>.8);assert.ok(overview.frames.at(-1).time<overview.durationSeconds);assert.equal(overview.scope,'reference-overview-only');assert.equal(overview.qualityApproved,false);assert.equal(overview.audioChecked,false);assert.equal(overview.continuousMotionChecked,false);assert.match(overview.timestampBasis,/actual decoded frame PTS not measured/);assert.equal(overview.distinctImageHashes,1);assert.deepEqual(overview.repeatedImageGroups,[[0,1,2,3,4,5,6,7]]);assert.equal(referenceReceipts.length,0);assert.equal(candidateReceipts.length,0)
 const frames=await tools.studio_reference_frames.execute({start:0,end:.8,referenceSha256:'fake'});assert.equal(frames.images.length,8);assert.equal(frames.referenceSha256,sha256);assert.equal(frames.scope,'reference-only');assert.equal(frames.receipt,undefined)
 const audio=await tools.studio_reference_audio.execute({start:0,end:.8});assert.equal(audio.referenceReceipt.kind,'audio');assert.equal(referenceReceipts.length,2);assert.equal(candidateReceipts.length,0);assert.equal(referenceReceipts[0].candidateSha256,undefined)
 assert.equal(tools.studio_inspect_frames,undefined);await writeFile(ref,'changed');await assert.rejects(tools.studio_reference_overview.execute({}),/reference-file-changed/);await assert.rejects(tools.studio_reference_frames.execute({start:0,end:.5}),/reference-file-changed/)
})

test('audio hook cannot mint evidence for ASR, omitted hash or mismatched source',async t=>{
 const s=await setup(t),tools:any={},receipts:any[]=[];let result:any={input_modality:'text',audio_sha256:'x'}
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordReceipt:(_:any,v:any)=>receipts.push(v)},isActive:()=>true,runCommand:async(_,args)=>{await writeFile(args.at(-1)!,'wav');return {stdout:''}},audioObserve:async()=>result})
 for(const bad of [{input_modality:'text',audio_sha256:hash('wav')},{input_modality:'input_audio'},{input_modality:'input_audio',audio_sha256:'f'.repeat(64)}]){result=bad;await assert.rejects(tools.studio_inspect_audio.execute({start:0,end:1}),/observation-failed/)}assert.equal(receipts.length,0)
})

test('character image is locked by host id and content hash, never caller path',async t=>{
 const s=await setup(t),tools:any={},path=join(s.cwd,'character.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]));const sha256=await fileSha256(path)
 const make=async(role:string,referenceSha256=sha256)=>registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async()=>({attachmentId:'real-image'})}},{input:{task:{cwd:s.cwd},card:{role},sessionId:'s'},workflow:{},isActive:()=>true,characterReferences:[{id:'approved',path,sha256:referenceSha256}]})
 await make('planner');const r=await tools.studio_character_image.execute({id:'approved',path:'/etc/hosts'});assert.equal(r.sha256,sha256);assert.equal(r.images.length,1);await assert.rejects(tools.studio_character_image.execute({id:'../../etc/hosts'}),/reference-id-mismatch.*approved.*not a viewing prohibition/)
 await make('executor');assert.equal((await tools.studio_character_image.execute({id:'approved'})).images.length,1);delete tools.studio_character_image;await make('notifier');assert.equal(tools.studio_character_image,undefined);await make('reviewer','f'.repeat(64));await assert.rejects(tools.studio_character_image.execute({id:'approved'}),/file-changed/)
})

test('Cordis optional attachment service is resolved through ctx.get, never uninjected property',async t=>{
 const s=await setup(t),tools:any={},path=join(s.cwd,'character.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]));const sha256=await fileSha256(path);let mounted=true,gets=0,saves=0
 const service={saveImage:async()=>{saves++;return {attachmentId:'cordis-image'}}}
 const ctx=new Proxy({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},get:(name:string)=>{assert.equal(name,'attachments');gets++;return mounted?service:undefined}}, {get(target,key,receiver){if(key==='attachments')throw Error('cannot get property "attachments" without inject');return Reflect.get(target,key,receiver)}})
 await registerStudioTools(ctx,{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordReceipt:(_:any,v:any)=>v},isActive:()=>true,characterReferences:[{id:'locked',path,sha256}],runCommand:async(_,args)=>{await writeFile(args.at(-1)!,'frame');return {stdout:''}}})
 assert.equal((await tools.studio_character_image.execute({id:'locked'})).images.length,1);assert.equal((await tools.studio_inspect_frames.execute({start:0,end:1})).images.length,8);assert.equal(saves,9);assert.equal(gets,2);mounted=false;await assert.rejects(tools.studio_character_image.execute({id:'locked'}),/attachment-capability-required/)
})

test('producer previews project mix with host hashes and no independent receipts; traversal and wrong role denied',async t=>{
 const s=await setup(t,'executor'),tools:any={};let active=true,wrongHash=false;const receipts:any[]=[]
 const input={task:{cwd:s.cwd},card:{role:'executor'},sessionId:'producer'}
 const register=async()=>registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input,workflow:{recordReceipt:(...a:any[])=>receipts.push(a)},isActive:()=>active,runCommand:async(file,args)=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:12}})};await writeFile(args.at(-1)!,'preview audio');return {stdout:''}},audioObserve:async({wavPath})=>({input_modality:'input_audio',audio_sha256:wrongHash?'bad':await fileSha256(wavPath)})})
 await register();const out=await tools.studio_preview_audio.execute({path:'film.mp4',start:1,end:3});assert.equal(out.sourceSha256,hash('video'));assert.equal(out.audioSha256,hash('preview audio'));assert.equal(out.independentReview,false);assert.equal(out.receipt,undefined);assert.equal(receipts.length,0)
 await assert.rejects(tools.studio_preview_audio.execute({path:'/etc/hosts',start:0,end:1}),/outside-project/);await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:9}),/range/);await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:11,end:13}),/range/);assert.equal(tools.studio_inspect_audio,undefined)
 wrongHash=true;await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:1}),/observation-failed/);wrongHash=false;active=false;await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:1}),/stale/);active=true;for(const deniedRole of ['planner','reviewer','notifier']){input.card.role=deniedRole;await register();await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:1}),/role/)}
})


async function audioRangeFixture(t:any){
 const s=await setup(t,'executor'),commands:string[][]=[],observed:any[]=[],receipts:any[]=[]
 let duration=3.575917
 const register=async(role='executor')=>{
  const tools:any={},input={task:{cwd:s.cwd,design:{studio:{referenceSha256:hash('video')}}},card:{role},sessionId:'range-session'}
  const dispose=await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input,workflow:{status:()=>({candidate:{sha256:hash('video'),durationSeconds:duration}}),candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),recordReceipt:(_:any,v:any)=>{receipts.push(v);return v}},isActive:()=>true,reference:{path:join(s.cwd,'film.mp4'),sha256:hash('video')},referenceReceipt:v=>{receipts.push(v);return v},runCommand:async(file,args)=>{
   if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:String(duration)}})}
   commands.push(args);await writeFile(args.at(-1)!,'fixture decoded audio');return {stdout:''}
  },audioObserve:async(value)=>{observed.push(value);return {input_modality:'input_audio',audio_sha256:await fileSha256(value.wavPath),observation:'Offline range fixture; not provider perception.'}}})
  t.after(dispose);return tools
 }
 return {register,commands,observed,receipts,setDuration:(value:number)=>duration=value}
}

test('producer audio preview clamps only <=1ms EOF rounding and reports the actual extraction and observer range',async t=>{
 const s=await audioRangeFixture(t),tools=await s.register()
 for(const item of [{duration:3.575917,end:3.576},{duration:4.207542,end:4.208},{duration:3.575917,end:3.575917+.001},{duration:3.575917,end:3.575917},{duration:3.575917,end:3.5}]){
  s.setDuration(item.duration)
  const start=.25,actualEnd=Math.min(item.end,item.duration),out=await tools.studio_preview_audio.execute({path:'film.mp4',start,end:item.end}),command=s.commands.at(-1)!,observation=s.observed.at(-1)!
  assert.equal(command[command.indexOf('-ss')+1],String(start))
  assert.equal(command[command.indexOf('-t')+1],String(actualEnd-start),'FFmpeg receives the normalized real duration, never the rounded EOF overshoot')
  assert.equal(observation.start,start);assert.equal(observation.end,actualEnd)
  assert.equal(out.start,start);assert.equal(out.end,actualEnd);assert.equal(out.sourceDurationSeconds,item.duration)
  assert.deepEqual(out.requestedRange,{start,end:item.end});assert.equal(out.rangeNormalized,item.end>item.duration)
  assert.equal(out.sourceSha256,hash('video'));assert.equal(out.audioSha256,hash('fixture decoded audio'))
  assert.equal(out.scope,'producer-self-check-only');assert.equal(out.qualityApproved,false);assert.equal(out.independentReview,false);assert.equal(out.receipt,undefined)
 }
 assert.equal(s.receipts.length,0)
})

test('real FFmpeg producer preview normalizes a millisecond-rounded WAV tail before decoding',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg',ffprobe=process.env.FFPROBE_PATH??'ffprobe'
 try{await run(ffmpeg,['-version']);await run(ffprobe,['-version'])}catch{t.skip('FFmpeg/ffprobe unavailable');return}
 const s=await setup(t,'executor'),source=join(s.cwd,'voice.wav'),tools:any={},commands:string[][]=[]
 await run(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3.575917','-c:a','pcm_s16le','-y',source])
 const probe=JSON.parse((await run(ffprobe,['-v','error','-show_format','-of','json',source])).stdout),duration=Number(probe.format.duration),requestedEnd=Math.ceil(duration*1000)/1000,start=.25
 assert.ok(requestedEnd>duration&&requestedEnd<=duration+.001,'real source has a sub-millisecond rounded tail')
 const dispose=await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd},card:{role:'executor'},sessionId:'real-audio-range'},workflow:{recordReceipt:()=>assert.fail('self-check cannot mint QA evidence')},isActive:()=>true,runCommand:async(file,args)=>{commands.push(args);return {stdout:String((await run(file,args)).stdout)}},audioObserve:async({wavPath,start:actualStart,end})=>{
  assert.equal(actualStart,start);assert.equal(end,duration)
  const decoded=JSON.parse((await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',wavPath])).stdout)
  assert.equal(decoded.streams[0].sample_rate,'16000');assert.equal(decoded.streams[0].channels,1)
  assert.ok(Math.abs(Number(decoded.format.duration)-(duration-start))<=1/16000,'real PCM decoding differs at most by one 16kHz sample')
  return {input_modality:'input_audio',audio_sha256:await fileSha256(wavPath),observation:'Offline decoded WAV fixture; no provider call.'}
 }})
 t.after(dispose)
 const out=await tools.studio_preview_audio.execute({path:'voice.wav',start,end:requestedEnd}),clip=commands.find(args=>args.includes('-vn'))!
 assert.equal(clip[clip.indexOf('-t')+1],String(duration-start));assert.equal(out.start,start);assert.equal(out.end,duration);assert.equal(out.requestedRange.end,requestedEnd);assert.equal(out.rangeNormalized,true)
 assert.equal(out.sourceSha256,await fileSha256(source));assert.equal(out.qualityApproved,false);assert.equal(out.independentReview,false);assert.equal(out.receipt,undefined)
})

test('producer audio preview rejects invalid ranges and >1ms overshoot before extraction; normalized real window is still <=8s',async t=>{
 const s=await audioRangeFixture(t),tools=await s.register(),duration=3.575917
 const invalid=[{start:0,end:duration+.001001},{start:-.000001,end:duration},{start:NaN,end:duration},{start:0,end:NaN},{start:0,end:Infinity},{start:Infinity,end:duration},{start:1,end:1},{start:1,end:.9},{start:duration,end:duration+.0005},{start:duration+.0002,end:duration+.0005}]
 for(const args of invalid){await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',...args}),/studio-invalid-sample-range/);assert.equal(s.commands.length,0);assert.equal(s.observed.length,0)}
 s.setDuration(8.0005)
 await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:8.001}),/studio-invalid-sample-range/)
 assert.equal(s.commands.length,0);assert.equal(s.observed.length,0)
 s.setDuration(12)
 await assert.rejects(tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:8.000001}),/studio-invalid-sample-range/)
 assert.equal(s.commands.length,0)
 s.setDuration(8)
 const out=await tools.studio_preview_audio.execute({path:'film.mp4',start:0,end:8.001})
 assert.equal(out.end,8);assert.equal(out.rangeNormalized,true);assert.equal(s.commands[0][s.commands[0].indexOf('-t')+1],'8');assert.equal(s.observed[0].end,8)
 assert.equal(s.receipts.length,0)
})

test('millisecond producer audio tail normalization does not relax reviewer or locked reference intervals',async t=>{
 const s=await audioRangeFixture(t),producer=await s.register(),reviewer=await s.register('reviewer'),args={start:0,end:3.576}
 await assert.rejects(producer.studio_reference_audio.execute(args),/studio-invalid-sample-range/)
 await assert.rejects(reviewer.studio_reference_audio.execute(args),/studio-invalid-sample-range/)
 await assert.rejects(reviewer.studio_inspect_audio.execute(args),/studio-invalid-sample-range/)
 assert.equal(s.commands.length,0);assert.equal(s.observed.length,0);assert.equal(s.receipts.length,0)
})

test('producer can observe locked reference frames and audio without reviewer candidate access',async t=>{
 const s=await setup(t,'executor'),tools:any={},refs:any[]=[],input={task:{cwd:s.cwd,design:{studio:{referenceSha256:hash('video')}}},card:{role:'executor'},sessionId:'producer'}
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},get:()=>({saveImage:async()=>({attachmentId:'frame'})})},{input,workflow:{},isActive:()=>true,reference:{path:join(s.cwd,'film.mp4'),sha256:hash('video')},referenceReceipt:v=>{refs.push(v);return v},runCommand:async(file,args)=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({format:{duration:100}})};await writeFile(args.at(-1)!,'sample');return {stdout:''}},audioObserve:async({wavPath})=>({input_modality:'input_audio',audio_sha256:await fileSha256(wavPath)})})
 assert.equal((await tools.studio_reference_frames.execute({start:0,end:1})).images.length,8);assert.equal((await tools.studio_reference_audio.execute({start:0,end:2})).scope,'reference-only');assert.equal(refs.length,2);assert.equal(refs.some(v=>v.candidateSha256),false);assert.equal(tools.studio_submit_review,undefined)
})

test('status renews expired host proof once and returns one coherent preflight snapshot',async t=>{
 const s=await setup(t),tools:any={};let status='expired',calls=0,reads=0
 const preflight=()=>({ok:status==='passed',status:status==='passed'?'ready':'blocked_quality_capability',checks:[{name:'audio',status}]})
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd,design:{studio:{referenceSha256:hash('video')}}},card:{role:'executor'},sessionId:'s'},runCommand:async()=>({stdout:JSON.stringify({format:{duration:'98.6'}})}),workflow:{preflight,status:()=>{reads++;return {candidate:null,preflight:preflight()}}},isActive:()=>true,refreshPreflight:async()=>{calls++;status='passed';return {reference:{path:join(s.cwd,'film.mp4'),sha256:hash('video')},characterReferences:[{id:'character',assetId:'primary-asset',path:'locked-image',sha256:'b'.repeat(64),sourceUrl:'https://cdn.vyibc.com/existing/primary.png',sourceSha256:'b'.repeat(64)}]}}})
 const result=await tools.studio_status.execute({});assert.equal(calls,1);assert.equal(result.preflight.ok,true);assert.equal(result.state.preflight,undefined);assert.equal(result.statusProjection.aliases['state.preflight'],'preflight');assert.equal(result.characterReferences[0].id,'character');assert.equal(result.characterReferences[0].sourceUrl,'https://cdn.vyibc.com/existing/primary.png');assert.equal(result.characterReferences[0].sourceSha256,'b'.repeat(64));assert.ok(!('path' in result.characterReferences[0]));assert.equal(reads,1);assert.equal(result.reference.durationSeconds,98.6)
 await tools.studio_status.execute({});assert.equal(calls,1,'unexpired successful proofs do not rerun dependency checks')
})

test('status failed revalidation stays blocked and callback errors cannot become a pass',async t=>{
 const s=await setup(t),tools:any={};let status='missing',calls=0
 const preflight=()=>({ok:false,status:'blocked_quality_capability',checks:[{name:'render',status}]})
 const input={task:{cwd:s.cwd},card:{role:'executor'},sessionId:'s'},workflow={preflight,status:()=>({candidate:null,preflight:preflight()})},ctx={tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}}
 await registerStudioTools(ctx,{input,workflow,isActive:()=>true,refreshPreflight:async()=>{calls++;status='failed'}})
 const result=await tools.studio_status.execute({});assert.equal(result.preflight.ok,false);assert.equal(result.preflight.checks[0].status,'failed');await tools.studio_status.execute({});assert.equal(calls,1)
 status='expired';await registerStudioTools(ctx,{input,workflow,isActive:()=>true,refreshPreflight:async()=>{throw Error('actual host unavailable')}});await assert.rejects(tools.studio_status.execute({}),/host unavailable/)
})

test('status refresh is single-flight and rejects a session becoming inactive during revalidation',async t=>{
 const s=await setup(t),tools:any={};let active=true,calls=0,release!:()=>void
 const waiting=new Promise<void>(r=>release=r),preflight=()=>({ok:false,checks:[{name:'character',status:'expired'}]})
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd},card:{role:'executor'},sessionId:'s'},workflow:{preflight,status:()=>({preflight:preflight()})},isActive:()=>active,refreshPreflight:async()=>{calls++;await waiting}})
 const first=tools.studio_status.execute({}),second=tools.studio_status.execute({});assert.equal(calls,1);active=false;release();await assert.rejects(first,/stale/);await assert.rejects(second,/stale/)
})

test('text-only model receives actual visual observations; failures never create receipts',async t=>{
 const s=await setup(t),tools:any={},receipts:any[]=[];let mode='ok',active=true
 const input={task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'}
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},get:()=>({saveImage:async()=>({attachmentId:'sample'})})},{input,workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordReceipt:(_:any,r:any)=>{receipts.push(r);return r}},isActive:()=>active,runCommand:async(_,args)=>{await writeFile(args.at(-1)!,'frame');return {stdout:''}},visionObserve:async({images})=>{if(mode==='error')throw Error('provider unavailable');if(mode==='stale')active=false;if(mode==='changed')await writeFile(images[0].path,'changed');return {ok:true,input_modality:mode==='text'?'text':'input_image',finish_reason:'stop',images:images.map(({path,...f})=>({...f,sha256:mode==='hash'?'bad':f.sha256})),observation:'Observed visual details'}}})
 const tool=tools.studio_inspect_frames,r=await tool.execute({start:0,end:1});assert.equal(r.observation.input_modality,'input_image');assert.equal(tool.output.render({},r).some((b:any)=>b.type==='image'),false);assert.equal(receipts.length,1)
 for(const value of ['error','text','hash','changed','stale']){mode=value;await assert.rejects(tool.execute({start:0,end:1}));assert.equal(receipts.length,1)}
})

test('producer visual previews stay scoped and never mint reviewer receipts',async t=>{
 const s=await setup(t,'executor'),tools:any={};let active=true;const input={task:{cwd:s.cwd},card:{role:'executor'},sessionId:'s'}
 await writeFile(join(s.cwd,'asset.png'),Buffer.from([137,80,78,71,13,10,26,10,0]))
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input,workflow:{recordReceipt:()=>{throw Error('must not mint receipt')}},isActive:()=>active,runCommand:async(file,args)=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'video'}],format:{duration:5}})};await writeFile(args.at(-1)!,jpegFixture('frame'));return {stdout:''}},visionObserve:async({images,purpose})=>{assert.equal(purpose,'preview');return {ok:true,input_modality:'input_image',finish_reason:'stop',images:images.map(({path,...f})=>f),observation:'observed'}}})
 const r=await tools.studio_preview_image.execute({path:'asset.png'});assert.equal(r.independentReview,false);assert.equal(r.receipt,undefined)
 const frames=await tools.studio_preview_frames.execute({path:'film.mp4',start:0,end:1});assert.equal(frames.frames.length,8);assert.equal(frames.independentReview,false)
 await assert.rejects(tools.studio_preview_image.execute({path:'/etc/hosts'}),/outside-project/);await assert.rejects(tools.studio_preview_frames.execute({path:'film.mp4',start:0,end:3}),/range/)
 input.card.role='reviewer';const other:any={};await registerStudioTools({tools:{register:(v:any)=>{other[v.name]=v;return()=>{}}}},{input,workflow:{},isActive:()=>true});assert.equal(other.studio_preview_image,undefined)
 active=false;await assert.rejects(tools.studio_preview_image.execute({path:'asset.png'}),/stale/)
})

test('actual silent and black encodes are refused before candidate state mutation',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile)
 const s=await setup(t,'executor'),tools:any={};let registered=0
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd,design:{studio:{referenceSha256:'a'.repeat(64)}}},card:{role:'executor'},sessionId:'s'},workflow:{recordCandidate:()=>registered++,recordCandidateLocation:()=>{}},isActive:()=>true})
 const file=join(s.cwd,'film.mp4'),args={path:'film.mp4',manifestPath:'manifest.json',revision:1}
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=108x192:r=30','-t','2','-y',file])
 await assert.rejects(tools.studio_register_candidate.execute(args),/audio-stream-required/)
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=108x192:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-y',file])
 await assert.rejects(tools.studio_register_candidate.execute(args),/mostly-black/)
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x24354b:s=108x192:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-y',file])
 await assert.rejects(tools.studio_register_candidate.execute(args),/mostly-uniform/)
 assert.equal(registered,0)
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=108x192:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-y',file])
 assert.equal((await tools.studio_register_candidate.execute(args)).qualityApproved,false);assert.equal(registered,1)
})


test('text pagination reconstructs unicode and refuses stale or invalid offsets',async t=>{
 const s=await setup(t,'planner'),text='许小满😀'.repeat(15000);await writeFile(join(s.cwd,'inputs.json'),text)
 let result=await s.tools.studio_read_text.execute({path:'inputs.json'}),joined=result.text
 assert.equal(result.completeRead,false)
 while(result.nextOffset!==null){result=await s.tools.studio_read_text.execute({path:'inputs.json',offset:result.nextOffset,expectedSha256:result.sha256});assert.ok(Buffer.byteLength(result.text)<=65536);joined+=result.text}
 assert.equal(joined,text);assert.equal(result.completeRead,true)
 await assert.rejects(s.tools.studio_read_text.execute({path:'inputs.json',offset:1}),/sha256-required/)
 await assert.rejects(s.tools.studio_read_text.execute({path:'inputs.json',offset:-1}),/invalid-page/)
 await writeFile(join(s.cwd,'inputs.json'),'changed')
 await assert.rejects(s.tools.studio_read_text.execute({path:'inputs.json',expectedSha256:result.sha256}),/file-changed/)
})
test('partial manifest cannot mint full source receipt until every range has been read',async t=>{
 const s=await setup(t);const a=await s.tools.studio_read_text.execute({path:'manifest.json',limit:1});assert.equal(a.receipt,undefined);assert.equal(s.receipts.length,0)
 const b=await s.tools.studio_read_text.execute({path:'manifest.json',offset:1,limit:1,expectedSha256:a.sha256});assert.equal(b.receipt.kind,'source');assert.equal(b.completeRead,true)
})
test('range errors expose probed duration and allowed window',async t=>{const s=await setup(t);await assert.rejects(s.tools.studio_inspect_frames.execute({start:99,end:101}),/durationSeconds=100.*maxWindowSeconds=2/)})

test('actual candidate registration is repeatable through file tool and rejects changed manifest',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile)
 const {default:Database}=await import('better-sqlite3'),{StudioWorkflow}=await import('../src/studio-workflow.js')
 const db=new Database(':memory:');t.after(()=>db.close());const workflow=new StudioWorkflow({kernel:{db}})
 const s=await setup(t,'executor'),tools:any={},input:any={task:{id:'retry-task',cwd:s.cwd,design:{evidenceContract:'studio-video-v1',studio:{characterId:'test-character',referenceSha256:'a'.repeat(64),referenceUrl:'https://cdn.vyibc.com/reference.mp4'}}},batch:{id:'batch'},card:{id:'producer-r1',role:'executor',round:1},sessionId:'producer'}
 const path=join(s.cwd,'film.mp4');await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=108x192:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-pix_fmt','yuv420p','-y',path])
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input,workflow,isActive:()=>true})
 const args={path:'film.mp4',manifestPath:'manifest.json',revision:1},first=await tools.studio_register_candidate.execute(args)
 const state=()=>db.prepare('SELECT * FROM dsh_studio_state ORDER BY kind').all()
 const before=state();assert.deepEqual(await tools.studio_register_candidate.execute(args),first);assert.deepEqual(state(),before)
 assert.equal(workflow.candidateLocation(input).sha256,await fileSha256(path))
 await writeFile(join(s.cwd,'manifest.json'),'{"changed":true}');await assert.rejects(tools.studio_register_candidate.execute(args),/revision-must-increase/);assert.deepEqual(state(),before)
 input.sessionId='restored-producer';await writeFile(join(s.cwd,'manifest.json'),'{}');await assert.rejects(tools.studio_register_candidate.execute(args),/revision-must-increase/)
})


test('inspection returns updated host progress only after recording its real observation receipt',async t=>{
 const s=await setup(t),tools:any={},receipts:any[]=[]
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordReceipt:(_:any,r:any)=>{receipts.push(r);return {...r,id:'actual-id'}},reviewProgress:()=>({observationCount:receipts.length,qualityApproved:false})},isActive:()=>true,runCommand:async(_,args)=>{await writeFile(args.at(-1)!,'audio');return {stdout:''}},audioObserve:async({wavPath})=>({input_modality:'input_audio',audio_sha256:await fileSha256(wavPath)})})
 const value=await tools.studio_inspect_audio.execute({start:0,end:3})
 assert.equal(value.receipt.id,'actual-id');assert.equal(value.reviewProgress.observationCount,1);assert.equal(value.reviewProgress.qualityApproved,false)
 assert.equal(value.observation.audio_sha256,hash('audio'))
})

test('sparse overview preserves dedicated vision purpose, rejects unauthorized roles and file mutation',async t=>{
 const s=await setup(t,'planner'),tools:any={},ref=join(s.cwd,'film.mp4');let mutate=false,seen:any
 const make=(role:string)=>registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async()=>({attachmentId:'fixture'})}},{input:{task:{cwd:s.cwd,design:{studio:{referenceSha256:hash('video')}}},card:{role},sessionId:'s'},workflow:{recordReceipt:()=>assert.fail('overview cannot mint receipt')},isActive:()=>true,reference:{path:ref,sha256:hash('video')},referenceReceipt:()=>assert.fail('overview cannot satisfy planner gate'),runCommand:async(file,args)=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({format:{duration:98.6}})};await writeFile(args.at(-1)!,'frame');return {stdout:''}},visionObserve:async value=>{seen=value;if(mutate)await writeFile(ref,'changed');return {ok:true,input_modality:'input_image',finish_reason:'stop',observation:'fixture',images:value.images}}})
 await make('notifier');assert.equal(tools.studio_reference_overview,undefined);assert.equal(seen,undefined)
 await make('planner');const result=await tools.studio_reference_overview.execute({});assert.equal(seen.purpose,'reference_overview');assert.equal(seen.images.length,8);assert.equal(result.frames.at(-1).time,98.35);assert.equal(result.qualityApproved,false);assert.equal(tools.studio_reference_overview.output.render({},result).filter((v:any)=>v.type==='image').length,0)
 mutate=true;await assert.rejects(tools.studio_reference_overview.execute({}),/reference-file-changed/)
})

test('strict-profile registered review publishes repair schema and native runtime rejects incomplete or placeholder issues',async t=>{
 const {ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{createRequire}=await import('node:module'),{pathToFileURL}=await import('node:url'),{dirname}=await import('node:path'),require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const s=await setup(t),ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),agent={ctx,session:{id:'strict-tool-session'}},tools:any={},reports:any[]=[]
 const previousMode=process.env.NODE_ENV;let dispose:()=>void=()=>{}
 try{
  // This case deliberately uses the actual SDK rather than the test-mode shim.
  process.env.NODE_ENV='development'
  dispose=await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return runtime.register(v)}}},{input:{task:{cwd:s.cwd,design:{studio:{structuredRepairs:true}}},card:{role:'reviewer'},sessionId:'strict-tool-session'},workflow:{status:()=>({candidate:s.getCandidate()}),candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),recordValidatedReview:(_:any,r:any)=>reports.push(r)},isActive:()=>true})
 }finally{if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode}
 t.after(()=>dispose())
 const schema=tools.studio_submit_review.parameters,issueSchema=schema.properties.issues.items
 for(const field of ['dimension','ranges','responsibleStage','cause','repair','verification'])assert.ok(issueSchema.required.includes(field),field+' must be advertised to the model')
 assert.deepEqual(issueSchema.properties.repair.required,['action','target','fromCandidateSha256'])
 assert.equal(issueSchema.properties.repair.additionalProperties,false)
 const invoke=(args:any)=>runtime.execute({name:'studio_submit_review',arguments:args,agent,callId:'strict-tool-shape',signal:new AbortController().signal} as any)
 assert.equal((await invoke({checks:[],issues:[{id:'legacy-only',severity:'major',status:'open'}]})).isError,true)
 assert.equal(reports.length,0)
 const report={checks:[{dimension:'motion',status:'fail',finding:'Fixture shows the reaction before its trigger.',ranges:[[0,2]],evidenceReceiptIds:['fixture-frames']}],issues:[{id:'motion-open',dimension:'motion',severity:'major',status:'open',ranges:[[0,2]],sceneId:'opening',responsibleStage:'storyboard',cause:'The reaction precedes the trigger.',repair:{action:'Place the trigger before the reaction.',target:'opening sequence',fromCandidateSha256:hash('video')},verification:{method:'frames',finding:'Inspect trigger then reaction in the repaired opening.',evidenceReceiptIds:[]}}]}
 const placeholder=structuredClone(report);placeholder.issues[0].cause='TBD'
 assert.equal((await invoke(placeholder)).isError,true);assert.equal(reports.length,0,'runtime execution still enforces concrete repair text after schema validation')
 assert.equal((await invoke(report)).isError,false);assert.equal(reports.length,1)
 assert.equal(reports[0].candidateSha256,hash('video'));assert.equal(reports[0].referenceSha256,s.getCandidate().referenceSha256);assert.equal(reports[0].revision,1)
 // This verifies the real tool shape/host binding, not the separate workflow QA gate.
 assert.equal(reports[0].issues[0].status,'open')
})

test('all four frame entrypoints use bounded two workers while keeping requested order and original evidence scope',async t=>{
 const s=await setup(t),tools:any={},candidateReceipts:any[]=[],referenceReceipts:any[]=[],purposes:string[]=[]
 let calls:number[]=[],inFlight=0,maxInFlight=0
 const register=(role:string)=>registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async({data}:any)=>({attachmentId:hash(data),mediaType:'image/jpeg'})}},{input:{task:{cwd:s.cwd,design:{studio:{referenceSha256:hash('video')}}},card:{role},sessionId:'s'},workflow:{status:()=>({candidate:s.getCandidate()}),candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),recordReceipt:(_:any,r:any)=>{candidateReceipts.push(r);return r}},isActive:()=>true,reference:{path:join(s.cwd,'film.mp4'),sha256:hash('video')},referenceReceipt:r=>{referenceReceipts.push(r);return r},runCommand:async(file,args)=>{
  if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'video'}],format:{duration:100}})}
  assert.equal(args[3],'-ss');assert.equal(args[5],'-i')
  const time=Number(args[4]),index=Number(args.at(-1)!.match(/(\d+)\.jpg$/)![1]);calls.push(time);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight)
  try{await new Promise(r=>setTimeout(r,index%2===0?8:1));await writeFile(args.at(-1)!,jpegFixture(`fixture-frame-${time}`));return {stdout:''}}finally{inFlight--}
 },visionObserve:async({images,purpose})=>{purposes.push(purpose);return {ok:true,input_modality:'input_image',finish_reason:'stop',images:images.map(({path,...v})=>v),observation:'Fixture visual observation; not whole-film approval.'}}})
 const cases=[{name:'studio_inspect_frames',role:'reviewer',args:{start:0,end:2},times:Array.from({length:8},(_,i)=>i/4),purpose:'candidate'},
  {name:'studio_reference_frames',role:'reviewer',args:{start:0,end:2},times:Array.from({length:8},(_,i)=>i/4),purpose:'reference'},
  {name:'studio_reference_overview',role:'planner',args:{},times:Array.from({length:8},(_,i)=>99.75*i/7),purpose:'reference_overview'},
  {name:'studio_preview_frames',role:'executor',args:{path:'film.mp4',start:0,end:2},times:Array.from({length:8},(_,i)=>i/4),purpose:'preview'}]
 for(const item of cases){
  const dispose=await register(item.role);calls=[];maxInFlight=0
  try{
   const result=await tools[item.name].execute(item.args)
   assert.equal(maxInFlight,2,item.name);assert.equal(inFlight,0);assert.deepEqual(calls,item.times,item.name+' must retain the eight separate input seeks')
   assert.deepEqual(result.frames.map((f:any)=>f.time),item.times);assert.deepEqual(result.frames.map((f:any)=>f.sha256),item.times.map(time=>hash(jpegFixture(`fixture-frame-${time}`))))
   assert.equal(purposes.at(-1),item.purpose)
   if(item.name==='studio_reference_frames')assert.equal(result.qualityApproved,undefined,'reference observation does not provide candidate quality approval')
   else assert.equal(result.qualityApproved,false)
   if(result.images?.length)assert.deepEqual(result.images.map((image:any)=>image.attachmentId),result.frames.map((frame:any)=>frame.sha256))
   if(item.name==='studio_inspect_frames'){assert.deepEqual(result.receipt.ranges,[[0,2]]);assert.equal(result.receipt.candidateSha256,hash('video'));assert.match(result.sampling,/remain unchecked/)}
   else assert.equal(result.receipt,undefined,'reference and producer views must not mint candidate evidence')
   if(item.name==='studio_reference_frames'){assert.deepEqual(result.referenceReceipt.ranges,[[0,2]]);assert.equal(result.referenceReceipt.candidateSha256,undefined)}
   if(item.name==='studio_reference_overview'){assert.equal(result.referenceReceipt,undefined);assert.equal(result.continuousMotionChecked,false);assert.match(result.timestampBasis,/PTS not measured/)}
   if(item.name==='studio_preview_frames')assert.equal(result.independentReview,false)
  }finally{dispose()}
 }
 assert.equal(candidateReceipts.length,1);assert.equal(referenceReceipts.length,1)
})

test('frame entrypoint drains a failed pair without dispatching remaining seeks or minting partial evidence',async t=>{
 const s=await setup(t),tools:any={},calls:number[]=[];let inFlight=0,savedImages=0,minted=0
 const dispose=await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async()=>{savedImages++;return {attachmentId:'must-not-save'}}}},{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{status:()=>({candidate:s.getCandidate()}),candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),recordReceipt:()=>{minted++;return {}}},isActive:()=>true,runCommand:async(_,args)=>{
  const time=Number(args[4]);calls.push(time);inFlight++
  try{await new Promise(r=>setTimeout(r,time===0?1:10));if(time===0)throw Error('fixture-seek-failed');await writeFile(args.at(-1)!,'sibling-frame');return {stdout:''}}finally{inFlight--}
 }})
 t.after(()=>dispose())
 await assert.rejects(tools.studio_inspect_frames.execute({start:0,end:2}),/fixture-seek-failed/)
 assert.deepEqual(calls,[0,.25]);assert.equal(inFlight,0);assert.equal(savedImages,0);assert.equal(minted,0)
})

test('strict candidate file tool rejects changed compiled index provenance atomically and accepts the matching host record',async t=>{
 // Probe/render facts are trusted-host contract fixtures, not actual rendering or QA.
 const {default:Database}=await import('better-sqlite3'),{StudioWorkflow}=await import('../src/studio-workflow.js'),{buildStudioReviewCoveragePlan}=await import('../src/studio-review-coverage.mjs')
 const s=await setup(t,'executor'),db=new Database(':memory:');t.after(()=>db.close())
 const store:any={kernel:{db},s:{runs:new Map([['producer-run',{id:'producer-run',cardId:'e1',sessionId:'producer',status:'running'}]])}},workflow=new StudioWorkflow(store),tools:any={}
 const task:any={id:'tool-coverage-task',cwd:s.cwd,design:{evidenceContract:'studio-video-v1',studio:{characterId:'fixture',referenceSha256:'a'.repeat(64),referenceUrl:'https://cdn.vyibc.com/fixture.mp4',reviewCoverage:'scene-action-v1'}}}
 const producer:any={task,batch:{id:'batch'},card:{id:'e1',role:'executor',round:1},sessionId:'producer'},planner={...producer,card:{id:'p1',role:'planner',round:1},sessionId:'planner'}
 const lines=[{id:'one',text:'完整原稿台词。'}],scriptSha256=hash(JSON.stringify(lines));workflow.recordScript(planner,{sha256:scriptSha256,lines})
 const doc=(value:any)=>{const bytes=Buffer.from(JSON.stringify(value));return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')}}
 const plan=buildStudioReviewCoveragePlan({storyboard:doc({scriptSha256,script:lines,scenes:[{id:'opening'}]}),executionBoard:doc({schema:'studio-board-v1',duration:100,script:lines,scenes:[{id:'opening',start:0,duration:100,layers:[{type:'image',motion:[{at:10,duration:2,to:{x:10}}]}]}]}),scriptSha256}),composition='fixture-composition',indexSha256=hash('<html>actual frozen fixture compiler bytes</html>')
 workflow.recordCompiledCoverage(producer,{composition,indexSha256,plan})
 const renderRecord=(output:string,actualIndexSha256:string)=>{
  const job=workflow.renderLedger.prepare(producer,'start',{composition,output},{renderJobScript:'/fixture/trusted/render.py',renderJobSha256:'d'.repeat(64),renderRuntime:'/fixture/runtime'})
  workflow.renderLedger.record(producer,job,{ok:true,intentId:job.intentId,jobId:hash(output),inputSha256:'f'.repeat(64),inputIndexSha256:actualIndexSha256,composition,output,state:'completed',outputSha256:hash('video'),width:1080,height:1920,fps:30,durationSeconds:100,helperSha256:'d'.repeat(64),helperPath:'/fixture/trusted/render.py',runtimePath:'/fixture/runtime'})
 }
 renderRecord('film.mp4','e'.repeat(64))
 const dispose=await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:producer,workflow,isActive:()=>true,runCommand:async(file)=>file.includes('ffprobe')?{stdout:JSON.stringify({streams:[{codec_type:'video',width:1080,height:1920,avg_frame_rate:'30/1'},{codec_type:'audio'}],format:{duration:100}})}:{stdout:''}})
 t.after(()=>dispose())
 const state=()=>db.prepare('SELECT * FROM dsh_studio_state ORDER BY kind').all(),before=state()
 await assert.rejects(tools.studio_register_candidate.execute({path:'film.mp4',manifestPath:'manifest.json',revision:1}),/render-source-mismatch/)
 assert.deepEqual(state(),before);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dsh_studio_state WHERE kind IN ('candidate','candidate_location','candidate_review_coverage')").get()!.n,0)
 await writeFile(join(s.cwd,'correct.mp4'),'video');renderRecord('correct.mp4',indexSha256)
 const result=await tools.studio_register_candidate.execute({path:'correct.mp4',manifestPath:'manifest.json',revision:1})
 assert.equal(result.candidate.sha256,await fileSha256(join(s.cwd,'correct.mp4')));assert.equal(result.qualityApproved,false)
 const bound=JSON.parse(db.prepare("SELECT payload FROM dsh_studio_state WHERE kind='candidate_review_coverage'").get()!.payload)
 assert.equal(bound.candidateSha256,hash('video'));assert.equal(bound.revision,1);assert.equal(bound.planSha256,plan.planSha256)
})
