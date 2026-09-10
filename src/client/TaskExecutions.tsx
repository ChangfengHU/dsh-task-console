import { useEffect, useState } from 'react'
import type { ExecutionPage, ExecutionQuery } from '../execution-history.ts'
import { executionCode, executionTime } from '../execution-label.ts'
import { go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'

const STATUS: Record<string, string> = { done: '已完成', failed: '未通过', cancelled: '已取消', running: '执行中', blocked: '已阻塞', waiting: '等待复验', review: '待评审' }
const BY: Record<string, string> = { manual: '手动', cron: '定时', retry: '重试' }

export function TaskExecutions({ api, query }: { api: TasksApi; query: URLSearchParams }) {
  const [data, setData] = useState<ExecutionPage | null>(null), [error, setError] = useState('')
  const [tasks, setTasks] = useState<{ id: string; title: string }[]>([])
  const [search, setSearch] = useState(query.get('q') ?? ''), [refresh, setRefresh] = useState(0)
  const key = query.toString(), taskId = query.get('task') ?? '', status = query.get('status') ?? 'all'
  const change = (changes: Record<string, string>) => {
    const next = new URLSearchParams(key); next.delete('page')
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key)
    go(`tasks/executions${next.size ? `?${next}` : ''}`)
  }
  useEffect(() => { setSearch(query.get('q') ?? '') }, [key])
  useEffect(() => {
    let live = true; setData(null); setError('')
    api.executionHistory({ taskId: taskId || undefined, query: query.get('q') ?? '', page: Number(query.get('page') || 1), status: status as ExecutionQuery['status'], includeArchived: query.get('archived') === '1' })
      .then(data => { if (live) { setData(data); setTasks(data.tasks) } }).catch(e => { if (live) setError(String(e.message ?? e)) })
    return () => { live = false }
  }, [api, key, refresh])
  return <section className="dtc-executions">
    <header className="dtc-executions-heading"><div><button className="dtc-btn sm" onClick={() => go('tasks')}>← 任务列表</button><h1>执行记录</h1><p>每次执行独立留痕；时间均为北京时间（UTC+8）。</p></div><button className="dtc-btn sm" onClick={() => setRefresh(value => value + 1)}>刷新</button></header>
    <form className="dtc-executions-filters" onSubmit={event => { event.preventDefault(); change({ q: search.trim() }) }}>
      <select aria-label="筛选任务" value={taskId} onChange={event => change({ task: event.target.value })}><option value="">全部任务</option>{taskId && !tasks.some(t => t.id === taskId) ? <option value={taskId}>{taskId}</option> : null}{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
      <select aria-label="筛选执行状态" value={status} onChange={event => change({ status: event.target.value === 'all' ? '' : event.target.value })}><option value="all">全部状态</option><option value="active">未结束</option><option value="done">已完成</option><option value="failed">未通过</option><option value="cancelled">已取消</option></select>
      <input aria-label="搜索执行记录" placeholder="任务名称 / 执行编号" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /><button className="dtc-btn sm" type="submit">查询</button>
      <label><input type="checkbox" checked={query.get('archived') === '1'} onChange={event => change({ archived: event.target.checked ? '1' : '' })} />包含归档执行</label>
    </form>
    {error ? <div role="alert" className="dtc-err">{error}</div> : !data ? <div className="dtc-empty">读取执行记录…</div> : <>
      <div className="dtc-execution-table">{data.rows.map(row => <a className="dtc-execution-row" key={row.id} href={`#/tc/tasks/${row.taskId}/runs/${row.id}`}>
        <span className="dtc-execution-when"><b>{executionTime(row.firedAt)}</b><code title={row.id}>{executionCode(row.id)}</code></span>
        <span className="dtc-execution-task"><b>{row.title}</b><small>{BY[row.by] ?? row.by} · {row.roles} 个角色节点 · {row.sessions} 个执行会话{row.endedAt ? ` · 结束 ${executionTime(row.endedAt)}` : ''}</small></span>
        <span className={`dtc-pill ${row.status === 'done' ? 'dtc-p-ok' : row.status === 'failed' ? 'dtc-p-bad' : 'dtc-p-grey'}`}>{STATUS[row.status] ?? row.status}{row.archivedAt ? ' · 已归档' : ''}</span><span className="dtc-execution-open">查看执行 →</span>
      </a>)}</div>
      {!data.rows.length ? <div className="dtc-empty">当前条件下没有执行记录。</div> : null}
      <footer className="dtc-executions-pagination"><span>共 {data.total} 条 · 第 {data.page} / {data.pages} 页 · 每页 {data.pageSize} 条</span><div><button className="dtc-btn sm" disabled={data.page <= 1} onClick={() => change({ page: String(data.page - 1) })}>上一页</button><button className="dtc-btn sm" disabled={data.page >= data.pages} onClick={() => change({ page: String(data.page + 1) })}>下一页</button></div></footer>
    </>}
  </section>
}
