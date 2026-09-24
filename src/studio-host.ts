import { readFile, realpath, stat } from 'node:fs/promises'
import { join,dirname,resolve,relative,isAbsolute,sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileSha256,studioPath } from './studio-tools.js'
import type { StudioWorkflow } from './studio-workflow.js'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
// Host deployment configuration, never a model-supplied task field.
async function configuration(): Promise<any> {try{return JSON.parse(await readFile(new URL('../studio-host.json',import.meta.url),'utf8'))}catch{return {}}}
interface HostDeps {config?:any;execute?:(script:string,args:string[],task:any,config:any,stdin?:string)=>Promise<any>}
/** Existing library blobs only. Installed MCP authorizes the ID before private transfer. */
export async function downloadStudioAsset(task:any,args:{id:string;path:string},deps:HostDeps={}){
 const config=deps.config??await configuration()
 if(!config.assetDownloadScript||!/^[a-f0-9]{64}$/.test(config.assetDownloadSha256??'')||!config.vaultTokenFile)throw Error('studio-asset-download-host-not-configured')
 if(await fileSha256(config.assetDownloadScript)!==config.assetDownloadSha256)throw Error('studio-asset-download-helper-changed')
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(args.id??''))throw Error('studio-asset-id-invalid')
 if(typeof args.path!=='string'||!args.path||isAbsolute(args.path)||args.path.includes('\0')||args.path.split(/[\\/]/).some(p=>p.startsWith('.')||/credential|secret|token|password|private.?key/i.test(p)))throw Error('studio-asset-output-invalid')
 const root=await realpath(task.cwd)
 const result=await(deps.execute??execute)(config.assetDownloadScript,['--project-root',root,'--id',args.id,'--output',args.path],task,config)
 if(result?.ok!==true){
  const codes:Record<string,string>={asset_metadata_only:'source-only',output_exists_with_other_bytes:'output-exists-with-other-bytes',installed_asset_transport_missing:'installed-asset-auth-unavailable',installed_asset_transport_unsupported:'installed-asset-auth-unavailable',asset_lookup_failed:'asset-lookup-failed',proxy_authorization_denied:'asset-file-auth-failed',download_integrity_failed:'download-integrity-failed',invalid_asset_metadata:'invalid-asset-metadata',invalid_archived_asset:'invalid-asset-metadata',private_reference_not_for_production:'private-reference-not-for-production',output_extension_mismatch:'output-extension-mismatch'}
  const code=codes[result?.error_code]??'asset-download-failed'
  return {ok:false,error_code:code,...(Number.isInteger(result?.httpStatus)&&result.httpStatus>=100&&result.httpStatus<=599?{httpStatus:result.httpStatus}:{}),nextAction:code==='source-only'?'This is a source card, not an archived file. Read its original source and verify permission to obtain media; do not invent a library file URL.':code==='asset-file-auth-failed'?'The host was denied access to the existing Fleet Media proxy. Verify the host configuration; do not substitute bootstrap tokens or expose credentials.':'Inspect the asset metadata and download status; preserve old files and use a new output path with the archived extension if necessary. Never expose credentials.',qualityApproved:false}
 }
 const path=await studioPath(root,args.path,true),size=(await stat(path)).size
 if(result.assetId!==args.id||result.path!==path||!Number.isInteger(result.bytes)||result.bytes!==size||size<1||size>20_000_000||!/^[a-f0-9]{64}$/.test(result.sha256??'')||await fileSha256(path)!==result.sha256||!['image','voice','sfx','bgm','reference'].includes(result.kind)||typeof result.reused!=='boolean')throw Error('studio-asset-download-receipt-invalid')
 return {ok:true,assetId:args.id,path:relative(root,path),sha256:result.sha256,bytes:size,kind:result.kind,reused:result.reused,newGeneration:0,qualityApproved:false}
}
async function execute(script:string,args:string[],task:any,config:any,stdin?:string):Promise<any>{
 return new Promise((resolve,reject)=>{const child=spawn('python3',[script,...args],{env:{...process.env,STUDIO_PROJECT_ROOT:task.cwd,STUDIO_VAULT_TOKEN_FILE:config.vaultTokenFile??''},stdio:['pipe','pipe','ignore']});let output='',overflow=false,done=false
 const finish=(err?:Error,result?:any)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(err);else resolve(result)}
 const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('studio-host-subprocess-timeout'))},420000)
 child.stdout.on('data',b=>{output+=b.toString();if(output.length>2_000_000){overflow=true;child.kill('SIGKILL')}});child.on('error',()=>finish(Error('studio-host-subprocess-unavailable')));child.stdin.on('error',()=>{});child.stdin.end(stdin??'')
 child.on('close',(code,signal)=>{if(overflow)return finish(Error('studio-host-output-too-large'));try{const result=JSON.parse(output);if(signal||code!==0&&result?.ok!==false)return finish(Error('studio-host-subprocess-failed'));finish(undefined,result)}catch{finish(Error('studio-host-output-invalid'))}})
 })
}
const cache=new Map<string,{at:number,value:any}>()
// Parallel stage startup shares one host probe; each caller still verifies its files.
const preflights=new Map<string,Promise<any>>()
async function sharedPreflight(key:string,run:()=>Promise<any>){
 const cached=cache.get(key);if(cached&&Date.now()-cached.at<60_000)return cached.value
 const pending=preflights.get(key);if(pending)return pending
 const request=Promise.resolve().then(run).then(value=>{
  if(value?.ok!==false)cache.set(key,{at:Date.now(),value})
  return value
 })
 preflights.set(key,request)
 try{return await request}finally{if(preflights.get(key)===request)preflights.delete(key)}
}
export async function refreshStudioCapabilities(workflow:StudioWorkflow,task:any,deps:HostDeps={}){
 const config=deps.config??await configuration(),exec=deps.execute??execute,now=Date.now(),checkedAt=new Date(now).toISOString(),expiresAt=new Date(now+15*60_000).toISOString()
 const record=(name:string,status:string,proofSha256?:string,reason?:string,method?:string)=>(workflow as any).recordCapability(task,{name,status,checkedAt,expiresAt,...(proofSha256?{proofSha256}:{}),...(reason?{reason}:{}),...(method?{method}:{})})
 let result:any,reference:any,characterReferences:any[]=[]
 if(config.preflightScript){const key=hash(JSON.stringify({id:task.id,cwd:task.cwd,studio:task.design?.studio,config}))
  try{result=await sharedPreflight(key,()=>exec(config.preflightScript,[],task,config,JSON.stringify(task)))}catch{result={capabilities:{}}}
  for(const [name,source] of [['character','character'],['reference','reference'],['frames','frames'],['render','hyperframes']]){const p=result?.capabilities?.[source];try{
   if(p?.ok!==true||!p.proofPath)throw Error('preflight unavailable');if(source==='hyperframes'&&(p.hyperframes_verified!==true||p.scope!=='actual_hyperframes_smoke_render'))throw Error('actual HyperFrames proof required')
   if(source==='character'){if(p.characterId!==task.design.studio.characterId||await fileSha256(p.imagePath)!==p.imageSha256||await fileSha256(p.profilePath)!==p.sha256)throw Error('character lock mismatch');characterReferences=[{id:p.profileAssetId??'character-primary',path:p.imagePath,sha256:p.imageSha256}]}
   else {if(await fileSha256(p.path)!==p.sha256)throw Error('preflight asset changed');if(source==='reference'){if(p.sha256!==task.design.studio.referenceSha256)throw Error('reference lock mismatch');reference={path:p.path,sha256:p.sha256}}}
   record(name,'passed',await fileSha256(p.proofPath),undefined,'host_preflight')
  }catch{record(name,'failed',undefined,`actual ${source} preflight missing or invalid`)}}
 }else for(const name of ['character','reference','frames','render'])record(name,'unknown',undefined,'host preflight script not configured')
 // Calibration evidence is separate from an endpoint listing or a successful observation.
 let calibration:any;try{if(config.calibrationPath)calibration=JSON.parse(await readFile(config.calibrationPath,'utf8'))}catch{}
 let regression:any;const regressionPath=config.calibrationRegressionPath??(config.calibrationPath?join(dirname(config.calibrationPath),'speech-differential-regression.json'):undefined);try{if(regressionPath)regression=JSON.parse(await readFile(regressionPath,'utf8'))}catch{}
 const valid=(v:any)=>v?.ok===true&&v.observation?.input_modality==='input_audio'&&v.observation?.finish_reason==='stop'&&/^[a-f0-9]{64}$/.test(v.audio_sha256??'')&&v.observation.audio_sha256===v.audio_sha256
 const rows=Array.isArray(calibration?.results)?calibration.results:[],regRows=Array.isArray(regression?.results)?regression.results:[]
 const audioOk=rows.some(valid)
 let calibrationHash:string|undefined;try{if(config.calibrationPath)calibrationHash=hash(JSON.stringify({calibration:await fileSha256(config.calibrationPath),regression:regressionPath?await fileSha256(regressionPath):null}))}catch{}
 record('audio',audioOk&&!!calibrationHash&&!!config.audioScript&&!!config.vaultTokenFile?'passed':'unknown',audioOk?calibrationHash:undefined,audioOk?'completed direct audio transport; not aesthetic approval':'completed direct audio observation not established','actual_audio')
 const clean=rows.find((v:any)=>v.sample==='clean'),missing=rows.find((v:any)=>v.sample==='missing'),silence=regRows.find((v:any)=>v.sample==='silence'),noise=regRows.find((v:any)=>v.sample==='noise')
 const calibrated=audioOk&&!!calibrationHash&&calibration?.schema==='studio-speech-calibration-v1'&&calibration.speech_calibration_pass===true&&valid(clean)&&clean.content_gate==='pass'&&valid(missing)&&missing.content_gate==='blocked'&&missing.issues?.some((i:any)=>i.code==='no_audible_signal')&&valid(silence)&&silence.content_gate==='blocked'&&silence.issues?.some((i:any)=>i.code==='speech_delete')&&valid(noise)&&noise.content_gate==='blocked'
 record('audio_calibration',calibrated?'passed':'unknown',calibrated?calibrationHash:undefined,calibrated?'scope=speech_content_and_acoustic_defects; normal/muted utterance and retrospective deletion/noise regression only; performance_calibrated=false; no film quality approval':'speech content and acoustic defect calibration not established','actual_audio')
 return {reference,characterReferences,preflight:result}
}
function audioFailure(result:any,prefix:string){
 if(result?.ok===true)return
 const stage=['input','vault','provider'].includes(result?.error_stage)?result.error_stage:'unknown'
 const type=['HTTPError','ValueError','PermissionError','RuntimeError','TimeoutError','URLError','FileNotFoundError'].includes(result?.error_type)?result.error_type:'Error'
 const status=Number.isInteger(result?.http_status)&&result.http_status>=100&&result.http_status<=599?`-http-${result.http_status}`:''
 throw Error(`${prefix}-failed:${stage}:${type}${status}`)
}
export async function observeStudioAudio(task:any,args:{wavPath:string,start:number,end:number},deps:HostDeps={}){
 const config=deps.config??await configuration();if(!config.audioScript||!config.vaultTokenFile)throw Error('studio-audio-host-not-configured');const result=await(deps.execute??execute)(config.audioScript,[args.wavPath,'--start-seconds',String(args.start),'--end-seconds',String(args.end)],task,config)
 audioFailure(result,'studio-audio');if(result.input_modality!=='input_audio'||result.finish_reason!=='stop'||result.audio_sha256!==await fileSha256(args.wavPath))throw Error('studio-audio-observation-invalid');return result
}
export async function checkStudioSpeech(task:any,args:{wavPath:string,start:number,end:number,expectedText:string,stage:'source'|'final'},deps:HostDeps={}){
 const config=deps.config??await configuration();if(!config.speechScript||!config.vaultTokenFile)throw Error('studio-speech-host-not-configured');const result=await(deps.execute??execute)(config.speechScript,[args.wavPath,'--expected-text',args.expectedText,'--stage',args.stage,'--start-seconds',String(args.start),'--end-seconds',String(args.end)],task,config)
 audioFailure(result,'studio-speech');if(result.audio_sha256!==await fileSha256(args.wavPath)||result.expected_text_sha256!==hash(args.expectedText)||!['pass','blocked'].includes(result.content_gate))throw Error('studio-speech-observation-invalid');return result
}

/** Actual Qwen VL observations; the language planner cannot self-attest seeing an image. */
export async function observeStudioVision(task:any,args:import('./studio-tools.js').VisionInput,deps:HostDeps={}){
 const config=deps.config??await configuration();if(!config.visionScript||!config.vaultTokenFile)throw Error('studio-vision-host-not-configured')
 const result=await(deps.execute??execute)(config.visionScript,[],task,config,JSON.stringify(args));audioFailure(result,'studio-vision')
 if(result.input_modality!=='input_image'||result.finish_reason!=='stop'||!result.observation||!Array.isArray(result.images)||result.images.length!==args.images.length)throw Error('studio-vision-observation-invalid')
 for(let i=0;i<args.images.length;i++){const expected=args.images[i];if(result.images[i].sha256!==expected.sha256||result.images[i].time!==expected.time||await fileSha256(expected.path)!==expected.sha256)throw Error('studio-vision-observation-invalid')}
 return result
}

/** Fixed, hash-checked local compiler. Arguments select data paths, never code. */
export async function compileStudioStoryboard(task:any,args:{boardPath:string;outputDirectory:string},deps:HostDeps={}){
 const config=deps.config??await configuration()
 if(!config.storyboardCompilerScript||!/^[a-f0-9]{64}$/.test(config.storyboardCompilerSha256??''))throw Error('studio-storyboard-host-not-configured')
 if(await fileSha256(config.storyboardCompilerScript)!==config.storyboardCompilerSha256)throw Error('studio-storyboard-compiler-changed')
 const root=await realpath(task.cwd),board=await realpath(resolve(root,args.boardPath)),boardRelative=relative(root,board)
 if(!boardRelative||isAbsolute(boardRelative)||boardRelative==='..'||boardRelative.startsWith('..'+sep)||!(await stat(board)).isFile())throw Error('studio-board-source-outside-project')
 // The board tool freezes an absolute path; the compiler deliberately accepts only
 // project-relative sources. Preserve its boundary instead of relaxing the CLI.
 if(!/^[A-Za-z0-9._-]{1,80}$/.test(args.outputDirectory)||['.','..'].includes(args.outputDirectory))throw Error('studio-board-output-name-invalid')
 const result=await(deps.execute??execute)(config.storyboardCompilerScript,['--project-root',root,'--board',boardRelative,'--output',args.outputDirectory],task,config)
 if(!result||typeof result.ok!=='boolean'||result.qualityApproved!==false)throw Error('studio-storyboard-host-result-invalid')
 return result
}
