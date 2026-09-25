import {readFile,stat,readdir,realpath} from 'node:fs/promises'
import {relative,sep,extname,join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {studioStageFor,studioStageCardId,type StudioStageId} from './studio-stages.js'
import {studioPath,fileSha256} from './studio-tools.js'
import {isStoryboardDocument,validateStoryboardScript} from './studio-storyboard-script.js'
import {probeStageMedia,requireStageMediaMetadata,stageMediaKind} from './studio-stage-media.js'
import {inspectAudioSignal} from './studio-audio-signal.js'
import {bindAudioRequirements} from './studio-audio-requirements.js'
import {bindSoundPlan,soundPlanError} from './studio-sound-plan.js'
import {bindVisualComponents,validateVisualComponentRequirements,type VisualComponentInputs} from './studio-visual-components.js'
import {visualRequirements,bindVisualCoverage} from './studio-visual-coverage.js'
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
/** Bounded, read-only suggestions. Never import files or select creative assets. */
async function stageRegistrationError(input:any,stage:string,code:string,field:string,reason:string):Promise<never>{
 const base=`stages/r${input.card.round}/${stage}/`,expectedPath=base+'manifest.json'
 const outputIndex=/^outputs\[(\d+)\]$/.exec(field)?.[1]
 const exampleOutputs=stage==='visual'?[base+'visual-plan.json',base+'pose.png']:stage==='sound'?[base+'sound-plan.json',base+'line.wav']:[base+'storyboard.json']
 const candidates:any[]=[];let scanned=0,probed=0,truncated=false,bytesRead=0
 const started=performance.now(),deadline=started+5000,abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000)
 const timeLeft=()=>Math.max(0,Math.floor(deadline-performance.now())),maxFileBytes=4*1024*1024,maxReadBytes=16*1024*1024
 const boundedHash=async(path:string)=>{const hash=createHash('sha256');let fileBytes=0;for await(const chunk of createReadStream(path,{signal:abort.signal})){fileBytes+=chunk.length;bytesRead+=chunk.length;if(!timeLeft()||fileBytes>maxFileBytes||bytesRead>maxReadBytes)throw Error('diagnostic-scan-budget');hash.update(chunk)}return hash.digest('hex')}
 try{
 const root=await realpath(input.task.cwd),queue=[base]
 while(queue.length&&scanned<128&&probed<8&&timeLeft()>0&&!abort.signal.aborted){
  const dir=queue.shift()!
  let entries:any[]
  try{const canonical=await realpath(join(root,dir));if(canonical!==resolve(root,dir))continue;entries=await readdir(canonical,{withFileTypes:true})}catch{continue}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(scanned++>=128||probed>=8||timeLeft()<=0||abort.signal.aborted){truncated=true;break}
   if(entry.name.startsWith('.')||/credential|secret|token|password|private.?key/i.test(entry.name)||entry.isSymbolicLink())continue
   const rel=dir+entry.name
   if(entry.isDirectory()){if(rel.split('/').length<8)queue.push(rel+'/');else truncated=true;continue}
   if(!entry.isFile()||!stageMediaKind(stage,rel))continue
   try{
    const path=await studioPath(root,rel,true),local=relative(root,path).split(sep).join('/'),size=(await stat(path)).size
    if(!local.startsWith(base)||local!==rel||size<1)continue
    if(size>maxFileBytes||bytesRead+size*2>maxReadBytes){truncated=true;continue}
    const sha256=await boundedHash(path);if(!timeLeft()||abort.signal.aborted){truncated=true;break}probed++
    const media=await probeStageMedia(stage,path,probed-1,{timeoutMs:Math.min(1000,timeLeft()),signal:abort.signal})
    if(await boundedHash(path)===sha256)candidates.push({path:rel,sha256,bytes:size,media})
   }catch{truncated=true;/* Failed/timed-out candidates remain explicitly unverified. */}
  }
 }
 truncated=truncated||queue.length>0||timeLeft()<=0||abort.signal.aborted
 }catch{truncated=true}finally{clearTimeout(timer)}
 throw Error(code+': '+JSON.stringify({error_code:code,field,...(outputIndex!==undefined?{outputIndex:Number(outputIndex)}:{}),reason,pathContract:{basis:'task-workspace-relative',relativeTo:'Task workspace root, not the stage directory or manifest parent',requiredPrefix:base,exampleOutputs,examplesArePlaceholders:true},stageDirectory:base,tool:'studio_register_stage',arguments:{path:expectedPath},manifestSchema:{stage,round:input.card.round,outputs:['project-relative existing file paths within '+base],summary:'actual work and unverified items'},eligibleExistingMedia:candidates,scan:{scanned,probed,bytesRead,elapsedMs:Math.round(performance.now()-started),deadlineMs:5000,maxFileBytes,maxReadBytes,truncated,complete:!truncated},retryable:false,retryAfterRepair:true,action:'Create/read the manifest at the exact arguments.path. outputs must explicitly list the actual image/audio files as well as required plan JSON; copying files or listing only JSON does not register media. Every output path is relative to the Task workspace root, not to the manifest or stage directory; keep the full stages/rN/stage/ prefix. For a legally reusable file outside this stage, explicitly copy it into the current stage directory and preserve the original before listing the new workspace-relative path. Do not assume a short filename is relative to the manifest. Correct the indicated field, preserve required dialogue and visual requirements, then call studio_register_stage with {path}. Listed candidates are verified files only, not selected poses or complete coverage; choose and explicitly register the needed paths yourself. If required media is absent, obtain it or reconcile its original generation job; do not invent paths, create placeholders, delete requirements, or repeat the same manifest unchanged.',qualityApproved:false}))
}
async function soundRequirements(input:any,plan:any,workflow:any){
 const story=workflow?.stageReceipt?.(input,'storyboard'),paths=story?.scriptBinding?.boards
 if(story?.stage!=='storyboard'||story.cardId!==studioStageCardId(input.batch.id,input.card.round,'storyboard')||!Array.isArray(paths)||paths.length!==1)soundPlanError('audioRequirements','Exactly one canonical storyboard registered for this batch and round is required.')
 await verifyStageReceipt(input,story,workflow)
 const file=story.outputs.find((f:any)=>f.path===paths[0])
 if(!file||!file.path.startsWith(`stages/r${input.card.round}/storyboard/`)||!Number.isFinite(file.bytes)||file.bytes<1||file.bytes>8*1024*1024)soundPlanError('audioRequirements','Registered storyboard file is invalid or belongs to another round.')
 const bytes=await readFile(await studioPath(input.task.cwd,file.path,true))
 if(bytes.length>8*1024*1024||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('studio-stage-file-changed')
 let board:any;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{soundPlanError('audioRequirements','Registered storyboard JSON is invalid.')}
 return bindAudioRequirements(board,file.sha256,plan)
}
async function soundBinding(input:any,outputs:any[],workflow:any,inspectSignal=false,bindRequirements=false){
 const plans=[]
 for(const output of outputs.filter(f=>extname(f.path).toLowerCase()==='.json')){
  if(output.bytes>8*1024*1024)soundPlanError('plan','JSON exceeds 8 MiB.')
  const bytes=await readFile(await studioPath(input.task.cwd,output.path,true))
  if(bytes.length>8*1024*1024)soundPlanError('plan','JSON exceeds 8 MiB.')
  if(createHash('sha256').update(bytes).digest('hex')!==output.sha256)throw Error('studio-stage-file-changed')
  let value:any;try{value=JSON.parse(bytes.toString('utf8'))}catch{soundPlanError('plan','Invalid JSON output.')}
  if(value?.schema==='sound-plan-v1')plans.push({value,output})
 }
 if(plans.length!==1)soundPlanError('plan','Exactly one registered sound-plan-v1 JSON is required.')
 const binding=bindSoundPlan(plans[0].value,workflow?.script?.(input),outputs,plans[0].output)
 const audioRequirements=bindRequirements?await soundRequirements(input,plans[0].value,workflow):undefined
 const bound=(value:any)=>audioRequirements?{...value,audioRequirements}:value
 if(inspectSignal){
  const inspected=new Set<string>(),decodeDeadline=performance.now()+60000
  for(const track of binding.tracks){
   if(inspected.has(track.path))continue
   const path=await studioPath(input.task.cwd,track.path,true)
   if(await fileSha256(path)!==track.sha256)throw Error('studio-stage-file-changed')
   const timeoutMs=Math.floor(decodeDeadline-performance.now())
   if(timeoutMs<1)soundPlanError(`${track.role==='voice'?'lines':track.role}[${track.index}].sourcePath`,'Audio signal inspection exceeded the 60 second registration budget; required sources remain unverified. Diagnose the source/decoder before retrying; do not drop required cues.')
   try{track.media.signalEvidence=await inspectAudioSignal(path,track.sha256,{timeoutMs})}
   catch(error:any){soundPlanError(`${track.role==='voice'?'lines':track.role}[${track.index}].sourcePath`,`${error.message}. Actual audio signal remains unverified. Repair the local FFmpeg dependency or source file and re-register; do not claim silence or completion from a failed probe.`)}
   if(await fileSha256(path)!==track.sha256)throw Error('studio-stage-file-changed')
   inspected.add(track.path)
  }
  // Apply the exact same source/field check used when replaying new receipts.
  if(bindRequirements&&digest(audioRequirements)!==digest(await soundRequirements(input,plans[0].value,workflow)))soundPlanError('audioRequirements','Registered storyboard requirements changed during audio inspection.')
  return bound(bindSoundPlan(plans[0].value,workflow?.script?.(input),outputs,plans[0].output))
 }
 return bound(binding)
}
async function storyboardBinding(input:any,outputs:any[],workflow:any){
 const script=workflow?.script?.(input)
 if(!script)throw Error('studio-storyboard-script-required: read studio_status.state.script; the planner must freeze dialogue with studio_freeze_script before storyboard handoff')
 const boards=[]
 for(const output of outputs.filter(f=>extname(f.path).toLowerCase()==='.json')){
  if(output.bytes>8*1024*1024)throw Error('studio-storyboard-json-too-large')
  const path=await studioPath(input.task.cwd,output.path,true),bytes=await readFile(path)
  if(bytes.length>8*1024*1024)throw Error('studio-storyboard-json-too-large')
  if(createHash('sha256').update(bytes).digest('hex')!==output.sha256)throw Error('studio-stage-file-changed')
  let board:any;try{board=JSON.parse(bytes.toString('utf8'))}catch{throw Error('studio-storyboard-json-invalid: repair JSON output before studio_register_stage')}
  if(isStoryboardDocument(board)){validateStoryboardScript(board,script);if(input.task.design?.studio?.visualCoverage==='requirements-v1')visualRequirements(board);if(input.task.design?.studio?.visualCoverage==='components-v2'){
   const lockedId=input.task.design.studio.characterId,typed=validateVisualComponentRequirements({storyboard:{bytes,sha256:output.sha256},characterIds:[lockedId]})
   if(!typed.requirements.some(r=>r.kind==='character'&&r.characterId===lockedId))throw Error('studio-storyboard-character-required: '+JSON.stringify({field:'visualRequirements.items',reason:'task-locked-character-not-represented',action:'Include the Task-designated character in the actual story and typed requirements. Background-only individual scenes are allowed; a background-only film cannot fulfill this character Task. Do not add a false declaration or invent files.',qualityApproved:false,pixelEvidence:'unverified'}))
  }boards.push(output.path)}
 }
 if(!boards.length)throw Error('studio-storyboard-document-required: include a JSON storyboard with scenes and scriptSha256 matching studio_status.state.script; unrelated JSON files do not satisfy storyboard handoff')
 if(['requirements-v1','components-v2'].includes(input.task.design?.studio?.visualCoverage)&&boards.length!==1)throw Error('studio-visual-coverage-required: register exactly one canonical storyboard before visual handoff')
 return {scriptSha256:script.sha256,boards}
}
/** Loads authoritative registered inputs only; callers also verify the stage receipts/actual media hashes. */
export async function studioVisualComponentInputs(input:any,workflow:any,visualOutputs?:any[]):Promise<VisualComponentInputs>{
 const story=workflow.stageReceipt(input,'storyboard'),paths=story?.scriptBinding?.boards
 if(!Array.isArray(paths)||paths.length!==1)throw Error('studio-visual-components-required: exactly one registered storyboard is required')
 const outputs=visualOutputs??workflow.stageReceipt(input,'visual')?.outputs
 if(!Array.isArray(outputs))throw Error('studio-visual-components-required: registered visual stage outputs are required')
 const load=async(f:any)=>{
  if(!f||!Number.isFinite(f.bytes)||f.bytes<1||f.bytes>8*1024*1024)throw Error('studio-visual-components-document-invalid')
  const bytes=await readFile(await studioPath(input.task.cwd,f.path,true))
  if(bytes.length>8*1024*1024||createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw Error('studio-stage-file-changed')
  return {bytes,sha256:f.sha256}
 }
 const storyboard=await load(story.outputs.find((f:any)=>f.path===paths[0])),plans=[]
 for(const f of outputs.filter((f:any)=>extname(f.path).toLowerCase()==='.json')){
  const doc=await load(f);let value:any
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(doc.bytes))}catch{throw Error('studio-visual-components-document-invalid')}
  if(value?.schema==='visual-plan-v2')plans.push(doc)
 }
 if(plans.length!==1)throw Error('studio-visual-components-required: include exactly one visual-plan-v2 with typed components, requirement bindings and actual registered image paths/SHA256; legacy visual-plan-v1 is not a v2 handoff')
 return {storyboard,visualPlan:plans[0],outputs:outputs.filter((f:any)=>f.media?.kind==='image'),characterIds:[input.task.design.studio.characterId]}
}
async function visualBinding(input:any,outputs:any[],workflow:any){
 if(input.task.design?.studio?.visualCoverage==='components-v2')return bindVisualComponents(await studioVisualComponentInputs(input,workflow,outputs))
 const receipt=workflow.stageReceipt(input,'storyboard'),paths=receipt?.scriptBinding?.boards
 if(!Array.isArray(paths)||paths.length!==1)throw Error('studio-visual-coverage-required: exactly one canonical registered storyboard is required')
 const boardFile=receipt.outputs.find((f:any)=>f.path===paths[0])
 const load=async(f:any)=>{if(!f||f.bytes>8*1024*1024)throw Error('studio-visual-coverage-file-invalid');const bytes=await readFile(await studioPath(input.task.cwd,f.path,true));if(bytes.length>8*1024*1024||createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw Error('studio-stage-file-changed');return JSON.parse(bytes.toString())}
 const plans=[]
 for(const f of outputs.filter(f=>extname(f.path)==='.json')){const v=await load(f);if(v.schema==='visual-plan-v1')plans.push(v)}
 if(plans.length!==1)throw Error('studio-visual-coverage-required: include exactly one visual-plan-v1 JSON with storyboardSha256, items:[{requirementId,path,usage}], missing:[]')
 return bindVisualCoverage(await load(boardFile),plans[0],outputs,boardFile.sha256)
}
export async function verifyStageReceipt(input:any,receipt:any,workflow?:any):Promise<void> {
 if(!receipt || receipt.configSha256!==digest(input.task.design.studioStages) || receipt.batchId!==input.batch.id || receipt.round!==input.card.round)throw Error('studio-stage-receipt-required')
 for(const f of [receipt.manifest,...receipt.outputs]){const path=await studioPath(input.task.cwd,f.path,true);if(await fileSha256(path)!==f.sha256)throw Error('studio-stage-file-changed')}
 receipt.outputs.forEach((output:any,index:number)=>requireStageMediaMetadata(receipt.stage,output,index))
 if(receipt.stage==='visual'&&['requirements-v1','components-v2'].includes(input.task.design?.studio?.visualCoverage)){
  if(!receipt.visualBinding||digest(receipt.visualBinding)!==digest(await visualBinding(input,receipt.outputs,workflow)))throw Error('studio-visual-coverage-required: receipt coverage missing or changed')
 }
 if(receipt.stage==='storyboard'){const binding=await storyboardBinding(input,receipt.outputs,workflow);if(!receipt.scriptBinding||digest(receipt.scriptBinding)!==digest(binding))throw Error('studio-storyboard-script-binding-required: frozen dialogue changed or legacy receipt has no verified binding; correct storyboard and re-register it before downstream generation')}
 if(receipt.stage==='sound'){
  // Legacy v2 replays the original algorithm; only new v3 receipts bind original audio requirements.
  if(receipt.stageContractVersion!==undefined||receipt.soundBinding!==undefined){
   if(![2,3].includes(receipt.stageContractVersion)||!receipt.soundBinding)soundPlanError('receipt','Unsupported contract or missing sound binding.')
   if(digest(receipt.soundBinding)!==digest(await soundBinding(input,receipt.outputs,workflow,false,receipt.stageContractVersion===3)))soundPlanError('receipt','Sound binding changed.')
  }
 }
}
export async function requireStudioStages(input:any,workflow:any,db:any) {
 if(!input.task.design?.studioStages)return
 const stage=studioStageFor(input)
 const required:StudioStageId[]=stage?(stage.id==='storyboard'?[]:['storyboard']):input.card.role==='executor'?['storyboard','visual','sound']:[]
 for(const id of required){
  const cardId=studioStageCardId(input.batch.id,input.card.round,id),row=db.prepare('SELECT status,tenant,assignee FROM tasks WHERE id=?').get(cardId)
  const spec=input.task.design.studioStages.find((s:any)=>s.id===id)
  if(row?.status!=='done'||row.tenant!==input.batch.id||row.assignee!==spec?.agentId)throw Error(`studio-stage-dependency-required:${id}`)
  const receipt=workflow.stageReceipt(input,id)
  if(receipt?.stage!==id)throw Error('studio-stage-receipt-required')
  await verifyStageReceipt(input,receipt,workflow)
 }
}
export async function registerStageFiles(input:any,pathValue:string,workflow:any,db:any) {
 const stage=studioStageFor(input);if(!stage)throw Error('studio-stage-role-required')
 await requireStudioStages(input,workflow,db)
 const base=`stages/r${input.card.round}/${stage.id}/`
 if(typeof pathValue!=='string'||!pathValue.trim())return stageRegistrationError(input,stage.id,'studio-stage-manifest-missing','path','Provide the existing stage manifest path in the tool argument {path}.')
 let path:string
 try{path=await studioPath(input.task.cwd,pathValue,true)}catch(error:any){if(error?.code==='ENOENT')return stageRegistrationError(input,stage.id,'studio-stage-manifest-missing','path','The supplied manifest path does not exist.');throw error}
 const local=(p:string)=>relative(input.task.cwd,p).split(sep).join('/')
 if(local(path)!==base+'manifest.json'||(await stat(path)).size>1024*1024)return stageRegistrationError(input,stage.id,'studio-stage-manifest-path','path','Manifest must be the exact stage manifest.json and at most 1 MiB.')
 const sha256=await fileSha256(path),value=JSON.parse(await readFile(path,'utf8'))
 if(!Array.isArray(value.outputs)||value.outputs.length<1)return stageRegistrationError(input,stage.id,'studio-stage-manifest-invalid','outputs','outputs must be a non-empty array of explicit project-relative file paths; plans do not implicitly register their referenced media.')
 if(value.stage!==stage.id||value.round!==input.card.round||typeof value.summary!=='string'||!value.summary.trim()||!Array.isArray(value.outputs)||value.outputs.length<1||value.outputs.length>200||new Set(value.outputs).size!==value.outputs.length)throw Error('studio-stage-manifest-invalid')
 const outputs=[]
 for(const [index,v] of value.outputs.entries()){
  let p:string
  const invalid=(reason:string)=>stageRegistrationError(input,stage.id,'studio-stage-output-invalid',`outputs[${index}]`,reason)
  try{p=await studioPath(input.task.cwd,v,true)}catch(error:any){
   if(error?.code==='ENOENT')return stageRegistrationError(input,stage.id,'studio-stage-output-missing',`outputs[${index}]`,`The listed output does not exist when resolved from the Task workspace root. Use the full ${base} prefix, not a stage-relative basename. Do not remove required dialogue or visual coverage to bypass this error.`)
   if(['studio-invalid-path','studio-path-outside-project','studio-sensitive-path','studio-file-required'].includes(error?.message))return invalid(`${error.message}: outputs must name existing non-sensitive files inside ${base}, resolved from the Task workspace root.`)
   throw error
  }
  const rel=local(p),size=(await stat(p)).size
  if(!rel.startsWith(base))return invalid(`The existing output is outside the current stage directory ${base}. Copy a legally reusable file into this directory, preserve the original, and list the copied file using its full workspace-relative path. Do not rename only the manifest entry without creating the real file.`)
  if(rel===base+'manifest.json')return invalid('The stage manifest cannot register itself as an output. Keep required actual plan and media files in outputs.')
  if(outputs.some(f=>f.path===rel))return invalid('This entry resolves to a file already registered by an earlier outputs entry. Register each actual file once without dropping required content.')
  if(size<1||size>500*1024*1024)return invalid('The output must be a non-empty existing file no larger than 500 MiB. A placeholder does not satisfy stage handoff.')
  const outputSha256=await fileSha256(p),media=await probeStageMedia(stage.id,p,outputs.length)
  if(await fileSha256(p)!==outputSha256)throw Error('studio-stage-file-changed')
  outputs.push({path:rel,sha256:outputSha256,bytes:size,...(media?{media}:{})})
 }
 const extensions=outputs.map(f=>extname(f.path).toLowerCase())
 const required=stage.id==='visual'?['.png','.jpg','.jpeg','.webp']:stage.id==='sound'?['.wav','.mp3','.m4a']:['.json']
 if(!extensions.some(e=>required.includes(e)))return stageRegistrationError(input,stage.id,'studio-stage-media-required','outputs',`No registered ${stage.id==='visual'?'image':stage.id==='sound'?'audio':'storyboard JSON'} file. Eligible extensions: ${required.join(', ')}. Files on disk are not registered unless their paths appear in outputs.`)
 if(await fileSha256(path)!==sha256)throw Error('studio-stage-file-changed')
 const scriptBinding=stage.id==='storyboard'?await storyboardBinding(input,outputs,workflow):undefined
 const audioBinding=stage.id==='sound'?await soundBinding(input,outputs,workflow,true,true):undefined
 const visual=stage.id==='visual'&&['requirements-v1','components-v2'].includes(input.task.design?.studio?.visualCoverage)?await visualBinding(input,outputs,workflow):undefined
 const receipt={...(visual?{visualBinding:visual}:{}),...(scriptBinding?{scriptBinding}:{}),...(audioBinding?{stageContractVersion:3,soundBinding:audioBinding}:{}),stage:stage.id,round:input.card.round,batchId:input.batch.id,sessionId:input.sessionId,cardId:input.card.id,configSha256:digest(input.task.design.studioStages),manifest:{path:local(path),sha256},outputs,summary:value.summary.slice(0,4000),qualityApproved:false}
 await verifyStageReceipt(input,receipt,workflow);workflow.recordStageReceipt(input,receipt)
 return receipt
}
