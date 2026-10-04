import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {extname} from 'node:path'
import {open} from 'node:fs/promises'
const run=promisify(execFile),positive=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>0
const imageCodec:Record<string,string>={'.png':'png','.jpg':'mjpeg','.jpeg':'mjpeg','.webp':'webp'}
export function stageMediaKind(stage:string,path:string){const ext=extname(path).toLowerCase();return stage==='sound'&&['.wav','.mp3','.m4a'].includes(ext)?'audio':stage==='visual'&&imageCodec[ext]?'image':undefined}
type NonMediaResponse='json_response'|'html_response'
/** Bounded format recognition only. Never expose or infer credentials from a response body. */
async function nonMediaResponse(path:string):Promise<NonMediaResponse|undefined>{
 let file:Awaited<ReturnType<typeof open>>|undefined
 try{
  file=await open(path,'r');const buffer=Buffer.alloc(16_385),{bytesRead}=await file.read(buffer,0,buffer.length,0)
  const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)).trimStart()
  if(/^<!doctype\s+html(?:\s|>)/i.test(text)||/^<html(?:\s|>)/i.test(text))return 'html_response'
  if(bytesRead<buffer.length&&/^[{[]/.test(text)){
   const value=JSON.parse(text);if(value&&typeof value==='object')return 'json_response'
  }
 }catch{/* Corrupt binary, truncated text or unreadable files are not confirmed response formats. */}
 finally{await file?.close().catch(()=>{})}
}
const failure=(reason:string,index:number,responseKind?:NonMediaResponse):never=>{
 const base='Check the corresponding manifest output. '
 const dependency=reason==='ffprobe_unavailable'
 const action=dependency
  ?base+'The host ffprobe executable is unavailable. Repair the configured FFPROBE_PATH or install the existing required host dependency, then re-probe the same file. This does not establish a download/authentication problem; do not re-download files or search for credentials to fix this error.'
  :responseKind
   ?base+'This file is a confirmed JSON/HTML response, not media; changing its extension cannot repair it. For an archived library asset, call studio_download_asset with its exact metadata ID as id and a new project-relative output as path, preserving the current stage prefix and archived extension. The host handles authentication. Do not repeat anonymous /file curl requests, seek/read/print tokens, or overwrite evidence. Source-only cards are not archived audio: only supported Incompetech BGM can use the tool’s explicit sourcePolicy after confirming the real project commitments. Other sources require a supported licensed acquisition route. If acquisition remains unavailable, report the exact capability failure or request preparation revision; do not silently remove required BGM/SFX, substitute silence, or change frozen dialogue.'
   :base+'The output is not valid media for this stage. Verify the real file format, source and successful download, then register a decodable audio/image file. Do not rename an error response or reuse an unchecked receipt. Repair the reported file without deleting required cues or changing frozen dialogue.'
 throw Error('studio-stage-media-invalid: '+JSON.stringify({error_code:'studio-stage-media-invalid',reason,outputIndex:index,retryable:false,retryAfterRepair:true,...(responseKind?{responseKind,recoveryTool:{name:'studio_download_asset',requiredArguments:{id:'Exact archived asset ID from metadata; not a guessed /file URL',path:'New Task-workspace-relative file under the current stages/rN/sound/ or stages/rN/visual/ directory, with the archived extension'},sourceOnly:{supportedSource:'Incompetech BGM',optionalArgument:'sourcePolicy',fields:{purpose:'video_soundtrack',platforms:['Actual intended publishing platform(s)'],attributionWillBeIncluded:true,platformAllowsAttribution:true,noAdditionalRestrictions:true,changesDescription:'Actual planned edits'},notice:'Declare only commitments the project will meet; include the resulting credit receipt in companion publication documentation.'}}}:{}),action}))
}
/** Abort must wait for the killed child's close, not merely reject while a
 * SIGTERM-ignoring diagnostic process remains alive. Normal probing is unchanged. */
function diagnosticProbe(file:string,args:string[],options:{timeoutMs:number;signal?:AbortSignal}):Promise<{stdout:string}>{
 return new Promise((resolve,reject)=>{
  const child=execFile(file,args,{timeout:options.timeoutMs,maxBuffer:1024*1024,killSignal:'SIGKILL'},(error,stdout)=>{options.signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve({stdout:String(stdout)})})
  const stop=()=>{child.kill('SIGKILL')}
  options.signal?.addEventListener('abort',stop,{once:true});if(options.signal?.aborted)stop()
 })
}
export async function probeStageMedia(stage:string,path:string,index:number,diagnostic?:{timeoutMs:number;signal?:AbortSignal}){
 if(diagnostic&&(!Number.isInteger(diagnostic.timeoutMs)||diagnostic.timeoutMs<1||diagnostic.timeoutMs>1000))throw Error('studio-diagnostic-probe-timeout-invalid')
 const kind=stageMediaKind(stage,path);if(!kind)return undefined
 let probe:any
 try{
  const args=['-v','error','-protocol_whitelist','file,pipe',...(kind==='image'?['-count_frames']:[]),'-show_streams','-show_format','-of','json',path],file=process.env.FFPROBE_PATH??'ffprobe'
  const result=diagnostic?await diagnosticProbe(file,args,diagnostic):await run(file,args,{timeout:60000,maxBuffer:1024*1024})
  probe=JSON.parse(String(result.stdout))
 }catch(error:any){const missing=error?.code==='ENOENT';failure(missing?'ffprobe_unavailable':'probe_failed_or_invalid_media',index,missing?undefined:await nonMediaResponse(path))}
 const streams=probe?.streams
 if(!Array.isArray(streams))failure('missing_streams',index)
 if(kind==='audio'){
  const audio=streams.find((s:any)=>s.codec_type==='audio'),durationSeconds=Number(probe.format?.duration??audio?.duration),sampleRate=Number(audio?.sample_rate),channels=Number(audio?.channels)
  if(!audio||typeof audio.codec_name!=='string'||!audio.codec_name||!positive(durationSeconds)||!positive(sampleRate)||!Number.isInteger(channels)||channels<1)failure('audio_stream_or_duration_invalid',index)
  return {kind,codecName:audio.codec_name,durationSeconds,sampleRate,channels}
 }
 const visual=streams.find((s:any)=>s.codec_type==='video'),width=Number(visual?.width),height=Number(visual?.height),frames=Number(visual?.nb_read_frames)
 if(streams.length!==1||visual?.codec_name!==imageCodec[extname(path).toLowerCase()]||!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||frames!==1)failure('static_image_codec_dimensions_or_decode_invalid',index)
 return {kind,codecName:visual.codec_name,width,height,frames}
}
/** Metadata is minted by the host and retained in its stage ledger. On replay,
 * verify file hashes and these fields without probing identical media again. */
export function requireStageMediaMetadata(stage:string,output:any,index:number){
 const kind=stageMediaKind(stage,output.path);if(!kind)return
 const m=output.media
 if(!m||m.kind!==kind)failure('media_probe_receipt_missing_reregister',index)
 if(kind==='audio'){
  if(typeof m.codecName!=='string'||!m.codecName||!positive(m.durationSeconds)||!positive(m.sampleRate)||!Number.isInteger(m.channels)||m.channels<1)failure('audio_probe_receipt_invalid',index)
 }else if(m.codecName!==imageCodec[extname(output.path).toLowerCase()]||!Number.isInteger(m.width)||m.width<1||!Number.isInteger(m.height)||m.height<1||m.frames!==1)failure('image_probe_receipt_invalid',index)
}
