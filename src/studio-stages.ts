/** Fixed video preparation DAG. Reuses Task scheduling and final Studio gates. */
export const STUDIO_STAGE_IDS = ['storyboard', 'visual', 'sound'] as const
export type StudioStageId = typeof STUDIO_STAGE_IDS[number]
export interface StudioStage { id: StudioStageId; agentId: string; brief: string }
export function validateStudioStages(value: unknown): StudioStage[] {
 if (!Array.isArray(value) || value.length !== 3) throw Error('studioStages requires storyboard, visual and sound')
 const result = STUDIO_STAGE_IDS.map(id => {
  const matches = value.filter(s => s?.id === id), s = matches[0]
  if (matches.length !== 1 || !s || Object.keys(s).some(k => !['id','agentId','brief'].includes(k)) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(s.agentId) || typeof s.brief !== 'string' || !s.brief.trim() || s.brief.length > 6000) throw Error('studioStages invalid stage')
  return {id, agentId:s.agentId, brief:s.brief.trim()}
 })
 if (new Set(result.map(s => s.agentId)).size !== 3) throw Error('studioStages requires distinct specialists')
 return result
}
export const studioStageCardId = (batch:string, round:number, id:StudioStageId) => `${batch}#s${round}-${id}`
export function studioStageFor(input:any):StudioStage|undefined {
 const stages = input.task?.design?.studioStages
 if (!stages || input.card?.role !== 'studio-stage') return
 const stage = stages.find((s:StudioStage) => input.card.id === studioStageCardId(input.batch.id,input.card.round,s.id))
 if (!stage || stage.agentId !== input.card.agentId || !Number.isInteger(input.card.round) || input.card.round < 1) throw Error('studio-stage-identity-mismatch')
 return stage
}
export function studioStageRows(task:any,batchId:string,round:number,plannerId:string) {
 return (task.design?.studioStages ?? []).map((s:StudioStage) => ({
  id:studioStageCardId(batchId,round,s.id),agentId:s.agentId,kind:'agent' as const,role:'studio-stage' as const,round,
  deps:s.id==='storyboard'?[plannerId]:[studioStageCardId(batchId,round,'storyboard')],
  brief:`${s.brief}\n本阶段=${s.id}，轮次=${round}。输出写入 stages/r${round}/${s.id}/，不得改写其他阶段或旧版。读取同轮上游交接。${s.id==='storyboard'?'先从 studio_status.state.script 读取冻结台词。分镜根字段 scriptSha256 必须为该记录的 sha256，script 数组按原样保存完整 {id,text}；镜头可无台词或引用相应台词ID，不能重写原文。发现剧情冲突应如实反馈，不自行解冻。':s.id==='sound'?'配音前读取 studio_status.state.script，逐句核对分镜引用。冻结记录是台词原文的依据；有冲突先报告，不能直接按冲突台词提交付费生成。':''}完成后写 manifest.json，格式 {"stage":"${s.id}","round":${round},"outputs":["stages/r${round}/${s.id}/实际文件"],"summary":"实际完成内容及未验证项"}。调用 studio_register_stage(path)，成功后 task_complete；本阶段交接不代表整片或审美通过。返修轮先查问题，仅修改必要素材，可复制未受影响产物并记录复用依据。`
 }))
}
