import {readFile,stat} from 'node:fs/promises'
import {relative,sep,extname} from 'node:path'
import {createHash} from 'node:crypto'
import {studioStageFor,studioStageCardId,type StudioStageId} from './studio-stages.js'
import {studioPath,fileSha256} from './studio-tools.js'
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
export async function verifyStageReceipt(input:any,receipt:any) {
 if(!receipt || receipt.configSha256!==digest(input.task.design.studioStages) || receipt.batchId!==input.batch.id || receipt.round!==input.card.round)throw Error('studio-stage-receipt-required')
 for(const f of [receipt.manifest,...receipt.outputs]){const path=await studioPath(input.task.cwd,f.path,true);if(await fileSha256(path)!==f.sha256)throw Error('studio-stage-file-changed')}
}
export async function requireStudioStages(input:any,workflow:any,db:any) {
 if(!input.task.design?.studioStages)return
 const stage=studioStageFor(input)
 const required:StudioStageId[]=stage?(stage.id==='storyboard'?[]:['storyboard']):input.card.role==='executor'?['storyboard','visual','sound']:[]
 for(const id of required){
  const cardId=studioStageCardId(input.batch.id,input.card.round,id),row=db.prepare('SELECT status,tenant,assignee FROM tasks WHERE id=?').get(cardId)
  const spec=input.task.design.studioStages.find((s:any)=>s.id===id)
  if(row?.status!=='done'||row.tenant!==input.batch.id||row.assignee!==spec?.agentId)throw Error(`studio-stage-dependency-required:${id}`)
  await verifyStageReceipt(input,workflow.stageReceipt(input,id))
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
  outputs.push({path:rel,sha256:await fileSha256(p),bytes:size})
 }
 const extensions=outputs.map(f=>extname(f.path).toLowerCase())
 const required=stage.id==='visual'?['.png','.jpg','.webp']:stage.id==='sound'?['.wav','.mp3','.m4a']:['.json']
 if(!extensions.some(e=>required.includes(e)))throw Error('studio-stage-media-required')
 if(await fileSha256(path)!==sha256)throw Error('studio-stage-file-changed')
 const receipt={stage:stage.id,round:input.card.round,batchId:input.batch.id,sessionId:input.sessionId,cardId:input.card.id,configSha256:digest(input.task.design.studioStages),manifest:{path:local(path),sha256},outputs,summary:value.summary.slice(0,4000),qualityApproved:false}
 await verifyStageReceipt(input,receipt);workflow.recordStageReceipt(input,receipt)
 return receipt
}
