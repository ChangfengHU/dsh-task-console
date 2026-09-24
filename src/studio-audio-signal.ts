import {spawn} from 'node:child_process'

export interface AudioSignalEvidence {
 schema:'decoded-audio-signal-v1';sha256:string;allSilent:boolean;decodedSamples:number;qualityApproved:false
}
const cache=new Map<string,AudioSignalEvidence>()
const MAX_DECODED_BYTES=512*1024*1024
/** Decode the original channels to floating-point PCM, without downmixing or
 * resampling. Exact zero is the only silence threshold. This establishes no
 * music, speech, performance, licensing or listening-quality claim. Caller
 * checks the source hash before and after, including cache hits. */
export async function inspectAudioSignal(path:string,sha256:string,options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<AudioSignalEvidence>{
 if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('studio-audio-signal-invalid-hash')
 const timeoutMs=options.timeoutMs??60000
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('studio-audio-signal-invalid-timeout')
 if(options.signal?.aborted)throw Error('studio-audio-signal-aborted')
 const executable=process.env.FFMPEG_PATH??'ffmpeg',key=executable+':'+sha256,previous=cache.get(key)
 if(previous)return {...previous}
 const evidence=await new Promise<AudioSignalEvidence>((resolve,reject)=>{
  const child=spawn(executable,['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-i',path,'-map','0:a:0','-vn','-sn','-dn','-c:a','pcm_f64le','-f','f64le','pipe:1'],{stdio:['ignore','pipe','pipe']})
  let pending=Buffer.alloc(0),bytes=0,samples=0,allSilent=true,failure:string|undefined
  const stop=(reason:string)=>{failure??=reason;child.kill('SIGKILL')}
  const abort=()=>stop('aborted'),timer=setTimeout(()=>stop('timeout'),timeoutMs)
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort()
  child.stdout.on('data',(chunk:Buffer)=>{
   if(failure)return
   bytes+=chunk.length;if(bytes>MAX_DECODED_BYTES){stop('decoded-byte-limit');return}
   const data=pending.length?Buffer.concat([pending,chunk]):chunk,end=data.length-data.length%8
   for(let offset=0;offset<end;offset+=8){
    const sample=data.readDoubleLE(offset)
    if(!Number.isFinite(sample)){stop('nonfinite-sample');return}
    samples++;if(sample!==0)allSilent=false
   }
   pending=Buffer.from(data.subarray(end))
  })
  // Diagnostics can contain private paths; drain without storing or returning.
  child.stderr.resume()
  child.on('error',(error:NodeJS.ErrnoException)=>{failure??=error.code==='ENOENT'?'ffmpeg-unavailable':'decoder-start-failed'})
  child.on('close',code=>{
   clearTimeout(timer);options.signal?.removeEventListener('abort',abort)
   if(failure||code!==0||pending.length||!samples){reject(Error('studio-audio-signal-'+(failure??'decode-failed')));return}
   resolve({schema:'decoded-audio-signal-v1',sha256,allSilent,decodedSamples:samples,qualityApproved:false})
  })
 })
 // Only complete successful decoding is cached; errors/timeouts never are.
 if(cache.size>=128)cache.delete(cache.keys().next().value!)
 cache.set(key,evidence)
 return {...evidence}
}
