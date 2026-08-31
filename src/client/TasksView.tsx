/**
 * Tasks: the board, one task's detail with its runs and legs, and the
 * "new task" wizard. Everything here is a projection of the host's event
 * stream, polled while the console is open.
 */

import { useEffect, useMemo, useState } from 'react'
import { cronHuman, nextFire, parseCron } from '../cron.ts'
import type { AgentRow, LegacyRun as Run, TaskEvent, TaskSpec } from '../wire.ts'
import { go } from './Console.tsx'

export interface TasksApi {
  tasks: () => Promise<{ tasks: (TaskSpec & { nextFire: string | null })[]; runs: Run[] }>
  createTask: (spec: Partial<TaskSpec>) => Promise<{ id: string }>
  setTaskEnabled: (id: string, enabled: boolean) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  fireTask: (id: string, by?: 'manual' | 'retry') => Promise<{ runId: string }>
  cancelRun: (runId: string) => Promise<void>
  taskEvents: (id: string) => Promise<TaskEvent[]>
  openSession: (sessionId: string) => Promise<void>
  sessionTurns: (sessionId: string) => Promise<import('../wire.ts').TurnLedger>
}

type TaskRow = TaskSpec & { nextFire: string | null }

const fmt = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 8) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const BY: Record<Run['by'], string> = { cron: '时间表', manual: '手动', retry: '重试' }
const LEG: Record<string, string> = { queued: '排队', running: '进行中', blocked: '停车等人', done: '完成', failed: '失败', timed_out: '超时', lost: '丢失', cancelled: '取消' }

export function runStatus(r: Run): 'run' | 'park' | 'done' | 'bad' {
  if (r.legs.some(l => l.status === 'blocked')) return 'park'
  if (r.legs.some(l => l.status === 'running')) return 'run'
  if (r.settled?.outcome === 'done' || r.legs.every(l => l.status === 'done')) return 'done'
  if (r.settled || r.legs.some(l => ['failed', 'timed_out', 'lost', 'cancelled'].includes(l.status))) return 'bad'
  return 'run'
}
const stPill = (st: ReturnType<typeof runStatus>) => ({ run: <span className="dtc-pill dtc-p-acc">进行中</span>, park: <span className="dtc-pill dtc-p-park">停车等人</span>, done: <span className="dtc-pill dtc-p-ok">完成</span>, bad: <span className="dtc-pill dtc-p-bad">失败</span> })[st]
const legDot = (status: string) => <span className={`dtc-dot dtc-dot-${status}`} title={LEG[status] ?? status} />

/** Poll the board while mounted; 2.5s is fast enough to feel live. */
export function useTasks(api: TasksApi): { tasks: TaskRow[]; runs: Run[]; reload: () => Promise<void>; error: string } {
  const [data, setData] = useState<{ tasks: TaskRow[]; runs: Run[] }>({ tasks: [], runs: [] })
  const [error, setError] = useState('')
  const reload = async () => { try { setData(await api.tasks()); setError('') } catch (e) { setError(String((e as Error).message ?? e)) } }
  useEffect(() => { void reload(); const t = window.setInterval(() => { void reload() }, 2500); return () => window.clearInterval(t) }, [api])
  return { ...data, reload, error }
}

const agentName = (agents: AgentRow[], id: string) => agents.find(a => a.id === id)?.name ?? id

// ── board ────────────────────────────────────────────────────────────────

export function TaskBoard({ api, agents, toast }: { api: TasksApi; agents: AgentRow[]; toast: (m: string) => void }) {
  const { tasks, runs, reload, error } = useTasks(api)
  const cols = useMemo(() => {
    const c: Record<'todo' | 'run' | 'park' | 'done' | 'bad', JSX.Element[]> = { todo: [], run: [], park: [], done: [], bad: [] }
    for (const t of tasks.filter(t => t.trigger.kind === 'cron')) c.todo.push(<CronCard key={t.id} t={t} agents={agents} onToggle={async () => { await api.setTaskEnabled(t.id, !t.enabled); toast(t.enabled ? '已停用' : '已启用'); await reload() }} />)
    for (const r of runs) { const t = tasks.find(x => x.id === r.taskId); if (!t) continue; c[runStatus(r)].push(<RunCard key={r.id} r={r} t={t} agents={agents} onRetry={async () => { await api.fireTask(t.id, 'retry'); toast('已重试'); await reload() }} />) }
    return c
  }, [tasks, runs, agents])
  const running = runs.filter(r => runStatus(r) === 'run').length, parked = runs.filter(r => runStatus(r) === 'park').length
  return (
    <>
      <div className="dtc-bar">
        <span><b style={{ color: 'var(--dtc-ink)' }}>{running}</b> 在跑</span><span><b style={{ color: 'var(--dtc-ink)' }}>{parked}</b> 停车等人</span><span><b style={{ color: 'var(--dtc-ink)' }}>{tasks.filter(t => t.trigger.kind === 'cron' && t.enabled).length}</b> 条时间表</span>
        <span className="sp" /><button className="dtc-btn pri" onClick={() => go('tasks/new')}>＋ 新建任务</button>
      </div>
      {error ? <div className="dtc-err">{error}</div> : null}
      <div style={{ overflowX: 'auto' }}><div className="dtc-cols">
        {([['todo', '待触发'], ['run', '进行中'], ['park', '停车等人'], ['done', '完成'], ['bad', '失败']] as const).map(([k, n]) => (
          <div key={k} className="dtc-col"><div className="dtc-colh"><span>{n}</span><span>{cols[k].length}</span></div>{cols[k].length ? cols[k] : <div className="dtc-empty" style={{ padding: 20 }}>空</div>}</div>
        ))}
      </div></div>
    </>
  )
}

function pipe(t: TaskSpec, agents: AgentRow[]) {
  return <span className="dtc-pipe">{t.participants.map((p, i) => <span key={i}>{i ? <span className="ar">→</span> : null}<span className="ag">{agentName(agents, p.agentId)}</span></span>)}</span>
}

function CronCard({ t, agents, onToggle }: { t: TaskRow; agents: AgentRow[]; onToggle: () => void }) {
  return (
    <div className="dtc-tcard s-cron" onClick={() => go(`tasks/${t.id}`)}>
      <div className="t"><span>{t.title}</span><span className="id dtc-mono">{t.id}</span></div>
      <div className="l dtc-mono">{cronHuman(t.trigger.kind === 'cron' ? t.trigger.expr : '')}</div>
      <div className="l">{t.enabled && t.nextFire ? `下次 ${fmt(t.nextFire)}` : '已停用'} <span className={`dtc-tog ${t.enabled ? 'on' : ''}`} onClick={e => { e.stopPropagation(); onToggle() }} /></div>
      <div className="l">{pipe(t, agents)}</div>
    </div>
  )
}

function RunCard({ r, t, agents, onRetry }: { r: Run; t: TaskSpec; agents: AgentRow[]; onRetry: () => void }) {
  const st = runStatus(r)
  const cur = r.legs.find(l => l.status === 'running' || l.status === 'blocked') ?? [...r.legs].reverse().find(l => l.status !== 'queued') ?? r.legs[0]
  const idx = r.legs.indexOf(cur)
  let line = ''
  if (st === 'run') line = `${agentName(agents, cur.agentId)} · 第 ${idx + 1}/${r.legs.length} 段 · ${dur(cur.startedAt)}`
  if (st === 'done') line = `${r.legs.length} 段全部完成 · ${dur(r.legs[0].startedAt, r.legs[r.legs.length - 1].endedAt)}`
  if (st === 'bad') line = `${agentName(agents, cur.agentId)} · ${LEG[cur.status] ?? cur.status}${cur.error ? ' · ' + cur.error.slice(0, 40) : ''}`
  return (
    <div className={`dtc-tcard s-${st}`} onClick={() => go(`tasks/${t.id}/runs/${r.id}`)}>
      <div className="t"><span>{t.title}</span><span className="id dtc-mono">{r.id}</span></div>
      {st === 'park' ? <div className="q">? {cur.question}</div> : <div className="l">{st === 'run' ? <span className="dtc-live" /> : null}{line}</div>}
      <div className="l dtc-faint">{fmt(r.firedAt)} · {BY[r.by]}</div>
      {st === 'bad' ? <div className="act"><button className="dtc-btn sm" onClick={e => { e.stopPropagation(); onRetry() }}>重试</button></div> : null}
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
