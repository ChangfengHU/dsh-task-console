import type { Participant } from './fold.ts'

/** Business presets, not a second scheduler. The Creator selects a policy, never rewrites its boundaries. */
export const workflowRecipes = [{ id: 'fleet-base-v2', title: 'Fleet 双浏览器基础节点接入与跨周期验收',
  description: '基础装机 → Runner 独立巡检 → 浏览器管理员最终验收。Gemini 策略要求 browser-1、browser-2 跨 20 分钟后台验证并提交宿主回执；一次复制成功不能交卷。目标/IP 留在本次输入中。',
  loginPolicies: ['preserve', 'provision-gemini'],
  requiredAgents: ['fleet-installer', 'fleet-runner-operator', 'browser-manager'],
}]

export interface WorkflowRecipe { id: 'fleet-base-v1' | 'fleet-base-v2'; login: 'preserve' | 'provision-gemini' }

export function composeRecipe(recipe: WorkflowRecipe) {
  if (!['fleet-base-v1', 'fleet-base-v2'].includes(recipe?.id) || !['preserve', 'provision-gemini'].includes(recipe.login)) throw new Error('未知工作流配方或登录策略')
  const provision = recipe.login === 'provision-gemini'
  const participants: Participant[] = [
    { agentId: 'fleet-installer', brief: '负责本次目标的基础 Fleet 幂等接入、十阶段验收和授权范围内的必要修复。健康组件检查复用，保留既有浏览器及资料，不卸载重装、不轮换凭据。使用自己的装机 Skill 与受限 runtime；不负责账号登录或 Runner。交接本轮 run_id、十阶段结果、checked/reused/changed/blocked 和验收报告。' },
    { agentId: 'browser-manager', brief: '负责目标浏览器的实例保全核验及本次登录策略，按用户指定实例执行；未另指定时处理现有 browser-1、browser-2。先 inspect，必要的独立管理 API 准备只能在宿主授权范围内。保留资料、有效登录和未选中实例，不创建/删除浏览器，不修复整机或网络。' + (provision
      ? '本次要求 Gemini/Google 账号配置：已有浏览器也必须逐一执行登录验收，不以本轮未创建浏览器为由跳过。仅在精确目标有 loginTargets 授权时使用 browser_login_candidates 与 browser_login_provision；有效目标账号复用，明确 out 时由工具从已授权来源选择并补登录。每个实例串行处理，持续 browser_status 到 complete/blocked。unknown、无合格来源或人工挑战须询问用户，不改用 copy 绕过。交接每实例 operationId、账号指纹、来源/选择理由、reused、loginVerified、matchesSource（原有账号复用时不适用）和新鲜验证时间。未验证不能宣布登录完成。'
      : '本次保持登录现状，只读观察并报告；不调用登录 provision/copy，不把未登录作为基础机器异常。') },
    { agentId: 'fleet-runner-operator', brief: '负责独立 Runner 幂等检查/必要恢复与真实签名验收作业；不修改基础装机、网络、浏览器或账号。保留健康 Runner，持续状态查询到本轮终态。作为最后一位角色，读取全部上游原始交接，分别汇总基础装机、浏览器实例、账号登录策略及实际验证、Runner 签名结果，输出完整验收报告。报告含 checked/reused/changed/blocked、操作回执和验收入口；不能用基础健康替代要求的账号登录结果，不因他人的文字总结就伪造登录证据。' },
  ]
  if (recipe.id === 'fleet-base-v2') {
    participants[2].brief = '负责本次目标的独立 Runner 幂等检查/必要恢复和真实签名作业。健康 Runner、路由和凭据复用；不修改基础装机、网络、浏览器或账号。持续 status 到 complete，交接原始 signedJobId、signatureVerified、所有检查和 changed/reused/blocked。Runner 的 browser 检查只证明安装及服务可达，不证明 Gemini 登录。完成后由浏览器管理员执行独立业务验收并汇总。'
    participants[1].brief = '你是最后一位执行角色，负责 browser-1、browser-2 的实例保全和最终账号验收。先 inspect；在既有 prepare/control 授权内幂等 prepare 已识别的浏览器 API，使其使用当前校验器，持续 status 到 complete，保留浏览器 PID、资料、桌面、网络和令牌。' + (provision
      ? '本次明确要求 Gemini 账号配置。逐个 browser_login_provision：有效登录复用；仅明确未登录时从已有授权来源补齐；不使用 copy 绕过 unknown、不反复复制直到短暂变绿。两实例均完成后调用 browser_login_acceptance，instances=[1,2]，读取独立后台检测并跨完整 20 分钟验收。持续 browser_status 到终态，不能用自己的等待时间、重复读取同一时间戳或一条成功回执替代稳定性证据。若工具阻塞，inspect 并依据原因诊断：页面未就绪不是缺少授权；只有平台挑战才询问用户。需要代码/检测器维护时 task_block(kind=capability)，等待修复后在本 Task 新尝试中复验，禁止伪造结果或更换 requestId 掩盖旧失败。只有 complete 且 result.stable=true 才能 task_complete；metadata.browserAcceptanceOperationId 必须是同一真实会话产生的验收 operationId（多目标时用 browserAcceptanceOperationIds 数组）。宿主将重新核验回执归属、20 分钟窗口、两个实例、账号指纹和 Fleet 当前结果，不合格会拒绝交卷。'
      : '本次保持登录现状，只读观察并报告，不调用 provision/copy/acceptance，不把未登录当作基础节点故障。') +
      '读取所有上游原始交接，汇总十阶段装机、Runner 签名检查、实例保全、每实例账号配置与跨周期验收结果，分别列出 checked/reused/changed/blocked、验证起止时间及报告入口。没有文件也要在 summary 给出完整报告；只能说明本次验收窗口通过，不能保证账号永久不失效。'
    participants.splice(1, 2, participants[2], participants[1])
  }
  return { title: provision ? 'Fleet 基础节点幂等接入与 Gemini 账号验收' : 'Fleet 基础节点幂等接入与健康验收',
    brief: '对本次输入指定的 Fleet 基础节点检查、复用健康组件并在授权范围修复漂移；保留既有环境、浏览器资料和有效登录，不卸载重装或轮换凭据。' +
      (provision ? '账号配置属于本次独立业务验收：为指定浏览器选择已授权 Gemini 来源并补齐登录，以实际验证为准。' : '保持账号登录现状；缺少站点登录不属于基础节点故障。') +
      (recipe.id === 'fleet-base-v2' ? '按基础装机者、Runner 运维者、浏览器管理员顺序协作，最后以两个浏览器跨周期验证及原始上游交接汇总完整报告；短暂成功不能作为最终验收。' : '仅由基础装机者、浏览器管理员、Runner 运维者按顺序协作，末位角色根据原始交接和本轮签名证据汇总完整报告。'),
    graphMode: 'static-chain' as const, participants }
}
