/** Run-scoped media tools. Paths and evidence hashes are host-derived, never model claims. */
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {realpath,readFile,stat,mkdir,mkdtemp} from 'node:fs/promises'
import {resolve,relative,sep,basename,extname,join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const run=promisify(execFile)
export const STUDIO_TOOL_NAMES=['studio_status','studio_register_candidate','studio_read_text','studio_inspect_frames','studio_inspect_probe','studio_inspect_audio','studio_submit_review','studio_reference_frames','studio_reference_audio','studio_character_image','studio_preview_audio','studio_preview_image','studio_preview_frames'] as const
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
export async function fileSha256(path:string){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex')}
export async function studioPath(cwd:string,value:string,text=false){
 if(typeof value!=='string'||!value||value.includes('\0'))throw Error('studio-invalid-path')
 const root=await realpath(cwd),p=await realpath(resolve(root,value)),rel=relative(root,p)
 if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||resolve(root,rel)!==p)throw Error('studio-path-outside-project')
 if(text&&rel.split(sep).some(s=>s.startsWith('.')||/credential|secret|token|password|private.?key/i.test(s)))throw Error('studio-sensitive-path')
 if(!(await stat(p)).isFile())throw Error('studio-file-required')
 return p
}
export interface VisionInput {images:{path:string;sha256:string;time?:number}[];purpose:'character'|'reference'|'candidate'|'preview'}
export interface StudioToolOptions {submitReview?:()=>Promise<void>;visionObserve?:(value:VisionInput)=>Promise<any>;input:any;workflow:any;isActive:()=>boolean;refreshPreflight?:()=>Promise<{reference?:{path:string;sha256:string};characterReferences?:{id:string;path:string;sha256:string}[]}|void>;audioObserve?:(value:{wavPath:string;start:number;end:number})=>Promise<any>;runCommand?:(file:string,args:string[])=>Promise<{stdout:string}>;reference?:{path:string;sha256:string};characterReferences?:{id:string;path:string;sha256:string}[];referenceReceipt?:(value:{referenceSha256:string;kind:'frames'|'audio';ranges:number[][];sha256:string})=>any}
export async function registerStudioTools(agentCtx:any,options:StudioToolOptions):Promise<()=>void>{
 const {input,workflow,isActive}=options,role=input.card?.role,disposers:(()=>void)[]=[]
 const defineTool=process.env.NODE_ENV==='test'?(s:any)=>s:(await import('@deepseek-ai/dsh-tools')).defineTool
 const command=options.runCommand??((file,args)=>run(file,args,{timeout:60000,maxBuffer:1024*1024}).then(r=>({stdout:String(r.stdout)})))
 const check=(exec?:any)=>{if(!isActive())throw Error('studio-stale-run');const id=exec?.agent?.session?.id;if(id&&id!==input.sessionId)throw Error('studio-session-mismatch')}
 // Match dsh-mcp-client resolveImageAdmission: optional Cordis services must use
 // ctx.get(), since property access requires a declared inject dependency.
 const attachmentStore=()=>{const store=typeof agentCtx.get==='function'?agentCtx.get('attachments'):agentCtx.attachments;if(typeof store?.saveImage!=='function')throw Error('studio-image-attachment-capability-required');return store}
 const requireRole=(roles:string[])=>{if(!roles.includes(role))throw Error('studio-role-denied')}
 const register=(name:string,description:string,parameters:any,execute:(args:any)=>Promise<any>,images=false,terminates=false)=>{
  disposers.push(agentCtx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:(_:any,v:any)=>[{type:'text',text:JSON.stringify(images?{...v,images:undefined}:v)},...(images&&!options.visionObserve?(v.images??[]).map((attachment:any)=>({type:'image',attachment})):[])]},async execute(args:any,exec:any){check(exec);const result=await execute(args);if(!terminates||!options.submitReview)check(exec);return JSON.parse(JSON.stringify(result))}})))
 }
 const observe=async(images:VisionInput['images'],purpose:VisionInput['purpose'])=>{
  if(!options.visionObserve)return undefined
  check();const result=await options.visionObserve({images,purpose});check()
  if(result?.ok!==true||result.input_modality!=='input_image'||result.finish_reason!=='stop'||!result.observation||!Array.isArray(result.images)||result.images.length!==images.length)throw Error('studio-vision-observation-invalid')
  for(let i=0;i<images.length;i++){const expected=images[i],actual=result.images[i];if(actual.sha256!==expected.sha256||actual.time!==expected.time||await fileSha256(expected.path)!==expected.sha256)throw Error('studio-vision-file-changed')}
  return result
 }
 const current=async()=>{const location=workflow.candidateLocation(input),state=workflow.status(input),saved=state.candidate,candidate=saved?.candidate??saved;if(!location||!candidate)throw Error('studio-candidate-required');const path=await studioPath(input.task.cwd,location.path);if(await fileSha256(path)!==candidate.sha256)throw Error('studio-candidate-file-changed');check();return {path,candidate}}
 const directory=async()=>{const root=await realpath(input.task.cwd),base=join(root,'.studio-review');await mkdir(base,{recursive:true,mode:0o700});if(await realpath(base)!==base)throw Error('studio-review-directory-symlink');return mkdtemp(join(base,'sample-'))}
 const interval=(args:any,duration:number,max:number)=>{const {start,end}=args;if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration||end-start>max)throw Error(`studio-invalid-sample-range: durationSeconds=${duration}; require 0 <= start < end <= ${duration}, maxWindowSeconds=${max}`);return [start,end]}
 let refreshingPreflight:Promise<void>|undefined,lastRefreshAttempt=0
 register('studio_status','Read host preflight and current version-bound state. Expired/missing host proofs trigger actual dependency revalidation; never aesthetic approval.',{},async()=>{
  let preflight=workflow.preflight(input.task)
  const needsRefresh=preflight.ok!==true&&preflight.checks?.some((c:any)=>['expired','missing','policy_mismatch','unknown'].includes(c.status))
  if(needsRefresh&&options.refreshPreflight){
   if(!refreshingPreflight&&Date.now()-lastRefreshAttempt>=60000){
    lastRefreshAttempt=Date.now()
    refreshingPreflight=(async()=>{check();const locks=await options.refreshPreflight!();check();if(locks){options.reference=locks.reference;options.characterReferences=locks.characterReferences}})().finally(()=>{refreshingPreflight=undefined})
   }
   if(refreshingPreflight)await refreshingPreflight
  }
  check();const state=workflow.status(input)
  // status() performs the authoritative fresh preflight once; expose that exact
  // snapshot at both levels, avoiding split results at an expiration boundary.
  preflight=state.preflight??workflow.preflight(input.task)
  const artifacts=state.candidate?(()=>{const loc=workflow.candidateLocation(input);return {manifestPath:relative(input.task.cwd,loc.manifestPath),videoPath:relative(input.task.cwd,loc.path)}})():null
  return {preflight,state:{...state,preflight},artifacts,reference:options.reference?{sha256:options.reference.sha256,durationSeconds:(await lockedReference()).duration}:null,characterReferences:(options.characterReferences??[]).map(({id,sha256})=>({id,sha256}))}
 })
 register('studio_register_candidate','Producer only: register actual project MP4 and manifest after host probing and hashing.',{path:{type:'string',required:true},manifestPath:{type:'string',required:true},revision:{type:'number',required:true}},async args=>{
  requireRole(['executor']);if(!Number.isInteger(args.revision)||args.revision<1)throw Error('studio-invalid-revision')
  const path=await studioPath(input.task.cwd,args.path),manifestPath=await studioPath(input.task.cwd,args.manifestPath)
  if(extname(path).toLowerCase()!=='.mp4')throw Error('studio-mp4-required')
  const before=await fileSha256(path),probe=JSON.parse((await command(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_streams','-show_format','-of','json',path])).stdout),video=probe.streams?.find((s:any)=>s.codec_type==='video')
  if(!video)throw Error('studio-video-stream-required')
  if(!probe.streams?.some((s:any)=>s.codec_type==='audio'))throw Error('studio-candidate-audio-stream-required: rendered file has no audio; repair the composition and mix before registering')
  const [n,d]=String(video.avg_frame_rate??'0/1').split('/').map(Number),candidate={sha256:await fileSha256(path),manifestSha256:await fileSha256(manifestPath),referenceSha256:input.task.design.studio.referenceSha256,revision:args.revision,durationSeconds:Number(probe.format?.duration),width:Number(video.width),height:Number(video.height),fps:n/d}
  if(candidate.sha256!==before)throw Error('studio-candidate-file-changed');if(![candidate.durationSeconds,candidate.width,candidate.height,candidate.fps].every(x=>Number.isFinite(x)&&x>0))throw Error('studio-probe-invalid')
  const scan=await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-i',path,'-an','-vf','fps=1,scale=160:90,blackframe=amount=98:threshold=32,signalstats,metadata=print:file=-','-f','null','-'])
  const blackSamples=[...scan.stdout.matchAll(/lavfi\.blackframe\.pblack=(\d+(?:\.\d+)?)/g)].filter(m=>Number(m[1])>=98).length
  if(blackSamples>=Math.max(1,Math.floor(candidate.durationSeconds)*0.9))throw Error('studio-candidate-mostly-black: at least 90% of one-second samples are black; repair scene loading before registering')
  const uniformSamples=scan.stdout.split(/frame:\s*\d+/).filter(frame=>['Y','U','V'].every(channel=>{
    const lo=frame.match(new RegExp(`lavfi\\.signalstats\\.${channel}MIN=(\\d+(?:\\.\\d+)?)`)),hi=frame.match(new RegExp(`lavfi\\.signalstats\\.${channel}MAX=(\\d+(?:\\.\\d+)?)`))
    return !!lo&&!!hi&&Number(hi[1])-Number(lo[1])<=2
  })).length
  if(uniformSamples>=Math.max(1,Math.floor(candidate.durationSeconds)*0.9))throw Error('studio-candidate-mostly-uniform: at least 90% of one-second samples contain only a nearly uniform color; verify mounted visible scenes before registering. This is technical rejection, not aesthetic scoring.')
  if(await fileSha256(path)!==before||await fileSha256(manifestPath)!==candidate.manifestSha256)throw Error('studio-candidate-file-changed')
  check();workflow.recordCandidate(input,candidate);workflow.recordCandidateLocation(input,{path,manifestPath,sha256:candidate.sha256});return {candidate,qualityApproved:false}
 })
 const textCoverage=new Map<string,{sha256:string;ranges:number[][]}>()
 register('studio_read_text','Planner/reviewer only: paginated UTF-8 project text. Follow nextOffset until null using returned sha256 as expectedSha256. Offsets/counts are UTF-16 code units. Partial reads do not certify full source review. Hidden/sensitive paths excluded.',{path:{type:'string',required:true},offset:{type:'number'},limit:{type:'number'},expectedSha256:{type:'string'}},async args=>{
  requireRole(['planner','reviewer']);const path=await studioPath(input.task.cwd,args.path,true)
  if((await stat(path)).size>8*1024*1024)throw Error('studio-text-too-large: maximum file size 8MiB')
  const data=await readFile(path);if(data.length>8*1024*1024||data.includes(0))throw Error('studio-text-invalid')
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data)}catch{throw Error('studio-text-invalid-utf8')}
  const sha256=hash(data),offset=args.offset??0,limit=args.limit??(data.length<=65536?Math.max(1,text.length):16384)
  if(!Number.isInteger(offset)||offset<0||offset>text.length||!Number.isInteger(limit)||limit<1||limit>65536)throw Error('studio-text-invalid-page')
  if(offset>0&&!/^[a-f0-9]{64}$/.test(args.expectedSha256??''))throw Error('studio-text-page-sha256-required')
  if(args.expectedSha256!==undefined&&args.expectedSha256!==sha256)throw Error('studio-text-file-changed')
  if(offset>0&&/[\uDC00-\uDFFF]/.test(text[offset]??'')&&/[\uD800-\uDBFF]/.test(text[offset-1]))throw Error('studio-text-invalid-page-boundary')
  let end=Math.min(text.length,offset+limit)
  while(Buffer.byteLength(text.slice(offset,end))>65536)end=offset+Math.floor((end-offset)/2)
  if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end])&&/[\uD800-\uDBFF]/.test(text[end-1]))end--
  if(end===offset&&offset<text.length)throw Error('studio-text-page-too-small')
  check();const prev=textCoverage.get(path),ranges=prev?.sha256===sha256?prev.ranges:[];ranges.push([offset,end]);ranges.sort((a,b)=>a[0]-b[0]);let covered=0;for(const [a,b] of ranges){if(a>covered)break;covered=Math.max(covered,b)}
  textCoverage.set(path,{sha256,ranges});let receipt:any
  if(role==='reviewer'&&workflow.status(input).candidate){const location=workflow.candidateLocation(input);if(location?.manifestPath&&path===location.manifestPath){const {candidate}=await current();if(sha256!==candidate.manifestSha256)throw Error('studio-manifest-file-changed');if(covered===text.length)receipt=workflow.recordReceipt(input,{candidateSha256:candidate.sha256,kind:'source',ranges:[[0,candidate.durationSeconds]],sha256})}}
  return {path:relative(input.task.cwd,path),text:text.slice(offset,end),sha256,totalChars:text.length,offset,nextOffset:end<text.length?end:null,completeRead:covered===text.length,...(receipt?{receipt,scope:'Manifest read only; source rights and claims still require review.'}:{})}
 })
 register('studio_inspect_probe','Reviewer only: actual ffprobe metadata bound to the current file, not aesthetic approval.',{},async()=>{requireRole(['reviewer']);const {path,candidate}=await current(),raw=(await command(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_streams','-show_format','-of','json',path])).stdout,probe=JSON.parse(raw);if(await fileSha256(path)!==candidate.sha256)throw Error('studio-candidate-file-changed');check();const receipt=workflow.recordReceipt(input,{candidateSha256:candidate.sha256,kind:'probe',ranges:[[0,candidate.durationSeconds]],sha256:hash(raw)});return {probe,receipt,qualityApproved:false}})

 register('studio_inspect_frames','Reviewer only: inspect 8 ordered actual frames across up to 2 seconds. Sparse sampling is not full-frame coverage.',{start:{type:'number',required:true},end:{type:'number',required:true}},async args=>{
  requireRole(['reviewer']);const attachments=attachmentStore();const {path,candidate}=await current(),[start,end]=interval(args,candidate.durationSeconds,2),dir=await directory(),images:any[]=[],frames:any[]=[]
  for(let i=0;i<8;i++){check();const time=start+(end-start)*i/8,p=join(dir,`${i}.jpg`);await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-ss',String(time),'-i',path,'-frames:v','1','-vf','scale=540:-2','-y',p]);const bytes=await readFile(p);if(bytes.length>4*1024*1024)throw Error('studio-frame-too-large');const attachment=await attachments.saveImage({data:bytes,mediaType:'image/jpeg',name:basename(p)});images.push(attachment);frames.push({time,sha256:hash(bytes)})}
  const observation=await observe(frames.map((f:any,i:number)=>({...f,path:join(dir,`${i}.jpg`)})),'candidate');if(await fileSha256(path)!==candidate.sha256)throw Error('studio-candidate-file-changed');check();const receipt=workflow.recordReceipt(input,{candidateSha256:candidate.sha256,kind:'frames',ranges:[[start,end]],sha256:hash(JSON.stringify(frames))});return {receipt,frames,images,observation,qualityApproved:false,sampling:'8 ordered samples; frames between sample points remain unchecked'}
 },true)
 register('studio_inspect_audio','Reviewer only: actual audio perception of at most 8 seconds; no ASR-only substitution.',{start:{type:'number',required:true},end:{type:'number',required:true}},async args=>{
  requireRole(['reviewer']);if(!options.audioObserve)throw Error('studio-audio-capability-required');const {path,candidate}=await current(),[start,end]=interval(args,candidate.durationSeconds,8),wavPath=join(await directory(),'audio.wav');await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-ss',String(start),'-i',path,'-t',String(end-start),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',wavPath]);const digest=await fileSha256(wavPath);check();const observation=await options.audioObserve({wavPath,start,end});if(!observation||typeof observation!=='object'||observation.isError||observation.error||observation.input_modality!=='input_audio'||observation.audio_sha256!==digest)throw Error('studio-audio-observation-failed');if(await fileSha256(wavPath)!==digest||await fileSha256(path)!==candidate.sha256)throw Error('studio-candidate-file-changed');check();const receipt=workflow.recordReceipt(input,{candidateSha256:candidate.sha256,kind:'audio',ranges:[[start,end]],sha256:digest});return {observation,receipt,qualityApproved:false}
 })
 const lockedReference=async()=>{
  const ref=options.reference;if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256)||ref.sha256!==input.task.design.studio.referenceSha256)throw Error('studio-reference-lock-required')
  const path=await realpath(ref.path);if(!(await stat(path)).isFile()||await fileSha256(path)!==ref.sha256)throw Error('studio-reference-file-changed')
  const probe=JSON.parse((await command(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_format','-of','json',path])).stdout),duration=Number(probe.format?.duration)
  if(!Number.isFinite(duration)||duration<=0)throw Error('studio-reference-probe-invalid');check();return {path,sha256:ref.sha256,duration}
 }
 register('studio_reference_frames','Planner/producer/reviewer: see 8 actual frames of the host-frozen reference film, up to 2 seconds. Reference observations never count as candidate evidence.',{start:{type:'number',required:true},end:{type:'number',required:true}},async args=>{
  requireRole(['planner','executor','reviewer']);const attachments=attachmentStore();const ref=await lockedReference(),[start,end]=interval(args,ref.duration,2),dir=await directory(),images:any[]=[],frames:any[]=[]
  for(let i=0;i<8;i++){check();const time=start+(end-start)*i/8,p=join(dir,`reference-${i}.jpg`);await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-ss',String(time),'-i',ref.path,'-frames:v','1','-vf','scale=540:-2','-y',p]);const bytes=await readFile(p);if(bytes.length>4*1024*1024)throw Error('studio-frame-too-large');images.push(await attachments.saveImage({data:bytes,mediaType:'image/jpeg',name:basename(p)}));frames.push({time,sha256:hash(bytes)})}
  const observation=await observe(frames.map((f:any,i:number)=>({...f,path:join(dir,`reference-${i}.jpg`)})),'reference');if(await fileSha256(ref.path)!==ref.sha256)throw Error('studio-reference-file-changed');check();const receipt=await options.referenceReceipt?.({referenceSha256:ref.sha256,kind:'frames',ranges:[[start,end]],sha256:hash(JSON.stringify(frames))});return {scope:'reference-only',referenceSha256:ref.sha256,frames,images,observation,referenceReceipt:receipt,sampling:'8 ordered samples; not continuous coverage'}
 },true)
 register('studio_reference_audio','Planner/producer/reviewer: hear up to 8 seconds of the frozen reference via actual audio perception. Never counts as candidate evidence.',{start:{type:'number',required:true},end:{type:'number',required:true}},async args=>{
  requireRole(['planner','executor','reviewer']);if(!options.audioObserve)throw Error('studio-audio-capability-required');const ref=await lockedReference(),[start,end]=interval(args,ref.duration,8),wavPath=join(await directory(),'reference.wav');await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-ss',String(start),'-i',ref.path,'-t',String(end-start),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',wavPath]);const digest=await fileSha256(wavPath);check();const observation=await options.audioObserve({wavPath,start,end});if(!observation||typeof observation!=='object'||observation.isError||observation.error||observation.input_modality!=='input_audio'||observation.audio_sha256!==digest)throw Error('studio-audio-observation-failed');if(await fileSha256(wavPath)!==digest||await fileSha256(ref.path)!==ref.sha256)throw Error('studio-reference-file-changed');check();const receipt=await options.referenceReceipt?.({referenceSha256:ref.sha256,kind:'audio',ranges:[[start,end]],sha256:digest});return {scope:'reference-only',referenceSha256:ref.sha256,observation,referenceReceipt:receipt,qualityApproved:false}
 })
 register('studio_character_image','Planner/producer/reviewer: view a host-locked character reference using an exact id from studio_status.characterReferences, NOT the characterId. Host locking permits viewing approved images; it does not forbid viewing. No arbitrary path access.',{id:{type:'string',required:true}},async args=>{
  requireRole(['planner','executor','reviewer']);const ref=options.characterReferences?.find(v=>v.id===args.id);if(!ref)throw Error(`studio-character-reference-id-mismatch: use an exact studio_status.characterReferences[].id; approved IDs: ${JSON.stringify((options.characterReferences??[]).map(v=>v.id))}. This is an invalid image reference ID, not a viewing prohibition.`);if(!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('studio-character-lock-required');const attachments=attachmentStore();const path=await realpath(ref.path);if(!(await stat(path)).isFile()||(await stat(path)).size>20*1024*1024)throw Error('studio-character-image-invalid');const bytes=await readFile(path);if(hash(bytes)!==ref.sha256)throw Error('studio-character-file-changed');const mediaType=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':null;if(!mediaType)throw Error('studio-character-image-invalid');check();const attachment=await attachments.saveImage({data:bytes,mediaType,name:basename(path)});check();const observation=await observe([{path,sha256:ref.sha256}],'character');return {scope:'character-reference-only',id:ref.id,sha256:ref.sha256,images:[attachment],observation,qualityApproved:false}
 },true)
 register('studio_preview_image','Producer only: inspect actual project PNG/JPEG via the host visual observer. No independent QA receipt.',{path:{type:'string',required:true}},async args=>{
  requireRole(['executor']);if(!options.visionObserve)throw Error('studio-vision-capability-required');const path=await studioPath(input.task.cwd,args.path,true),sha256=await fileSha256(path),observation=await observe([{path,sha256}],'preview');return {scope:'producer-self-check-only',sourcePath:relative(input.task.cwd,path),sha256,observation,qualityApproved:false,independentReview:false}
 })
 register('studio_preview_frames','Producer only: inspect 8 ordered frames of a project pilot or MP4 across at most 2 seconds. No independent QA receipt.',{path:{type:'string',required:true},start:{type:'number',required:true},end:{type:'number',required:true}},async args=>{
  requireRole(['executor']);if(!options.visionObserve)throw Error('studio-vision-capability-required');const path=await studioPath(input.task.cwd,args.path),sourceSha256=await fileSha256(path),probe=JSON.parse((await command(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_streams','-show_format','-of','json',path])).stdout),duration=Number(probe.format?.duration)
  if(!probe.streams?.some((s:any)=>s.codec_type==='video')||!Number.isFinite(duration)||duration<=0)throw Error('studio-preview-video-required');const [start,end]=interval(args,duration,2),dir=await directory(),frames:VisionInput['images']=[]
  for(let i=0;i<8;i++){check();const time=start+(end-start)*i/8,p=join(dir,`preview-${i}.jpg`);await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-ss',String(time),'-i',path,'-frames:v','1','-vf','scale=540:-2','-y',p]);frames.push({path:p,time,sha256:await fileSha256(p)})}
  const observation=await observe(frames,'preview');if(await fileSha256(path)!==sourceSha256)throw Error('studio-preview-file-changed');check();return {scope:'producer-self-check-only',sourcePath:relative(input.task.cwd,path),sourceSha256,frames:frames.map(({path,...f})=>f),observation,qualityApproved:false,independentReview:false,sampling:'8 ordered samples; frames between sample points remain unchecked'}
 })
 register('studio_preview_audio','Producer only: hear up to 8 seconds of a real project audio file or temporary mix. Self-check only; never creates independent-review evidence.',{path:{type:'string',required:true},start:{type:'number',required:true},end:{type:'number',required:true}},async args=>{
  requireRole(['executor']);if(!options.audioObserve)throw Error('studio-audio-capability-required');const path=await studioPath(input.task.cwd,args.path),sourceSha256=await fileSha256(path),probe=JSON.parse((await command(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_streams','-show_format','-of','json',path])).stdout),duration=Number(probe.format?.duration)
  if(!probe.streams?.some((s:any)=>s.codec_type==='audio')||!Number.isFinite(duration)||duration<=0)throw Error('studio-preview-audio-required');const [start,end]=interval(args,duration,8),wavPath=join(await directory(),'preview.wav');await command(process.env.FFMPEG_PATH??'ffmpeg',['-nostdin','-v','error','-ss',String(start),'-i',path,'-t',String(end-start),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',wavPath]);const digest=await fileSha256(wavPath);check();const observation=await options.audioObserve({wavPath,start,end});if(!observation||typeof observation!=='object'||observation.isError||observation.error||observation.input_modality!=='input_audio'||observation.audio_sha256!==digest)throw Error('studio-audio-observation-failed');if(await fileSha256(wavPath)!==digest||await fileSha256(path)!==sourceSha256)throw Error('studio-preview-file-changed');check();return {scope:'producer-self-check-only',sourcePath:relative(input.task.cwd,path),sourceSha256,audioSha256:digest,start,end,observation,qualityApproved:false,independentReview:false}
 })
 register('studio_submit_review','Reviewer only: submit final findings bound to the actual candidate. Host validates evidence and hands off this task stage; invalid reports must be corrected. This never approves publication or human quality.',{checks:{type:'array',required:true,items:{type:'object',additionalProperties:true}},issues:{type:'array',required:true,items:{type:'object',additionalProperties:true}}},async args=>{requireRole(['reviewer']);const {candidate}=await current();check();workflow.recordReview(input,{candidateSha256:candidate.sha256,referenceSha256:candidate.referenceSha256,revision:candidate.revision,checks:args.checks,issues:args.issues});if(options.submitReview)await options.submitReview();return {recorded:true,taskHandoff:!!options.submitReview,qualityApproved:false}},false,true)
 return ()=>{for(const d of disposers.splice(0)){try{d()}catch{}}}
}
