/** Preserve the existing eight independent input seeks; only their scheduling
 * changes. These are requested seek positions, NOT measured decoded frame PTS,
 * continuous video coverage, or quality evidence until the caller verifies the
 * unchanged source and issues the usual host receipt. */
import {lstat} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'

export interface StudioFrameSample {requestedTime:number;path:string}
export interface StudioFrameSamplingOptions {
 videoPath:string
 outputDirectory:string
 /** Actual host-probed source duration. Every requested seek must be before EOF. */
 durationSeconds:number
 /** Exactly the eight original ordered seek positions; never rounded/retimed here. */
 times:number[]
 command:(file:string,args:string[])=>Promise<{stdout:string}>
 assertActive?:()=>void
 ffmpegPath?:string
 width?:number
 filePrefix?:string
 /** Explicit serial mode is retained for diagnosis/resource-constrained hosts. */
 concurrency?:1|2
}

export async function sampleOrderedStudioFrames(options:StudioFrameSamplingOptions):Promise<StudioFrameSample[]> {
 const {videoPath,outputDirectory,durationSeconds,command,assertActive=()=>{},times}=options
 const concurrency=options.concurrency??2,width=options.width??540,prefix=options.filePrefix??''
 if(typeof videoPath!=='string'||!isAbsolute(videoPath)||videoPath.includes('\0')||typeof outputDirectory!=='string'||!isAbsolute(outputDirectory)||outputDirectory.includes('\0'))throw Error('studio-frame-sampling-path-required')
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0||!Array.isArray(times)||times.length!==8||times.some((t,i)=>!Number.isFinite(t)||t<0||t>=durationSeconds||(i>0&&t<=times[i-1])))throw Error('studio-frame-sampling-eight-ordered-seeks-before-eof-required')
 if(![1,2].includes(concurrency)||!Number.isInteger(width)||width<1||width>4096||typeof command!=='function'||typeof assertActive!=='function'||typeof prefix!=='string'||!/^[a-zA-Z0-9_-]{0,32}$/.test(prefix))throw Error('studio-frame-sampling-options-invalid')
 const requested=[...times],samples:StudioFrameSample[]=new Array(8)
 let next=0,failed=false,failure:unknown
 const worker=async()=>{
  while(!failed){
   const index=next++
   if(index>=requested.length)return
   try{
    assertActive()
    const time=requested[index],path=join(outputDirectory,`${prefix}${index}.jpg`)
    // Keep -ss BEFORE -i, exactly as the previous tool. A single-process select
    // filter or output seek could choose different frames around GOPs/EOF.
    await command(options.ffmpegPath??'ffmpeg',['-nostdin','-v','error','-ss',String(time),'-i',videoPath,'-frames:v','1','-vf',`scale=${width}:-2`,'-y',path])
    assertActive()
    // FFmpeg can exit 0 but emit no frame for an at-EOF seek. Missing/empty
    // output must not turn into a successful sample or an observation receipt.
    const file=await lstat(path).catch(()=>null)
    if(!file?.isFile()||file.isSymbolicLink()||file.size<1||file.size>4*1024*1024)throw Error('studio-frame-sample-missing-or-invalid')
    assertActive()
    samples[index]={requestedTime:time,path}
   }catch(error){if(!failed){failed=true;failure=error}}
  }
 }
 // Workers absorb errors until both have drained. No newly queued seeks run
 // after a failure; already-started processes finish before this call rejects.
 await Promise.all(Array.from({length:concurrency},()=>worker()))
 if(failed)throw failure
 assertActive()
 return samples
}
