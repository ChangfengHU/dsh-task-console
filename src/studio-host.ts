import {readStudioHostConfiguration} from './studio-config.js'
import {readStudioCharacterProfile,type StudioCharacterProfileLock} from './studio-character-profile.js'
import {publicCharacterReference} from './studio-character-source.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join,dirname,resolve,relative,isAbsolute,sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileSha256,studioPath } from './studio-tools.js'
import type { StudioWorkflow } from './studio-workflow.js'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
// Host deployment configuration, never a model-supplied task field.
interface HostDeps {config?:any;configPath?:string;execute?:(script:string,args:string[],task:any,config:any,stdin?:string)=>Promise<any>}
/** Existing library blobs only. Installed MCP authorizes the ID before private transfer. */
export async function downloadStudioAsset(task:any,args:{id:string;path:string},deps:HostDeps={}){
 const config=deps.config??await readStudioHostConfiguration(deps.configPath)
 if(!config.assetDownloadScript||!/^[a-f0-9]{64}$/.test(config.assetDownloadSha256??'')||!config.vaultTokenFile)throw Error('studio-asset-download-host-not-configured')
 if(await fileSha256(config.assetDownloadScript)!==config.assetDownloadSha256)throw Error('studio-asset-download-helper-changed')
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(args.id??''))throw Error('studio-asset-id-invalid')
 if(typeof args.path!=='string'||!args.path||isAbsolute(args.path)||args.path.includes('\0')||args.path.split(/[\\/]/).some(p=>p.startsWith('.')||/credential|secret|token|password|private.?key/i.test(p)))throw Error('studio-asset-output-invalid')
 const root=await realpath(task.cwd)
 const result=await(deps.execute??execute)(config.assetDownloadScript,['--project-root',root,'--id',args.id,'--output',args.path,...(config.dshProfilePath?['--dsh-profile',config.dshProfilePath]:[])],task,config)
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
 return new Promise((resolve,reject)=>{const child=spawn('python3',[script,...args],{env:{...process.env,...(config.dshProfilePath?{STUDIO_DSH_PROFILE:config.dshProfilePath}:{}),...(config.renderRuntime?{STUDIO_RENDER_RUNTIME:config.renderRuntime}:{}),STUDIO_PROJECT_ROOT:task.cwd,STUDIO_TASK_ID:String(task.id??''),STUDIO_VAULT_TOKEN_FILE:config.vaultTokenFile??'',STUDIO_OBSERVATION_CACHE_ROOT:config.observationCacheRoot??'',STUDIO_OBSERVATION_CACHE_EPOCH:config.observationCacheEpoch??''},stdio:['pipe','pipe','ignore']});let output='',overflow=false,done=false
 const finish=(err?:Error,result?:any)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(err);else resolve(result)}
 const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('studio-host-subprocess-timeout'))},420000)
 child.stdout.on('data',b=>{output+=b.toString();if(output.length>2_000_000){overflow=true;child.kill('SIGKILL')}});child.on('error',()=>finish(Error('studio-host-subprocess-unavailable')));child.stdin.on('error',()=>{});child.stdin.end(stdin??'')
 child.on('close',(code,signal)=>{if(overflow)return finish(Error('studio-host-output-too-large'));try{const result=JSON.parse(output);if(signal||code!==0&&result?.ok!==false)return finish(Error('studio-host-subprocess-failed'));finish(undefined,result)}catch{finish(Error('studio-host-output-invalid'))}})
 })
}
const PREFLIGHT_LIFETIME=15*60_000
interface PreflightSnapshot {value:any;checkedAt:number;expiresAt:number;files:Record<string,string>}
const cache=new Map<string,PreflightSnapshot>()
// Parallel stage startup shares one host probe; each caller still verifies its files.
const preflights=new Map<string,Promise<PreflightSnapshot>>()
const identities=new Map<string,Promise<unknown>>()
const preflightEnvironment=()=>Object.fromEntries(['STUDIO_RENDER_RUNTIME','FFMPEG_PATH','PATH','PUPPETEER_EXECUTABLE_PATH','STUDIO_DSH_PROFILE'].map(k=>[k,process.env[k]??null]))
async function sharedIdentity(key:string,config:any){
 const pending=identities.get(key);if(pending)return pending
 const request=preflightIdentity(config);identities.set(key,request)
 try{return await request}finally{if(identities.get(key)===request)identities.delete(key)}
}
async function preflightIdentity(config:any){
 const runtime=config.renderRuntime??process.env.STUDIO_RENDER_RUNTIME??'/home/claude/dsh-studio-migration/render-runtime'
 const paths=[config.preflightScript,...[runtime,config.renderRuntime].filter((v,i,a)=>v&&a.indexOf(v)===i).flatMap(root=>[
  join(root,'node_modules/hyperframes/package.json'),join(root,'node_modules/hyperframes/bin/hyperframes.mjs'),join(root,'node_modules/ffmpeg-static/ffmpeg')]),
  process.env.FFMPEG_PATH??'', '/usr/bin/node','/usr/bin/google-chrome','/usr/bin/ffprobe',
  config.dshProfilePath??process.env.STUDIO_DSH_PROFILE??'/home/claude/.dsh/profiles/web/cordis.patch.yml',config.vaultTokenFile].filter(Boolean)
 // Metadata detects replacement of large host binaries without rereading them
 // on every handoff; helper/package bytes also bind same-path code updates.
 const files=await Promise.all(paths.map(async path=>{try{const [info,actual]=await Promise.all([stat(path),realpath(path)]);return [path,actual,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs,
  path===config.preflightScript||path.endsWith('/package.json')?await fileSha256(path):null]}catch{return [path,'unavailable']}}))
 return {files,environment:preflightEnvironment()}
}
const characterProfileLock=(p:any):StudioCharacterProfileLock=>({path:p.profilePath,sha256:p.sha256,characterId:p.characterId,...(p.profileVersion!==undefined?{profileVersion:p.profileVersion}:{})})
async function preflightFiles(value:any,task:any):Promise<Record<string,string>>{
 const files:Record<string,string>={}
 if(value?.ok===false)throw Error('preflight failed')
 for(const name of ['character','reference','frames','hyperframes']){
  const p=value?.capabilities?.[name]
  if(p?.ok!==true||!p.proofPath)throw Error('preflight incomplete')
  if(name==='hyperframes'&&(p.hyperframes_verified!==true||p.scope!=='actual_hyperframes_smoke_render'))throw Error('render proof invalid')
  if((name==='character'&&p.characterId!==task.design?.studio?.characterId)||(name==='reference'&&p.sha256!==task.design?.studio?.referenceSha256))throw Error('preflight policy changed')
  if(name==='character'){publicCharacterReference({id:p.profileAssetId??'character-primary',path:p.imagePath,sha256:p.imageSha256,...(p.profileAssetId?{assetId:p.profileAssetId}:{}),...(p.sourceUrl!==undefined?{sourceUrl:p.sourceUrl,sourceSha256:p.sourceSha256}:{})});await readStudioCharacterProfile(task,characterProfileLock(p))}
  const assets=name==='character'?[[p.imagePath,p.imageSha256],[p.profilePath,p.sha256]]:[[p.path,p.sha256]]
  for(const [path,expected] of assets){const actual=await fileSha256(path);if(actual!==expected)throw Error('preflight asset changed');files[path]=actual}
  files[p.proofPath]=await fileSha256(p.proofPath)
 }
 return files
}
async function sharedPreflight(key:string,task:any,run:()=>Promise<any>){
 const cached=cache.get(key),now=Date.now()
 if(cached&&now>=cached.checkedAt&&now<cached.expiresAt){
  try{for(const [path,expected] of Object.entries(cached.files))if(await fileSha256(path)!==expected)throw Error('preflight proof changed');if(Date.now()>=cached.expiresAt)throw Error('preflight expired during verification');return cached}catch{cache.delete(key)}
 }else if(cached)cache.delete(key)
 const pending=preflights.get(key);if(pending)return pending
 const checkedAt=Date.now()
 const request=Promise.resolve().then(run).then(async value=>{
  const snapshot:PreflightSnapshot={value:structuredClone(value),checkedAt,expiresAt:checkedAt+PREFLIGHT_LIFETIME,files:{}}
  try{snapshot.files=await preflightFiles(value,task);if(Date.now()<snapshot.expiresAt)cache.set(key,snapshot)}catch{/* Failed or incomplete evidence is never reused. */}
  return snapshot
 })
 preflights.set(key,request)
 try{return await request}finally{if(preflights.get(key)===request)preflights.delete(key)}
}
export async function refreshStudioCapabilities(workflow:StudioWorkflow,task:any,deps:HostDeps={}){
 const config=deps.config??await readStudioHostConfiguration(deps.configPath),exec=deps.execute??execute,now=Date.now(),checkedAt=new Date(now).toISOString(),expiresAt=new Date(now+15*60_000).toISOString()
 const record=(name:string,status:string,proofSha256?:string,reason?:string,method?:string,timing?:PreflightSnapshot)=>(workflow as any).recordCapability(task,{name,status,checkedAt:timing?new Date(timing.checkedAt).toISOString():checkedAt,expiresAt:timing?new Date(timing.expiresAt).toISOString():expiresAt,...(proofSha256?{proofSha256}:{}),...(reason?{reason}:{}),...(method?{method}:{})})
 let result:any,reference:any,characterReferences:any[]=[],characterProfile:StudioCharacterProfileLock|undefined
 if(config.preflightScript){const scope=JSON.stringify({id:task.id,cwd:task.cwd,studio:task.design?.studio,config,environment:preflightEnvironment()}),key=hash(JSON.stringify({scope,host:await sharedIdentity(scope,config)}))
  let snapshot:PreflightSnapshot|undefined
  try{snapshot=await sharedPreflight(key,task,()=>exec(config.preflightScript,[],task,config,JSON.stringify(task)));result=snapshot.value}catch{result={capabilities:{}}}
  for(const [name,source] of [['character','character'],['reference','reference'],['frames','frames'],['render','hyperframes']]){const p=result?.capabilities?.[source];try{
   if(p?.ok!==true||!p.proofPath)throw Error('preflight unavailable');if(source==='hyperframes'&&(p.hyperframes_verified!==true||p.scope!=='actual_hyperframes_smoke_render'))throw Error('actual HyperFrames proof required')
   if(source==='character'){if(p.characterId!==task.design.studio.characterId||await fileSha256(p.imagePath)!==p.imageSha256||await fileSha256(p.profilePath)!==p.sha256)throw Error('character lock mismatch');const ref={id:p.profileAssetId??'character-primary',path:p.imagePath,sha256:p.imageSha256,...(p.profileAssetId?{assetId:p.profileAssetId}:{}),...(p.sourceUrl!==undefined?{sourceUrl:p.sourceUrl,sourceSha256:p.sourceSha256}:{})};publicCharacterReference(ref);const profileLock=characterProfileLock(p);await readStudioCharacterProfile(task,profileLock);characterReferences=[ref];characterProfile=profileLock}
   else {if(await fileSha256(p.path)!==p.sha256)throw Error('preflight asset changed');if(source==='reference'){if(p.sha256!==task.design.studio.referenceSha256)throw Error('reference lock mismatch');reference={path:p.path,sha256:p.sha256}}}
   const proofHash=await fileSha256(p.proofPath)
   if(snapshot?.files[p.proofPath]&&snapshot.files[p.proofPath]!==proofHash)throw Error('preflight proof changed')
   record(name,'passed',proofHash,undefined,'host_preflight',snapshot)
  }catch{if(source==='character'){characterProfile=undefined;characterReferences=[]}record(name,'failed',undefined,`actual ${source} preflight missing or invalid`)}}
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
 return {reference,characterReferences,characterProfile,preflight:result}
}
function audioFailure(result:any,prefix:string){
 if(result?.ok===true)return
 const stage=['input','vault','provider'].includes(result?.error_stage)?result.error_stage:'unknown'
 const type=['HTTPError','ValueError','PermissionError','RuntimeError','TimeoutError','URLError','FileNotFoundError','VisionError'].includes(result?.error_type)?result.error_type:'Error'
 const status=Number.isInteger(result?.http_status)&&result.http_status>=100&&result.http_status<=599?`-http-${result.http_status}`:''
 // Preserve bounded diagnostic enums, never provider text, exception strings or URLs.
 const details:any={}
 if(['invalid_png_header','png_dimensions_out_of_bounds','image_transport_timeout','image_transport_failed','stream_size_limit','sse_json_invalid','sse_object_invalid','provider_error_event','choices_invalid','choice_invalid','unexpected_choice','delta_invalid','unexpected_tool_call','text_delta_invalid','observation_size_limit','stream_done_missing','finish_reason_not_stop','observation_empty','stream_timeout','stream_read_failed','credential_echo_rejected','provider_timeout','provider_request_failed','input_or_vault_failure'].includes(result?.error_code))details.code=result.error_code
 if(['gaierror','TimeoutError','ConnectionRefusedError','ConnectionResetError','SSLError','SSLEOFError','SSLCertVerificationError','OSError'].includes(result?.reason_type)){
  details.reasonType=result.reason_type
  if(Number.isInteger(result.reason_errno)&&Math.abs(result.reason_errno)<=4096)details.errno=result.reason_errno
 }
 const diagnostic=result?.diagnostics
 if(typeof diagnostic?.done==='boolean')details.done=diagnostic.done
 if(['stop','length','content_filter','tool_calls','function_call','unknown'].includes(diagnostic?.finish_reason))details.finishReason=diagnostic.finish_reason
 for(const [from,to] of [['received_chars','receivedChars'],['received_bytes','receivedBytes']])if(Number.isInteger(diagnostic?.[from])&&diagnostic[from]>=0&&diagnostic[from]<=10_000_000)details[to]=diagnostic[from]
 if(Object.keys(details).length){
  details.nextAction=result?.http_status===401||result?.http_status===403?'Authorization failed. Repair host credentials; do not repeat the provider request or treat the observation as evidence.':details.code==='finish_reason_not_stop'&&details.finishReason==='length'?'Observation output was truncated. Do not use partial evidence. Narrow the observation scope or shorten the requested interval once; if it repeats, report a capability failure. Do not alter the film or lower QA criteria.':details.reasonType==='SSLCertVerificationError'?'TLS verification failed. Repair the host trust configuration; never disable certificate verification.':'Observation failed, not a quality finding. Retry the same observation at most once for a transient failure; on repetition report the capability gap and preserve prior valid evidence. Do not loop indefinitely.'
 }
 throw Error(`${prefix}-failed:${stage}:${type}${status}${Object.keys(details).length?'; '+JSON.stringify(details):''}`)
}
export async function observeStudioAudio(task:any,args:{wavPath:string,start:number,end:number},deps:HostDeps={}){
 const config=deps.config??await readStudioHostConfiguration(deps.configPath);if(!config.audioScript||!config.vaultTokenFile)throw Error('studio-audio-host-not-configured');const result=await(deps.execute??execute)(config.audioScript,[args.wavPath,'--start-seconds',String(args.start),'--end-seconds',String(args.end)],task,config)
 audioFailure(result,'studio-audio');if(result.input_modality!=='input_audio'||result.finish_reason!=='stop'||result.audio_sha256!==await fileSha256(args.wavPath))throw Error('studio-audio-observation-invalid');return result
}
export async function checkStudioSpeech(task:any,args:{wavPath:string,start:number,end:number,expectedText:string,stage:'source'|'final'},deps:HostDeps={}){
 const config=deps.config??await readStudioHostConfiguration(deps.configPath);if(!config.speechScript||!config.vaultTokenFile)throw Error('studio-speech-host-not-configured');const result=await(deps.execute??execute)(config.speechScript,[args.wavPath,'--expected-text',args.expectedText,'--stage',args.stage,'--start-seconds',String(args.start),'--end-seconds',String(args.end)],task,config)
 audioFailure(result,'studio-speech');if(result.audio_sha256!==await fileSha256(args.wavPath)||result.expected_text_sha256!==hash(args.expectedText)||!['pass','blocked'].includes(result.content_gate))throw Error('studio-speech-observation-invalid');return result
}

/** Actual Qwen VL observations; the language planner cannot self-attest seeing an image. */
export async function observeStudioVision(task:any,args:import('./studio-tools.js').VisionInput,deps:HostDeps={}){
 const config=deps.config??await readStudioHostConfiguration(deps.configPath);if(!config.visionScript||!config.vaultTokenFile)throw Error('studio-vision-host-not-configured')
 const result=await(deps.execute??execute)(config.visionScript,[],task,config,JSON.stringify(args));audioFailure(result,'studio-vision')
 if(result.input_modality!=='input_image'||result.finish_reason!=='stop'||!result.observation||!Array.isArray(result.images)||result.images.length!==args.images.length)throw Error('studio-vision-observation-invalid')
 for(let i=0;i<args.images.length;i++){const expected=args.images[i];if(result.images[i].sha256!==expected.sha256||result.images[i].time!==expected.time||await fileSha256(expected.path)!==expected.sha256)throw Error('studio-vision-observation-invalid')}
 return result
}

/** Fixed, hash-checked local compiler. Arguments select data paths, never code. */
export async function compileStudioStoryboard(task:any,args:{boardPath:string;outputDirectory:string},deps:HostDeps={}){
 const config=deps.config??await readStudioHostConfiguration(deps.configPath)
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
