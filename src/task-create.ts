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
  trigger?: TaskSpec['trigger']
}

export class TaskCreator {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly runner: TaskRunner, readonly agents: () => Promise<IntakeAgent[]>) {}

  catalog() {
    return [...this.runner.store.tasks.values()].filter(t => t.enabled && t.origin?.source === 'task-chat')
      .map(({ id, title, brief, participants, graphMode, workflowRecipe, design, trigger }) => ({ id, title, brief, participants, trigger,
        ...(graphMode ? { graphMode } : {}), ...(workflowRecipe ? { workflowRecipe } : {}), ...(design ? { design } : {}) }))
  }

  async context() {
    return { agents: (await this.agents()).filter(a => !['task-create-agent', 'task-intake'].includes(a.id)), tasks: this.catalog(), recipes: workflowRecipes,
      scheduling: { trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' }, approval: '批准后创建暂停的时间表；先手动执行，通过业务和通知验收后才能启用定时。每次复用同一Task、新增Batch。', overlap: '上一轮未结束时跳过并留记录', missed: '重启后漏跑合并为最近一次', waiting: 'task_wait(until,reason) 持久化等待，同一Batch/卡新Run继续；等待不消耗返工轮次，但受总时长限制。', permissions: '定时不增加权限；当前角色配置变化会停止派发并要求重新审查。' },
      evidenceContracts: [{ id: 'browser-patrol-v2', purpose: '周期性浏览器登录巡查：dynamic-rounds 的规划者→Gate→浏览器管理员→只读评估者→规划者。规划者每轮用 task_plan_round(summary,items:[{ip,instance,action:verify|provision|resume,reason}]) 冻结真实目标和动作；未知先验证，有未登录证据才允许 provision。MCP 强制逐目标累计修复预算；无删除重建权限。执行者/评估者 task_complete 交接事实，不等于业务通过；规划者 task_finalize 由真实工具证据把关。修改过的实例用 task_wait 分时独立复验，同一卡新Run，已健康实例只做当前检查。', browserPatrol: { scope: 'fleet-existing-authorized', actions: ['provision','resume'], observationMinutes: 20, minSamples: 4 }, notifications: '需要企微时显式设置 design.notifications={channel:"wecom",chatIds:[已确认群ID]}。规划者必须具备实际企微发送MCP，通过 task_notify 生成基于证据的通知并持久化结果；先用 vyibc-wecom_list_groups 发现现有订阅群；只有一个群时预填其真实chatId交审查，多个群再询问。禁止索要已有密钥或默认广播。' },
        { id: 'browser-patrol-v1', purpose: '旧版单角色巡查兼容；新定时和动态返工目标使用v2，不为兼容改写历史计划。' }],
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
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_schedule_bindings(task_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, turn_json TEXT NOT NULL, roster_hash TEXT NOT NULL)`)
    return db
  }

  /** Reuse only explicitly reviewed recurring input; never replay bootstrap credentials. */
  async scheduledTurn(task: TaskSpec, occurrenceId: string): Promise<TaskTurn | undefined> {
    if (!task.origin) return undefined
    const row = this.plansDb().prepare('SELECT * FROM dsh_schedule_bindings WHERE task_id=?').get(task.id) as any
    if (!row) throw new Error('缺少独立审查的定时输入，不能重放旧 Signal')
    const roster = (await this.context()).agents, selected = task.participants.map(p => roster.find(a => a.id === p.agentId) ?? null)
    if (digest(selected) !== row.roster_hash) throw new Error('定时任务角色配置已变化，需重新审查')
    const turn = JSON.parse(row.turn_json) as TaskTurn
    if (digest(workflowDefinition(task)) !== digest(turn.workflow!.definition)) throw new Error('定时任务定义与审查快照不一致')
    return { ...turn, origin: { ...turn.origin!, signalId: occurrenceId, decision: 'reuse', reason: '执行独立审查通过的定时目标；按当前真实清单重新检查' } }
  }

  plans(page = 1) {
    const db = this.plansDb(), total = (db.prepare('SELECT COUNT(*) AS n FROM dsh_task_plans').get() as any).n
    const pages = Math.max(1, Math.ceil(total / 10)), current = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)))
    return { page: current, pages, total, rows: db.prepare('SELECT id,title,state,created_at,source_session,task_id,batch_id FROM dsh_task_plans ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET ?').all((current - 1) * 10) }
  }

  async assertScheduleActivation(task: TaskSpec) {
    if (task.trigger.kind !== 'cron' || !task.origin?.reviewPlanId) return;
    const row = this.plansDb().prepare('SELECT state FROM dsh_task_plans WHERE id=?').get(task.origin.reviewPlanId) as any
    if (row?.state !== 'awaiting_trial') return
    await this.scheduledTurn(task, 'activation-check')
    const batches = [...this.runner.store.s.batches.values()].filter(b => b.taskId === task.id)
    if (batches.some(b => !b.settled)) throw new Error('首次手动执行尚未结束，不能启用定时')
    const manual = batches.filter(b => b.by === 'manual').sort((a,b) => b.firedAt.localeCompare(a.firedAt))[0]
    if (!manual || manual.settled?.outcome !== 'done' || !manual.turn?.workflow || digest(manual.turn.workflow.definition) !== digest(workflowDefinition(task)))
      throw new Error('先对当前已审查计划手动执行并通过业务验收，再启用定时')
    if (task.design?.notifications) {
      const notices = this.plansDb().prepare('SELECT state FROM dsh_task_notifications WHERE batch_id=?').all(manual.id) as any[]
      if (notices.length < task.design.notifications.chatIds.length || notices.some(n => n.state !== 'sent'))
        throw new Error('首次执行的企微通知尚未全部确认送达，不能启用定时；仅处理通知，不重复浏览器修复')
    }
  }

  scheduleActivated(task: TaskSpec) {
    if (task.trigger.kind === 'cron' && task.origin?.reviewPlanId)
      this.plansDb().prepare("UPDATE dsh_task_plans SET state='scheduled' WHERE id=? AND state='awaiting_trial'").run(task.origin.reviewPlanId)
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
      if (['dispatched', 'scheduled', 'awaiting_trial'].includes(row.state) && decision === 'approve') return this.plan(id)
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
      if (!store.tasks.has(p.task.id)) await store.append({ t: 'task/created', at: new Date().toISOString(), taskId: p.task.id, task: { ...p.task, ...(p.task.trigger.kind === 'cron' ? { enabled: false } : {}), origin: { ...p.task.origin, reviewPlanId: id } } })
      const definition = workflowDefinition(p.task)
      const turn: TaskTurn = { objective: `${p.task.brief}\n\n[THIS EXECUTION — USER REQUEST]\n${p.input.text}`, participants: p.task.participants,
        userRequest: p.input.text, workflow: { id: digest(definition), definition }, ...(p.cwd ? { cwd: p.cwd } : {}), targets: p.targets,
        origin: { source: 'task-chat', signalId: p.input.requestId, intakeSessionId: p.input.sessionId, decision: p.decision, reason: p.reason, reviewPlanId: id } }
      if (p.task.trigger.kind === 'cron') {
        db.prepare(`INSERT INTO dsh_schedule_bindings VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET plan_id=excluded.plan_id,turn_json=excluded.turn_json,roster_hash=excluded.roster_hash`).run(p.task.id, id, JSON.stringify(turn), p.rosterHash)
        this.runner.schedule.sync(store.tasks.get(p.task.id)!, Date.now())
        db.prepare("UPDATE dsh_task_plans SET state='awaiting_trial',task_id=? WHERE id=? AND state='approved'").run(p.task.id, id)
        return this.plan(id)
      }
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
        if (proposal.trigger && JSON.stringify(proposal.trigger) !== JSON.stringify(task.trigger)) throw new Error('复用不能修改时间表；需创建新的待审查计划')
      } else {
        const reusable = (value: string) => ips.reduce((s, ip) => s.split(ip).join('{{target}}'), scrub(value))
        task = validateTask({ id: `T-chat-${input.requestId.slice(0, 20)}`, title: reusable(proposal.title ?? ''), brief: reusable(proposal.brief ?? ''),
          participants: proposal.participants?.map(p => ({ agentId: p.agentId, brief: reusable(p.brief ?? '') })), graphMode: proposal.graphMode,
          trigger: proposal.trigger, cwd, timeoutSec: 7200, onFail: 'stop', maxTries: 1 }, ids)
        task.origin = { source: 'task-chat', signalId: input.requestId, intakeSessionId: input.sessionId, decision: 'create', reason: scrub(proposal.reason) }
        if (proposal.recipe) task.workflowRecipe = { ...proposal.recipe }
      }
      if (task.trigger.kind === 'cron' && leases.length) throw new Error('定时任务不能保存或复用首次登录密码；请先完成金库接入')
      if (task.participants.length > 8 || task.participants.some(p => !ids.has(p.agentId))) throw new Error('工作流角色已失效或超出 8 位参与者上限')
      if (proposal.design) {
        if (proposal.decision === 'reuse' && JSON.stringify(validateDesign(proposal.design)) !== JSON.stringify(task.design)) throw new Error('复用不能改写决策设计；请创建新的待审查计划')
        const reusableDesign = proposal.decision === 'create'
          ? JSON.parse(ips.reduce((s, ip) => s.split(ip).join('{{target}}'), JSON.stringify(proposal.design)))
          : proposal.design
        task = { ...task, design: validateDesign(reusableDesign) }
      }
      if (task.design?.evidenceContract === 'browser-patrol-v2') {
        if (task.graphMode !== 'dynamic-rounds' || new Set(task.participants.map(p => p.agentId)).size !== 3) throw new Error('巡查v2需要三个不同的规划/执行/独立评估角色')
        const team = task.participants.map(p => roster.find(r => r.id === p.agentId)!)
        for (const role of team) {
          const tools = Object.values(role.mcpTools).flat()
          if (!['browser_fleet_inventory','browser_login_verify','browser_status'].every(t => tools.includes(t))) throw new Error(`角色 ${role.id} 缺少真实清单/登录验证/回执 MCP 能力`)
        }
        if (team[1].id !== 'browser-manager') throw new Error('当前巡查执行者必须是已受限的浏览器管理员')
        for (const role of [team[0],team[2]]) if (Object.values(role.mcpTools).flat().some(t => /^browser_(create|retire|restore|purge|prepare|login_(copy|provision|resume|acceptance))$/.test(t))) throw new Error('规划者和独立评估者只允许浏览器只读能力')
        if (task.design.notifications && !Object.values(team[0].mcpTools).flat().some(t => t.replace(/-/g, '_') === 'vyibc_wecom_send_message')) throw new Error('规划者没有配置企业微信发送 MCP，不能承诺通知')
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
          const accepted = db.prepare("SELECT id FROM dsh_task_plans WHERE request_id=? AND state IN ('approved','dispatched','scheduled','awaiting_trial')").get(input.requestId)
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
