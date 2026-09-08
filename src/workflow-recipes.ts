import type { Participant } from './fold.ts'

/** Business presets, not a second scheduler. The Creator selects a policy, never rewrites its boundaries. */
export const workflowRecipes = [{ id: 'fleet-base-v1', title: 'Fleet 基础节点幂等接入与验收',
  description: '固定三职责：基础装机 → 浏览器管理员 → Runner 独立巡检并汇总报告。目标/IP 留在本次输入中。',
  loginPolicies: ['preserve', 'provision-gemini'],
  requiredAgents: ['fleet-installer', 'browser-manager', 'fleet-runner-operator'],
}]

export interface WorkflowRecipe { id: 'fleet-base-v1'; login: 'preserve' | 'provision-gemini' }

export function composeRecipe(recipe: WorkflowRecipe) {
  if (recipe?.id !== 'fleet-base-v1' || !['preserve', 'provision-gemini'].includes(recipe.login)) throw new Error('未知工作流配方或登录策略')
  const provision = recipe.login === 'provision-gemini'
  const participants: Participant[] = [
    { agentId: 'fleet-installer', brief: '负责本次目标的基础 Fleet 幂等接入、十阶段验收和授权范围内的必要修复。健康组件检查复用，保留既有浏览器及资料，不卸载重装、不轮换凭据。使用自己的装机 Skill 与受限 runtime；不负责账号登录或 Runner。交接本轮 run_id、十阶段结果、checked/reused/changed/blocked 和验收报告。' },
    { agentId: 'browser-manager', brief: '负责目标浏览器的实例保全核验及本次登录策略，按用户指定实例执行；未另指定时处理现有 browser-1、browser-2。先 inspect，必要的独立管理 API 准备只能在宿主授权范围内。保留资料、有效登录和未选中实例，不创建/删除浏览器，不修复整机或网络。' + (provision
      ? '本次要求 Gemini/Google 账号配置：已有浏览器也必须逐一执行登录验收，不以本轮未创建浏览器为由跳过。仅在精确目标有 loginTargets 授权时使用 browser_login_candidates 与 browser_login_provision；有效目标账号复用，明确 out 时由工具从已授权来源选择并补登录。每个实例串行处理，持续 browser_status 到 complete/blocked。unknown、无合格来源或人工挑战须询问用户，不改用 copy 绕过。交接每实例 operationId、账号指纹、来源/选择理由、reused、loginVerified、matchesSource（原有账号复用时不适用）和新鲜验证时间。未验证不能宣布登录完成。'
      : '本次保持登录现状，只读观察并报告；不调用登录 provision/copy，不把未登录作为基础机器异常。') },
    { agentId: 'fleet-runner-operator', brief: '负责独立 Runner 幂等检查/必要恢复与真实签名验收作业；不修改基础装机、网络、浏览器或账号。保留健康 Runner，持续状态查询到本轮终态。作为最后一位角色，读取全部上游原始交接，分别汇总基础装机、浏览器实例、账号登录策略及实际验证、Runner 签名结果，输出完整验收报告。报告含 checked/reused/changed/blocked、操作回执和验收入口；不能用基础健康替代要求的账号登录结果，不因他人的文字总结就伪造登录证据。' },
  ]
  return { title: provision ? 'Fleet 基础节点幂等接入与 Gemini 账号验收' : 'Fleet 基础节点幂等接入与健康验收',
    brief: '对本次输入指定的 Fleet 基础节点检查、复用健康组件并在授权范围修复漂移；保留既有环境、浏览器资料和有效登录，不卸载重装或轮换凭据。' +
      (provision ? '账号配置属于本次独立业务验收：为指定浏览器选择已授权 Gemini 来源并补齐登录，以实际验证为准。' : '保持账号登录现状；缺少站点登录不属于基础节点故障。') +
      '仅由基础装机者、浏览器管理员、Runner 运维者按顺序协作，末位角色根据原始交接和本轮签名证据汇总完整报告。',
    graphMode: 'static-chain' as const, participants }
}
