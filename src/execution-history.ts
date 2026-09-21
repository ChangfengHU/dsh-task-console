import type { EventStore } from './tasks.ts'
import { batchStatus } from './fold.ts'

export interface ExecutionQuery {
  taskId?: string
  page?: number
  query?: string
  status?: 'all' | 'active' | 'done' | 'failed' | 'cancelled'
  includeArchived?: boolean
}

export interface ExecutionPage {
  page: number; pages: number; total: number; pageSize: number
  tasks: { id: string; title: string }[]
  rows: { id: string; taskId: string; title: string; firedAt: string; endedAt?: string; by: string;
    status: string; archivedAt?: string; roles: number; sessions: number }[]
}

/** Page IDs in SQLite; never load session logs, prompts or operation payloads. */
export function executionHistory(store: EventStore, input: ExecutionQuery = {}): ExecutionPage {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('执行记录查询条件无效')
  const { taskId, includeArchived = false, status = 'all', query = '' } = input
  if (typeof includeArchived !== 'boolean' || typeof query !== 'string' || query.length > 200
    || !['all', 'active', 'done', 'failed', 'cancelled'].includes(status)) throw new Error('执行记录查询条件无效')
  if (taskId !== undefined && (typeof taskId !== 'string' || !store.tasks.has(taskId))) throw new Error('没有这个任务')
  const where = ['1=1'], params: (string | number)[] = []
  if (taskId) { where.push('b.spec_id=?'); params.push(taskId) }
  else where.push("json_extract(s.spec_json,'$.archivedAt') IS NULL")
  if (!includeArchived) where.push('b.archived_at IS NULL')
  if (status === 'active') where.push('b.settled_at IS NULL')
  else if (status !== 'all') { where.push('b.outcome=?'); params.push(status) }
  if (query.trim()) {
    where.push("(instr(lower(b.id),?)>0 OR instr(lower(b.spec_id),?)>0 OR instr(lower(json_extract(s.spec_json,'$.title')),?)>0)")
    const term = query.trim().toLowerCase()
    params.push(term.replace(/^#(?=.)/, ''), term, term)
  }
  const from = `FROM dsh_batches b JOIN dsh_task_specs s ON s.id=b.spec_id WHERE ${where.join(' AND ')}`
  const db = store.kernel.db, pageSize = 10
  const total = (db.prepare(`SELECT COUNT(*) n ${from}`).get(...params) as { n: number }).n
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pages, Math.max(1, Math.floor(Number(input.page) || 1)))
  const ids = db.prepare(`SELECT b.id ${from} ORDER BY b.fired_at DESC,b.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as { id: string }[]
  const rows = ids.map(({ id }) => {
    const batch = store.s.batches.get(id)!, task = store.tasks.get(batch.taskId)!
    const cards = batch.cardIds.map(id => store.s.cards.get(id)!).filter(Boolean)
    const state = batchStatus(store.s, batch)
    const status = batch.settled?.outcome ?? (cards.some(c => c.wakeAt) ? 'waiting' : ({ run: 'running', park: 'blocked', review: 'review', done: 'done', bad: 'failed' }[state]))
    return { id, taskId: task.id, title: task.title, firedAt: batch.firedAt, by: batch.by, status,
      ...(batch.settled ? { endedAt: batch.settled.at } : {}), ...(batch.archivedAt ? { archivedAt: batch.archivedAt } : {}),
      roles: cards.filter(c => c.kind !== 'gate').length,
      sessions: new Set(cards.flatMap(c => c.runIds.map(id => store.s.runs.get(id)?.sessionId).filter(Boolean))).size }
  })
  return { page, pages, total, pageSize, rows, tasks: [...store.tasks.values()].filter(t => !t.archivedAt || t.id === taskId).map(({ id, title }) => ({ id, title })) }
}
