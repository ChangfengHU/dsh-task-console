/**
 * The four tools a card's session gets and nothing else does — the
 * lifecycle terminators (hermes: kanban_complete / kanban_block /
 * kanban_request_review). Registered on the agent's own scope after its
 * preset is mounted, so an "@agent" chat on the same preset never sees them.
 *
 * @module dsh-task-console/worker-tools
 */

import type { BlockKind } from './fold.ts'

export interface WorkerHooks {
  complete(summary: string, artifacts: string[], metadata?: Record<string, unknown>): Promise<void>
  block(reason: string, kind: BlockKind): Promise<void>
  requestReview(summary: string, artifacts: string[], metadata?: Record<string, unknown>, reviewer?: string): Promise<void>
  requestChanges(reason: string): Promise<void>
  planRound?(summary: string): Promise<void>
  finalize?(summary: string, artifact?: string): Promise<void>
}

const OUT = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' } } } as const
const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

export const WORKER_TOOL_NAMES = ['task_complete', 'task_block', 'task_request_review', 'task_request_changes', 'task_plan_round', 'task_finalize'] as const

/** Register the four tools on one agent scope. Returns the disposer. */
export async function registerWorkerTools(agentCtx: any, hooks: WorkerHooks, options: { planner?: boolean; dynamicRounds?: boolean } = {}): Promise<() => void> {
  // The real compiler is host-owned. Unit tests use identity descriptors so they do not need to install the whole dsh host.
  const defineTool: (spec: any) => any = process.env.NODE_ENV === 'test' ? (spec => spec) : (await import('@deepseek-ai/dsh-tools')).defineTool
  const disposers: (() => void)[] = []
  if (!options.planner) disposers.push(agentCtx.tools.register(defineTool({
    name: 'task_complete',
    description: '交卷:这张卡做完了。summary 写「产物 / 干了什么 / 下游注意」;生成的文件路径必须放进 artifacts,系统会保存副本供浏览器预览和下载。调用后不要再做别的。',
    parameters: {
      summary: { type: 'string', required: true, description: '交接单正文,给下游看的。' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '交付文件路径,相对路径按任务工作区解析。没有文件可省略。' },
      metadata: { type: 'object', additionalProperties: true, description: '可选的结构化结果数据。' },
    },
    output: { schema: OUT, render },
    async execute(args: any) {
      const summary = String(args.summary ?? '').trim()
      if (!summary) return { ok: false, note: 'summary 不能为空' }
      const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String) : []
      await hooks.complete(summary, artifacts, args.metadata as Record<string, unknown> | undefined)
      return { ok: true, note: artifacts.length ? `已交卷并登记 ${artifacts.length} 个产物。` : '已交卷,下一张卡会收到这份交接单。' }
    },
  })))
  disposers.push(agentCtx.tools.register(defineTool({
    name: 'task_block',
    description: '做不下去时调用并结束本次运行。kind: needs_input=需要人回答;capability=缺工具或权限;transient=临时故障;dependency=等待其他任务。解除后会创建新的 run，不会复活旧 worker。',
    parameters: {
      reason: { type: 'string', required: true, description: '一句话说清卡在哪。' },
      kind: { type: 'string', required: true, enum: ['needs_input', 'capability', 'transient', 'dependency'], description: '卡住的类型。' },
    },
    output: { schema: OUT, render },
    async execute(args: any) {
      const reason = String(args.reason ?? '').trim(); const kind = String(args.kind ?? 'needs_input') as BlockKind
      if (!reason) return { ok: false, note: 'reason 不能为空' }
      await hooks.block(reason, (['needs_input', 'capability', 'transient', 'dependency'] as string[]).includes(kind) ? kind : 'needs_input')
      return { ok: true, note: '已记录并结束本次运行；解除阻塞后会创建新的 run。' }
    },
  })))
  if (!options.planner && !options.dynamicRounds) disposers.push(agentCtx.tools.register(defineTool({
    name: 'task_request_review',
    description: '提交同卡评审。指定 reviewer 时由该 Agent 创建独立 review run；不指定时进入人工验收。验收通过前不会放行下游。',
    parameters: {
      summary: { type: 'string', required: true, description: '交接单正文。' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '待验收的交付文件路径。' },
      metadata: { type: 'object', additionalProperties: true, description: '可选的结构化结果数据。' },
      reviewer: { type: 'string', description: '可选 reviewer Agent preset id；省略表示人工验收。' },
    },
    output: { schema: OUT, render },
    async execute(args: any) {
      const summary = String(args.summary ?? '').trim()
      if (!summary) return { ok: false, note: 'summary 不能为空' }
      const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String) : []
      await hooks.requestReview(summary, artifacts, args.metadata as Record<string, unknown> | undefined, String(args.reviewer ?? '').trim() || undefined)
      return { ok: true, note: `已提交验收${artifacts.length ? `,登记 ${artifacts.length} 个产物` : ''}。` }
    },
  })))
  if (!options.planner && !options.dynamicRounds) disposers.push(agentCtx.tools.register(defineTool({
    name: 'task_request_changes',
    description: '仅供同卡 reviewer 使用：退回当前实现并结束本次 review run。任务会恢复给原 implementer，评审意见进入下一次 handoff。',
    parameters: { reason: { type: 'string', required: true, description: '明确、可执行的返工原因。' } },
    output: { schema: OUT, render },
    async execute(args: any) {
      const reason = String(args.reason ?? '').trim()
      if (!reason) return { ok: false, note: 'reason 不能为空' }
      await hooks.requestChanges(reason)
      return { ok: true, note: '已退回原 implementer；本次 review run 已结束。' }
    },
  })))
  if (options.planner) {
    disposers.push(agentCtx.tools.register(defineTool({
      name: 'task_plan_round',
      description: '规划者决定继续或返工时调用。系统会在一个 SQLite 事务里创建真实的 Gate、执行者、评估者和下一位规划者 Task，并写入真实 task_links。',
      parameters: { summary: { type: 'string', required: true, description: '本轮计划；返工时要包含评估意见和可执行改动。' } },
      output: { schema: OUT, render },
      async execute(args: any) {
        const summary = String(args.summary ?? '').trim()
        if (!summary) return { ok: false, note: 'summary 不能为空' }
        if (!hooks.planRound) return { ok: false, note: '当前任务不支持动态回合' }
        await hooks.planRound(summary)
        return { ok: true, note: '下一轮 Task 与 task_links 已写入数据库；规划者交卷后 Gate 才会放行。' }
      },
    })))
    disposers.push(agentCtx.tools.register(defineTool({
      name: 'task_finalize',
      description: '规划者确认上一轮通过时调用，结束整个动态 DAG；有文件交付时用 artifact 明确指定最终产物路径。',
      parameters: {
        summary: { type: 'string', required: true, description: '批准依据和最终交接。' },
        artifact: { type: 'string', description: '最终交付文件路径；必须是本次运行已登记的产物。没有文件交付时省略。' },
      },
      output: { schema: OUT, render },
      async execute(args: any) {
        const summary = String(args.summary ?? '').trim()
        if (!summary) return { ok: false, note: 'summary 不能为空' }
        if (!hooks.finalize) return { ok: false, note: '当前任务不支持结束决策' }
        const artifact = String(args.artifact ?? '').trim() || undefined
        await hooks.finalize(summary, artifact)
        return { ok: true, note: artifact ? '动态 DAG 已批准结束，并确认最终产物。' : '动态 DAG 已批准结束。' }
      },
    })))
  }
  return () => { for (const d of disposers.splice(0)) { try { d() } catch { /* already gone */ } } }
}
