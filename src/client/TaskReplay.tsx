/**
 * One task, replayed. Left: the event stream, append-only, with the real
 * time of each event and who moved (host / agent / person / clock). Right:
 * the board state at the cursor — computed by the same fold the host runs,
 * so scrubbing backwards shows exactly what the board showed then. Below:
 * the run ledger (one row per leg = one real session), each expandable into
 * that session's own turn ledger.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cronHuman } from '../cron.ts'
import { actorOf, describe, fold, runStatus, type Event, type Run, type TaskSpec } from '../fold.ts'
import type { AgentRow } from '../wire.ts'
import { closeConsole, go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'
import { TurnLedgerView, useLedger, type LedgerApi } from './TurnLedger.tsx'

const fmt = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 8) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const LEG: Record<string, string> = { queued: '排队', running: '进行中', blocked: '停车等人', done: '完成', failed: '失败', timed_out: '超时', lost: '丢失', cancelled: '取消' }
const ACTOR: Record<ReturnType<typeof actorOf>, { label: string; cls: string }> = { dispatcher: { label: '宿主', cls: 'dtc-p-grey' }, agent: { label: 'Agent', cls: 'dtc-p-acc' }, person: { label: '人', cls: 'dtc-p-warn' }, clock: { label: '时钟', cls: 'dtc-p-park' } }
const ST: Record<ReturnType<typeof runStatus>, { label: string; cls: string }> = { run: { label: '进行中', cls: 'dtc-p-acc' }, park: { label: '停车等人', cls: 'dtc-p-park' }, done: { label: '完成', cls: 'dtc-p-ok' }, bad: { label: '失败', cls: 'dtc-p-bad' } }

export function TaskReplay({ api, agents, id, runId, toast }: { api: TasksApi & LedgerApi; agents: AgentRow[]; id: string; runId?: string; toast: (m: string) => void }) {
  const [events, setEvents] = useState<Event[]>([])
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)   // null = live (end)
  const [playing, setPlaying] = useState(false)
  const [openLeg, setOpenLeg] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let stop = false
    const load = () => api.taskEvents(id).then(ev => { if (!stop) { setEvents(ev as Event[]); setError('') } }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    void load(); const t = window.setInterval(load, 3000)
    return () => { stop = true; window.clearInterval(t) }
  }, [api, id])

  const upto = cursor === null ? events.length : Math.min(cursor, events.length)
  const state = useMemo(() => fold(events.slice(0, upto)), [events, upto])
  const full = useMemo(() => fold(events), [events])
  const task: TaskSpec | undefined = full.tasks.get(id) ?? state.tasks.get(id)
  const runsAll = [...full.runs.values()].filter(r => r.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
  const selId = runId ?? runsAll[0]?.id
  const runNow: Run | undefined = selId ? state.runs.get(selId) : undefined
  const runFull: Run | undefined = selId ? full.runs.get(selId) : undefined

  useEffect(() => {
    if (!playing) { window.clearTimeout(timer.current); return }
    if (upto >= events.length) { setPlaying(false); setCursor(null); return }
    timer.current = window.setTimeout(() => setCursor(c => (c ?? events.length) + 1), 900)
    return () => window.clearTimeout(timer.current)
  }, [playing, upto, events.length])

  const agentName = (aid: string) => agents.find(a => a.id === aid)?.name ?? aid
  const legAgent = (rid: string, leg: number) => { const r = full.runs.get(rid); return r ? agentName(r.legs[leg]?.agentId ?? '') : `第 ${leg + 1} 段` }

  if (!task) return <div className="dtc-empty">{error || (events.length ? '没有这个任务' : <><span className="dtc-spin" /> 读取事件流…</>)}</div>
  const stepTo = (n: number) => { setPlaying(false); setCursor(Math.max(1, Math.min(n, events.length)) === events.length ? null : Math.max(1, Math.min(n, events.length))) }

  return (
    <>
      <div className="dtc-crumb"><a onClick={() => go('tasks')}>任务</a><span>/</span><span className="dtc-mono">{task.id}</span>{runFull ? <><span>/</span><span className="dtc-mono">{runFull.id}</span></> : null}</div>
      <div className="dtc-h1">{task.title}
        {task.trigger.kind === 'cron' ? <span className="dtc-pill dtc-p-warn">{cronHuman(task.trigger.expr)}</span> : <span className="dtc-pill dtc-p-grey">单次</span>}
        {!task.enabled ? <span className="dtc-pill dtc-p-bad">已停用</span> : null}
        {runFull ? <span className={`dtc-pill ${ST[runStatus(runFull)].cls}`}>{ST[runStatus(runFull)].label}</span> : null}
        <span className="dtc-acts">
          {runsAll.length > 1 ? <select value={selId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)} style={{ width: 'auto' }}>{runsAll.map(r => <option key={r.id} value={r.id}>{r.id} · {fmt(r.firedAt)} · {ST[runStatus(r)].label}</option>)}</select> : null}
          <button className="dtc-btn pri" onClick={async () => { const { runId: rid } = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${rid}`) }}>▶ 再跑一次</button>
          {runFull && (runStatus(runFull) === 'run' || runStatus(runFull) === 'park') ? <button className="dtc-btn danger" onClick={async () => { await api.cancelRun(runFull.id); toast('已取消') }}>取消这次</button> : null}
          {task.trigger.kind === 'cron' ? <button className="dtc-btn" onClick={() => api.setTaskEnabled(task.id, !task.enabled)}>{task.enabled ? '停用' : '启用'}</button> : null}
          <button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); toast('已删除'); go('tasks') }}>删除</button>
        </span></div>
      {error ? <div className="dtc-err">{error}</div> : null}

      {/* ── replay: stream on the left, derived state on the right ── */}
      <div className="dtc-replay">
        <div className="dtc-panel dtc-stream">
          <h3>事件流 <span className="dtc-faint" style={{ fontWeight: 400 }}>只追加 · 真实时刻 · 谁动的手</span><span className="sp" /><span className="dtc-faint">{upto} / {events.length}</span></h3>
          <div className="dtc-evlist">
            {events.map((e, i) => {
              const a = ACTOR[actorOf(e)]
              const on = i < upto, cur = i === upto - 1
              return (
                <div key={i} className={`dtc-ev ${on ? 'on' : 'off'} ${cur ? 'cur' : ''}`} onClick={() => stepTo(i + 1)}>
                  <span className="dtc-mono n">{String(i + 1).padStart(3, '0')}</span>
                  <span className="dtc-mono ts">{fmt(e.at)}</span>
                  <span className={`dtc-pill ${a.cls}`}>{a.label}</span>
                  <span className="dtc-mono t">{e.t}</span>
                  <span className="d">{describe(e, agentName, legAgent)}</span>
                </div>
              )
            })}
          </div>
          <div className="dtc-scrub">
            <button className="dtc-btn sm" onClick={() => stepTo(1)} disabled={upto <= 1}>⏮</button>
            <button className="dtc-btn sm" onClick={() => stepTo(upto - 1)} disabled={upto <= 1}>◀ 上一条</button>
            <button className={`dtc-btn sm ${playing ? 'pri' : ''}`} onClick={() => { if (upto >= events.length) setCursor(1); setPlaying(p => !p) }}>{playing ? '❚❚ 暂停' : '▶ 连播'}</button>
            <button className="dtc-btn sm" onClick={() => stepTo(upto + 1)} disabled={upto >= events.length}>下一条 ▶</button>
            <button className="dtc-btn sm" onClick={() => { setPlaying(false); setCursor(null) }} disabled={cursor === null}>⏭ 回到现在</button>
            <input type="range" min={1} max={Math.max(1, events.length)} value={upto} onChange={e => stepTo(Number(e.target.value))} />
          </div>
        </div>

        <div className="dtc-panel dtc-derived">
          <h3>看板状态 <span className="dtc-faint" style={{ fontWeight: 400 }}>由左边重放得出{cursor !== null ? ` · 停在第 ${upto} 条` : ' · 现在'}</span></h3>
          {runNow ? (
            <>
              <div className="dtc-kv" style={{ marginBottom: 10 }}>
                <span className="k">运行</span><span className="dtc-mono">{runNow.id} <span className={`dtc-pill ${ST[runStatus(runNow)].cls}`}>{ST[runStatus(runNow)].label}</span></span>
                <span className="k">触发</span><span>{({ cron: '时间表', manual: '手动', retry: '重试' })[runNow.by]} · {fmt(runNow.firedAt)}</span>
              </div>
              <div className="dtc-chain">
                {runNow.legs.map((l, i) => (
                  <div key={i} className={`dtc-node s-${l.status}`}>
                    <div className="who">{agentName(l.agentId)}</div>
                    <div className="st">{LEG[l.status]}{l.tries > 1 ? ` · 第 ${l.tries} 次` : ''}</div>
                    {l.startedAt ? <div className="dtc-faint dtc-mono" style={{ fontSize: 11 }}>{dur(l.startedAt, l.endedAt ?? (cursor !== null ? events[upto - 1]?.at : undefined))}</div> : null}
                    {l.question ? <div className="q">? {l.question}</div> : null}
                    {i < runNow.legs.length - 1 ? <div className={`edge ${l.status === 'done' ? 'open' : 'held'}`} title={l.status === 'done' ? '上游已完成,这条边放行' : '上游未完成,按住下游'} /> : null}
                  </div>
                ))}
              </div>
              <div className="dtc-note">紫边 = 上游还没完成,按住下游;绿边 = 已放行。节点之间只有两条通道:任务书,和上游的交接单。</div>
            </>
          ) : <div className="dtc-empty">这个时刻还没有运行。</div>}
        </div>
      </div>

      {/* ── run ledger ── */}
      {runFull ? (
        <div className="dtc-panel"><h3>运行台账 <span className="dtc-faint" style={{ fontWeight: 400 }}>一次运行 = {runFull.legs.filter(l => l.sessionId).length} 个真实会话;每段拿到什么、交出什么</span></h3>
          <table className="dtc-runs"><thead><tr><th>段</th><th>角色</th><th>会话</th><th>状态</th><th>耗时</th><th>拿到了什么</th><th>交出了什么</th><th /></tr></thead><tbody>
            {runFull.legs.map((l, i) => {
              const p = task.participants[i]; const up = i > 0 ? runFull.legs[i - 1] : undefined
              const got = [`任务书`, p?.brief ? `分工:${p.brief}` : null, up ? `上游 ${agentName(up.agentId)} 的交接单${up.handoff ? `(${up.handoff.length} 字)` : '(空)'}` : null].filter(Boolean).join(' + ')
              const key = `${runFull.id}:${i}`
              return (
                <>
                  <tr key={key} className="row" onClick={() => setOpenLeg(o => o === key ? null : key)}>
                    <td className="dtc-mono">{i + 1}</td><td><b>{agentName(l.agentId)}</b></td><td className="dtc-mono dtc-faint">{l.sessionId ?? '—'}</td>
                    <td><span className={`dtc-pill ${l.status === 'done' ? 'dtc-p-ok' : l.status === 'running' ? 'dtc-p-acc' : l.status === 'blocked' ? 'dtc-p-park' : l.status === 'queued' ? 'dtc-p-grey' : 'dtc-p-bad'}`}>{LEG[l.status]}</span></td>
                    <td>{dur(l.startedAt, l.endedAt)}</td><td className="dtc-faint" style={{ fontSize: 12 }}>{got}</td>
                    <td className="dtc-faint" style={{ fontSize: 12 }}>{l.handoff ? l.handoff.slice(0, 60) + (l.handoff.length > 60 ? '…' : '') : l.error ?? '—'}</td>
                    <td>{l.sessionId ? <button className="dtc-btn sm" onClick={e => { e.stopPropagation(); closeConsole(); void api.openSession(l.sessionId!) }}>打开会话</button> : null}</td>
                  </tr>
                  {openLeg === key ? <tr key={key + ':x'}><td colSpan={8}><LegDetail api={api} leg={l} live={l.status === 'running' || l.status === 'blocked'} /></td></tr> : null}
                </>
              )
            })}
          </tbody></table>
        </div>
      ) : null}

      {/* ── roles + brief ── */}
      <div className="dtc-two">
        <div className="dtc-panel"><h3>角色配置 <span className="dtc-faint" style={{ fontWeight: 400 }}>每段带自己的 preset;工具就是权限</span></h3>
          <div className="dtc-roles">
            {task.participants.map((p, i) => { const a = agents.find(x => x.id === p.agentId); return (
              <div key={i} className="dtc-role">
                <div className="h"><span className="ord">{i + 1}</span><b>{a?.name ?? p.agentId}</b><span className="dtc-mono dtc-faint">{p.agentId}</span><span className="sp" /><a onClick={() => go(`agents/${p.agentId}`)}>编辑</a></div>
                {a?.spec ? <div className="b">
                  <div><span className="k">模型</span><span className="dtc-mono">{a.spec.model || '默认'}{a.spec.effort ? ` · ${a.spec.effort}` : ''}</span></div>
                  <div><span className="k">工具</span><span>{a.spec.tools.join(', ') || '无'}</span></div>
                  <div><span className="k">MCP</span><span>{a.spec.mcp.join(', ') || '无'}</span></div>
                  <div><span className="k">Skill</span><span>{a.spec.skills.join(', ') || '无'}</span></div>
                  {p.brief ? <div><span className="k">分工</span><span>{p.brief}</span></div> : null}
                </div> : <div className="b dtc-faint">不是任务台写的 preset,字段不可见。</div>}
              </div>) })}
          </div>
        </div>
        <div className="dtc-panel"><h3>任务书 <span className="dtc-faint" style={{ fontWeight: 400 }}>建卡即写死,每段原文收到</span></h3>
          <div style={{ whiteSpace: 'pre-wrap' }}>{task.brief}</div>
          <div className="dtc-kv" style={{ marginTop: 12 }}>
            <span className="k">工作区</span><span className="dtc-mono">{task.cwd}</span>
            <span className="k">超时</span><span>{Math.round(task.timeoutSec / 60)} 分钟 / 段</span>
            <span className="k">失败后</span><span>{task.onFail === 'retry' ? `自动重试,最多 ${task.maxTries} 次` : '停下,人来重试'}</span>
          </div>
        </div>
      </div>
    </>
  )
}

function LegDetail({ api, leg, live }: { api: LedgerApi; leg: Run['legs'][number]; live: boolean }) {
  const { ledger, error } = useLedger(api, leg.sessionId, live)
  return (
    <div className="dtc-legdetail">
      {leg.handoff ? <><div className="dtc-faint" style={{ fontSize: 12, margin: '4px 0' }}>交接单(最后一条回复,原样交给下一段)</div><div className="dtc-hand">{leg.handoff}</div></> : null}
      {leg.error ? <div className="dtc-err">{leg.error}</div> : null}
      <div className="dtc-faint" style={{ fontSize: 12, margin: '10px 0 4px' }}>回合账本(这段会话自己的日志折出来的)</div>
      {error ? <div className="dtc-err">{error}</div> : ledger ? <TurnLedgerView ledger={ledger} /> : <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div>}
    </div>
  )
}
