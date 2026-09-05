/**
 * Durable Task Intake: an external fact becomes an Agent routing decision,
 * then a Task/Turn. The coordinator owns validation and persistence; the LLM
 * may choose only from the roster and Tasks supplied in its bounded context.
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TaskRunner } from './runner.ts'
import type { Participant, TaskOrigin, TaskSpec, TaskTarget, TaskTurn } from './tasks.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const SAFE_KIND = /^[a-z][a-z0-9._-]{0,63}$/
const STATUSES = ['received', 'deciding', 'materializing', 'materialized', 'needs_triage', 'failed'] as const
const SECRET_TEXT = /(?:\bauthorization\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:pass(?:word|wd)?|secret|api[_ -]?key|private[_ -]?key)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i

export type TaskSignalStatus = typeof STATUSES[number]

export interface TaskSignalFact {
  name: string
  value: string | number | boolean | null
}

export interface TaskSignal {
  schemaVersion: 1
  id: string
  source: string
  kind: string
  observedAt: string
  goal: { key?: string; title: string; objective: string }
  incident?: { id: string; faultKind: string; state: string; severity?: string; summary?: string }
  targets: TaskTarget[]
  constraints: string[]
  facts: TaskSignalFact[]
  requiredExecutorTools?: string[]
}

export interface IntakeAgent {
  id: string
  name: string
  description: string
  model?: string
  permission?: string
  tools: string[]
  mcpTools: Record<string, string[]>
  skills: string[]
  toolSchemas?: string[]
  toolDescriptions?: Record<string, string>
  taskExpertise?: string[]
}

export interface IntakeTaskCandidate {
  id: string
  title: string
  objective: string
  state: 'active' | 'done' | 'failed' | 'idle'
  graphMode: 'static-chain' | 'dynamic-rounds'
  participantIds: string[]
  incidentIds: string[]
  targets: TaskTarget[]
  score: number
  reasons: string[]
}

export interface TaskIntakeContext {
  policy: string[]
  agents: IntakeAgent[]
  candidateTasks: IntakeTaskCandidate[]
  recommendedTaskId?: string
  requiredExecutorTools?: string[]
}

export interface DecisionParticipant extends Participant {
  role?: 'planner' | 'executor' | 'reviewer' | 'worker'
}

export interface TaskIntakeDecision {
  action: 'create' | 'reuse' | 'triage'
  reason: string
  confidence: number
  taskId?: string
  title?: string
  objective?: string
  workflow?: 'static-chain' | 'dynamic-rounds'
  participants?: DecisionParticipant[]
}

export interface TaskIntakeDecisionResult {
  decision: TaskIntakeDecision
  sessionId: string
}

export interface TaskSignalView {
  signal: TaskSignal
  status: TaskSignalStatus
  receivedAt: string
  updatedAt: string
  intakeSessionId?: string
  decision?: TaskIntakeDecision
  taskId?: string
  batchId?: string
  error?: string
  runState?: 'active' | 'blocked' | 'done' | 'failed' | 'missing'
}

interface SignalRow {
  signal_id: string
  signal_json: string
  status: TaskSignalStatus
  intake_session_id: string | null
  decision_json: string | null
  task_id: string | null
  batch_id: string | null
  error: string | null
  received_at: number
  updated_at: number
}

export interface TaskIntakeOptions {
  agents: () => Promise<IntakeAgent[]>
  decide: (signal: TaskSignal, context: TaskIntakeContext) => Promise<TaskIntakeDecisionResult>
  workspace?: string
  timeoutSec?: number
  now?: () => number
}

const oneLine = (value: unknown, maximum: number) => String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').slice(0, maximum)
const noSecretText = (value: string, field: string): string => {
  if (SECRET_TEXT.test(value)) throw new Error(`${field} 不允许包含凭据`)
  return value
}
const iso = (value: unknown) => {
  const parsed = Date.parse(String(value ?? ''))
  if (!Number.isFinite(parsed)) throw new Error('observedAt 必须是 ISO 时间')
  return new Date(parsed).toISOString()
}

function stringId(value: unknown, field: string): string {
  const out = oneLine(value, 160)
  if (!ID.test(out)) throw new Error(`${field} 不合法`)
  return out
}

/** Strict input deliberately excludes arbitrary nested payloads and credentials. */
export function validateTaskSignal(raw: unknown): TaskSignal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('signal 必须是对象')
  const input = raw as Record<string, unknown>
  const requiredExecutorTools = input.requiredExecutorTools === undefined ? undefined : input.requiredExecutorTools
  if (requiredExecutorTools !== undefined && (!Array.isArray(requiredExecutorTools) || requiredExecutorTools.length > 32 || requiredExecutorTools.some(x => typeof x !== 'string' || !/^[A-Za-z][A-Za-z0-9_:-]{0,159}$/.test(x)))) throw new Error('requiredExecutorTools 必须是明确的工具名称列表')
  if (Number(input.schemaVersion) !== 1) throw new Error('只支持 Task Signal schemaVersion=1')
  const source = oneLine(input.source, 120)
  if (!source) throw new Error('source 必填')
  const kind = oneLine(input.kind, 64).toLowerCase()
  if (!SAFE_KIND.test(kind)) throw new Error('kind 不合法')
  const goalRaw = input.goal
  if (!goalRaw || typeof goalRaw !== 'object' || Array.isArray(goalRaw)) throw new Error('goal 必填')
  const goalInput = goalRaw as Record<string, unknown>
  const title = noSecretText(oneLine(goalInput.title, 120), 'goal.title')
  const objective = noSecretText(String(goalInput.objective ?? '').trim().slice(0, 12_000), 'goal.objective')
  if (title.length < 2) throw new Error('goal.title 至少 2 个字符')
  if (objective.length < 8) throw new Error('goal.objective 至少 8 个字符')
  const goalKey = oneLine(goalInput.key, 160)
  if (goalKey && !ID.test(goalKey)) throw new Error('goal.key 不合法')
  let incident: TaskSignal['incident']
  if (input.incident !== undefined) {
    if (!input.incident || typeof input.incident !== 'object' || Array.isArray(input.incident)) throw new Error('incident 不合法')
    const value = input.incident as Record<string, unknown>
    const faultKind = oneLine(value.faultKind, 64).toLowerCase()
    if (!SAFE_KIND.test(faultKind)) throw new Error('incident.faultKind 不合法')
    incident = {
      id: stringId(value.id, 'incident.id'),
      faultKind,
      state: oneLine(value.state, 40) || 'confirmed',
      ...(oneLine(value.severity, 24) ? { severity: oneLine(value.severity, 24) } : {}),
      ...(oneLine(value.summary, 1_000) ? { summary: noSecretText(oneLine(value.summary, 1_000), 'incident.summary') } : {}),
    }
  }
  const targets = (Array.isArray(input.targets) ? input.targets : []).slice(0, 32).map((rawTarget, index) => {
    if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) throw new Error(`targets[${index}] 不合法`)
    const target = rawTarget as Record<string, unknown>
    const targetKind = oneLine(target.kind, 64).toLowerCase()
    if (!SAFE_KIND.test(targetKind)) throw new Error(`targets[${index}].kind 不合法`)
    return { kind: targetKind, id: stringId(target.id, `targets[${index}].id`), ...(oneLine(target.label, 120) ? { label: oneLine(target.label, 120) } : {}) }
  })
  const constraints = [...new Set((Array.isArray(input.constraints) ? input.constraints : []).map((value, index) => noSecretText(oneLine(value, 300), `constraints[${index}]`)).filter(Boolean))].slice(0, 32)
  const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 64).map((rawFact, index) => {
    if (!rawFact || typeof rawFact !== 'object' || Array.isArray(rawFact)) throw new Error(`facts[${index}] 不合法`)
    const fact = rawFact as Record<string, unknown>
    const name = oneLine(fact.name, 80)
    if (!name || /pass(word)?|secret|token|authorization|cookie|private.?key/i.test(name)) throw new Error(`facts[${index}].name 不允许`) 
    const candidate = fact.value
    if (candidate !== null && !['string', 'number', 'boolean'].includes(typeof candidate)) throw new Error(`facts[${index}].value 只允许标量`)
    return { name, value: typeof candidate === 'string' ? noSecretText(oneLine(candidate, 1_000), `facts[${index}].value`) : candidate as number | boolean | null }
  })
  return {
    schemaVersion: 1,
    id: stringId(input.id, 'id'),
    source,
    kind,
    observedAt: iso(input.observedAt),
    goal: { ...(goalKey ? { key: goalKey } : {}), title, objective },
    ...(incident ? { incident } : {}),
    targets,
    constraints,
    facts,
    ...(requiredExecutorTools ? { requiredExecutorTools: [...new Set(requiredExecutorTools as string[])] } : {}),
  }
}

export function validateTaskIntakeDecision(raw: unknown, context: TaskIntakeContext): TaskIntakeDecision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('decision 必须是对象')
  const input = raw as Record<string, unknown>
  const action = oneLine(input.action, 20) as TaskIntakeDecision['action']
  if (!['create', 'reuse', 'triage'].includes(action)) throw new Error('action 必须是 create / reuse / triage')
  const reason = oneLine(input.reason, 1_500)
  if (reason.length < 6) throw new Error('reason 必须说明判断依据')
  const confidence = Number(input.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence 必须在 0..1')
  if (action === 'triage') return { action, reason, confidence }
  const workflow = input.workflow === 'static-chain' ? 'static-chain' : 'dynamic-rounds'
  const participants = (Array.isArray(input.participants) ? input.participants : []).map((rawParticipant, index) => {
    if (!rawParticipant || typeof rawParticipant !== 'object' || Array.isArray(rawParticipant)) throw new Error(`participants[${index}] 不合法`)
    const participant = rawParticipant as Record<string, unknown>
    const agentId = stringId(participant.agentId, `participants[${index}].agentId`)
    if (!context.agents.some(agent => agent.id === agentId)) throw new Error(`Agent 不在可用名册:${agentId}`)
    const role = oneLine(participant.role, 20) as DecisionParticipant['role']
    if (role && !['planner', 'executor', 'reviewer', 'worker'].includes(role)) throw new Error(`participants[${index}].role 不合法`)
    return { agentId, ...(role ? { role } : {}), ...(oneLine(participant.brief, 1_000) ? { brief: oneLine(participant.brief, 1_000) } : {}) }
  })
  if (!participants.length) throw new Error('至少选择一个 Agent')
  if (new Set(participants.map(row => row.agentId)).size !== participants.length) throw new Error('同一 Agent 不能在一个 Turn 重复出现')
  if (workflow === 'dynamic-rounds') {
    const expected = ['planner', 'executor', 'reviewer']
    if (participants.length !== 3 || participants.some((row, index) => row.role !== expected[index])) throw new Error('动态回合必须依次选择 planner、executor、reviewer')
  }
  if (context.requiredExecutorTools?.length) {
    const executors = participants.filter(row => row.role === 'executor' || row.role === 'worker')
    if (!executors.some(row => {
      const agent = context.agents.find(agent => agent.id === row.agentId)!
      return context.requiredExecutorTools!.every(tool => agent.toolSchemas?.includes(tool))
    })) throw new Error('执行者不具备所需的实际工具；请选择有能力的 Agent，或 triage。不得以基础装机或通用 shell 替代受限工具。')
    for (const row of participants.filter(row => row.role === 'planner' || row.role === 'reviewer')) {
      const agent = context.agents.find(agent => agent.id === row.agentId)!
      if (!context.requiredExecutorTools.every(tool => agent.taskExpertise?.includes(tool))) {
        throw new Error(`${row.role} 的 taskExpertise 不覆盖本次执行工具契约；请选择对应领域的规划/验收角色或 triage，不得让基础节点角色规划 Runner 部署。`)
      }
    }
  }
  const objective = String(input.objective ?? '').trim().slice(0, 12_000)
  if (objective && objective.length < 8) throw new Error('objective 至少 8 个字符')
  const title = oneLine(input.title, 120)
  if (action === 'create' && title.length < 2) throw new Error('create 必须给出 title')
  let taskId: string | undefined
  if (action === 'reuse') {
    taskId = stringId(input.taskId, 'taskId')
    if (!context.candidateTasks.some(task => task.id === taskId)) throw new Error('只能复用上下文中列出的候选 Task')
    if (context.recommendedTaskId && taskId !== context.recommendedTaskId) throw new Error(`当前 Incident 已关联 ${context.recommendedTaskId}，不得改绑其他 Task`)
  } else if (context.recommendedTaskId) {
    throw new Error(`当前 Incident 已关联 ${context.recommendedTaskId}，应复用而不是新建`)
  }
  return {
    action, reason, confidence,
    ...(taskId ? { taskId } : {}),
    ...(title ? { title } : {}),
    ...(objective ? { objective } : {}),
    workflow,
    participants,
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

export class TaskIntakeCoordinator {
  private readonly runner: TaskRunner
  private readonly options: TaskIntakeOptions
  private readonly active = new Map<string, Promise<void>>()
  /** One bounded routing queue prevents concurrent Signals from racing the same Incident/goal decision. */
  private decisionQueue: Promise<void> = Promise.resolve()

  constructor(runner: TaskRunner, options: TaskIntakeOptions) {
    this.runner = runner
    this.options = options
  }

  private now(): number { return Math.floor((this.options.now?.() ?? Date.now()) / 1000) }
  private workspace(): string { return this.options.workspace ?? process.env.DSH_TASK_INTAKE_WORKSPACE ?? join(homedir(), '.dsh', 'task-console', 'intake-workspace') }

  async start(): Promise<void> {
    const db = this.runner.store.kernel.db
    this.runner.store.kernel.write(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dsh_task_signals (
          signal_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          source TEXT NOT NULL,
          signal_kind TEXT NOT NULL,
          incident_id TEXT,
          goal_key TEXT,
          signal_json TEXT NOT NULL,
          status TEXT NOT NULL,
          intake_session_id TEXT,
          decision_json TEXT,
          task_id TEXT,
          batch_id TEXT,
          error TEXT,
          received_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signals_status ON dsh_task_signals(status, received_at);
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signals_incident ON dsh_task_signals(incident_id, received_at);
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signals_goal ON dsh_task_signals(goal_key, received_at);
        CREATE TABLE IF NOT EXISTS dsh_task_signal_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signal_events_signal ON dsh_task_signal_events(signal_id, id);
        CREATE TABLE IF NOT EXISTS dsh_task_incident_links (
          incident_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          first_signal_id TEXT NOT NULL,
          last_signal_id TEXT NOT NULL,
          incident_state TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (incident_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_incident_task ON dsh_task_incident_links(task_id, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_task_incident_one_task ON dsh_task_incident_links(incident_id);
        CREATE TABLE IF NOT EXISTS dsh_task_targets (
          task_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          label TEXT,
          first_signal_id TEXT NOT NULL,
          last_signal_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, target_kind, target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_targets_resource ON dsh_task_targets(target_kind, target_id, updated_at);
      `)
      const interrupted = db.prepare(`SELECT signal_id FROM dsh_task_signals WHERE status IN ('deciding','materializing')`).all() as { signal_id: string }[]
      const reset = db.prepare(`UPDATE dsh_task_signals SET status='received', error=NULL, updated_at=? WHERE signal_id=?`)
      const event = db.prepare(`INSERT INTO dsh_task_signal_events(signal_id, kind, payload_json, created_at) VALUES (?, 'recovered', ?, ?)`)
      for (const row of interrupted) { reset.run(this.now(), row.signal_id); event.run(row.signal_id, JSON.stringify({ reason: 'host_restart' }), this.now()) }
    })
    const pending = db.prepare(`SELECT signal_id FROM dsh_task_signals WHERE status='received' ORDER BY received_at`).all() as { signal_id: string }[]
    for (const row of pending) this.kick(row.signal_id)
  }

  async submit(raw: unknown): Promise<TaskSignalView> {
    const signal = validateTaskSignal(raw)
    const db = this.runner.store.kernel.db
    const now = this.now()
    const encoded = JSON.stringify(signal)
    const inserted = this.runner.store.kernel.write(() => {
      const result = db.prepare(`INSERT OR IGNORE INTO dsh_task_signals(
        signal_id,schema_version,source,signal_kind,incident_id,goal_key,signal_json,status,received_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'received',?,?)`).run(
        signal.id, signal.schemaVersion, signal.source, signal.kind, signal.incident?.id ?? null,
        signal.goal.key ?? null, encoded, now, now,
      )
      if (result.changes) db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'received',?,?)`)
        .run(signal.id, JSON.stringify({ source: signal.source, kind: signal.kind, incident_id: signal.incident?.id ?? null }), now)
      return result.changes === 1
    })
    if (!inserted) {
      const existing = db.prepare('SELECT signal_json FROM dsh_task_signals WHERE signal_id=?').get(signal.id) as { signal_json: string } | undefined
      if (!existing || existing.signal_json !== encoded) throw Object.assign(new Error('Signal id 已存在，但内容不同'), { status: 409 })
    }
    if (inserted) this.kick(signal.id)
    return this.get(signal.id)!
  }

  get(signalId: string): TaskSignalView | undefined {
    const row = this.runner.store.kernel.db.prepare('SELECT * FROM dsh_task_signals WHERE signal_id=?').get(signalId) as SignalRow | undefined
    return row ? this.view(row) : undefined
  }

  list(limit = 50): TaskSignalView[] {
    const size = Math.max(1, Math.min(200, Math.floor(limit)))
    return (this.runner.store.kernel.db.prepare('SELECT * FROM dsh_task_signals ORDER BY received_at DESC, signal_id DESC LIMIT ?').all(size) as SignalRow[]).map(row => this.view(row))
  }

  events(signalId: string): { id: number; kind: string; at: string; payload: Record<string, unknown> }[] {
    const rows = this.runner.store.kernel.db.prepare('SELECT id,kind,payload_json,created_at FROM dsh_task_signal_events WHERE signal_id=? ORDER BY id').all(signalId) as { id: number; kind: string; payload_json: string | null; created_at: number }[]
    return rows.map(row => ({ id: row.id, kind: row.kind, at: new Date(row.created_at * 1000).toISOString(), payload: parseJson(row.payload_json, {}) }))
  }

  async wait(signalId: string, timeoutMs = 300_000): Promise<TaskSignalView> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const row = this.get(signalId)
      if (!row) throw new Error('没有这个 Task Signal')
      if (['materialized', 'needs_triage', 'failed'].includes(row.status)) return row
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('等待 Task Intake 决策超时')
  }

  context(signal: TaskSignal, agents: IntakeAgent[]): TaskIntakeContext {
    const db = this.runner.store.kernel.db
    const direct = signal.incident?.id ? (db.prepare(`SELECT task_id FROM dsh_task_incident_links WHERE incident_id=? ORDER BY updated_at DESC`).all(signal.incident.id) as { task_id: string }[]).map(row => row.task_id) : []
    const targetMatches = new Set<string>()
    for (const target of signal.targets) for (const row of db.prepare(`SELECT task_id FROM dsh_task_targets WHERE target_kind=? AND target_id=?`).all(target.kind, target.id) as { task_id: string }[]) targetMatches.add(row.task_id)
    const goalMatches = signal.goal.key ? new Set((db.prepare(`SELECT DISTINCT task_id FROM dsh_task_signals WHERE goal_key=? AND task_id IS NOT NULL`).all(signal.goal.key) as { task_id: string }[]).map(row => row.task_id)) : new Set<string>()
    const candidates: IntakeTaskCandidate[] = []
    for (const task of this.runner.store.s.tasks.values()) {
      const batches = [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === task.id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      const active = batches.some(batch => !batch.settled)
      const latest = batches[0]
      const state: IntakeTaskCandidate['state'] = active ? 'active' : latest?.settled?.outcome === 'done' ? 'done' : latest?.settled ? 'failed' : 'idle'
      const incidentIds = (db.prepare('SELECT incident_id FROM dsh_task_incident_links WHERE task_id=? ORDER BY updated_at DESC').all(task.id) as { incident_id: string }[]).map(row => row.incident_id)
      const targets = (db.prepare('SELECT target_kind AS kind,target_id AS id,label FROM dsh_task_targets WHERE task_id=? ORDER BY updated_at DESC').all(task.id) as { kind: string; id: string; label: string | null }[]).map(row => ({ kind: row.kind, id: row.id, ...(row.label ? { label: row.label } : {}) }))
      const reasons: string[] = []
      let score = active ? 5 : 0
      if (direct.includes(task.id)) { score += 100; reasons.push('same incident lifecycle') }
      if (goalMatches.has(task.id)) { score += 40; reasons.push('same goal key') }
      if (targetMatches.has(task.id)) { score += 10; reasons.push('overlapping target; target is not identity') }
      if (score || candidates.length < 12) candidates.push({ id: task.id, title: task.title, objective: task.brief, state, graphMode: task.graphMode ?? 'static-chain', participantIds: task.participants.map(row => row.agentId), incidentIds, targets, score, reasons })
    }
    candidates.sort((a, b) => b.score - a.score || Number(a.state !== 'active') - Number(b.state !== 'active') || a.id.localeCompare(b.id))
    const usable = agents.filter(agent => agent.id !== 'task-intake')
    const recommendedTaskId = direct.find(id => this.runner.store.s.tasks.has(id))
    return {
      policy: [
        'Task identity is a durable goal/root-cause boundary; never use a node, IP, account, or other target as the Task identity.',
        'Reuse a Task for a later Turn only when it continues the same goal or incident lifecycle. A target overlap alone is weak evidence.',
        'Create a Task for an independent goal/root cause or when no semantically matching Task exists.',
        'Select only registered Agents and never expand their configured Tool, MCP, Skill, or permission boundaries.',
        'When evidence is insufficient, choose triage instead of silently merging unrelated work.',
      ],
      agents: usable,
      ...(signal.requiredExecutorTools?.length ? { requiredExecutorTools: signal.requiredExecutorTools } : {}),
      candidateTasks: candidates.slice(0, 20),
      ...(recommendedTaskId ? { recommendedTaskId } : {}),
    }
  }

  private view(row: SignalRow): TaskSignalView {
    const batch = row.batch_id ? this.runner.store.s.batches.get(row.batch_id) : undefined
    const cards = batch?.cardIds.map(id => this.runner.store.s.cards.get(id)) ?? []
    const blocked = cards.some(card => card?.status === 'blocked') && !cards.some(card => card?.status === 'running')
    const runState = !row.batch_id ? undefined : !batch ? 'missing' : !batch.settled ? (blocked ? 'blocked' : 'active') : batch.settled.outcome === 'done' ? 'done' : 'failed'
    return {
      signal: parseJson(row.signal_json, {} as TaskSignal), status: row.status,
      receivedAt: new Date(row.received_at * 1000).toISOString(), updatedAt: new Date(row.updated_at * 1000).toISOString(),
      ...(row.intake_session_id ? { intakeSessionId: row.intake_session_id } : {}),
      ...(row.decision_json ? { decision: parseJson(row.decision_json, {} as TaskIntakeDecision) } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.batch_id ? { batchId: row.batch_id } : {}),
      ...(row.error ? { error: row.error } : {}), ...(runState ? { runState } : {}),
    }
  }

  private kick(signalId: string): void {
    if (this.active.has(signalId)) return
    const work = this.decisionQueue.catch(() => undefined).then(() => this.process(signalId))
    this.decisionQueue = work.catch(() => undefined)
    void work.finally(() => this.active.delete(signalId)).catch(() => undefined)
    this.active.set(signalId, work)
    void work.catch(() => undefined)
  }

  private transition(signalId: string, from: TaskSignalStatus[], to: TaskSignalStatus, kind: string, payload?: Record<string, unknown>): boolean {
    const db = this.runner.store.kernel.db
    return this.runner.store.kernel.write(() => {
      const marks = from.map(() => '?').join(',')
      const result = db.prepare(`UPDATE dsh_task_signals SET status=?, updated_at=?, error=NULL WHERE signal_id=? AND status IN (${marks})`).run(to, this.now(), signalId, ...from)
      if (result.changes) db.prepare('INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,?,?,?)').run(signalId, kind, payload ? JSON.stringify(payload) : null, this.now())
      return result.changes === 1
    })
  }

  private fail(signalId: string, error: unknown): void {
    const message = oneLine(error instanceof Error ? error.message : error, 2_000) || 'Task Intake failed'
    const db = this.runner.store.kernel.db
    this.runner.store.kernel.write(() => {
      db.prepare(`UPDATE dsh_task_signals SET status='failed',error=?,updated_at=? WHERE signal_id=? AND status NOT IN ('materialized','needs_triage')`).run(message, this.now(), signalId)
      db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'failed',?,?)`).run(signalId, JSON.stringify({ error: message }), this.now())
    })
  }

  private async process(signalId: string): Promise<void> {
    if (!this.transition(signalId, ['received'], 'deciding', 'decision_started')) return
    try {
      const row = this.get(signalId)
      if (!row) throw new Error('Task Signal disappeared')
      const agents = await this.options.agents()
      const context = this.context(row.signal, agents)
      const routed = await this.options.decide(row.signal, context)
      const decision = validateTaskIntakeDecision(routed.decision, context)
      const db = this.runner.store.kernel.db
      this.runner.store.kernel.write(() => {
        db.prepare(`UPDATE dsh_task_signals SET intake_session_id=?,decision_json=?,updated_at=? WHERE signal_id=? AND status='deciding'`).run(routed.sessionId, JSON.stringify(decision), this.now(), signalId)
        db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'decision_recorded',?,?)`).run(signalId, JSON.stringify({ session_id: routed.sessionId, decision }), this.now())
      })
      if (decision.action === 'triage') {
        this.transition(signalId, ['deciding'], 'needs_triage', 'triage_required', { reason: decision.reason, confidence: decision.confidence })
        return
      }
      if (!this.transition(signalId, ['deciding'], 'materializing', 'materialization_started', { action: decision.action })) throw new Error('Task Signal 状态已改变')
      await this.materialize(row.signal, decision, routed.sessionId)
    } catch (error) { this.fail(signalId, error) }
  }

  private async materialize(signal: TaskSignal, decision: TaskIntakeDecision, sessionId: string): Promise<void> {
    const participants = decision.participants!.map(row => ({ agentId: row.agentId, ...(row.brief ? { brief: row.brief } : {}) }))
    const graphMode = decision.workflow ?? 'dynamic-rounds'
    const taskId = decision.action === 'reuse' ? decision.taskId! : `T-intake-${hash(signal.id)}`
    const existing = this.runner.store.s.tasks.get(taskId)
    if (decision.action === 'reuse') {
      if (!existing) throw new Error('要复用的 Task 已不存在')
      if ((existing.graphMode ?? 'static-chain') !== graphMode) throw new Error('复用 Turn 的 workflow 必须与已有 Task 一致')
    } else if (!existing) {
      const at = new Date(this.now() * 1000).toISOString()
      const origin: TaskOrigin = { source: signal.source, signalId: signal.id, ...(signal.incident ? { incidentId: signal.incident.id } : {}), intakeSessionId: sessionId, decision: 'create', reason: decision.reason }
      const task: TaskSpec = {
        id: taskId, title: decision.title || signal.goal.title, brief: decision.objective || signal.goal.objective,
        trigger: { kind: 'once' }, participants, graphMode, cwd: this.workspace(),
        timeoutSec: Math.min(Math.max(this.options.timeoutSec ?? (Number(process.env.DSH_TASK_INTAKE_TIMEOUT_SEC) || 1_800), 60), 21_600),
        onFail: 'retry', maxTries: 2, enabled: true, createdAt: at, origin,
      }
      await mkdir(task.cwd, { recursive: true, mode: 0o700 })
      await this.runner.store.append({ t: 'task/created', at, taskId, task })
    }
    const task = this.runner.store.s.tasks.get(taskId)
    if (!task) throw new Error('Task materialization failed')
    await mkdir(this.workspace(), { recursive: true, mode: 0o700 })
    const origin: TaskOrigin = { source: signal.source, signalId: signal.id, ...(signal.incident ? { incidentId: signal.incident.id } : {}), intakeSessionId: sessionId, decision: decision.action, reason: decision.reason }
    const turn: TaskTurn = {
      objective: decision.objective || signal.goal.objective, participants,
      targets: signal.targets, origin,
    }
    const batchId = `b-intake-${hash(signal.id)}`
    const batch = await this.runner.fire(taskId, 'manual', { batchId, turn })
    const db = this.runner.store.kernel.db
    this.runner.store.kernel.write(() => {
      const now = this.now()
      if (signal.incident) db.prepare(`INSERT INTO dsh_task_incident_links(incident_id,task_id,first_signal_id,last_signal_id,incident_state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(incident_id,task_id) DO UPDATE SET last_signal_id=excluded.last_signal_id,incident_state=excluded.incident_state,updated_at=excluded.updated_at`)
        .run(signal.incident.id, taskId, signal.id, signal.id, signal.incident.state, now, now)
      for (const target of signal.targets) db.prepare(`INSERT INTO dsh_task_targets(task_id,target_kind,target_id,label,first_signal_id,last_signal_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id,target_kind,target_id) DO UPDATE SET label=COALESCE(excluded.label,dsh_task_targets.label),last_signal_id=excluded.last_signal_id,updated_at=excluded.updated_at`)
        .run(taskId, target.kind, target.id, target.label ?? null, signal.id, signal.id, now, now)
      const updated = db.prepare(`UPDATE dsh_task_signals SET status='materialized',task_id=?,batch_id=?,updated_at=?,error=NULL WHERE signal_id=? AND status='materializing'`).run(taskId, batch.id, now, signal.id)
      if (updated.changes !== 1) throw new Error('Task Signal materialization lost its claim')
      db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'materialized',?,?)`).run(signal.id, JSON.stringify({ task_id: taskId, batch_id: batch.id, action: decision.action }), now)
    })
  }
}
