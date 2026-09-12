import { useEffect, useState } from 'react'
import type { AgentHistoryPage } from '../wire.ts'
import { executionCode, executionTime } from '../execution-label.ts'
import { go, readRouteQuery, type Api } from './Console.tsx'

export type AgentTab = 'config' | 'actions' | 'sessions' | 'tasks'
export function agentTab(): AgentTab {
  const tab = readRouteQuery().get('tab')
  return tab === 'actions' || tab === 'sessions' || tab === 'tasks' ? tab : 'config'
}
export function agentPage(): number {
  const page = Number(readRouteQuery().get('page') ?? 1)
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

const STATUS: Record<string, string> = { idle: '空闲', pending: '待执行', running: '运行中', run: '执行中', blocked: '等待处理', park: '等待处理', review: '待评估', done: '已完成', failed: '失败', bad: '异常结束', crashed: '中断', cancelled: '已取消', timed_out: '超时' }
const taskPath = (row: { id: string; batchId?: string }) => `tasks/${encodeURIComponent(row.id)}${row.batchId ? `/runs/${encodeURIComponent(row.batchId)}` : ''}`

export function AgentHistory({ api, id, tab, page, onCounts }: { api: Api; id: string; tab: AgentTab; page: number; onCounts: (counts: AgentHistoryPage['counts']) => void }) {
  const [data, setData] = useState<AgentHistoryPage | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [opening, setOpening] = useState('')
  const summaryOnly = tab === 'config' || tab === 'actions'
  useEffect(() => {
    let stop = false
    setData(null); setError('')
    api.agentHistory({ agentId: id, kind: tab === 'tasks' ? 'tasks' : 'sessions', page: summaryOnly ? 1 : page, pageSize: summaryOnly ? 1 : 10 })
      .then(result => { if (!stop) { setData(result); onCounts(result.counts) } })
      .catch(e => { if (!stop) setError(String(e.message ?? e)) })
    return () => { stop = true }
  }, [api, id, tab, page, refresh, onCounts])
  if (summaryOnly) return error ? <div className="dtc-err" role="alert">关联记录读取失败：{error} <button className="dtc-btn sm" onClick={() => setRefresh(n => n + 1)}>重试</button></div> : null
  const navigate = (p: number) => go(`agents/${encodeURIComponent(id)}?tab=${tab}&page=${p}`)
  const open = async (sessionId: string) => {
    setOpening(sessionId); setError('')
    try { await api.openSession(sessionId) } catch (e) { setError(String((e as Error).message ?? e)) } finally { setOpening('') }
  }
  return <section className="dtc-agent-history" aria-label={tab === 'sessions' ? 'Agent 会话列表' : 'Agent 任务列表'}>
    <div className="dtc-history-tools"><span className="dtc-muted">{tab === 'sessions' ? '此 Agent 的直接会话及实际执行会话' : '创建 / 编排和参与的任务合并展示，同一任务不重复'} · 北京时间</span><button className="dtc-btn sm" onClick={() => setRefresh(n => n + 1)}>刷新</button></div>
    {error ? <div className="dtc-err" role="alert">{error} <button className="dtc-btn sm" onClick={() => setRefresh(n => n + 1)}>重试</button></div> : null}
    {!data && !error ? <div className="dtc-panel" role="status">正在读取{tab === 'sessions' ? '会话' : '任务'}…</div> : null}
    {data?.total === 0 ? <div className="dtc-panel dtc-muted">暂无关联{tab === 'sessions' ? '会话' : '任务'}。</div> : null}
    {data?.sessions.map(row => <article className="dtc-history-row" key={row.id} data-session-id={row.id}>
      <div className="dtc-history-main"><h3>{row.title}</h3><div className="dtc-history-meta"><span>{row.kind === 'task' ? '任务执行会话' : '直接会话'}</span><time>{executionTime(row.createdAt)}</time><span>{STATUS[row.status] ?? row.status}</span>{!row.available ? <span>会话文件已不存在</span> : null}</div>
        <div className="dtc-history-id" title={row.id}>{row.id}</div>
        {row.tasks.length ? <div className="dtc-history-links">{row.tasks.map(t => <a key={`${t.id}/${t.batchId ?? ''}`} href={`#/tc/${taskPath(t)}`}>{t.title}{t.batchId ? ` · ${executionCode(t.batchId)}` : ''} ↗</a>)}</div> : null}
      </div><button className="dtc-btn sm" disabled={!row.available || !!opening} onClick={() => void open(row.id)}>{opening === row.id ? '打开中…' : '打开会话 ↗'}</button>
    </article>)}
    {data?.tasks.map(row => <article className="dtc-history-row" key={row.id} data-task-id={row.id}>
      <div className="dtc-history-main"><h3><a href={`#/tc/${taskPath(row)}`}>{row.title}</a></h3><div className="dtc-history-meta">{row.relations.map(r => <span className="dtc-pill dtc-p-grey" key={r}>{r === 'creator' ? '创建 / 编排' : '参与执行'}</span>)}<span>{STATUS[row.status] ?? row.status}</span><span>关联执行 {row.executions} 次</span></div><div className="dtc-history-meta"><span>{row.batchId ? '最近关联执行' : '任务创建'} · {executionTime(row.latestAt)}</span>{row.batchId ? <span title={row.batchId}>{executionCode(row.batchId)}</span> : null}</div></div>
      <a className="dtc-btn sm" href={`#/tc/${taskPath(row)}`}>查看任务 ↗</a>
    </article>)}
    {data ? <div className="dtc-history-pager"><span>共 {data.total} 条 · 每页 {data.pageSize} 条</span><div><button className="dtc-btn sm" disabled={data.page <= 1} onClick={() => navigate(data.page - 1)}>上一页</button><span>{data.page} / {data.pages}</span><button className="dtc-btn sm" disabled={data.page >= data.pages} onClick={() => navigate(data.page + 1)}>下一页</button></div></div> : null}
  </section>
}
