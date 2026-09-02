import { useEffect, useMemo, useState } from 'react'
import type { TaskSessionRow } from '../wire.ts'

export interface NativeSessionRow {
  id: string
  displayTitle: string
  agentPreset?: string
  cwd?: string
  running: boolean
  blank: boolean
  updatedAt: number
  archived: boolean
}

interface SessionsApi {
  taskSessions: () => Promise<TaskSessionRow[]>
  sessionSnapshot: () => NativeSessionRow[]
  subscribeSessions: (listener: () => void) => () => void
  refreshSessions: () => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  openSession: (sessionId: string) => Promise<void>
}

const PAGE_SIZE = 20

export function SessionsPage({ api, toast }: { api: SessionsApi; toast: (message: string) => void }) {
  const [native, setNative] = useState<NativeSessionRow[]>([])
  const [relations, setRelations] = useState<TaskSessionRow[]>([])
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'task' | 'all' | 'archived'>('task')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  const readNative = () => setNative(api.sessionSnapshot())
  const load = async () => {
    setLoading(true)
    try { await api.refreshSessions(); readNative(); setRelations(await api.taskSessions()) }
    catch (error) { toast(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load(); return api.subscribeSessions(readNative) }, [api])
  useEffect(() => { setPage(1) }, [query, scope])

  const relationBySession = useMemo(() => new Map(relations.map(row => [row.sessionId, row])), [relations])
  const rows = useMemo(() => native.filter(session => {
    const relation = relationBySession.get(session.id)
    if (scope === 'task' && !relation) return false
    if (scope === 'archived' && !session.archived) return false
    const text = `${session.displayTitle} ${session.id} ${session.agentPreset ?? ''} ${relation?.taskTitle ?? ''}`.toLowerCase()
    return !query.trim() || text.includes(query.trim().toLowerCase())
  }).sort((a, b) => b.updatedAt - a.updatedAt), [native, relationBySession, query, scope])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const visible = rows.slice((Math.min(page, pages) - 1) * PAGE_SIZE, Math.min(page, pages) * PAGE_SIZE)

  const archive = async (row: NativeSessionRow) => {
    if (row.running) { toast('运行中的会话不能归档'); return }
    try { await api.archiveSession(row.id); toast('会话已归档，日志仍然保留'); readNative() }
    catch (error) { toast(error instanceof Error ? error.message : String(error)) }
  }

  return <div className="dtc-body dtc-sessions">
    <section className="dtc-cpanel dtc-session-summary">
      <div><b>{native.length}</b><span>DSH 会话</span></div><div><b>{relations.length}</b><span>任务运行记录</span></div><div><b>{native.filter(row => row.archived).length}</b><span>已归档</span></div>
      <p>任务完成后自动归档其角色会话；归档只移出普通侧栏，不删除日志和任务证据。</p>
    </section>
    <section className="dtc-cpanel dtc-session-panel">
      <div className="dtc-session-tools"><div className="dtc-segment"><button className={scope === 'task' ? 'on' : ''} onClick={() => setScope('task')}>任务会话</button><button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全部</button><button className={scope === 'archived' ? 'on' : ''} onClick={() => setScope('archived')}>已归档</button></div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、任务、Agent 或 Session ID" /><button className="dtc-btn sm" onClick={() => void load()}>刷新</button></div>
      {loading ? <div className="dtc-empty"><span className="dtc-spin" /> 读取会话…</div> : visible.length ? <div className="dtc-session-list">{visible.map(row => { const relation = relationBySession.get(row.id); return <article key={row.id} className="dtc-session-row"><div className="dtc-session-main"><div><b>{row.displayTitle || row.id}</b>{row.running ? <span className="dtc-pill dtc-p-blue">运行中</span> : row.archived ? <span className="dtc-pill dtc-p-grey">已归档</span> : <span className="dtc-pill dtc-p-green">可用</span>}</div><code>{row.id}</code><small>{row.agentPreset || '默认 Agent'}{row.cwd ? ` · ${row.cwd}` : ''}</small></div><div className="dtc-session-link">{relation ? <><b>{relation.taskTitle}</b><span>{relation.role}{relation.round ? ` · Round ${relation.round}` : ''} · {relation.status}</span><button onClick={() => window.location.hash = `#/tc/tasks/${relation.taskId}/runs/${relation.batchId}?session=${encodeURIComponent(row.id)}`}>查看任务 ↗</button></> : <span>非任务会话</span>}</div><div className="dtc-session-actions"><button className="dtc-btn sm" onClick={() => void api.openSession(row.id)}>打开</button>{!row.archived ? <button className="dtc-btn sm" disabled={row.running} onClick={() => void archive(row)}>归档</button> : null}</div></article> })}</div> : <div className="dtc-empty">没有符合条件的会话。</div>}
      <div className="dtc-pagination"><span>共 {rows.length} 条 · 第 {Math.min(page, pages)} / {pages} 页</span><div><button className="dtc-btn sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><button className="dtc-btn sm" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</button></div></div>
    </section>
  </div>
}
