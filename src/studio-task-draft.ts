/** Pure Studio request composer. Host discovery/allocation happens before this function. */
import {isAbsolute} from 'node:path'
import {validateTask} from './tasks.js'
import {validateStudioPolicy} from './studio-policy.js'
import type {TaskDesign} from './task-design.js'
export const STUDIO_TASK_ROLE_KEYS=['director','storyboard','visual','sound','editor','quality'] as const
export interface StudioTaskRequest {
 characterId:string;referenceUrl:string;referenceSha256:string;
 roles:Record<typeof STUDIO_TASK_ROLE_KEYS[number],string>;topic?:string;
 durationMin?:number;durationMax?:number;maxRepairRounds?:number;
 generationLimits:{imageCalls:number;imageBatches:number;voiceSegments:number}
}
export interface StudioDraftContext {
 taskId:string;cwd:string;createdAt:string;installedAgentIds:readonly string[];
 executionBindingSupported:boolean
}
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function fail(field:string,reason:string):never{throw Error('studio-task-draft-invalid: '+JSON.stringify({field,reason,createdTask:false,startedTask:false}))}
export const STUDIO_TASK_REQUEST_CONTRACT={
 id:'studio-task-request-v1',required:['characterId','referenceUrl','referenceSha256','roles','generationLimits'],optional:['topic','durationMin','durationMax','maxRepairRounds'],additionalProperties:false,
 roles:[...STUDIO_TASK_ROLE_KEYS],defaults:{durationMin:90,durationMax:110,maxRepairRounds:2},
 maxRepairRounds:{type:'integer',minimum:0,maximum:2,meaning:'At most three production rounds including the initial candidate; requests for more repairs are rejected, never reduced silently.'},
 fixed:{width:1080,height:1920,fps:30,dialogueLanguage:'zh-CN',visualCoverage:'requirements-v1',publish:false,executionBinding:'agent-runtime-v1',workspaceMode:'studio-batch-v1'},
 execution:{timeoutSec:7200,onFail:'retry',maxTries:3},topic:{maxCharacters:2000,blank:'autonomous selection using character and authorized available sources',input:'Use an explicitly supplied topic. When the user delegates topic discovery, omit this field and leave selection to the director; the Task Creator must not silently fix its own theme or attribute it to the user.'},
 generationLimits:{required:['imageCalls','imageBatches','voiceSegments'],imageCalls:{minimum:0,maximum:6,meaning:'generated image/prompt items'},imageBatches:{minimum:0,maximum:6,meaning:'generation submissions'},voiceSegments:{minimum:0,maximum:80,meaning:'synthesized voice segments'},default:null},
 reference:'Use the selected source metadata candidate URL on HTTPS cdn.vyibc.com and its declared expected SHA-256; no query/fragment/credentials or invented values. Unverified metadata may enter a pending-review draft. Host preflight must download and match actual bytes before production, followed by actual reference observation. Metadata and a matching hash do not establish baseline approval.',
 character:'Caller must resolve an authorized existing characterId. Full profile is verified at host preflight; current policy does not pin a requested profile version/SHA.',
 roster:'Six distinct IDs must come from host installed-role discovery. Name presence is not proof of granted tools or working providers.',
} as const
const fields=[...STUDIO_TASK_REQUEST_CONTRACT.required,...STUDIO_TASK_REQUEST_CONTRACT.optional] as readonly string[]
export function composeStudioTaskDraft(raw:unknown,context:StudioDraftContext){
 if(!object(raw)||Object.keys(raw as object).some(k=>!fields.includes(k)))fail('request','Only the Studio request fields are accepted; host paths, Task state, credentials and publication are not request parameters.')
 const request=raw as StudioTaskRequest
 if(typeof request.characterId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.characterId))fail('characterId','Resolve one authorized existing character first; a name, absent ID or generated placeholder is not a resolved character.')
 if(typeof request.referenceUrl!=='string'||typeof request.referenceSha256!=='string')fail('reference','Resolve a reference candidate URL and its source-declared expected SHA-256 before composing; metadata may enter pending review unverified. Host preflight must verify actual bytes before production; this function cannot discover or download them.')
 if(!object(request.roles)||Object.keys(request.roles).length!==STUDIO_TASK_ROLE_KEYS.length||STUDIO_TASK_ROLE_KEYS.some(k=>typeof request.roles[k]!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(request.roles[k])))fail('roles','Supply all six exact installed Agent IDs: director, storyboard, visual, sound, editor, quality.')
 const ids=STUDIO_TASK_ROLE_KEYS.map(k=>request.roles[k]);if(new Set(ids).size!==6)fail('roles','All six roles must use different Agent IDs.')
 if(!object(context)||!Array.isArray(context.installedAgentIds)||context.installedAgentIds.some(id=>typeof id!=='string'))fail('host.installedAgentIds','Current installed-role discovery is required, not a fabricated roster.')
 if(ids.some(id=>!context.installedAgentIds.includes(id)))fail('roles','At least one selected Agent ID is not in the supplied installed roster. Install/resolve the missing role before composing.')
 if(context.executionBindingSupported!==true)fail('host.executionBinding','This composer requires a host that implements agent-runtime-v1; do not silently omit the execution binding.')
 if(typeof context.taskId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(context.taskId)||typeof context.cwd!=='string'||!isAbsolute(context.cwd)||context.cwd.includes('\0')||typeof context.createdAt!=='string'||!Number.isFinite(Date.parse(context.createdAt)))fail('host.taskIdentity','The host must allocate a new taskId, absolute workspace and valid createdAt; none is accepted from the request.')
 if(request.topic!==undefined&&(typeof request.topic!=='string'||request.topic.length>STUDIO_TASK_REQUEST_CONTRACT.topic.maxCharacters||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request.topic)))fail('topic','Topic must be text up to 2000 characters or omitted; blank requests authorized topic discovery.')
 if(!object(request.generationLimits)||!Object.hasOwn(request.generationLimits,'imageBatches')||typeof request.generationLimits.imageBatches!=='number')fail('generationLimits','Explicit imageCalls (image items), imageBatches (submissions) and voiceSegments are required. Missing budgets are not permission to generate.')
 if(request.maxRepairRounds!==undefined&&(!Number.isInteger(request.maxRepairRounds)||request.maxRepairRounds<STUDIO_TASK_REQUEST_CONTRACT.maxRepairRounds.minimum||request.maxRepairRounds>STUDIO_TASK_REQUEST_CONTRACT.maxRepairRounds.maximum))fail('maxRepairRounds','This composer supports 0 to 2 repair rounds (at most 3 production rounds including the initial candidate). A larger request needs an extended execution contract; it is not silently reduced.')
 const policy=validateStudioPolicy({characterId:request.characterId,referenceUrl:request.referenceUrl,referenceSha256:request.referenceSha256,width:STUDIO_TASK_REQUEST_CONTRACT.fixed.width,height:STUDIO_TASK_REQUEST_CONTRACT.fixed.height,fps:STUDIO_TASK_REQUEST_CONTRACT.fixed.fps,dialogueLanguage:STUDIO_TASK_REQUEST_CONTRACT.fixed.dialogueLanguage,visualCoverage:STUDIO_TASK_REQUEST_CONTRACT.fixed.visualCoverage,durationMin:request.durationMin??STUDIO_TASK_REQUEST_CONTRACT.defaults.durationMin,durationMax:request.durationMax??STUDIO_TASK_REQUEST_CONTRACT.defaults.durationMax,maxRepairRounds:request.maxRepairRounds??STUDIO_TASK_REQUEST_CONTRACT.defaults.maxRepairRounds,generationLimits:request.generationLimits,publish:false})
 // Null is an invalid supplied value, not a request to silently use defaults.
 for(const field of ['durationMin','durationMax','maxRepairRounds'] as const)if(Object.hasOwn(request,field)&&typeof request[field]!=='number')fail(field,'Supply a number or omit the field.')
 const topic=request.topic?.trim()??'',roles={...request.roles},limits=policy.generationLimits!
 const brief=[
  `制作一部中文对白、中文字幕的角色卡通视频，目标${policy.durationMin}至${policy.durationMax}秒，1080×1920、30fps。角色与参考候选以任务策略和宿主实际冻结档案为准，不从会话历史猜测。来源声明的预期SHA必须先经宿主下载比对，再实际观察；元数据或哈希相符不代表用户认可基准。`,
  topic?`本次候选主题：${topic}`:'主题留空：编导结合完整角色人格、授权参考和可获得的资料比较候选并自主选择，不冒称热门、全站排名或保证吸粉；资料不可用时准确说明。',
  '先读取完整角色人格、身份图、常用场景、表情动作与音色策略及经宿主核验的参考片，单独核对基准认可状态。形成完整故事、可表演分场与精确台词，再冻结；不能用几句梗概、空白或重复静帧凑目标片长。对白与非对白段均有表达目的，开头建立具体矛盾，结尾完成情绪与视听收束。',
  '六角色按真实Task Link协作：编导→分镜→视觉和声音并行→交接闸门→动画合成→独立质检→编导。分镜列逐镜需求；视觉区分整张参考表和独立姿势，实际检查裁切、锚点、边缘、比例和代表合成；声音按冻结原文生成并测量真实时长。素材不足或剧情根本问题正式回交，不删除要求过检查。',
  `授权上限：${limits.imageCalls}个生成图片项、${limits.imageBatches}次图片提交、${limits.voiceSegments}个配音片段。每prompt计图片项，每generate_image提交计一批；同设置多项可用prompts组织，但不扩大额度。失败/未知请求仍占预算，对账原作业，不换编号盲重试；额度为0即不得新增对应生成。`,
  '按角色真实授权音色及情境选择语气，不默认收藏声线，只记录实际支持且已传入的参数。为本故事获取有许可配乐和现成音效；来源卡不是音频，短音效不能冒充全片音乐。真实配音时长决定排镜，不能漏词、机械加速、无理由断乐或配乐遮蔽对白。',
  '剪辑汇聚同轮已登记素材，先检查困难动作样片，再完成真实MP4。检查步态接触、轴线、重影、闪屏、转场、字幕与混音。先上传实际候选到R2并保存公开访问的字节/哈希验证，不伪造URL或空MP4。',
  `独立质检实际成片、完整声音及连续动作并对照已核验参考片，单独记录基准认可状态，问题记录时间点、证据、严重程度、责任阶段和改法。最多${policy.maxRepairRounds}轮成片返修，保留原版与未改素材；当前每轮仍有准备节点，不声称能自动裁剪返修子图。未检查填pending，major/blocker未解决不得通过；技术成功不等于质量通过。`,
  '交付候选R2地址、工程、剧本、分镜、素材/音频清单、PUBLICATION.md、QA及实际截图和连续动作采样。必要署名放随片说明；仅交用户审核，不发布社交平台。只写宿主分配的本Task目录，按阶段/轮次保存版本；不改安装Skill、系统服务、浏览器登录，不启用新收费服务、下载TTS模型或读取输出凭据。',
 ].join('\n')
 const stageBriefs={storyboard:'将本轮冻结台词、角色人格与已核验参考转成完整分镜及逐镜素材需求；不得改写台词，登记真实分镜后交接。',visual:'按同轮分镜取得或生成真实表情、姿势、背景与道具，观察与核对裁切锚点，逐项绑定素材需求并登记；缺项明确回交。',sound:'按冻结原文和角色授权声音策略生成完整分句配音，实测时长并试听，获取许可配乐音效，登记完整sound-plan与实际音频。'}
 const design:TaskDesign={workspaceMode:STUDIO_TASK_REQUEST_CONTRACT.fixed.workspaceMode,executionBinding:'agent-runtime-v1',evidenceContract:'studio-video-v1',studio:policy,studioStages:(['storyboard','visual','sound'] as const).map(id=>({id,agentId:roles[id],brief:stageBriefs[id]})),scope:'指定已解析角色与待核验参考候选，自主或按给定主题制作中文卡通并交R2预览；发布不在授权内。',branches:[
  {id:'prepare',when:'角色、参考、工具、预算与当前能力已核对',action:'编导完成故事并冻结台词，交分镜、视觉、声音三个真实阶段节点',evidence:'冻结台词、参考观察、Task Link及阶段产物回执'},
  {id:'produce',when:'同轮分镜、视觉与声音已登记且文件未变化',action:'合成师按实际音频排镜并完成候选，上传真实预览',evidence:'实际MP4、公开URL字节及哈希、工程与配音时间表'},
  {id:'review',when:'当前候选已登记',action:'独立检查实际全片声音、画面、连续动作及认可参考',evidence:'与当前候选绑定的QA和观察回执，不使用旧版本结论'},
  {id:'repair',when:'独审有未解决major/blocker且返修轮次及预算允许',action:'编导按问题定位返修，保留旧版并复用有效素材，修订后重新独审',evidence:'问题到改动映射、新候选及复检；未解决项不得隐藏'},
 ],coordination:'编导→分镜→视觉/声音并行→Gate→动画合成→独立质检→编导；同批次同轮文件哈希交接，缺失、变化或依赖未完成不能合成，阶段交接不等于质量通过。',failurePolicy:{isolateItems:true,maxAttempts:policy.maxRepairRounds+1,stopConditions:['缺权限或真实视听/渲染能力：保留产物并报告确切缺项','付费生成结果未知：对账原作业，不重复提交或重置额度','预算/返修轮次耗尽仍未达标：交真实候选与未通过项，不冒称发布就绪']},acceptance:[
  `真实可播放MP4，1080×1920、30fps、实测${policy.durationMin}至${policy.durationMax}秒，R2实际公开访问验证`,
  '全部必检维度有对应真实证据；major/blocker和pending未清除不得判通过',
  '实际全片音频、关键画面和连续动作与认可片对照；不以渲染或自动分数代替审美',
  '保存工程、版本、剧本、分镜、素材声音来源、PUBLICATION及QA，并记录真实检查范围和介入',
  '交预览待用户审核；禁止自行发布或宣称用户已认可',
 ]}
 const validated=validateTask({id:context.taskId,title:'卡通视频｜'+(topic?topic.slice(0,60):'指定角色 · 自主选题'),brief,graphMode:'dynamic-rounds',participants:[{agentId:roles.director,brief:'选题、完整故事、台词冻结与独审后的返修计划；不代替用户授权发布。'},{agentId:roles.editor,brief:'汇聚实际阶段素材，完成动画、字幕、混音、渲染、R2候选交付与局部返修。'},{agentId:roles.quality,brief:'独立检查实际候选与参考并提交真实视听报告，不修改成片。'}],cwd:context.cwd,...STUDIO_TASK_REQUEST_CONTRACT.execution,trigger:{kind:'once'},design},new Set(context.installedAgentIds))
 return {schema:'studio-task-draft-v1' as const,draft:{...validated,createdAt:context.createdAt,saveOnly:true},createdTask:false,startedTask:false,qualityApproved:false,resolution:{characterId:policy.characterId,referenceUrl:policy.referenceUrl,referenceSha256:policy.referenceSha256,verifiedByComposer:false,characterProfileVersionPinned:false,downloadVerification:'pending_host_preflight' as const,baselineApproval:'not_established_by_composer' as const,notice:'Caller-supplied source metadata only, admitted to a pending-review draft. referenceSha256 is the source-declared expected hash, not proof of verified bytes or baseline approval. This pure composer does not query character_get, verify permissions, download the reference candidate or inspect Agent grants. Host preflight must validate the full character JSON and match actual reference bytes to the expected hash before production; actual reference observation is still required. Current StudioPolicy freezes characterId but does not pin a requested profile version/SHA; do not claim that stronger guarantee.'}}
}
