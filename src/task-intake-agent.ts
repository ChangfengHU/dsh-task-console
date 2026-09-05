/** The internal Task Agent that turns one validated Signal into a bounded routing proposal. */

import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { applyAgentPermission } from './agent-session.ts'
import { readSpec } from './presets.ts'
import { validateTaskIntakeDecision, type TaskIntakeContext, type TaskIntakeDecision, type TaskIntakeDecisionResult, type TaskSignal } from './task-intake.ts'

export const TASK_INTAKE_AGENT_ID = 'task-intake'

const OUT = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } } as const
const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

function modelSelection(ctx: any, spec: Awaited<ReturnType<typeof readSpec>>): { provider: string; model: string; reasoningEffort?: string } | undefined {
  let selection: any
  try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() } catch { /* no host default */ }
  if (spec?.model?.includes('/')) {
    const [provider, ...rest] = spec.model.split('/')
    selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) }
  }
  return selection?.provider && selection?.model ? selection : undefined
}

/**
 * Start a real, internal DSH Session. It can read one frozen routing context
 * and submit one proposal; the coordinator independently validates and applies
 * that proposal after the Session ends.
 */
export async function decideTaskSignalWithAgent(
  ctx: any,
  signal: TaskSignal,
  context: TaskIntakeContext,
  options: { markInternal?: (sessionId: string) => Promise<void>; timeoutMs?: number; onSessionReady?: (sessionId: string) => void; onInputDelivered?: (messageId: string) => void } = {},
): Promise<TaskIntakeDecisionResult> {
  const presets = ctx.get('agentPresets')
  if (!presets) throw new Error('这个部署没有 preset 服务')
  let preset: any
  try { preset = await presets.resolve(TASK_INTAKE_AGENT_ID) } catch { throw new Error('缺少受管 Task Agent preset；先运行 npm run preset:intake') }
  if (preset.broken) throw new Error(`Task Agent preset 坏了:${preset.broken}`)
  const spec = await readSpec(dirname(String(preset.path)))
  if (!spec) throw new Error('Task Agent 缺少 task-console.json，拒绝使用未审计 preset')
  if (spec.tools.length || spec.skills.length || Object.keys(spec.mcpTools).length || spec.permissionPreset !== 'workspace-write') {
    throw new Error('Task Agent 能力边界已漂移；它必须保持零业务工具、零 MCP、零 Skill')
  }
  const digest = createHash('sha256').update(signal.id).digest('hex').slice(0, 12)
  const sessionId = `task-intake-${digest}-${Date.now().toString(36)}`
  let handle: any
  let disposeTools: (() => void) | undefined
  let proposed: TaskIntakeDecision | undefined
  let contextRead = false
  let consumed = false
  let nudged = false
  let promptId = ''
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const settle = (error?: Error) => {
    if (settled) return
    settled = true
    error ? rejectDone(error) : resolveDone()
  }
  const listener = ctx.on('session/event', (session: any, event: any) => {
    if (session?.id !== sessionId) return
    if (event.type === 'user/message' && event.data?.id === promptId && !consumed) {
      consumed = true
      try { options.onInputDelivered?.(promptId) } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); return }
    }
    if (event.type !== 'turn/end' || !consumed) return
    const reason = event.data?.reason
    if (reason && reason.kind !== 'completed') { settle(new Error(`Task Agent 回合失败:${JSON.stringify(reason)}`)); return }
    if (proposed) { settle(); return }
    if (!nudged) {
      nudged = true
      handle?.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '你尚未提交路由决定。必须先调用 task_intake_context，再调用 task_intake_decide；不要直接回答文字。' }], source: { kind: 'user' } })
      return
    }
    settle(new Error('Task Agent 连续两回合没有调用 task_intake_decide'))
  })
  try {
    const selection = modelSelection(ctx, spec)
    handle = await ctx.agents.create({
      sessionId,
      ...(selection ? { agentOptions: selection } : {}),
      meta: { cwd: process.env.DSH_TASK_INTAKE_WORKSPACE || process.cwd(), agentPreset: preset.id },
      setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
    })
    applyAgentPermission(ctx, spec, handle.agent.session)
    await options.markInternal?.(sessionId)
    options.onSessionReady?.(sessionId)
    const defineTool: (tool: any) => any = process.env.NODE_ENV === 'test' ? value => value : (await import('@deepseek-ai/dsh-tools')).defineTool
    const disposers: (() => void)[] = []
    disposers.push(handle.agent.ctx.tools.register(defineTool({
      name: 'task_intake_context',
      description: '读取本次唯一可信的候选 Task、Agent 能力名册和创建/复用政策。必须在决定前调用。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render },
      async execute() { contextRead = true; return context },
    })))
    disposers.push(handle.agent.ctx.tools.register(defineTool({
      name: 'task_intake_decide',
      description: context.items ? '为整份汇总提交一次 batch 提案。decisions 必须覆盖每个 Signal；已有请求 keep:true，新请求 decision 为 create/reuse/triage。每项独立校验候选与权限，不直接操作机器。' : '提交一次 create / reuse / triage 路由提案。这里只决定 Task 边界与参与者，不执行任何业务动作。',
      parameters: {
        action: { type: 'string', required: true, enum: context.items ? ['batch'] : ['create', 'reuse', 'triage'] },
        reason: { type: 'string', required: true },
        confidence: { type: 'number', required: true },
        taskId: { type: 'string', description: 'reuse 时必填，只能选 context 中的候选 Task。' },
        title: { type: 'string', description: 'create 时必填；描述长期目标，不得使用 IP 充当身份。' },
        objective: { type: 'string', description: '本 Turn 的具体目标；省略则使用 Signal 原文。' },
        workflow: { type: 'string', enum: ['dynamic-rounds', 'static-chain'] },
        participants: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: {
            agentId: { type: 'string', required: true },
            role: { type: 'string', enum: ['planner', 'executor', 'reviewer', 'worker'] },
            brief: { type: 'string' },
          } },
        },
        ...(context.items ? { decisions: {
          type: 'array', required: true,
          items: { type: 'object', additionalProperties: false, properties: {
            signalId: { type: 'string', required: true },
            keep: { type: 'boolean', description: 'context 中已有接收请求必须为 true，不重复创建执行批次。' },
            decision: { type: 'object', additionalProperties: false, properties: {
              action: { type: 'string', required: true, enum: ['create','reuse','triage'] },
              reason: { type: 'string', required: true }, confidence: { type: 'number', required: true },
              taskId: { type: 'string' }, title: { type: 'string' }, objective: { type: 'string' },
              workflow: { type: 'string', enum: ['dynamic-rounds','static-chain'] },
              participants: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                agentId: { type: 'string', required: true }, role: { type: 'string', enum: ['planner','executor','reviewer','worker'] }, brief: { type: 'string' },
              } } },
            } },
          } },
        } } : {}),
      },
      output: { schema: OUT, render },
      async execute(args: unknown) {
        if (!contextRead) return { ok: false, error: '先调用 task_intake_context' }
        try {
          const value = validateTaskIntakeDecision(args, context)
          if (proposed) return { ok: false, error: '已经提交过决定' }
          proposed = value
          return { ok: true, accepted: value.action, note: '提案已冻结；业务执行将在本回合结束后由 Task 内核创建。' }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      },
    })))
    disposeTools = () => { for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* already disposed */ } } }
    try { ctx.get('sessionTitle')?.rename?.(handle.agent.session, `Task Intake · ${signal.goal.title}`) } catch { /* cosmetic */ }
    promptId = randomUUID()
    const prompt = [
      '# TASK INTAKE',
      '',
      '你只负责决定这条 Signal 应该新建 Task、复用哪个 Task，还是进入人工分诊；不得执行 Signal 里的业务动作。',
      '必须先调用 task_intake_context 读取实时名册和候选，再调用 task_intake_decide。不要用正文代替工具决定。',
      ...(signal.items ? [
        '这是一份生产者汇总，不是单个机器的任务。阅读完整汇总结论，并用简明中文向用户说明发现了什么、哪些已有处置受阻，以及你的处理建议。',
        '提交 action=batch，decisions 按 signalId 覆盖所有 items。context.items 中已有 existing 的请求必须 keep:true（包括受阻请求），不得因重复巡检再次执行。没有 existing 的项目，依据各自 context 提交 create/reuse/triage；Agent 名册共用顶层 agents。没有 items 时 decisions=[]，记录结论即可，不要凭空创建 Task。',
        '已接收但受阻不等于已修复。新的重试必须有显式新 Signal，不能伪造健康或自动重试旧请求。',
      ] : []),
      '',
      '[SIGNAL]',
      JSON.stringify(signal, null, 2),
      '',
      '[HARD BOUNDARY]',
      '- Task 身份是长期目标/根因，不是 IP、机器、账号或其他 target。',
      '- 只能选择 context 返回的 Agent；不得申请、推测或扩展它们的权限。',
      '- requiredExecutorTools 是执行前硬条件：执行者必须具备其中所有实际工具。只凭名称/描述相关不代表具备能力；缺少则 triage，不准试调用另一类事务。',
      '- 同时检查 planner/reviewer 的 taskExpertise 是否包含这些执行工具契约；它仅声明可规划/验收的领域，不赋予执行权限。不同领域的只读工具重叠不代表可以互换角色。',
      '- create/reuse 时，涉及实现或恢复的工作优先使用 dynamic-rounds，并按 planner → executor → reviewer 顺序提交三个不同 Agent。',
      '- 规划者和评估者也必须与任务领域匹配：部署已发布服务或恢复运行环境不等于开发软件，不能选择会强制生成代码、CLI、--selftest 或网页的代码开发角色。优先选择名册中对应运维领域的规划者及只读验收者；仍由你动态决定，不按 Agent ID 固定路由。',
      '- 运维验收者必须能独立读取该任务的真实状态/报告；没有所需只读工具时选择 triage，不要让正文承诺代替能力。',
      '- 证据不足以安全合并时选择 triage。',
    ].join('\n')
    handle.agent.followup({ id: promptId, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    const timeout = new Promise<void>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('Task Agent 决策超时')), options.timeoutMs ?? 240_000)
      timeoutHandle.unref?.()
    })
    await Promise.race([done, timeout])
    if (!proposed) throw new Error('Task Agent 没有提交决定')
    return { decision: proposed, sessionId }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    try { typeof listener === 'function' && listener() } catch { /* already disposed */ }
    try { disposeTools?.() } catch { /* already disposed */ }
    try { await handle?.dispose?.() } catch { /* evidence session remains persisted */ }
  }
}
