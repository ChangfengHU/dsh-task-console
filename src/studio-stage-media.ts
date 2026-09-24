import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {extname} from 'node:path'
const run=promisify(execFile),positive=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>0
const imageCodec:Record<string,string>={'.png':'png','.jpg':'mjpeg','.jpeg':'mjpeg','.webp':'webp'}
export function stageMediaKind(stage:string,path:string){const ext=extname(path).toLowerCase();return stage==='sound'&&['.wav','.mp3','.m4a'].includes(ext)?'audio':stage==='visual'&&imageCodec[ext]?'image':undefined}
const failure=(reason:string,index:number):never=>{throw Error('studio-stage-media-invalid: '+JSON.stringify({error_code:'studio-stage-media-invalid',reason,outputIndex:index,retryable:false,retryAfterRepair:true,action:'Check the corresponding manifest output. A downloaded login page, JSON error or renamed file is not media. Verify source access and successful download, then register a real decodable audio/image file. If ffprobe is unavailable, repair the host dependency first. Do not rename an error response or reuse an unchecked receipt.'}))}
export async function probeStageMedia(stage:string,path:string,index:number){
 const kind=stageMediaKind(stage,path);if(!kind)return undefined
 let probe:any
 try{
  const result=await run(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-protocol_whitelist','file,pipe',...(kind==='image'?['-count_frames']:[]),'-show_streams','-show_format','-of','json',path],{timeout:60000,maxBuffer:1024*1024})
  probe=JSON.parse(String(result.stdout))
 }catch(error:any){failure(error?.code==='ENOENT'?'ffprobe_unavailable':'probe_failed_or_invalid_media',index)}
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
