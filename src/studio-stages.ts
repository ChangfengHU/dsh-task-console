import {STUDIO_SPEECH_MAX_SECONDS} from './studio-speech-limits.js'
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
  brief:`${s.brief}\n${s.id==='visual'?'执行方法：先按每项分镜需求列出可直接使用的已归档文件、必须实际导出的裁切/合成产物、以及确需新生成的素材。每次提交前读取剩余图片项数和批次数，把有共同设置的需求合理组成prompts；优先补足人物动作与可用复合画面，不能把全部批次都用于背景。生图提交返回queued/running仅表示后台尚未完成：保存原taskId，用get_task查询原作业，按成功item下载并检查真实文件；等待期间不要反复修改manifest登记缺项，不重复提交或清预算。角色表不是独立姿势：真正导出裁切后用studio_preview_image检查当前文件，再登记实际路径；缺项正式回交，不用missing:[]掩盖。':s.id==='sound'?'执行方法：从各scene引用的lineId定位冻结台词，不把第N句机械套入第N场；生成后测真实语音duration，再据动作和对白位置重算各cue，不能重叠、截断或静音占位。配乐先取得可用真实文件。归档音乐/音效使用 studio_download_asset({id:工具返回的真实ID,path:本阶段新文件相对路径})，宿主负责认证；不要自行拼接/file地址或匿名curl，不向模型取密钥。遇source-only来源卡先读取 studio_read_guide({id:"handoff"}) 的来源获取方法，再按实际sourcePolicy执行；来源卡、短音效或静音文件不能充当所需背景音乐。失败保留原audioRequirements，完成原作业对账或正式回交，不能删bgm/sfx来交卷。':''}\n${s.id!=='sound'&&task.design?.studio?.visualCoverage==='components-v2'?'分层覆盖契约 components-v2：分镜 visualRequirements={schema:"components-v2",items:[{id,sceneId,kind,componentKey,characterId?,purpose}]}；kind为character/background/prop/subject，人物身份绑定本Task角色ID。场景id唯一，每个原场景明确需求。视觉提交唯一 visual-plan-v2，storyboardSha256绑定登记分镜原文件；components:[{id,kind,componentKey,characterId?,path,sha256}]绑定实际登记图片，items:[{requirementId,componentId,usage}]逐项满足原需求，missing:[]不得掩盖缺项。真实合成图可含多组件、可复用，背景组件不能代替人物；裁切必须是真实登记文件。typed声明不代表像素或质量通过。合成使用独立 studio-execution-components-v2 侧车经bindingPath交给studio_compile_storyboard：绑定storyboardSha256/visualPlanSha256/executionBoardSha256和mappings:[{sceneIndex,layerIndex,originalSceneId,requirementId,componentId}]。拆镜可沿用originalSceneId，实际image src必须匹配已登记组件，不把v2规划visualRequirements对象复制进执行板。':''}\n${s.id!=='sound'&&task.design?.studio?.visualCoverage==='requirements-v1'?'素材覆盖契约：storyboard.json 必须是唯一标准分镜，scenes 使用唯一 id；根字段 visualRequirements:[{id,sceneId,purpose}] 列出每个镜头实际所需姿势、表情、背景或道具，每个 scene 至少一项。视觉阶段交唯一 schema=visual-plan-v1 JSON，storyboardSha256 为已登记分镜文件哈希，items:[{requirementId,path,usage}] 逐项绑定实际登记图片，missing:[] 只在无缺项时填写。允许有依据复用但写明镜头用途；缺素材不能仅以已有少量图片提交完成，无法满足则正式请求前期返工。此覆盖检查不代表画质或表演通过。':''}\n本阶段=${s.id}，轮次=${round}。输出写入 stages/r${round}/${s.id}/，不得改写其他阶段或旧版。读取同轮上游交接。${s.id==='storyboard'?'先从 studio_status.state.script 读取冻结台词。分镜根字段 scriptSha256 必须为该记录的 sha256，script 数组按原样保存完整 {id,text}；镜头可无台词或引用相应台词ID，不能重写原文。发现剧本语言、内容体量或时长的根本问题，用 studio_request_preparation_revision(reason,evidencePath) 正式回交编导，不自行解冻。':s.id==='sound'?'配音前读取 studio_status.state.script，逐句核对分镜引用。冻结记录是台词原文的依据；有冲突先报告，不能直接按冲突台词提交付费生成。当前逐句检查要求每段实测源音频及最终区间均不超过'+STUDIO_SPEECH_MAX_SECONDS+'秒（完整台词观察能力上限，不是语速或创作质量标准）；若原稿需要重组，调用 studio_request_preparation_revision，以实际分镜/声音计划作为证据，不删词或截断。声音交接须含唯一 schema=sound-plan-v1 的 JSON，scriptSha256 对应冻结稿；lines 按冻结顺序完整保留 id/text，另有 bgm/sfx 数组。每条 cue 含 id/start/end，配音 sourcePath 或配乐音效 path 必须对应本阶段 manifest.outputs 中实际音频；sourcePath 与 path 同时存在时前者是交付源，后者仅为后续剪辑目标。sourceSha256/sourceDurationSeconds 如有必须符合实际文件。所需配乐音效不能只写占位路径，也不能为过检查删掉；复制合法复用文件并登记来源。':''}完成后写 manifest.json。manifest.outputs 的每个路径均相对 Task 工作区根目录，不是相对 manifest 所在目录；必须保留 stages/r${round}/${s.id}/ 前缀，不能只填文件名。复用阶段外的合法素材时先复制到本阶段目录并保留原件，再登记实际复制路径；只改清单路径不会创建文件。格式 {"stage":"${s.id}","round":${round},"outputs":["stages/r${round}/${s.id}/实际文件"],"summary":"实际完成内容及未验证项"}。调用 studio_register_stage(path)，成功后 task_complete；本阶段交接不代表整片或审美通过。返修轮先查问题，仅修改必要素材，可复制未受影响产物并记录复用依据。`
 }))
}
