import { readFile } from 'node:fs/promises'
import { join,dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileSha256 } from './studio-tools.js'
import type { StudioWorkflow } from './studio-workflow.js'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
// Host deployment configuration, never a model-supplied task field.
async function configuration(): Promise<any> {try{return JSON.parse(await readFile(new URL('../studio-host.json',import.meta.url),'utf8'))}catch{return {}}}
interface HostDeps {config?:any;execute?:(script:string,args:string[],task:any,config:any,stdin?:string)=>Promise<any>}
async function execute(script:string,args:string[],task:any,config:any,stdin?:string):Promise<any>{
 return new Promise((resolve,reject)=>{const child=spawn('python3',[script,...args],{env:{...process.env,STUDIO_PROJECT_ROOT:task.cwd,STUDIO_VAULT_TOKEN_FILE:config.vaultTokenFile??''},stdio:['pipe','pipe','ignore']});let output='',overflow=false,done=false
 const finish=(err?:Error,result?:any)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(err);else resolve(result)}
 const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('studio-host-subprocess-timeout'))},420000)
 child.stdout.on('data',b=>{output+=b.toString();if(output.length>2_000_000){overflow=true;child.kill('SIGKILL')}});child.on('error',()=>finish(Error('studio-host-subprocess-unavailable')));child.stdin.on('error',()=>{});child.stdin.end(stdin??'')
 child.on('close',()=>{if(overflow)return finish(Error('studio-host-output-too-large'));try{finish(undefined,JSON.parse(output))}catch{finish(Error('studio-host-output-invalid'))}})
 })
}
const cache=new Map<string,{at:number,value:any}>()
export async function refreshStudioCapabilities(workflow:StudioWorkflow,task:any,deps:HostDeps={}){
 const config=deps.config??await configuration(),exec=deps.execute??execute,now=Date.now(),checkedAt=new Date(now).toISOString(),expiresAt=new Date(now+15*60_000).toISOString()
 const record=(name:string,status:string,proofSha256?:string,reason?:string,method?:string)=>(workflow as any).recordCapability(task,{name,status,checkedAt,expiresAt,...(proofSha256?{proofSha256}:{}),...(reason?{reason}:{}),...(method?{method}:{})})
 let result:any,reference:any,characterReferences:any[]=[]
 if(config.preflightScript){const key=hash(JSON.stringify({id:task.id,cwd:task.cwd,studio:task.design?.studio,script:config.preflightScript})),old=cache.get(key)
  try{result=old&&now-old.at<60_000?old.value:await exec(config.preflightScript,[],task,config,JSON.stringify(task));if(!old||result!==old.value)cache.set(key,{at:Date.now(),value:result})}catch{result={capabilities:{}}}
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
