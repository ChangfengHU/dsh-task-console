/** Chat intake uses the existing Task/Batch scheduler, never a second executor. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { credentialFromSession, type ToolExecutionLike } from './fleet-onboard-tools.ts'
import { cardRun, validateTask, type TaskSpec, type TaskTurn } from './tasks.ts'
import type { TaskRunner } from './runner.ts'
import type { IntakeAgent } from './task-intake.ts'
import { workflowDefinition } from './workflow-plan.ts'
import { composeRecipe, workflowRecipes, type WorkflowRecipe } from './workflow-recipes.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function userInput(exec: ToolExecutionLike) {
  const messages = exec.agent?.session?.deriveMessages?.() as any[] | undefined
  const users = (messages ?? []).filter(m => m.role === 'user' && (!m.source || m.source.kind === 'user'))
  const last = users.at(-1)
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
  const sessionId = String(exec.agent?.session?.id ?? exec.agent?.session?.header?.id ?? '')
  if (!sessionId || !text?.trim()) throw new Error('需要真实用户消息，不能用模型编造的输入创建任务')
  return { text, sessionId, requestId: digest([sessionId, last.id ?? users.length, text]) }
}

export type TaskProposal = {
  decision: 'create' | 'reuse'; taskId?: string; reason: string
  recipe?: WorkflowRecipe
  title?: string; brief?: string; participants?: TaskSpec['participants']; graphMode?: TaskSpec['graphMode']
}

export class TaskCreator {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly runner: TaskRunner, readonly agents: () => Promise<IntakeAgent[]>) {}

  catalog() {
    return [...this.runner.store.tasks.values()].filter(t => t.enabled && t.origin?.source === 'task-chat')
      .map(({ id, title, brief, participants, graphMode, workflowRecipe }) => ({ id, title, brief, participants,
        ...(graphMode ? { graphMode } : {}), ...(workflowRecipe ? { workflowRecipe } : {}) }))
  }

  async context() {
    return { agents: (await this.agents()).filter(a => !['task-create-agent', 'task-intake'].includes(a.id)), tasks: this.catalog(), recipes: workflowRecipes,
      contract: 'Task 是可复用目标/流程，不绑定 IP。每次提交一个独立执行 Batch。static-chain 按所选业务角色顺序交接；dynamic-rounds 仅用于规划者、执行者、评估者三人返工协议。不得改变 Agent 权限。' }
  }

  async submit(proposal: TaskProposal, exec: ToolExecutionLike, cwd?: string) {
    const input = userInput(exec)
    const pending = this.queue.then(() => this.dispatch(proposal, input, exec, cwd))
    this.queue = pending.catch(() => undefined)
    return pending
  }

  async launch(taskId: string, text: string, requestId: string, cwd?: string) {
    if (typeof text !== 'string' || text.trim().length < 2 || text.length > 32_000) throw new Error('请输入本次任务参数（最多 32000 字符）')
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new Error('需要稳定的提交 ID')
    const exec = { agent: { session: { id: `workflow-${requestId}`, deriveMessages: () => [{ id: requestId, role: 'user', content: [{ type: 'text', text }] }] } } }
    const input = { ...userInput(exec), requestId: digest(['workflow', requestId]) }
    const pending = this.queue.then(() => this.dispatch({ decision: 'reuse', taskId, reason: '用户通过 @ 选择已有工作流，提交本次参数' }, input, exec, cwd, true))
    this.queue = pending.catch(() => undefined)
    return pending
  }

  private async dispatch(raw: TaskProposal, input: ReturnType<typeof userInput>, exec: ToolExecutionLike, cwd?: string, directWorkflow = false) {
    if (input.text.length > 32_000 || JSON.stringify(raw).length > 32_000) throw new Error('任务输入或计划过长')
    const store = this.runner.store, db = store.kernel.db
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_task_requests (
      id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, task_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      source_session TEXT NOT NULL, created_at TEXT NOT NULL
    )`)
    const old = db.prepare('SELECT * FROM dsh_task_requests WHERE id = ?').get(input.requestId) as any
    // The first accepted decision for one user message wins, even if the LLM repeats a tool call.
    if (!directWorkflow && old && store.s.batches.has(old.batch_id)) return this.status(old.task_id, old.batch_id)
    if (!['create', 'reuse'].includes(raw?.decision) || !raw.reason?.trim()) throw new Error('需要 create/reuse 决策及理由')
    const roster = (await this.context()).agents, ids = new Set(roster.map(a => a.id))
    const batchId = old?.batch_id ?? `b-chat-${input.requestId.slice(0, 20)}`
    const leases: { ip: string; password: string; material: Uint8Array }[] = []
    const ips = [...new Set((input.text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []).filter(ip => ip.split('.').every(n => +n <= 255)))]
    for (const ip of ips) {
      const lease = credentialFromSession(ip, exec)
      if (lease.material) { const material = JSON.parse(Buffer.from(lease.material).toString()); leases.push({ ip, password: material.password, material: lease.material }) }
    }
    const scrub = (value: string) => leases.reduce((s, l) => s.split(l.password).join('[credential supplied privately]'), value)
    try {
      let proposal: TaskProposal = JSON.parse(scrub(JSON.stringify(raw)))
      if (proposal.recipe) {
        if (proposal.decision !== 'create' || proposal.title || proposal.brief || proposal.participants || proposal.graphMode)
          throw new Error('预制配方只接受 create、reason、recipe；不能混入另一份角色计划')
        proposal = { ...proposal, ...composeRecipe(proposal.recipe) }
      }
      let task: TaskSpec
      if (proposal.decision === 'reuse') {
        const found = store.tasks.get(proposal.taskId ?? '')
        if (!found || !found.enabled || found.origin?.source !== 'task-chat') throw new Error('只能复用已启用的聊天工作流；不能重放巡检 Signal')
        task = found
      } else {
        const reusable = (value: string) => ips.reduce((s, ip) => s.split(ip).join('{{target}}'), scrub(value))
        task = validateTask({ id: `T-chat-${input.requestId.slice(0, 20)}`, title: reusable(proposal.title ?? ''), brief: reusable(proposal.brief ?? ''),
          participants: proposal.participants?.map(p => ({ agentId: p.agentId, brief: reusable(p.brief ?? '') })), graphMode: proposal.graphMode,
          cwd, timeoutSec: 7200, onFail: 'stop', maxTries: 1 }, ids)
        task.origin = { source: 'task-chat', signalId: input.requestId, intakeSessionId: input.sessionId, decision: 'create', reason: scrub(proposal.reason) }
        if (proposal.recipe) task.workflowRecipe = { ...proposal.recipe }
      }
      if (task.participants.length > 8 || task.participants.some(p => !ids.has(p.agentId))) throw new Error('工作流角色已失效或超出 8 位参与者上限')
      const hash = digest({ proposal, text: scrub(input.text), cwd })
      if (old && old.payload_hash !== hash) throw new Error('同一提交已被接受；不能替换尚未派发的计划')
      if (old && store.s.batches.has(old.batch_id)) return this.status(old.task_id, old.batch_id)
      // Credential bytes never enter a Task, event, prompt, handoff or tool result.
      if (leases.length) {
        const root = join(store.root, 'private-inputs'); await mkdir(root, { recursive: true, mode: 0o700 })
        await writeFile(join(root, `${batchId}.json`), JSON.stringify({ expiresAt: Date.now() + 24 * 3600_000,
          credentials: leases.map(l => JSON.parse(Buffer.from(l.material).toString())) }), { mode: 0o600 })
      }
      if (!old) db.prepare('INSERT INTO dsh_task_requests VALUES (?, ?, ?, ?, ?, ?)').run(input.requestId, hash, task.id, batchId, input.sessionId, new Date().toISOString())
      if (!store.tasks.has(task.id)) await store.append({ t: 'task/created', at: new Date().toISOString(), taskId: task.id, task })
      const definition = workflowDefinition(task)
      const turn: TaskTurn = { objective: `${task.brief}\n\n[THIS EXECUTION — USER REQUEST]\n${scrub(input.text)}`, participants: task.participants,
        userRequest: scrub(input.text), workflow: { id: digest(definition), definition },
        ...(cwd ? { cwd } : {}), targets: ips.map(ip => ({ kind: 'fleet-node', id: ip })),
        origin: { source: 'task-chat', signalId: input.requestId, ...(!directWorkflow ? { intakeSessionId: input.sessionId } : {}), decision: proposal.decision, reason: scrub(proposal.reason) } }
      await this.runner.fire(task.id, 'manual', { batchId, turn })
      return this.status(task.id, batchId)
    } finally { for (const lease of leases) lease.material.fill(0) }
  }

  status(taskId: string, batchId: string) {
    const store = this.runner.store, batch = store.s.batches.get(batchId)
    if (!batch || batch.taskId !== taskId) throw new Error('没有这个执行记录')
    return { taskId, batchId, outcome: batch.settled?.outcome ?? 'running', path: `/#/tc/tasks/${taskId}/runs/${batchId}`,
      cards: batch.cardIds.map(id => { const card = store.s.cards.get(id)!; const run = cardRun(store.s, card); return {
        id, agentId: card.agentId, dependsOn: card.deps, status: card.status, sessionId: run?.sessionId ?? null, summary: run?.summary ?? null, error: run?.error ?? null,
      } }), note: '已提交不等于已完成。看板记录真实角色状态、会话、工具调用和交接；复用 Task 会增加执行记录，不增加任务卡片。' }
  }
}
