import { useEffect, useMemo, useRef, useState } from 'react'
import { graphEventLabel, replayGraph, type GraphFrame, type GraphSnapshot, type GraphTaskRow } from '../graph-data.ts'
import type { AgentRow, Batch, TaskSpec } from '../wire.ts'
import { go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'

const epoch = (value?: number | null) => value ? new Date(value * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
const STATUS: Record<string, string> = { todo: '等依赖', ready: '就绪', running: '运行中', blocked: '阻塞', review: '待验收', done: '完成', archived: '归档', triage: '需处理' }
const ROLE: Record<string, { label: string; icon: string }> = {
  planner: { label: '规划者', icon: '🦊' }, executor: { label: '执行者', icon: '🐻' }, reviewer: { label: '评估者', icon: '🦉' }, gate: { label: '闸门', icon: '◇' },
}

function DbDag({ frame, selected, onSelect, nameOf }: { frame: GraphFrame; selected: string | null; onSelect: (id: string) => void; nameOf: (id: string | null) => string }) {
  const byId = new Map(frame.tasks.map(task => [task.id, task]))
  const indegree = new Map(frame.tasks.map(task => [task.id, 0]))
  const children = new Map(frame.tasks.map(task => [task.id, [] as string[]]))
  for (const link of frame.links) if (byId.has(link.parent_id) && byId.has(link.child_id)) { indegree.set(link.child_id, (indegree.get(link.child_id) ?? 0) + 1); children.get(link.parent_id)!.push(link.child_id) }
  const sortIds = (ids: string[]) => ids.sort((a, b) => (byId.get(a)?.created_at ?? 0) - (byId.get(b)?.created_at ?? 0) || a.localeCompare(b))
  const queue = sortIds(frame.tasks.filter(task => !indegree.get(task.id)).map(task => task.id))
  const ordered: GraphTaskRow[] = []
  while (queue.length) {
    const id = queue.shift()!; ordered.push(byId.get(id)!)
    for (const child of sortIds([...(children.get(id) ?? [])])) { const next = (indegree.get(child) ?? 1) - 1; indegree.set(child, next); if (!next) { queue.push(child); sortIds(queue) } }
  }
  for (const task of frame.tasks) if (!ordered.includes(task)) ordered.push(task)
  const width = Math.max(760, ordered.length * 226 + 48)
  const height = 250
  const positions = new Map(ordered.map((task, index) => [task.id, { x: 28 + index * 226, y: task.node_kind === 'gate' ? 91 : 75 }]))
  return <div className="dtc-dbdag-scroll"><div className="dtc-dbdag" style={{ width, height }}>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`${frame.links.length} 条数据库依赖`}>
      <defs><marker id="db-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" /></marker></defs>
      {frame.links.map(link => { const a = positions.get(link.parent_id); const b = positions.get(link.child_id); if (!a || !b) return null; const aw = byId.get(link.parent_id)?.node_kind === 'gate' ? 142 : 178; const ay = a.y + 48; const by = b.y + 48; return <g key={`${link.parent_id}>${link.child_id}`}><path className="dtc-dbdag-edge" d={`M${a.x + aw} ${ay} C${a.x + aw + 21} ${ay},${b.x - 21} ${by},${b.x} ${by}`} markerEnd="url(#db-arrow)" /><text x={(a.x + aw + b.x) / 2} y={Math.min(ay, by) - 9}>depends</text></g> })}
    </svg>
    {ordered.map(task => { const pos = positions.get(task.id)!; const role = ROLE[task.role ?? task.node_kind] ?? { label: task.role ?? '角色', icon: '●' }; const runs = frame.runs.filter(run => run.task_id === task.id); return <button key={task.id} className={`dtc-dbnode k-${task.node_kind} s-${task.status} ${selected === task.id ? 'selected' : ''}`} style={{ left: pos.x, top: pos.y }} onClick={() => onSelect(task.id)}>
      <i>{role.icon}</i><span><b>{role.label}{task.round ? ` ${task.round}` : ''}</b><small>{task.node_kind === 'gate' ? 'System task · no Agent Run' : nameOf(task.assignee)}</small><em>{runs.length} Run · row #{task.id.split('#').at(-1)}</em></span><strong>{STATUS[task.status] ?? task.status}</strong>
    </button> })}
  </div></div>
}

export function DynamicTaskReplay({ api, agents, task, batches, batchId, toast }: { api: TasksApi; agents: AgentRow[]; task: TaskSpec; batches: Batch[]; batchId: string; toast: (text: string) => void }) {
  const [data, setData] = useState<GraphSnapshot | null>(null)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    let stop = false
    const load = () => api.taskGraph(task.id, batchId).then(next => { if (!stop) { setData(next); setError(''); setSelected(cur => cur && next.live.tasks.some(row => row.id === cur) ? cur : next.live.tasks.find(row => ['running', 'blocked', 'ready'].includes(row.status))?.id ?? next.live.tasks.at(-1)?.id ?? null) } }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    void load(); const poll = window.setInterval(load, 2500)
    return () => { stop = true; window.clearInterval(poll) }
  }, [api, task.id, batchId])
  const events = data?.events ?? []
  const step = cursor === null ? events.length : Math.min(cursor, events.length)
  const frame = useMemo(() => !data ? { tasks: [], links: [], runs: [] } : cursor === null ? data.live : replayGraph(data.events, step), [data, cursor, step])
  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!playing) return
    if (step >= events.length) { setPlaying(false); setCursor(null); return }
    timer.current = window.setTimeout(() => setCursor(step + 1), Math.round(900 / speed))
    return () => window.clearTimeout(timer.current)
  }, [playing, step, events.length, speed])
  const nameOf = (id: string | null) => id ? agents.find(agent => agent.id === id)?.name ?? id : '系统'
  if (!data) return <div className="dtc-empty">{error || <><span className="dtc-spin" /> 读取 SQLite 图数据…</>}</div>
  const node = frame.tasks.find(row => row.id === selected) ?? frame.tasks.at(-1)
  const parents = node ? frame.links.filter(link => link.child_id === node.id).map(link => frame.tasks.find(row => row.id === link.parent_id)).filter(Boolean) as GraphTaskRow[] : []
  const children = node ? frame.links.filter(link => link.parent_id === node.id).map(link => frame.tasks.find(row => row.id === link.child_id)).filter(Boolean) as GraphTaskRow[] : []
  const runs = node ? frame.runs.filter(run => run.task_id === node.id) : []
  const current = step ? events[step - 1] : undefined
  const done = frame.tasks.filter(row => row.status === 'done').length
  const rounds = frame.tasks.filter(row => row.node_kind === 'gate').length
  const seek = (next: number) => { setPlaying(false); setCursor(Math.max(0, Math.min(next, events.length))) }
  return <div className="dtc-cartoon dtc-dbtruth">
    <header className="dtc-cartoon-head"><button className="dtc-cartoon-back" onClick={() => go('tasks')}>←</button><div className="dtc-cartoon-logo">🗃️</div><div className="dtc-cartoon-title"><span>DATABASE TRUTH REPLAY</span><h1>{task.title}</h1><small>{batchId} · tasks / task_links / task_runs / task_events</small></div><div className="dtc-cartoon-live"><i />{cursor === null ? 'SQLite 实时态' : `历史事件 #${step}`}</div><div className="dtc-cartoon-actions">{batches.length > 1 ? <select value={batchId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)}>{batches.map(batch => <option key={batch.id} value={batch.id}>{batch.id}</option>)}</select> : null}<button className="dtc-btn pri" onClick={async () => { const next = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${next.runId}`) }}>▶ 再跑一次</button>{!data.batch.outcome ? <button className="dtc-btn" onClick={async () => { await api.cancelRun(batchId); toast('已取消运行') }}>取消</button> : null}<button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); go('tasks') }}>删除</button></div></header>
    {error ? <div className="dtc-err">{error}</div> : null}
    <section className="dtc-cartoon-summary dtc-dag-summary"><div><span>真实 Tasks</span><strong>{frame.tasks.length}</strong><em>{done} 完成 · {frame.tasks.length - done} 未完成</em></div><div><span>真实 Links</span><strong>{frame.links.length}</strong><em>只计 task_links 行</em></div><div><span>真实 Runs</span><strong>{frame.runs.length}</strong><em>Gate 永远是 0 Run</em></div><div><span>执行回合</span><strong>{rounds}</strong><em>每个真实 Gate 对应一轮</em></div></section>
    <section className="dtc-dag-cockpit"><main className="dtc-cpanel dtc-dag-panel"><div className="dtc-cpanel-head"><div><b>数据库有向无环图</b><small>节点=tasks 行；箭头=task_links 行；页面不补角色、不补边</small></div><code>{frame.tasks.length}N / {frame.links.length}E</code></div>{frame.tasks.length ? <DbDag frame={frame} selected={node?.id ?? null} onSelect={setSelected} nameOf={nameOf} /> : <div className="dtc-empty">事件 #0：数据库还没有 Task 行。</div>}
      <div className={`dtc-replaybar ${playing ? 'playing' : ''}`}><div className="dtc-replay-now"><span>{cursor === null ? '实时数据库' : playing ? '自动回放中' : '历史快照'}</span><b>{String(step).padStart(2, '0')} / {String(events.length).padStart(2, '0')}</b><small>{current ? `${epoch(current.created_at)} · ${graphEventLabel(current)}` : '尚未发生事件'}</small></div><div className="dtc-replay-actions"><button onClick={() => seek(0)} disabled={!step}>从头</button><button onClick={() => seek(step - 1)} disabled={!step}>←</button><button className="play" onClick={() => { if (step >= events.length) setCursor(0); setPlaying(value => !value) }}>{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button><button onClick={() => seek(step + 1)} disabled={step >= events.length}>→</button></div><label className="dtc-replay-range"><span>task_events.id</span><input type="range" min="0" max={events.length} value={step} onChange={e => seek(Number(e.target.value))} /><output>{step}</output></label><div className="dtc-replay-tail"><label>速度<select value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option></select></label><button className="live" disabled={cursor === null} onClick={() => { setPlaying(false); setCursor(null) }}>● 回到实时</button></div></div>
    </main><aside className="dtc-cpanel dtc-dag-inspector"><div className="dtc-cpanel-head"><div><b>数据库行检查器</b><small>当前回放时刻可见的真实证据</small></div>{node ? <span>{node.node_kind.toUpperCase()}</span> : null}</div>{node ? <div className="dtc-dbinspect"><h2>{(ROLE[node.role ?? node.node_kind] ?? ROLE.executor).icon} {(ROLE[node.role ?? node.node_kind] ?? ROLE.executor).label} {node.round}</h2><p className="dtc-mono">{node.id}</p><dl><dt>tasks.status</dt><dd>{node.status}</dd><dt>assignee</dt><dd>{nameOf(node.assignee)}</dd><dt>created_at</dt><dd>{epoch(node.created_at)}</dd><dt>completed_at</dt><dd>{epoch(node.completed_at)}</dd><dt>父依赖</dt><dd>{parents.map(row => `${row.role}${row.round}`).join('、') || '无'}</dd><dt>子节点</dt><dd>{children.map(row => `${row.role}${row.round}`).join('、') || '尚未写入'}</dd></dl><h3>task_runs ({runs.length})</h3>{runs.length ? runs.map(run => <button key={run.id} className="dtc-dbrun" onClick={() => run.session_id && api.openSession(run.session_id)}><b>Run #{run.id} · {run.status}</b><small>{nameOf(run.profile)} · {epoch(run.started_at)}{run.session_id ? ' · 打开会话 ↗' : ''}</small>{run.summary ? <p>{run.summary}</p> : null}</button>) : <div className="dtc-clegend">Gate 和尚未领取的 Task 没有 Run 行。</div>}</div> : <div className="dtc-empty">这个时刻没有节点。</div>}</aside></section>
    <details className="dtc-cpanel dtc-timeline" open><summary><span><b>Canonical task_events</b><small>点击任一事件，把同一个渲染器还原到该事务之后</small></span><em>{events.length} ROWS</em></summary><div className="dtc-activity-list">{[...events].reverse().map((event, index) => { const eventStep = events.length - index; return <button key={event.id} className={`dtc-activity-row ${eventStep > step ? 'off' : ''} ${eventStep === step ? 'cur' : ''}`} onClick={() => seek(eventStep)}><span className="dot" /><span className="copy"><b>{graphEventLabel(event)}</b><span>{event.kind}</span><small>{epoch(event.created_at)} · task_events.id={event.id}</small></span><span className="dtc-pill dtc-p-grey">DB</span></button> })}</div></details>
  </div>
}
