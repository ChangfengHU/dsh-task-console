/**
 * Tasks: the board, one task's detail with its runs and legs, and the
 * "new task" wizard. Everything here is a projection of the host's event
 * stream, polled while the console is open.
 */

import { useEffect, useMemo, useState } from 'react'
import { cronHuman, nextFire, parseCron } from '../cron.ts'
import type { AgentRow, ArtifactView, LegacyRun as Run, TaskEvent, TaskSnapshot, TaskSpec } from '../wire.ts'
import { closeConsole, go } from './Console.tsx'

export interface TasksApi {
  tasks: () => Promise<{ tasks: (TaskSpec & { nextFire: string | null })[]; runs: Run[] }>
  createTask: (spec: Partial<TaskSpec>) => Promise<{ id: string }>
  setTaskEnabled: (id: string, enabled: boolean) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  fireTask: (id: string, by?: 'manual' | 'retry') => Promise<{ runId: string }>
  cancelRun: (runId: string) => Promise<void>
  taskSnapshot: (id: string, batchId?: string) => Promise<TaskSnapshot>
  taskEvents: (id: string) => Promise<TaskEvent[]>
  taskArtifacts: (id: string, batchId?: string) => Promise<ArtifactView[]>
  artifactContent: (id: string, artifactId: string, batchId?: string) => Promise<{ artifact: ArtifactView; base64: string }>
  publishArtifact: (id: string, artifactId: string) => Promise<{ publicUrl: string }>
  reviewCard: (cardId: string, decision: 'approve' | 'changes', note?: string, targetCardId?: string) => Promise<void>
  unblockCard: (cardId: string) => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  sessionTurns: (sessionId: string) => Promise<import('../wire.ts').TurnLedger>
}

type TaskRow = TaskSpec & { nextFire: string | null }

const fmt = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 8) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const BY: Record<Run['by'], string> = { cron: '时间表', manual: '手动', retry: '重试' }
const ago = (iso: string) => { const s = Math.round((Date.now() - +new Date(iso)) / 1000); if (s < 60) return '刚刚'; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`; return `${Math.floor(s / 86400)} 天前` }
const LEG: Record<string, string> = { queued: '排队', running: '进行中', blocked: '停车等人', review: '待验收', done: '完成', failed: '失败', timed_out: '超时', lost: '丢失', cancelled: '取消' }

export function runStatus(r: Run): 'run' | 'park' | 'review' | 'done' | 'bad' {
  if (r.legs.some(l => l.status === 'blocked')) return 'park'
  if (r.legs.some(l => l.status === 'review')) return 'review'
  if (r.legs.some(l => l.status === 'running')) return 'run'
  if (r.settled?.outcome === 'done' || r.legs.every(l => l.status === 'done')) return 'done'
  if (r.settled || r.legs.some(l => ['failed', 'timed_out', 'lost', 'cancelled'].includes(l.status))) return 'bad'
  return 'run'
}

/** Poll the board while mounted; 2.5s is fast enough to feel live. */
export function useTasks(api: TasksApi): { tasks: TaskRow[]; runs: Run[]; reload: () => Promise<void>; error: string; loaded: boolean } {
  const [data, setData] = useState<{ tasks: TaskRow[]; runs: Run[] }>({ tasks: [], runs: [] })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const reload = async () => { try { setData(await api.tasks()); setError(''); setLoaded(true) } catch (e) { setError(String((e as Error).message ?? e)) } }
  useEffect(() => { void reload(); const t = window.setInterval(() => { void reload() }, 2500); return () => window.clearInterval(t) }, [api])
  return { ...data, reload, error, loaded }
}

const agentName = (agents: AgentRow[], id: string) => agents.find(a => a.id === id)?.name ?? id

// ── task home ────────────────────────────────────────────────────────────

type TaskFilter = 'all' | 'active' | 'attention' | 'done' | 'schedule'

function taskState(task: TaskRow, latest?: Run): ReturnType<typeof runStatus> | 'schedule' | 'idle' {
  if (latest) return runStatus(latest)
  return task.trigger.kind === 'cron' ? 'schedule' : 'idle'
}

const STATE_ORDER: Record<ReturnType<typeof taskState>, number> = { park: 0, review: 1, bad: 2, run: 3, schedule: 4, idle: 5, done: 6 }
const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'active', label: '进行中' }, { id: 'attention', label: '需要处理' }, { id: 'done', label: '已完成' }, { id: 'schedule', label: '时间表' },
]

export function TaskBoard({ api, agents, toast }: { api: TasksApi; agents: AgentRow[]; toast: (m: string) => void }) {
  const { tasks, runs, reload, error, loaded } = useTasks(api)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const history = new Map<string, Run[]>()
    for (const run of runs) history.set(run.taskId, [...(history.get(run.taskId) ?? []), run])
    return tasks.map(task => {
      const taskRuns = (history.get(task.id) ?? []).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      const latest = taskRuns[0]
      return { task, latest, history: taskRuns.length, state: taskState(task, latest) }
    }).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.latest?.firedAt ?? b.task.createdAt).localeCompare(a.latest?.firedAt ?? a.task.createdAt))
  }, [tasks, runs, agents])
  const visible = rows.filter(row => {
    const q = query.trim().toLowerCase()
    if (q && !`${row.task.title} ${row.task.brief} ${row.task.participants.map(p => agentName(agents, p.agentId)).join(' ')}`.toLowerCase().includes(q)) return false
    if (filter === 'active') return row.state === 'run'
    if (filter === 'attention') return row.state === 'park' || row.state === 'review' || row.state === 'bad'
    if (filter === 'done') return row.state === 'done'
    if (filter === 'schedule') return row.task.trigger.kind === 'cron'
    return true
  })
  const active = rows.filter(row => row.state === 'run').length
  const attention = rows.filter(row => row.state === 'park' || row.state === 'review' || row.state === 'bad').length
  const schedules = tasks.filter(task => task.trigger.kind === 'cron' && task.enabled).length
  return (
    <div className="dtc-taskhome">
      <section className="dtc-taskintro">
        <div>
          <div className="dtc-eyebrow">TASK ORCHESTRATION</div>
          <h1>任务中心</h1>
          <p>用预置 Agent 组成执行链，集中查看依赖、验收、交接和最终产物。</p>
        </div>
        <div className="dtc-storage"><span className="db">▤</span><div><b>本地 SQLite</b><span>任务数据保存在这台 DSH</span></div><i>已连接</i></div>
      </section>
      <section className="dtc-taskmetrics">
        <div><span>任务组</span><b>{tasks.length}</b><small>可重复运行的目标</small></div>
        <div><span>正在执行</span><b className="acc">{active}</b><small>当前活跃任务</small></div>
        <div><span>需要处理</span><b className={attention ? 'warn' : ''}>{attention}</b><small>等待回答、验收或重试</small></div>
        <div><span>已启用时间表</span><b>{schedules}</b><small>按计划自动触发</small></div>
      </section>
      <div className="dtc-tasktools">
        <div className="dtc-taskfilters">{FILTERS.map(item => <button key={item.id} className={filter === item.id ? 'on' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
        <label className="dtc-tasksearch"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务或 Agent" /></label>
      </div>
      {error ? <div className="dtc-err">{error}</div> : null}
      {!loaded ? <div className="dtc-empty"><span className="dtc-spin" /> 读取任务…</div> : visible.length ? <div className="dtc-taskgrid">{visible.map(row => <TaskGroupCard key={row.task.id} {...row} agents={agents} api={api} reload={reload} toast={toast} />)}</div> : <div className="dtc-taskempty"><span>▦</span><b>{query ? '没有匹配的任务' : '这个视图还没有任务'}</b><p>{query ? '换一个关键词试试。' : '新建任务后，角色、依赖和运行状态会显示在这里。'}</p>{!query ? <button className="dtc-btn pri" onClick={() => go('tasks/new')}>＋ 新建任务</button> : null}</div>}
    </div>
  )
}

function pipe(t: TaskSpec, agents: AgentRow[]) {
  return <span className="dtc-flow">{t.participants.map((p, i) => <span key={i}>{i ? <span className="ar">→</span> : null}<span className="dot" /><span className="nm">{agentName(agents, p.agentId)}</span></span>)}</span>
}
function flowOf(r: Run, agents: AgentRow[]) {
  return <span className="dtc-flow">{r.legs.map((l, i) => <span key={i}>{i ? <span className="ar">→</span> : null}<span className={`dot ${l.status}`} /><span className="nm">{agentName(agents, l.agentId)}</span></span>)}</span>
}

function TaskGroupCard({ task, latest, history, state, agents, api, reload, toast }: {
  task: TaskRow; latest?: Run; history: number; state: ReturnType<typeof taskState>; agents: AgentRow[]; api: TasksApi; reload: () => Promise<void>; toast: (m: string) => void
}) {
  const current = latest?.legs.find(leg => leg.status === 'running' || leg.status === 'blocked' || leg.status === 'review') ?? latest?.legs.at(-1)
  const done = latest?.legs.filter(leg => leg.status === 'done').length ?? 0
  const total = latest?.legs.length ?? task.participants.length
  const status = ({ run: ['进行中', 'dtc-p-acc'], park: ['等待回答', 'dtc-p-park'], review: ['待验收', 'dtc-p-warn'], done: ['已完成', 'dtc-p-ok'], bad: ['执行失败', 'dtc-p-bad'], schedule: [task.enabled ? '等待触发' : '已停用', 'dtc-p-grey'], idle: ['尚未运行', 'dtc-p-grey'] } as const)[state]
  const progress = total ? Math.round(done / total * 100) : 0
  const toggleSchedule = async () => { await api.setTaskEnabled(task.id, !task.enabled); toast(task.enabled ? '已停用时间表' : '已启用时间表'); await reload() }
  const retry = async () => { await api.fireTask(task.id, 'retry'); toast('已创建重试运行'); await reload() }
  return (
    <div className={`dtc-taskgroup s-${state}`} role="button" tabIndex={0} data-task-id={task.id} onClick={() => go(`tasks/${task.id}`)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) go(`tasks/${task.id}`) }}>
      <div className="dtc-taskgroup-head"><div className="mark">{task.title.trim().charAt(0) || '任'}</div><div className="copy"><h2>{task.title}</h2><span className="dtc-mono">{task.id}</span></div><span className={`dtc-pill ${status[1]}`}>{status[0]}</span></div>
      <p className="brief">{task.brief}</p>
      <div className="dtc-taskgroup-flow">{latest ? flowOf(latest, agents) : pipe(task, agents)}</div>
      {latest ? <div className="dtc-taskprogress"><div><span>最近一次进度</span><b>{done}/{total}</b></div><div className="track"><i style={{ width: `${progress}%` }} /></div></div> : null}
      {state === 'park' && current?.question ? <div className="dtc-tasknotice ask"><b>{agentName(agents, current.agentId)} 正在等你</b><span>{current.question}</span></div> : null}
      {state === 'review' && current ? <div className="dtc-tasknotice review"><b>{agentName(agents, current.agentId)} 已提交</b><span>验收通过后才会启动下游任务。</span></div> : null}
      {state === 'bad' && current ? <div className="dtc-tasknotice bad"><b>{agentName(agents, current.agentId)} 执行失败</b><span>{current.error || LEG[current.status] || current.status}</span></div> : null}
      <div className="dtc-taskgroup-foot"><div>
        {task.trigger.kind === 'cron' ? <><span className="dtc-mono">{cronHuman(task.trigger.expr)}</span><span>{task.enabled && task.nextFire ? `下次 ${fmt(task.nextFire)}` : '时间表已停用'}</span></> : latest ? <><span>{ago(latest.firedAt)} · {BY[latest.by]}</span><span>{history} 次运行</span></> : <span>单次任务</span>}
        </div><div className="acts">
          {task.trigger.kind === 'cron' ? <button className="dtc-btn sm" onClick={event => { event.stopPropagation(); void toggleSchedule() }}>{task.enabled ? '停用' : '启用'}</button> : null}
          {state === 'bad' ? <button className="dtc-btn sm" onClick={event => { event.stopPropagation(); void retry() }}>重试</button> : null}
          {state === 'park' && current?.sessionId ? <button className="dtc-btn sm pri" onClick={event => { event.stopPropagation(); closeConsole(); void api.openSession(current.sessionId!) }}>去回答</button> : null}
          <span className="open">查看详情 →</span>
        </div>
      </div>
    </div>
  )
}

// ── new task ─────────────────────────────────────────────────────────────

const CRON_PRESETS: [string, string][] = [['*/10 * * * *', '每 10 分钟'], ['0 * * * *', '每小时'], ['0 3 * * *', '每天 03:00'], ['0 9 * * 1-5', '工作日 09:00'], ['0 9 * * 1', '每周一 09:00']]

export function NewTask({ api, agents, toast, workspaces }: { api: TasksApi; agents: AgentRow[]; toast: (m: string) => void; workspaces: { id: string; path: string; title: string }[] }) {
  const [brief, setBrief] = useState('')
  const [parts, setParts] = useState<{ agentId: string; brief?: string }[]>([])
  const [kind, setKind] = useState<'once' | 'cron'>('once')
  const [expr, setExpr] = useState('*/10 * * * *')
  const [cwd, setCwd] = useState(workspaces[0]?.path ?? '')
  const [timeout, setTimeoutMin] = useState(30)
  const [onFail, setOnFail] = useState<'stop' | 'retry'>('stop')
  const [tries, setTries] = useState(2)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const usable = agents.filter(a => !a.broken)
  const ok = brief.trim().length >= 4 && parts.length > 0 && (kind === 'once' || !!parseCron(expr))
  const toggle = (id: string) => setParts(p => p.some(x => x.agentId === id) ? p.filter(x => x.agentId !== id) : [...p, { agentId: id }])
  const move = (i: number, d: number) => setParts(p => { const n = [...p]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n })
  const noAsk = parts.some(p => { const a = agents.find(x => x.id === p.agentId); return a?.spec && !a.spec.tools.includes('ask-user') })
  const claudeOnes = parts.map(p => agents.find(x => x.id === p.agentId)).filter(a => a?.spec?.model.startsWith('claude-local')).map(a => a!.name)
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const { id } = await api.createTask({ brief, participants: parts, trigger: kind === 'once' ? { kind: 'once' } : { kind: 'cron', expr }, cwd, timeoutSec: timeout * 60, onFail, maxTries: tries })
      toast(kind === 'once' ? '已建卡并触发' : '已建卡')
      go(`tasks/${id}`)
    } catch (e) { setErr(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  const next = kind === 'cron' && parseCron(expr) ? nextFire(parseCron(expr)!) : null
  return (
    <>
      <div className="dtc-crumb"><a onClick={() => go('tasks')}>任务</a><span>/</span><span>新建</span></div>
      {err ? <div className="dtc-err">{err}</div> : null}
      <div className="dtc-wiz"><div>
        <div className="dtc-step"><h3><span className="no">1</span>写任务书</h3><div className="sub">建卡后不可改。每个参与者都会原文收到它。</div>
          <textarea value={brief} onChange={e => setBrief(e.target.value)} placeholder="要做成什么样,怎么算做完。例:逐台核对机群状态,把异常写成「现象 / 依据 / 建议动作」。" /></div>
        <div className="dtc-step"><h3><span className="no">2</span>选参与者</h3><div className="sub">勾选顺序 = 接力顺序:上一位的最后一条回复作为交接单交给下一位。</div>
          <div className="dtc-pick">{usable.map(a => { const i = parts.findIndex(p => p.agentId === a.id); return (
            <div key={a.id} className={`dtc-pk ${i >= 0 ? 'on' : ''}`} onClick={() => toggle(a.id)}><span className={`ord ${i >= 0 ? '' : 'off'}`}>{i >= 0 ? i + 1 : '+'}</span><div><div className="pn">{a.name} <span className="dtc-mono dtc-faint" style={{ fontSize: 11 }}>{a.id}</span></div><div className="pd">{a.description}</div></div></div>) })}</div>
          {parts.length ? <div className="dtc-order">{parts.map((p, i) => <div key={p.agentId} className="dtc-oi"><span className="ord">{i + 1}</span><b>{agentName(agents, p.agentId)}</b><input placeholder="它的分工(可选)" value={p.brief ?? ''} onChange={e => setParts(ps => ps.map((x, j) => j === i ? { ...x, brief: e.target.value } : x))} /><button className="dtc-btn sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button className="dtc-btn sm" disabled={i === parts.length - 1} onClick={() => move(i, 1)}>↓</button></div>)}</div> : null}
          {claudeOnes.length ? <div className="dtc-warn">{claudeOnes.join('、')} 挂在 claude-local 上:这条路上 dsh 的工具都是延迟工具,它交不了卷(task_complete),会被催一次后判「没按协议交卷」。换成 codex-local 或 API 型模型再参与任务。</div> : null}
          {noAsk ? <div className="dtc-warn">有参与者没勾 ask_user_question,它遇到拿不准的事只能失败,不会停下来问。</div> : null}
        </div>
        <div className="dtc-step"><h3><span className="no">3</span>触发</h3><div className="sub">单次任务提交后立刻进「进行中」;时间表任务进「待触发」,到点各生一张运行卡。</div>
          <div className="dtc-radio"><div className={`dtc-rd ${kind === 'once' ? 'on' : ''}`} onClick={() => setKind('once')}>现在跑一次</div><div className={`dtc-rd ${kind === 'cron' ? 'on' : ''}`} onClick={() => setKind('cron')}>按时间表</div></div>
          {kind === 'cron' ? <><div className="dtc-chips" style={{ margin: '10px 0' }}>{CRON_PRESETS.map(([e, n]) => <button key={e} className={`dtc-chip ${expr === e ? 'on' : ''}`} onClick={() => setExpr(e)}>{n}</button>)}</div>
            <div className="dtc-chips"><input className="dtc-mono" style={{ width: 180 }} value={expr} onChange={e => setExpr(e.target.value)} /><span className="dtc-muted" style={{ fontSize: 12.5 }}>{cronHuman(expr)}{next ? ` · 下次 ${fmt(next.toISOString())}` : ''}</span></div></> : null}
        </div>
        <div className="dtc-step"><h3><span className="no">4</span>边界</h3><div className="sub">默认值一般不用动。</div>
          <div className="dtc-fields">
            <label>工作区(会话落在哪个分组)<select value={cwd} onChange={e => setCwd(e.target.value)}>{workspaces.map(w => <option key={w.id} value={w.path}>{w.title} · {w.path}</option>)}{!workspaces.some(w => w.path === cwd) && cwd ? <option value={cwd}>{cwd}</option> : null}</select></label>
            <label>每段超时(分钟)<input type="number" value={timeout} onChange={e => setTimeoutMin(+e.target.value)} /></label>
            <label>失败后<select value={onFail} onChange={e => setOnFail(e.target.value as 'stop' | 'retry')}><option value="stop">停下,人来重试</option><option value="retry">自动重试</option></select></label>
            {onFail === 'retry' ? <label>最多重试<input type="number" value={tries} onChange={e => setTries(+e.target.value)} /></label> : null}
          </div></div>
      </div>
      <div className="dtc-panel dtc-sticky"><h3>建卡预览</h3><div className="dtc-kv">
        <span className="k">任务书</span><span>{brief.trim() ? brief.trim().slice(0, 60) + (brief.length > 60 ? '…' : '') : <span className="dtc-faint">还没写</span>}</span>
        <span className="k">参与</span><span>{parts.length ? parts.map(p => agentName(agents, p.agentId)).join(' → ') : <span className="dtc-faint">还没选</span>}</span>
        <span className="k">触发</span><span>{kind === 'once' ? '提交即跑' : cronHuman(expr)}</span>
        <span className="k">边界</span><span>{timeout} 分钟/段 · {onFail === 'retry' ? `失败重试 ${tries} 次` : '失败停下'}</span>
        <span className="k">进哪列</span><span>{kind === 'once' ? '进行中' : '待触发'}</span></div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}><button className="dtc-btn pri" disabled={!ok || busy} onClick={submit}>{busy ? '建卡中…' : kind === 'once' ? '建卡并运行' : '建卡'}</button><button className="dtc-btn" onClick={() => go('tasks')}>取消</button></div>
      </div></div>
    </>
  )
}
