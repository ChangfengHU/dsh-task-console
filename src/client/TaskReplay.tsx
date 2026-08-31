/**
 * One task, one batch: the chain of cards up front, the run ledger under
 * it, the brief / roles / bounds on the rail, and the append-only event
 * stream in a bottom drawer with a scrubber — the state shown up top is
 * `fold(events.slice(0, cursor))`, the same fold the host runs.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cronHuman } from '../cron.ts'
import { actorOf, batchStatus, cardRun, describe, fold, type Batch, type Card, type Event, type Run, type TaskSpec } from '../fold.ts'
import type { AgentRow } from '../wire.ts'
import { closeConsole, go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'
import { TurnLedgerView, useLedger, type LedgerApi } from './TurnLedger.tsx'

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const CARD: Record<string, string> = { todo: '等上游', ready: '就绪', running: '进行中', blocked: '停车等人', done: '完成', review: '待验收', failed: '失败', cancelled: '取消' }
const RUN: Record<string, string> = { completed: '交卷', review: '提交验收', blocked: '停车', crashed: '进程没了', timed_out: '超时', failed: '失败', protocol_violation: '没按协议交卷', cancelled: '取消' }
const ACTOR = { dispatcher: { label: '系统', cls: 'dtc-p-grey' }, agent: { label: 'Agent', cls: 'dtc-p-acc' }, person: { label: '人', cls: 'dtc-p-warn' }, clock: { label: '时钟', cls: 'dtc-p-park' } } as const
const BS = { run: { label: '进行中', cls: 'dtc-p-acc' }, park: { label: '停车等人', cls: 'dtc-p-park' }, done: { label: '完成', cls: 'dtc-p-ok' }, bad: { label: '失败', cls: 'dtc-p-bad' } } as const
const pillOf = (st: string) => st === 'done' || st === 'review' ? 'dtc-p-ok' : st === 'running' ? 'dtc-p-acc' : st === 'blocked' ? 'dtc-p-park' : st === 'failed' ? 'dtc-p-bad' : 'dtc-p-grey'

export function TaskReplay({ api, agents, id, runId, toast }: { api: TasksApi & LedgerApi; agents: AgentRow[]; id: string; runId?: string; toast: (m: string) => void }) {
  const [events, setEvents] = useState<Event[]>([])
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [openCard, setOpenCard] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let stop = false
    const load = () => api.taskEvents(id).then(ev => { if (!stop) { setEvents(ev as Event[]); setError('') } }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    void load(); const t = window.setInterval(load, 3000)
    return () => { stop = true; window.clearInterval(t) }
  }, [api, id])

  const upto = cursor === null ? events.length : Math.min(cursor, events.length)
  const full = useMemo(() => fold(events), [events])
  const now = useMemo(() => cursor === null ? full : fold(events.slice(0, upto)), [events, upto, cursor, full])
  const task: TaskSpec | undefined = full.tasks.get(id)
  const batches = [...full.batches.values()].filter(b => b.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
  const selId = runId ?? batches[0]?.id
  const batchFull: Batch | undefined = selId ? full.batches.get(selId) : undefined
  const batchNow: Batch | undefined = selId ? now.batches.get(selId) : undefined

  useEffect(() => {
    if (!playing) { window.clearTimeout(timer.current); return }
    if (upto >= events.length) { setPlaying(false); setCursor(null); return }
    timer.current = window.setTimeout(() => setCursor(c => (c ?? events.length) + 1), 900)
    return () => window.clearTimeout(timer.current)
  }, [playing, upto, events.length])

  const agentName = (aid: string) => agents.find(a => a.id === aid)?.name ?? aid
  const stepTo = (n: number) => { setPlaying(false); const v = Math.max(1, Math.min(n, events.length)); setCursor(v >= events.length ? null : v); setDrawer(true); document.getElementById('dtc-chain-anchor')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
  if (!task) return <div className="dtc-empty">{error || (events.length ? '没有这个任务' : <><span className="dtc-spin" /> 读取事件流…</>)}</div>

  const cardsNow = batchNow ? batchNow.cardIds.map(cid => now.cards.get(cid)).filter(Boolean) as Card[] : []
  const cardsFull = batchFull ? batchFull.cardIds.map(cid => full.cards.get(cid)).filter(Boolean) as Card[] : []
  const bst = batchFull ? batchStatus(full, batchFull) : undefined
  const stopAt = cursor !== null ? events[upto - 1]?.at : undefined
  const total = cardsFull.length ? dur(cardsFull.find(c => c.startedAt)?.startedAt, batchFull?.settled?.at ?? [...cardsFull].reverse().find(c => c.endedAt)?.endedAt) : ''
  const asks = batchFull ? [...full.runs.values()].filter(r => r.batchId === batchFull.id && r.blockKind).length : 0
  const last = events[events.length - 1]

  return (
    <>
      <div className="dtc-crumb"><a onClick={() => go('tasks')}>任务</a><span>/</span><span>{task.title}</span></div>
      <div className="dtc-h1">{task.title}
        {bst ? <span className={`dtc-pill ${BS[bst].cls}`}>{BS[bst].label}</span> : null}
        {task.trigger.kind === 'cron' ? <span className="dtc-pill dtc-p-warn">{cronHuman(task.trigger.expr)}</span> : <span className="dtc-pill dtc-p-grey">单次</span>}
        {!task.enabled ? <span className="dtc-pill dtc-p-bad">已停用</span> : null}
        <span className="dtc-acts">
          {batches.length > 1 ? <select value={selId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)} style={{ width: 'auto' }}>{batches.map(b => <option key={b.id} value={b.id}>{b.id === batches[0].id ? '这次运行' : '之前'} · {b.id} · {fmt(b.firedAt)} · {BS[batchStatus(full, b)].label}</option>)}</select> : null}
          <button className="dtc-btn pri" onClick={async () => { const { runId: rid } = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${rid}`) }}>▶ 再跑一次</button>
          {batchFull && (bst === 'run' || bst === 'park') ? <button className="dtc-btn danger" onClick={async () => { await api.cancelRun(batchFull.id); toast('已取消') }}>取消这次</button> : null}
          {task.trigger.kind === 'cron' ? <button className="dtc-btn" onClick={() => api.setTaskEnabled(task.id, !task.enabled)}>{task.enabled ? '停用' : '启用'}</button> : null}
          <button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); toast('已删除'); go('tasks') }}>删除</button>
        </span></div>
      <div className="dtc-sub">{batchFull ? `${({ cron: '到点', manual: '手动', retry: '重试' })[batchFull.by]}触发 · ${cardsFull.length} 棒接力${total ? ` · 共 ${total}` : ''}${asks ? ` · 中途问过 ${asks} 次` : ''}` : '还没跑过'}</div>
      {error ? <div className="dtc-err">{error}</div> : null}

      <div className="dtc-two">
        <div>
          {/* ── chain ── */}
          <div className="dtc-panel">
            <h3 id="dtc-chain-anchor">现在到哪了 <span className="dtc-faint" style={{ fontWeight: 400 }}>{stopAt ? <><span className="dtc-chip stale">回放到 {fmt(stopAt)}(第 {upto} 步)</span></> : '每张卡一个人,左到右接力'}</span></h3>
            {cardsNow.length ? <>
              <div className="dtc-chain">
                {cardsNow.map((c, i) => {
                  const r = cardRun(now, c)
                  const el = c.startedAt ? dur(c.startedAt, c.endedAt ?? stopAt) : ''
                  const up = i ? cardsNow[i - 1] : undefined
                  const open = up ? (up.status === 'done' || up.status === 'review') : false
                  return (
                    <span key={c.id} style={{ display: 'contents' }}>
                      {up ? <div className={`dtc-link ${open ? 'open' : ''}`}><span className="lbl">{open ? '已交接' : '等上一位'}</span><div className="bar" /><span className="lbl">{open ? '' : ''}</span></div> : null}
                      <div className={`dtc-node s-${c.status}`}>
                        <div className="role"><div className="av">{agentName(c.agentId)[0]}</div><div><div className="nm">{agentName(c.agentId)}</div><div className="dtc-faint" style={{ fontSize: 11.5 }}>第 {c.index + 1} 棒</div></div></div>
                        <div className="st">{c.status === 'running' ? <span className="dtc-live" /> : null}{CARD[c.status]}{c.runIds.length > 1 ? ` · 第 ${c.runIds.length} 次` : ''}</div>
                        {el ? <div className="dur">{el}<small>{c.endedAt ? '用时' : '已跑'}</small></div> : <div className="dur dtc-faint">—</div>}
                        {r?.status === 'blocked' && r.question ? <div className="q">? {r.question.slice(0, 60)}{r.question.length > 60 ? '…' : ''}</div> : null}
                        {c.error && c.status === 'failed' ? <div className="q bad">{c.error.slice(0, 60)}</div> : null}
                      </div>
                    </span>
                  )
                })}
              </div>
              <div className="dtc-chain-cap"><span className="dtc-chip">{cardsFull.filter(c => c.runIds.length).length} 个会话</span><span>绿线 = 上一位交卷了,下一位可以开始;紫线 = 还在等上一位</span></div>
            </> : <div className="dtc-empty">这个时刻还没有运行。</div>}
          </div>

          {/* ── run ledger ── */}
          {batchFull ? <div className="dtc-panel"><h3>每一棒干了什么 <span className="dtc-faint" style={{ fontWeight: 400 }}>拿到什么、交出什么;点一行看完整交接单和它调过的工具</span></h3>
            <div className="dtc-ledger">
              {cardsFull.map((c, i) => {
                const r = cardRun(full, c)
                const up = i ? cardsFull[i - 1] : undefined
                const got = ['任务书', c.brief ? '分工' : null, up ? `上游 ${agentName(up.agentId)} 的交接单` : null].filter(Boolean).join(' + ')
                const gave = c.summary ? c.summary.split('\n')[0] : r?.status === 'blocked' ? '(等人)' : c.error ?? '—'
                const isOpen = openCard === c.id
                return (
                  <div key={c.id} className={`dtc-leg ${isOpen ? 'open' : ''}`}>
                    <div className="head" onClick={() => setOpenCard(isOpen ? null : c.id)}>
                      <span className="no">{i + 1}</span>
                      <div className="who">{agentName(c.agentId)}<small>{r ? `第 ${r.attempt} 次 · ${fmt(r.startedAt)}` : '还没开始'}</small></div>
                      <span className={`dtc-pill ${pillOf(c.status)}`}>{CARD[c.status]}{c.runIds.length > 1 ? ` · 第 ${c.runIds.length} 次` : ''}</span>
                      <span className="dtc-mono dtc-muted">{c.startedAt ? dur(c.startedAt, c.endedAt) : '—'}</span>
                      <div className="io"><div><b>拿到</b><span>{got}</span></div><span className="arr">→</span><div><b>交出</b><span>{gave}</span></div></div>
                      <div className="acts">{r?.sessionId ? <button className="dtc-btn sm" title={r.sessionId} onClick={e => { e.stopPropagation(); closeConsole(); void api.openSession(r.sessionId) }}>看对话</button> : null}</div>
                    </div>
                    {isOpen ? <CardDetail api={api} card={c} runs={c.runIds.map(rid => full.runs.get(rid)).filter(Boolean) as Run[]} /> : null}
                  </div>
                )
              })}
            </div>
          </div> : null}
        </div>

        {/* ── rail ── */}
        <div>
          <div className="dtc-panel"><h3>任务书 <span className="dtc-faint" style={{ fontWeight: 400 }}>建卡即写死</span></h3><div style={{ whiteSpace: 'pre-wrap' }}>{task.brief}</div></div>
          <div className="dtc-panel"><h3>谁来做 <span className="dtc-faint" style={{ fontWeight: 400 }}>每一棒一个 Agent,各带各的工具</span></h3>
            <div className="dtc-roles">{task.participants.map((p, i) => { const a = agents.find(x => x.id === p.agentId); return (
              <div key={i} className="dtc-role"><div className="h"><span className="ord">{i + 1}</span><b>{a?.name ?? p.agentId}</b><span className="dtc-mono dtc-faint">{p.agentId}</span><span className="sp" /><a onClick={() => go(`agents/${p.agentId}`)}>配置</a></div>
                {a?.spec ? <div className="cap"><em>{a.spec.model.split('/')[1] ?? '默认模型'}</em><em>{a.spec.tools.length} 工具</em><em>{a.spec.mcp.length} MCP</em><em>{a.spec.skills.length} skill</em></div> : <div className="dtc-faint" style={{ fontSize: 12 }}>不是任务台写的 preset</div>}
                {p.brief ? <div className="dtc-muted" style={{ fontSize: 12, marginTop: 3 }}>分工:{p.brief}</div> : null}</div>) })}</div>
          </div>
          <div className="dtc-panel"><h3>边界</h3><div className="dtc-kv">
            <span className="k">工作区</span><span className="dtc-mono">{task.cwd}</span>
            <span className="k">超时</span><span>{Math.round(task.timeoutSec / 60)} 分钟 / 卡</span>
            <span className="k">失败后</span><span>{task.onFail === 'retry' ? `自动重试,最多 ${task.maxTries} 次` : '停下,人来重试'}</span>
            <span className="k">触发</span><span>{task.trigger.kind === 'cron' ? cronHuman(task.trigger.expr) : '单次'}</span>
          </div></div>
        </div>
      </div>

      {drawer ? <div style={{ height: '44vh' }} /> : null}
      {/* ── event stream: a bar, then a drawer ── */}
      <div className="dtc-evbar" onClick={() => setDrawer(d => !d)}>
        <b>过程回放</b><span className="dtc-muted">{events.length} 步</span>
        {last ? <span className="dtc-muted">最近:{fmt(last.at)} {describe(last, full, agentName)}</span> : null}
        <span className="sp" /><span className="dtc-faint">{drawer ? '收起 ▾' : '▴ 一步一步看'}</span>
      </div>
      {drawer ? <div className="dtc-drawer">
        <div className="dh"><b>过程回放</b><span className="dtc-muted">点任一步,上面的接力图就退回到那一刻</span><span className="sp" /><span className="dtc-muted">第 {upto} / {events.length} 步</span><button className="dtc-btn sm" onClick={() => setDrawer(false)}>收起 ▾</button></div>
        <div className="dbody">
          {events.map((e, i) => { const a = ACTOR[actorOf(e)]; return (
            <div key={i} className={`dtc-ev ${i < upto ? '' : 'off'} ${i === upto - 1 ? 'cur' : ''}`} onClick={() => stepTo(i + 1)}>
              <span className="dtc-mono n">{String(i + 1).padStart(3, '0')}</span><span className="dtc-mono ts">{fmt(e.at)}</span>
              <span className={`dtc-pill ${a.cls}`}>{a.label}</span><span className="d">{describe(e, full, agentName)}<small>{e.t}</small></span>
            </div>) })}
        </div>
        <div className="dtc-scrub">
          <button className="dtc-btn sm" onClick={() => stepTo(1)} disabled={upto <= 1}>⏮</button>
          <button className="dtc-btn sm" onClick={() => stepTo(upto - 1)} disabled={upto <= 1}>◀ 上一条</button>
          <button className={`dtc-btn sm ${playing ? 'pri' : ''}`} onClick={() => { if (upto >= events.length) setCursor(1); setPlaying(p => !p) }}>{playing ? '❚❚ 暂停' : '▶ 连播'}</button>
          <button className="dtc-btn sm" onClick={() => stepTo(upto + 1)} disabled={upto >= events.length}>下一条 ▶</button>
          <button className="dtc-btn sm" onClick={() => { setPlaying(false); setCursor(null) }} disabled={cursor === null}>⏭ 回到现在</button>
          <input type="range" min={1} max={Math.max(1, events.length)} value={upto} onChange={e => stepTo(Number(e.target.value))} />
          <span className="dtc-faint" style={{ fontSize: 12 }}>上面的接力图跟着走</span>
        </div>
      </div> : null}
    </>
  )
}

function CardDetail({ api, card, runs }: { api: LedgerApi; card: Card; runs: Run[] }) {
  const latest = runs[runs.length - 1]
  const [runId, setRunId] = useState<string | undefined>(latest?.id)
  const run = runs.find(r => r.id === runId) ?? latest
  const { ledger, error } = useLedger(api, run?.sessionId || undefined, run?.status === 'running' || run?.status === 'blocked')
  return (
    <div className="bodyx">
      {runs.length > 1 ? <div className="dtc-chips" style={{ marginBottom: 8 }}>{runs.map(r => <button key={r.id} className={`dtc-chip ${r.id === run?.id ? 'on' : ''}`} onClick={() => setRunId(r.id)}>第 {r.attempt} 次 · {RUN[r.outcome ?? r.status] ?? r.status}</button>)}</div> : null}
      {run?.summary ? <><div className="dtc-faint" style={{ fontSize: 12, marginBottom: 6 }}>交接单 · {run.outcome === 'review' ? '提交验收' : 'task_complete 交的'},原样给下一张卡</div><div className="dtc-hand">{run.summary}</div></> : null}
      {run?.error ? <div className="dtc-err">{RUN[run.outcome ?? ''] ?? ''} {run.error}</div> : null}
      {run?.status === 'blocked' ? <div className="dtc-ask"><b>? {run.question}</b><div className="dtc-note">它在等你回答。点「打开会话」在会话里答,答完这里自动继续。</div></div> : null}
      {card.status === 'failed' && !run?.error ? <div className="dtc-err">{card.error}</div> : null}
      <div className="dtc-faint" style={{ fontSize: 12, margin: '12px 0 4px' }}>回合账本 · 这段会话自己的日志折出来</div>
      {error ? <div className="dtc-err">{error}</div> : ledger ? <TurnLedgerView ledger={ledger} compact /> : run?.sessionId ? <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div> : <div className="dtc-empty">没有会话。</div>}
    </div>
  )
}
