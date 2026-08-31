/**
 * The three tools a card's session gets and nothing else does — the
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
  requestReview(summary: string, artifacts: string[], metadata?: Record<string, unknown>): Promise<void>
}

const OUT = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' } } } as const
const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

export const WORKER_TOOL_NAMES = ['task_complete', 'task_block', 'task_request_review'] as const

/** Register the three tools on one agent scope. Returns the disposer. */
export async function registerWorkerTools(agentCtx: any, hooks: WorkerHooks): Promise<() => void> {
  // The real compiler is host-owned. Unit tests use identity descriptors so they do not need to install the whole dsh host.
  const defineTool: (spec: any) => any = process.env.NODE_ENV === 'test' ? (spec => spec) : (await import('@deepseek-ai/dsh-tools')).defineTool
  const disposers: (() => void)[] = []
  disposers.push(agentCtx.tools.register(defineTool({
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
    description: '做不下去时调用。kind: needs_input=要人回答(会停车等人,人在这个会话里回答后你继续);capability=缺工具或权限;transient=临时故障可重试;dependency=要等别的卡。',
    parameters: {
      reason: { type: 'string', required: true, description: '一句话说清卡在哪。' },
      kind: { type: 'string', required: true, enum: ['needs_input', 'capability', 'transient', 'dependency'], description: '卡住的类型。' },
    },
    output: { schema: OUT, render },
    async execute(args: any) {
      const reason = String(args.reason ?? '').trim(); const kind = String(args.kind ?? 'needs_input') as BlockKind
      if (!reason) return { ok: false, note: 'reason 不能为空' }
      await hooks.block(reason, (['needs_input', 'capability', 'transient', 'dependency'] as string[]).includes(kind) ? kind : 'needs_input')
      return { ok: true, note: kind === 'needs_input' ? '已停车等人。等对方在这个会话里回答,然后继续。' : '已记录。这一次运行到此为止。' }
    },
  })))
  disposers.push(agentCtx.tools.register(defineTool({
    name: 'task_request_review',
    description: '做完了但需要人工把关时调用。验收通过前不会启动下游或判定整批完成;文件路径放进 artifacts。',
    parameters: {
      summary: { type: 'string', required: true, description: '交接单正文。' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '待验收的交付文件路径。' },
      metadata: { type: 'object', additionalProperties: true, description: '可选的结构化结果数据。' },
    },
    output: { schema: OUT, render },
    async execute(args: any) {
      const summary = String(args.summary ?? '').trim()
      if (!summary) return { ok: false, note: 'summary 不能为空' }
      const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String) : []
      await hooks.requestReview(summary, artifacts, args.metadata as Record<string, unknown> | undefined)
      return { ok: true, note: `已提交验收${artifacts.length ? `,登记 ${artifacts.length} 个产物` : ''}。` }
    },
  })))
  return () => { for (const d of disposers.splice(0)) { try { d() } catch { /* already gone */ } } }
}
