import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,symlink,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {registerStudioTools,studioPath,fileSha256} from '../src/studio-tools.ts'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
async function setup(t:any,role='reviewer'){
 const cwd=await mkdtemp(join(tmpdir(),'studio-tools-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await writeFile(join(cwd,'film.mp4'),'video');await writeFile(join(cwd,'manifest.json'),'{}')
 const tools:any={},receipts:any[]=[],reviews:any[]=[];let candidate:any={sha256:hash('video'),manifestSha256:hash('{}'),referenceSha256:'a'.repeat(64),durationSeconds:100,revision:1},location:any={path:join(cwd,'film.mp4'),manifestPath:join(cwd,'manifest.json')},active=true
 const workflow={preflight:()=>({ok:true}),status:()=>({candidate:{candidate}}),candidateLocation:()=>location,recordCandidate:(_:any,c:any)=>candidate=c,recordCandidateLocation:(_:any,l:any)=>location=l,recordReceipt:(_:any,r:any)=>{receipts.push(r);return {...r,id:'host-id'}},recordReview:(_:any,r:any)=>reviews.push(r)}
 const input={task:{cwd,design:{studio:{referenceSha256:'a'.repeat(64)}}},card:{role},sessionId:'s'},agentCtx={tools:{register:(s:any)=>{tools[s.name]=s;return()=>delete tools[s.name]}},attachments:{saveImage:async({data}:any)=>({attachmentId:hash(data.toString()),mediaType:'image/jpeg',bytes:data.length,width:540,height:960})}}
 const runCommand=async(file:string,args:string[])=>{if(file.includes('ffprobe'))return {stdout:JSON.stringify({streams:[{codec_type:'video',width:1080,height:1920,avg_frame_rate:'30/1'}],format:{duration:'100'}})};await writeFile(args.at(-1)!,`actual-frame-${args[4]}`);return {stdout:''}}
 const dispose=await registerStudioTools(agentCtx,{input,workflow,isActive:()=>active,runCommand,audioObserve:async({wavPath})=>({observation:'actual audio',calibrated:false,input_modality:'input_audio',audio_sha256:await fileSha256(wavPath)})})
 return {cwd,tools,receipts,reviews,dispose,deactivate:()=>active=false,getCandidate:()=>candidate}
}
test('realpath confines symlinks and traversal; text rejects hidden/sensitive',async t=>{const s=await setup(t);await symlink('/etc/hosts',join(s.cwd,'escape'));await assert.rejects(studioPath(s.cwd,'escape'),/outside/);await assert.rejects(studioPath(s.cwd,'../../../etc/hosts'));await writeFile(join(s.cwd,'.env'),'secret');await assert.rejects(studioPath(s.cwd,'.env',true),/sensitive/);await writeFile(join(s.cwd,'credentials.json'),'{}');await assert.rejects(studioPath(s.cwd,'credentials.json',true),/sensitive/)})
test('producer registers actual hashes and probe dimensions',async t=>{const s=await setup(t,'executor');await s.tools.studio_register_candidate.execute({path:'film.mp4',manifestPath:'manifest.json',revision:2});assert.equal(s.getCandidate().sha256,hash('video'));assert.equal(s.getCandidate().manifestSha256,hash('{}'));assert.equal(s.getCandidate().fps,30);assert.equal(await fileSha256(join(s.cwd,'film.mp4')),hash('video'))})
test('role denial and stale session reject before work',async t=>{const s=await setup(t,'planner');await assert.rejects(s.tools.studio_register_candidate.execute({}),/role/);await assert.rejects(s.tools.studio_status.execute({}, {agent:{session:{id:'other'}}}),/session/);s.deactivate();await assert.rejects(s.tools.studio_status.execute({}),/stale/)})
test('read text is bounded and binaries rejected',async t=>{const s=await setup(t);assert.equal((await s.tools.studio_read_text.execute({path:'manifest.json'})).text,'{}');await writeFile(join(s.cwd,'large.txt'),'x'.repeat(65537));await assert.rejects(s.tools.studio_read_text.execute({path:'large.txt'}),/large/);await writeFile(join(s.cwd,'binary.txt'),Buffer.from([0,1]));await assert.rejects(s.tools.studio_read_text.execute({path:'binary.txt'}),/invalid/)})
test('ordered actual frames return durable image blocks and trusted receipt',async t=>{const s=await setup(t),tool=s.tools.studio_inspect_frames,result=await tool.execute({start:0,end:2}),content=tool.output.render({},result);assert.equal(content.filter((b:any)=>b.type==='image').length,8);assert.equal(result.frames.length,8);assert.equal(s.receipts[0].kind,'frames');assert.equal(s.receipts[0].candidateSha256,hash('video'));assert.match(s.receipts[0].sha256,/^[a-f0-9]{64}$/);await assert.rejects(tool.execute({start:0,end:4}),/range/)})
test('changed candidate refused and no receipt minted',async t=>{const s=await setup(t);await writeFile(join(s.cwd,'film.mp4'),'altered');await assert.rejects(s.tools.studio_inspect_frames.execute({start:0,end:1}),/changed/);assert.equal(s.receipts.length,0)})
test('review identity and version supplied by host; not acceptance',async t=>{const s=await setup(t),r=await s.tools.studio_submit_review.execute({checks:[],issues:[],candidateSha256:'fake',revision:900});assert.equal(s.reviews[0].candidateSha256,hash('video'));assert.equal(s.reviews[0].revision,1);assert.equal(r.qualityApproved,false)})
test('audio actual host wav hash recorded with calibration result intact',async t=>{const s=await setup(t),r=await s.tools.studio_inspect_audio.execute({start:1,end:3});assert.equal(r.observation.calibrated,false);assert.equal(r.receipt.kind,'audio');assert.equal(r.qualityApproved,false);await assert.rejects(s.tools.studio_inspect_audio.execute({start:0,end:9}),/range/)})
test('disposer removes registered tools',async t=>{const s=await setup(t);s.dispose();assert.equal(Object.keys(s.tools).length,0)})
test('real FFmpeg MP4 probe and frame extraction integration',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile)
 try{await run('ffmpeg',['-version']);await run('ffprobe',['-version'])}catch{t.skip('FFmpeg/ffprobe unavailable');return}
 const s=await setup(t,'executor');await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=108x192:r=30','-t','1','-pix_fmt','yuv420p','-y',join(s.cwd,'film.mp4')])
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
 const frames=await tools.studio_reference_frames.execute({start:0,end:.8,referenceSha256:'fake'});assert.equal(frames.images.length,8);assert.equal(frames.referenceSha256,sha256);assert.equal(frames.scope,'reference-only');assert.equal(frames.receipt,undefined)
 const audio=await tools.studio_reference_audio.execute({start:0,end:.8});assert.equal(audio.referenceReceipt.kind,'audio');assert.equal(referenceReceipts.length,2);assert.equal(candidateReceipts.length,0);assert.equal(referenceReceipts[0].candidateSha256,undefined)
 await assert.rejects(tools.studio_inspect_frames.execute({start:0,end:.5}),/role/);await writeFile(ref,'changed');await assert.rejects(tools.studio_reference_frames.execute({start:0,end:.5}),/reference-file-changed/)
})

test('audio hook cannot mint evidence for ASR, omitted hash or mismatched source',async t=>{
 const s=await setup(t),tools:any={},receipts:any[]=[];let result:any={input_modality:'text',audio_sha256:'x'}
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordReceipt:(_:any,v:any)=>receipts.push(v)},isActive:()=>true,runCommand:async(_,args)=>{await writeFile(args.at(-1)!,'wav');return {stdout:''}},audioObserve:async()=>result})
 for(const bad of [{input_modality:'text',audio_sha256:hash('wav')},{input_modality:'input_audio'},{input_modality:'input_audio',audio_sha256:'f'.repeat(64)}]){result=bad;await assert.rejects(tools.studio_inspect_audio.execute({start:0,end:1}),/observation-failed/)}assert.equal(receipts.length,0)
})

test('character image is locked by host id and content hash, never caller path',async t=>{
 const s=await setup(t),tools:any={},path=join(s.cwd,'character.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]));const sha256=await fileSha256(path)
 const make=async(role:string,referenceSha256=sha256)=>registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},attachments:{saveImage:async()=>({attachmentId:'real-image'})}},{input:{task:{cwd:s.cwd},card:{role},sessionId:'s'},workflow:{},isActive:()=>true,characterReferences:[{id:'approved',path,sha256:referenceSha256}]})
 await make('planner');const r=await tools.studio_character_image.execute({id:'approved',path:'/etc/hosts'});assert.equal(r.sha256,sha256);assert.equal(r.images.length,1);await assert.rejects(tools.studio_character_image.execute({id:'../../etc/hosts'}),/lock-required/)
 await make('executor');await assert.rejects(tools.studio_character_image.execute({id:'approved'}),/role/);await make('reviewer','f'.repeat(64));await assert.rejects(tools.studio_character_image.execute({id:'approved'}),/file-changed/)
})

test('Cordis optional attachment service is resolved through ctx.get, never uninjected property',async t=>{
 const s=await setup(t),tools:any={},path=join(s.cwd,'character.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]));const sha256=await fileSha256(path);let mounted=true,gets=0,saves=0
 const service={saveImage:async()=>{saves++;return {attachmentId:'cordis-image'}}}
 const ctx=new Proxy({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}},get:(name:string)=>{assert.equal(name,'attachments');gets++;return mounted?service:undefined}}, {get(target,key,receiver){if(key==='attachments')throw Error('cannot get property "attachments" without inject');return Reflect.get(target,key,receiver)}})
 await registerStudioTools(ctx,{input:{task:{cwd:s.cwd},card:{role:'reviewer'},sessionId:'s'},workflow:{candidateLocation:()=>({path:join(s.cwd,'film.mp4')}),status:()=>({candidate:s.getCandidate()}),recordReceipt:(_:any,v:any)=>v},isActive:()=>true,characterReferences:[{id:'locked',path,sha256}],runCommand:async(_,args)=>{await writeFile(args.at(-1)!,'frame');return {stdout:''}}})
 assert.equal((await tools.studio_character_image.execute({id:'locked'})).images.length,1);assert.equal((await tools.studio_inspect_frames.execute({start:0,end:1})).images.length,8);assert.equal(saves,9);assert.equal(gets,2);mounted=false;await assert.rejects(tools.studio_character_image.execute({id:'locked'}),/attachment-capability-required/)
})
