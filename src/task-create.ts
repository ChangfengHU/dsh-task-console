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
import { validateDesign, type TaskDesign } from './task-design.ts'

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
  design?: TaskDesign
}

export class TaskCreator {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly runner: TaskRunner, readonly agents: () => Promise<IntakeAgent[]>) {}

  catalog() {
    return [...this.runner.store.tasks.values()].filter(t => t.enabled && t.origin?.source === 'task-chat')
      .map(({ id, title, brief, participants, graphMode, workflowRecipe, design }) => ({ id, title, brief, participants,
        ...(graphMode ? { graphMode } : {}), ...(workflowRecipe ? { workflowRecipe } : {}), ...(design ? { design } : {}) }))
  }

  async context() {
    return { agents: (await this.agents()).filter(a => !['task-create-agent', 'task-intake'].includes(a.id)), tasks: this.catalog(), recipes: workflowRecipes,
      contract: 'Task 是可复用目标/流程，不绑定 IP。task_create_submit 只保存待审查计划，不启动执行；审查入口独立于创建 Agent。每次先提供 design:{scope,branches:[{id,when,action,evidence}],coordination,failurePolicy:{isolateItems,maxAttempts,stopConditions:[]},acceptance:[]}。条件由业务 Agent 根据真实工具证据执行，不能把自然语言条件伪装成内核自动 DAG。static-chain 按所选业务角色交接，也可只选一个业务 Agent 处理多目标分支；dynamic-rounds 仅用于规划者、执行者、评估者三人返工协议。不得改变 Agent 权限。' }
  }

  async prepare(proposal: TaskProposal, exec: ToolExecutionLike, cwd?: string) {
    validateDesign(proposal.design)
    const input = userInput(exec)
    const pending = this.queue.then(() => this.dispatch(proposal, input, exec, cwd, false, true))
    this.queue = pending.catch(() => undefined)
    return pending
  }

  private plansDb() {
    const db = this.runner.store.kernel.db
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_task_plans (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, source_session TEXT NOT NULL,
      hash TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, reviewed_at TEXT, review_reason TEXT, task_id TEXT, batch_id TEXT
    )`)
    return db
  }

  plans(page = 1) {
    const db = this.plansDb(), total = (db.prepare('SELECT COUNT(*) AS n FROM dsh_task_plans').get() as any).n
    const pages = Math.max(1, Math.ceil(total / 10)), current = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)))
    return { page: current, pages, total, rows: db.prepare('SELECT id,title,state,created_at,source_session,task_id,batch_id FROM dsh_task_plans ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET ?').all((current - 1) * 10) }
  }

  plan(id: string) {
    const row = this.plansDb().prepare('SELECT * FROM dsh_task_plans WHERE id=?').get(id) as any
    if (!row) throw new Error('没有这个待审查计划')
    const p = JSON.parse(row.payload)
    return { id: row.id, hash: row.hash, state: row.state, createdAt: row.created_at,
      reviewedAt: row.reviewed_at, reviewReason: row.review_reason, sourceSessionId: row.source_session,
      request: p.input.text, definition: workflowDefinition(p.task), decision: p.decision,
      taskId: row.task_id, batchId: row.batch_id, path: `/#/tc/tasks/plans/${row.id}`,
      note: row.state === 'pending' ? '待审查；尚未创建执行 Task/Batch，未启动任何执行 Agent。' : '审批记录与原始计划保留，修改需生成新计划。' }
  }

  async review(id: string, hash: string, decision: 'approve' | 'reject', reason: string) {
    const pending = this.queue.then(async () => {
      const db = this.plansDb(), row = db.prepare('SELECT * FROM dsh_task_plans WHERE id=?').get(id) as any
      if (!row || row.hash !== hash) throw new Error('计划不存在或指纹变化，请重新审查')
      if (!['approve', 'reject'].includes(decision) || !reason?.trim() || reason.length > 4000) throw new Error('需要审查决定与理由')
      if (row.state === 'dispatched' && decision === 'approve') return this.plan(id)
      if (row.state !== 'pending' && !(row.state === 'approved' && decision === 'approve')) throw new Error('计划不再待审查，不能改写历史决定')
      const p = JSON.parse(row.payload), roster = (await this.context()).agents
      if (decision === 'reject') {
        db.prepare("UPDATE dsh_task_plans SET state='rejected',reviewed_at=?,review_reason=? WHERE id=? AND state='pending'").run(new Date().toISOString(), reason.trim(), id)
        return this.plan(id)
      }
      const selected = p.task.participants.map((a: any) => roster.find(r => r.id === a.agentId) ?? null)
      if (digest(selected) !== p.rosterHash) throw new Error('参与 Agent 的能力或配置已变化，需创建并审查新计划')
      if (p.decision === 'reuse') {
        const current = this.runner.store.tasks.get(p.task.id)
        if (!current?.enabled || digest(workflowDefinition(current)) !== digest(workflowDefinition(p.task))) throw new Error('待复用工作流已变化，需重新审查')
      }
      if (row.state === 'pending') {
        const claimed = db.prepare("UPDATE dsh_task_plans SET state='approved',reviewed_at=?,review_reason=? WHERE id=? AND state='pending'").run(new Date().toISOString(), reason.trim(), id)
        if (claimed.changes !== 1) throw new Error('审查状态已被其他操作改变，请重新读取')
      }
      const store = this.runner.store
      if (!store.tasks.has(p.task.id)) await store.append({ t: 'task/created', at: new Date().toISOString(), taskId: p.task.id, task: { ...p.task, origin: { ...p.task.origin, reviewPlanId: id } } })
      const definition = workflowDefinition(p.task)
      const turn: TaskTurn = { objective: `${p.task.brief}\n\n[THIS EXECUTION — USER REQUEST]\n${p.input.text}`, participants: p.task.participants,
        userRequest: p.input.text, workflow: { id: digest(definition), definition }, ...(p.cwd ? { cwd: p.cwd } : {}), targets: p.targets,
        origin: { source: 'task-chat', signalId: p.input.requestId, intakeSessionId: p.input.sessionId, decision: p.decision, reason: p.reason, reviewPlanId: id } }
      await this.runner.fire(p.task.id, 'manual', { batchId: p.batchId, turn })
      db.prepare("UPDATE dsh_task_plans SET state='dispatched',task_id=?,batch_id=? WHERE id=? AND state='approved'").run(p.task.id, p.batchId, id)
      return this.plan(id)
    })
    this.queue = pending.catch(() => undefined)
    return pending
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

  private async dispatch(raw: TaskProposal, input: ReturnType<typeof userInput>, exec: ToolExecutionLike, cwd?: string, directWorkflow = false, stageOnly = false) {
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
      if (proposal.design) {
        if (proposal.decision === 'reuse' && JSON.stringify(validateDesign(proposal.design)) !== JSON.stringify(task.design)) throw new Error('复用不能改写决策设计；请创建新的待审查计划')
        const reusableDesign = proposal.decision === 'create'
          ? JSON.parse(ips.reduce((s, ip) => s.split(ip).join('{{target}}'), JSON.stringify(proposal.design)))
          : proposal.design
        task = { ...task, design: validateDesign(reusableDesign) }
      }
      const hash = digest({ proposal, text: scrub(input.text), cwd })
      if (old && old.payload_hash !== hash) throw new Error('同一提交已被接受；不能替换尚未派发的计划')
      if (old && store.s.batches.has(old.batch_id)) return this.status(old.task_id, old.batch_id)
      // Credential bytes never enter a Task, event, prompt, handoff or tool result.
      if (leases.length) {
        const root = join(store.root, 'private-inputs'); await mkdir(root, { recursive: true, mode: 0o700 })
        await writeFile(join(root, `${batchId}.json`), JSON.stringify({ expiresAt: Date.now() + 24 * 3600_000,
          credentials: leases.map(l => JSON.parse(Buffer.from(l.material).toString())) }), { mode: 0o600 })
      }
      if (stageOnly) {
        const planId = `P-chat-${digest([input.requestId, hash]).slice(0, 20)}`, db = this.plansDb()
        const payload = JSON.stringify({ task, input: { ...input, text: scrub(input.text) }, cwd, batchId,
          decision: proposal.decision, reason: proposal.reason, targets: ips.map(ip => ({ kind: 'fleet-node', id: ip })),
          rosterHash: digest(task.participants.map(a => roster.find(r => r.id === a.agentId))) })
        const oldPlan = db.prepare('SELECT id FROM dsh_task_plans WHERE id=?').get(planId)
        if (!oldPlan) {
          const accepted = db.prepare("SELECT id FROM dsh_task_plans WHERE request_id=? AND state IN ('approved','dispatched')").get(input.requestId)
          if (accepted) throw new Error('这条请求已有放行计划，不能通过改写计划再次执行')
          db.transaction(() => {
            db.prepare("UPDATE dsh_task_plans SET state='superseded' WHERE request_id=? AND state='pending'").run(input.requestId)
            db.prepare("INSERT INTO dsh_task_plans(id,request_id,source_session,hash,state,title,payload,created_at) VALUES (?,?,?,?,'pending',?,?,?)")
              .run(planId, input.requestId, input.sessionId, hash, task.title, payload, new Date().toISOString())
          })()
        }
        return this.plan(planId)
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
