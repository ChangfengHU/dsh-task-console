import {readFile,stat} from 'node:fs/promises'
import {relative,sep,extname} from 'node:path'
import {createHash} from 'node:crypto'
import {studioStageFor,studioStageCardId,type StudioStageId} from './studio-stages.js'
import {studioPath,fileSha256} from './studio-tools.js'
import {isStoryboardDocument,validateStoryboardScript} from './studio-storyboard-script.js'
import {probeStageMedia,requireStageMediaMetadata} from './studio-stage-media.js'
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
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
  if(isStoryboardDocument(board)){validateStoryboardScript(board,script);boards.push(output.path)}
 }
 if(!boards.length)throw Error('studio-storyboard-document-required: include a JSON storyboard with scenes and scriptSha256 matching studio_status.state.script; unrelated JSON files do not satisfy storyboard handoff')
 return {scriptSha256:script.sha256,boards}
}
export async function verifyStageReceipt(input:any,receipt:any,workflow?:any) {
 if(!receipt || receipt.configSha256!==digest(input.task.design.studioStages) || receipt.batchId!==input.batch.id || receipt.round!==input.card.round)throw Error('studio-stage-receipt-required')
 for(const f of [receipt.manifest,...receipt.outputs]){const path=await studioPath(input.task.cwd,f.path,true);if(await fileSha256(path)!==f.sha256)throw Error('studio-stage-file-changed')}
 receipt.outputs.forEach((output:any,index:number)=>requireStageMediaMetadata(receipt.stage,output,index))
 if(receipt.stage==='storyboard'){const binding=await storyboardBinding(input,receipt.outputs,workflow);if(!receipt.scriptBinding||digest(receipt.scriptBinding)!==digest(binding))throw Error('studio-storyboard-script-binding-required: frozen dialogue changed or legacy receipt has no verified binding; correct storyboard and re-register it before downstream generation')}
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
 const base=`stages/r${input.card.round}/${stage.id}/`,path=await studioPath(input.task.cwd,pathValue,true)
 const local=(p:string)=>relative(input.task.cwd,p).split(sep).join('/')
 if(local(path)!==base+'manifest.json'||(await stat(path)).size>1024*1024)throw Error('studio-stage-manifest-path')
 const sha256=await fileSha256(path),value=JSON.parse(await readFile(path,'utf8'))
 if(value.stage!==stage.id||value.round!==input.card.round||typeof value.summary!=='string'||!value.summary.trim()||!Array.isArray(value.outputs)||value.outputs.length<1||value.outputs.length>200||new Set(value.outputs).size!==value.outputs.length)throw Error('studio-stage-manifest-invalid')
 const outputs=[]
 for(const v of value.outputs){
  const p=await studioPath(input.task.cwd,v,true),rel=local(p),size=(await stat(p)).size
  if(!rel.startsWith(base)||rel===base+'manifest.json'||size<1||size>500*1024*1024)throw Error('studio-stage-output-invalid')
  const outputSha256=await fileSha256(p),media=await probeStageMedia(stage.id,p,outputs.length)
  if(await fileSha256(p)!==outputSha256)throw Error('studio-stage-file-changed')
  outputs.push({path:rel,sha256:outputSha256,bytes:size,...(media?{media}:{})})
 }
 const extensions=outputs.map(f=>extname(f.path).toLowerCase())
 const required=stage.id==='visual'?['.png','.jpg','.jpeg','.webp']:stage.id==='sound'?['.wav','.mp3','.m4a']:['.json']
 if(!extensions.some(e=>required.includes(e)))throw Error('studio-stage-media-required')
 if(await fileSha256(path)!==sha256)throw Error('studio-stage-file-changed')
 const scriptBinding=stage.id==='storyboard'?await storyboardBinding(input,outputs,workflow):undefined
 const receipt={...(scriptBinding?{scriptBinding}:{}),stage:stage.id,round:input.card.round,batchId:input.batch.id,sessionId:input.sessionId,cardId:input.card.id,configSha256:digest(input.task.design.studioStages),manifest:{path:local(path),sha256},outputs,summary:value.summary.slice(0,4000),qualityApproved:false}
 await verifyStageReceipt(input,receipt,workflow);workflow.recordStageReceipt(input,receipt)
 return receipt
}
