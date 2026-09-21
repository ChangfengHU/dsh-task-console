import type { EventStore } from './tasks.ts'
import { batchStatus } from './fold.ts'

export type TaskListFilter = 'all' | 'active' | 'attention' | 'done' | 'schedule' | 'ended'
export interface TaskListQuery { page?: number; pageSize?: number; query?: string; filter?: TaskListFilter }
export function taskListIndex(store: EventStore, input: TaskListQuery = {}, names: Map<string, string> = new Map()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('无效列表查询')
  const filter = input.filter ?? 'all', query = input.query ?? ''
  if (!['all','active','attention','done','schedule','ended'].includes(filter) || typeof query !== 'string' || query.length > 200) throw Error('无效列表筛选')
  for (const n of [input.page, input.pageSize]) if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw Error('无效分页参数')
  const pageSize = Math.min(10, input.pageSize ?? 10)
  const latest = new Map<string, any>(), counts = new Map<string, number>()
  for (const b of store.s.batches.values()) {
    if (b.archivedAt) continue
    counts.set(b.taskId, (counts.get(b.taskId) ?? 0) + 1)
    const old = latest.get(b.taskId)
    if (!old || b.firedAt > old.firedAt || b.firedAt === old.firedAt && b.id > old.id) latest.set(b.taskId, b)
  }
  const order: Record<string, number> = { park:0, review:1, bad:2, run:3, schedule:4, idle:5, done:6 }
  const all = [...store.tasks.values()].filter(t => !t.archivedAt).map(task => {
    const batch = latest.get(task.id), state = batch ? batchStatus(store.s, batch) : task.trigger.kind === 'cron' ? 'schedule' : 'idle'
    return { task, batch, state, history: counts.get(task.id) ?? 0 }
  })
  const metrics = { total:all.length, active:all.filter(r=>r.state==='run').length, attention:all.filter(r=>['park','review','bad'].includes(r.state)).length,
    schedules:all.filter(r=>r.task.trigger.kind==='cron'&&r.task.enabled).length, ended:all.filter(r=>['done','bad'].includes(r.state)).length }
  const term = query.trim().toLowerCase()
  const rows = all.filter(r => (!term || `${r.task.title} ${r.task.brief} ${r.task.participants.map(p=>`${p.agentId} ${names.get(p.agentId)??''}`).join(' ')}`.toLowerCase().includes(term)) &&
    (filter==='all' || filter==='active'&&r.state==='run' || filter==='attention'&&['park','review','bad'].includes(r.state) || filter==='done'&&r.state==='done' || filter==='schedule'&&r.task.trigger.kind==='cron' || filter==='ended'&&['done','bad'].includes(r.state)))
    .sort((a,b)=>order[a.state]-order[b.state] || (b.batch?.firedAt??b.task.createdAt).localeCompare(a.batch?.firedAt??a.task.createdAt) || a.task.id.localeCompare(b.task.id))
  const total=rows.length, pages=Math.max(1,Math.ceil(total/pageSize)), page=Math.min(input.page??1,pages)
  return {page,pageSize,pages,total,metrics,rows:rows.slice((page-1)*pageSize,page*pageSize)}
}
