import { batchStatus, type State } from './fold.ts'
import { taskAgentIds } from './task-design.ts'
import type { AgentHistoryPage, AgentHistoryQuery, AgentSessionRow, AgentTaskRow } from './wire.ts'

/** Metadata only: no transcript or tool-result reads in listing paths. */
export interface AgentSessionHeader { id: string; createdAt: number; agentPreset?: string }

export function historyQuery(raw: unknown): Required<AgentHistoryQuery> {
  const q = raw as AgentHistoryQuery
  if (!q || typeof q.agentId !== 'string' || !q.agentId.trim() || !['sessions', 'tasks'].includes(q.kind)) throw new Error('非法 Agent 历史查询')
  const page = q.page ?? 1, pageSize = q.pageSize ?? 10
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error('分页参数应为正整数，每页最多 50 条')
  return { agentId: q.agentId, kind: q.kind, page, pageSize }
}

export function firstAgentUse(headers: AgentSessionHeader[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const h of headers) if (h.agentPreset && Number.isFinite(h.createdAt)) {
    const at = new Date(h.createdAt).toISOString()
    if (!result.has(h.agentPreset) || at < result.get(h.agentPreset)!) result.set(h.agentPreset, at)
  }
  return result
}

/** Join actual preset ownership, task origins, dynamic cards and historical runs. */
export function agentHistory(st: State, headers: AgentSessionHeader[], query: Required<AgentHistoryQuery>): AgentHistoryPage {
  const { agentId, kind, pageSize } = query
  const bySession = new Map(headers.map(h => [h.id, h]))
  const owned = new Set(headers.filter(h => h.agentPreset === agentId).map(h => h.id))
  const sessions = new Map<string, AgentSessionRow>()
  const tasks = new Map<string, AgentTaskRow>()
  const relevant = new Map<string, Set<string>>()
  for (const id of owned) {
    const h = bySession.get(id)!
    sessions.set(id, { id, title: '', createdAt: new Date(h.createdAt).toISOString(), status: 'idle', kind: 'direct', available: true, tasks: [] })
  }
  const addTask = (taskId: string, relation: 'creator' | 'participant', batchId?: string) => {
    const task = st.tasks.get(taskId)
    if (!task) return
    let row = tasks.get(taskId)
    if (!row) { row = { id: taskId, title: task.title, createdAt: task.createdAt, latestAt: task.createdAt, status: 'pending', relations: [], executions: 0 }; tasks.set(taskId, row) }
    if (!row.relations.includes(relation)) row.relations.push(relation)
    if (batchId && st.batches.has(batchId)) {
      const ids = relevant.get(taskId) ?? new Set<string>()
      ids.add(batchId); relevant.set(taskId, ids)
      const batch = st.batches.get(batchId)!
      if (!row.batchId || batch.firedAt > row.latestAt || (batch.firedAt === row.latestAt && batchId > row.batchId)) {
        row.batchId = batchId; row.latestAt = batch.firedAt; row.status = batch.settled?.outcome ?? batchStatus(st, batch)
      }
      row.executions = ids.size
    }
  }
  const origin = (taskId: string, sessionId?: string, batchId?: string) => {
    if (!sessionId || !owned.has(sessionId)) return
    addTask(taskId, 'creator', batchId)
    const task = st.tasks.get(taskId)
    const session = sessions.get(sessionId)
    if (task && session) {
      if (batchId) session.tasks = session.tasks.filter(t => t.id !== taskId || t.batchId)
      if (!session.tasks.some(t => t.id === taskId && (!batchId || t.batchId === batchId))) session.tasks.push({ id: taskId, title: task.title, batchId })
    }
  }
  for (const task of st.tasks.values()) {
    if (taskAgentIds(task).includes(agentId)) addTask(task.id, 'participant')
    origin(task.id, task.origin?.intakeSessionId)
  }
  for (const batch of st.batches.values()) {
    // A later turn replaces the template team; never borrow the old participants.
    const participants = batch.turn?.participants ?? st.tasks.get(batch.taskId)?.participants ?? []
    const design = batch.turn?.workflow?.definition.design ?? st.tasks.get(batch.taskId)?.design
    if (taskAgentIds({participants,design}).includes(agentId)) addTask(batch.taskId, 'participant', batch.id)
    origin(batch.taskId, batch.turn?.origin?.intakeSessionId, batch.id)
  }
  for (const card of st.cards.values()) if (card.agentId === agentId && card.kind !== 'gate') addTask(card.taskId, 'participant', card.batchId)
  for (const run of st.runs.values()) {
    // Run.profileId is the executor, which may be the card owner's reviewer.
    const owner = run.profileId ?? bySession.get(run.sessionId)?.agentPreset ?? st.cards.get(run.cardId)?.agentId
    if (owner !== agentId) continue
    addTask(run.taskId, 'participant', run.batchId)
    if (!run.sessionId) continue
    let row = sessions.get(run.sessionId)
    if (!row) { row = { id: run.sessionId, title: '', createdAt: run.sessionCreatedAt ?? run.startedAt, status: run.status, kind: 'task', available: bySession.has(run.sessionId), tasks: [] }; sessions.set(row.id, row) }
    row.kind = 'task'; row.status = run.status
    const task = st.tasks.get(run.taskId)
    if (task && !row.tasks.some(t => t.id === task.id && t.batchId === run.batchId)) row.tasks.push({ id: task.id, title: task.title, batchId: run.batchId })
  }
  const ss = [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const ts = [...tasks.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt) || b.id.localeCompare(a.id))
  const total = kind === 'sessions' ? ss.length : ts.length
  const pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(query.page, pages), offset = (page - 1) * pageSize
  return { kind, sessions: kind === 'sessions' ? ss.slice(offset, offset + pageSize) : [], tasks: kind === 'tasks' ? ts.slice(offset, offset + pageSize) : [], counts: { sessions: ss.length, tasks: ts.length }, total, pages, page, pageSize }
}
