import {readStudioHostConfiguration,studioHostExecutables,STUDIO_HOST_EXECUTABLES} from './studio-config.js'
/** Pinned asynchronous render bridge. No caller-supplied commands or credentials. */
import {realpath,stat} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {isAbsolute,relative,resolve,sep} from 'node:path'
import {fileSha256,studioPath} from './studio-tools.js'
interface Dependencies {config?:any;configPath?:string;execute?:(script:string,args:string[])=>Promise<any>}
const digest=/^[a-f0-9]{64}$/
const errorActions:Record<string,string>={
 render_node_version_unsupported:'The host renderer requires Node 22 or later at its pinned path; repair host configuration, not the project composition.',
 project_relative_path_required:'Use a relative composition/output path inside this task.',project_path_invalid:'Use files inside the current task; do not traverse outside it.',plain_directory_required:'The composition must be a real directory.',plain_file_required:'Verify each referenced local file exists.',
 input_symlink_forbidden:'Freeze regular local files; symbolic links are not render inputs.',sensitive_input_forbidden:'Keep credentials and private configuration out of the composition.',input_snapshot_too_large:'Limit the composition directory to required render assets.',input_changed_during_snapshot:'Stop editing inputs and submit a stable composition.',
 freeze_dynamic_dependencies_required:'Freeze dynamically loaded dependencies locally before rendering.',freeze_remote_dependencies_required:'Download permitted dependencies into the composition first.',freeze_dependencies_inside_composition:'Copy required dependencies inside the composition directory and update references.',composition_audio_required:'Mount actual narration/audio in the composition before rendering.',
 invalid_render_request:'Correct the composition/output and requested media dimensions.',output_exists:'Preserve existing output; choose a new MP4 path.',output_reserved_by_other_job:'Query the original job; do not overwrite its reserved output.',invalid_job_id:'Use the exact jobId returned by studio_render_start.',job_identity_mismatch:'Use the job belonging to the current task.',
 worker_start_unknown_reconcile_required:'Reconcile the original job before another submission.',worker_lost_reconcile_required:'The original worker cannot be confirmed alive; inspect its saved logs and status before retry.',render_inputs_changed:'Inputs changed after submission; preserve this job and freeze a revised composition.',render_runtime_changed:'The pinned runtime changed; verify the deployed host before retry.',render_output_exists:'An output already exists; preserve it and inspect the original job.',
 render_step_timeout:'Inspect the original job logs; do not replace the video with a placeholder.',render_step_failed:'Inspect the failed step logs and repair that prerequisite.',render_check_failed:'Inspect the composition check log and repair the HTML/assets.',render_render_failed:'Inspect the renderer log and correct its reported error.',render_decode_failed:'The output did not fully decode; inspect the decode log and repair the render.',render_video_audio_required:'Render both real video and audio streams.',render_media_spec_mismatch:'Correct the actual output dimensions and frame rate.',completed_output_changed:'The completed file changed; preserve evidence and render a new revision.',render_worker_failed:'Inspect the saved worker logs before retry.',render_host_failed:'Inspect the configured host render capability.'
}
for(const stage of ['check','render','decode'])for(const outcome of ['failed','timeout'])errorActions[`${stage}_step_${outcome}`]=`Inspect the ${stage} log and repair the reported prerequisite; preserve the original job before retry.`
function failure(code:any){const errorCode=typeof code==='string'&&Object.hasOwn(errorActions,code)?code:'render_host_failed';return {errorCode,nextAction:errorActions[errorCode]}}
function safeRelative(value:any){return typeof value==='string'&&value.length>0&&value.length<=240&&!isAbsolute(value)&&!value.includes('\0')&&!value.includes('\\')&&!value.split('/').some(p=>!p||p==='..'||p.startsWith('.')||/credential|secret|token|password|private.?key/i.test(p))}
export const studioRenderConfiguration=readStudioHostConfiguration
async function execute(script:string,args:string[],config:any):Promise<any>{
 return new Promise((resolve,reject)=>{
  // The render bridge does not need provider credentials. Its detached worker applies its own allowlist too.
  const env:Record<string,string>={};for(const name of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[name])env[name]=process.env[name]!
  const child=spawn(config.pythonExecutable??'python3',['-B',script,...args],{env,stdio:['ignore','pipe','ignore']});let output='',finished=false
  const finish=(error?:Error,result?:any)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(result)}
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('studio-render-bridge-timeout: inspect original job before retry'))},45000)
  child.on('error',()=>finish(Error('studio-render-bridge-unavailable')))
  child.stdout.on('data',b=>{output+=b.toString();if(output.length>1000000){child.kill('SIGKILL');finish(Error('studio-render-bridge-output-too-large'))}})
  child.on('close',(code,signal)=>{try{const result=JSON.parse(output);if(signal||code!==0&&result?.ok!==false)throw Error();finish(undefined,result)}catch{finish(Error('studio-render-bridge-output-invalid'))}})
 })
}
/** All checks before this returns are read-only and cannot dispatch a renderer. */
export async function prepareStudioRenderJob(task:any,action:'start'|'status',args:{composition?:string;output?:string;jobId?:string},deps:Dependencies={},reconcileExistingIntent=false){
 args={...args}
 const config={...(deps.config??await studioRenderConfiguration(deps.configPath))}
 const executables=studioHostExecutables(config)
 if(!config.renderJobScript||!digest.test(config.renderJobSha256??'')||!config.renderRuntime)throw Error('studio-render-host-not-configured')
 if(await fileSha256(config.renderJobScript)!==config.renderJobSha256)throw Error('studio-render-helper-changed')
 const root=await realpath(task.cwd),policy=task.design?.studio&&{...task.design.studio}
 if(!policy||policy.width!==1080||policy.height!==1920||policy.fps!==30)throw Error('studio-render-policy-invalid')
 const argv=[action,'--project-root',root]
 if(action==='start'){
  if(!safeRelative(args.composition)||!safeRelative(args.output)||!args.output!.endsWith('.mp4'))throw Error('studio-render-path-invalid')
  if(!reconcileExistingIntent){
   const composition=await realpath(resolve(root,args.composition!)),rel=relative(root,composition)
   if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!(await stat(composition)).isDirectory())throw Error('studio-render-composition-invalid')
   await studioPath(root,`${args.composition}/index.html`,true)
  }
  argv.push('--composition',args.composition!,'--output',args.output!,'--runtime',config.renderRuntime,'--width',String(policy.width),'--height',String(policy.height),'--fps',String(policy.fps))
  for(const [field,path]of Object.entries(executables))argv.push(STUDIO_HOST_EXECUTABLES[field as keyof typeof STUDIO_HOST_EXECUTABLES].flag,path)
 }else{
  if(!digest.test(args.jobId??''))throw Error('studio-render-job-id-invalid')
  argv.push('--job-id',args.jobId!)
 }
 return {dispatch:async(intentId?:string)=>{
 const commandArgs=[...argv]
 if(intentId!==undefined){if(!digest.test(intentId))throw Error('studio-render-intent-invalid');if(action==='start')commandArgs.push('--intent-id',intentId)}
 const r=await(deps.execute??((script,args)=>execute(script,args,config)))(config.renderJobScript,commandArgs)
 // Never return arbitrary subprocess body, log contents, environment or provider errors.
 if(r?.ok!==true)return {ok:false,...failure(r?.errorCode),qualityApproved:false}
 if(!digest.test(r.jobId??'')||action==='status'&&r.jobId!==args.jobId||!['queued','running','completed','failed','unknown'].includes(r.state)||!digest.test(r.inputSha256??'')||!safeRelative(r.composition)||!safeRelative(r.output))throw Error('studio-render-receipt-invalid')
 if(action==='start'&&(r.composition!==args.composition||r.output!==args.output))throw Error('studio-render-receipt-mismatch')
 if(intentId!==undefined&&r.intentId!==intentId)throw Error('studio-render-intent-mismatch')
 const result:any={...(intentId?{intentId,helperSha256:config.renderJobSha256,helperPath:config.renderJobScript,runtimePath:config.renderRuntime}:{}),ok:true,jobId:r.jobId,state:r.state,composition:r.composition,output:r.output,inputSha256:r.inputSha256,reused:r.reused===true,qualityApproved:false}
 if(r.inputIndexSha256!==undefined){if(!digest.test(r.inputIndexSha256))throw Error('studio-render-input-index-invalid');result.inputIndexSha256=r.inputIndexSha256}
 if(r.state==='completed'){
  const output=await studioPath(root,r.output,true),size=(await stat(output)).size
  if(!digest.test(r.outputSha256??'')||!Number.isInteger(r.bytes)||r.bytes!==size||size<1||await fileSha256(output)!==r.outputSha256||r.width!==policy.width||r.height!==policy.height||Math.abs(r.fps-policy.fps)>.001||!Number.isFinite(r.durationSeconds)||r.durationSeconds<=0)throw Error('studio-render-completed-file-invalid')
  Object.assign(result,{outputSha256:r.outputSha256,bytes:size,width:r.width,height:r.height,fps:r.fps,durationSeconds:r.durationSeconds,nextAction:'Register the real candidate and its manifest, then run full quality review. Rendering is not quality approval.'})
 }else if(['failed','unknown'].includes(r.state))Object.assign(result,failure(r.errorCode))
 else result.nextAction='Call studio_render_status with this jobId. Do not submit another render while this job is pending.'
 if(Array.isArray(r.logs)){
  result.logs=[]
  for(const value of r.logs.slice(0,10))if(typeof value==='string'&&!isAbsolute(value)&&!value.includes('..')&&/^[A-Za-z0-9_./-]+\.log$/.test(value)){
   try{const path=await studioPath(root,value);result.logs.push(relative(root,path))}catch{}
  }
 }
 return result
 }}
}

export async function studioRenderJob(task:any,action:'start'|'status',args:{composition?:string;output?:string;jobId?:string},deps:Dependencies={},intentId?:string){
 return (await prepareStudioRenderJob(task,action,args,deps)).dispatch(intentId)
}

/** Operator-only reconciliation. The pinned host checks the exact intent before inspecting current inputs.
 * If no job exists it validates the composition and safely returns plain_directory_required without dispatch. */
export async function reconcileStudioRenderIntent(task:any,args:{composition:string;output:string},deps:Dependencies,intentId:string){
 if(!digest.test(intentId))throw Error('studio-render-intent-invalid')
 const result=await (await prepareStudioRenderJob(task,'start',args,deps,true)).dispatch(intentId)
 return result?.ok===false&&result.errorCode==='plain_directory_required'?{...result,reconciledAbsent:true}:result
}


/** Preflight does not reserve. Once the intent is durable, every bridge failure
 * is ambiguous unless an authoritative original-job receipt resolves it. */
export async function invokeStudioRenderJob(input:any,action:'start'|'status',args:any,ledger:any,assertActive:()=>void,deps:Dependencies={}){
 args=structuredClone(args)
 assertActive()
 const prior=ledger.lookup(input,action,args)
 const hostConfig=deps.config??await studioRenderConfiguration(deps.configPath)
 const config=prior?.helperPath?{...studioHostExecutables(hostConfig),renderJobScript:prior.helperPath,renderJobSha256:prior.helperSha256,renderRuntime:prior.runtimePath}:hostConfig
 const selectedAction=action==='start'&&prior?.jobId?'status':action
 const selectedArgs=selectedAction==='status'?{jobId:prior?.jobId??args.jobId}:args
 const prepared=await prepareStudioRenderJob(input.task,selectedAction,selectedArgs,{...deps,config})
 assertActive()
 // No await between the durable reservation and the dispatch boundary.
 const intent=ledger.prepare(input,action,args,config)
 if(intent.helperPath!==config.renderJobScript||intent.helperSha256!==config.renderJobSha256||intent.runtimePath!==config.renderRuntime)throw Error('studio-render-origin-changed-before-dispatch')
 let result:any
 try{result=await prepared.dispatch(intent.intentId)}
 catch(error){ledger.record(input,intent,{ok:false,errorCode:'render_host_failed'});throw error}
 // Preserve original-job facts even when the calling session expired while
 // awaiting them; ledger CAS prevents an older observation from overwriting.
 ledger.record(input,intent,result)
 assertActive()
 return result
}
