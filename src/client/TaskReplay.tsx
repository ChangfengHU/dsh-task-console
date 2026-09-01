/** Run detail: dependency graph first, selected-card evidence, and an always-visible activity stream. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cronHuman } from '../cron.ts'
import { actorOf, batchStatus, cardRun, describe, fold, type Batch, type Card, type Event, type Run, type State, type TaskSpec } from '../fold.ts'
import type { AgentRow, ArtifactView } from '../wire.ts'
import { closeConsole, go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'
import { TurnLedgerView, useLedger, type LedgerApi } from './TurnLedger.tsx'

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`
const publicUrls = (...values: (string | undefined)[]) => [...new Set(values.join('\n').match(/https:\/\/[^\s<>"'`]+/g)?.map(url => url.replace(/[),.;:!?。，；：！？]+$/u, '')) ?? [])]
const CARD: Record<string, string> = { todo: '等上游', ready: '就绪', running: '进行中', blocked: '停车等人', done: '完成', review: '待验收', failed: '失败', cancelled: '取消' }
const RUN: Record<string, string> = { completed: '交卷', review: '提交验收', blocked: '停车', crashed: '进程没了', timed_out: '超时', failed: '失败', protocol_violation: '没按协议交卷', cancelled: '取消' }
const ACTOR = { dispatcher: { label: '系统', cls: 'dtc-p-grey' }, agent: { label: 'Agent', cls: 'dtc-p-acc' }, person: { label: '人', cls: 'dtc-p-warn' }, clock: { label: '时钟', cls: 'dtc-p-park' } } as const
const BS = { run: { label: '进行中', cls: 'dtc-p-acc' }, park: { label: '停车等人', cls: 'dtc-p-park' }, review: { label: '待验收', cls: 'dtc-p-warn' }, done: { label: '完成', cls: 'dtc-p-ok' }, bad: { label: '失败', cls: 'dtc-p-bad' } } as const
const pillOf = (st: string) => st === 'done' ? 'dtc-p-ok' : st === 'review' ? 'dtc-p-warn' : st === 'running' ? 'dtc-p-acc' : st === 'blocked' ? 'dtc-p-park' : st === 'failed' ? 'dtc-p-bad' : 'dtc-p-grey'
type EventFilter = 'all' | 'process' | 'control' | 'result'
const FILTERS: { id: EventFilter; label: string }[] = [{ id: 'all', label: '全部' }, { id: 'process', label: '进程' }, { id: 'control', label: '控制' }, { id: 'result', label: '结果' }]
const ROLE_ICONS = ['🦊', '🐻', '🐰', '🐱', '🐼', '🦉']
const ROLE_COLORS = ['#ffd66b', '#a9ead4', '#ffc2d2', '#cfc5ff', '#bfe8ff', '#ffcfad']

interface ReviewGateCycle {
  cardId: string
  runId: string
  round: number
  requestedAt: string
  status: 'pending' | 'approved' | 'changes'
  decidedAt?: string
  note?: string
  targetCardId?: string
}

function eventGroup(e: Event): Exclude<EventFilter, 'all'> {
  if (e.t === 'run/session_created' || e.t === 'run/prompt_dispatched' || e.t === 'run/claimed') return 'process'
  if (e.t === 'run/completed' || e.t === 'run/failed' || e.t === 'run/timed_out' || e.t === 'run/cancelled' || e.t === 'artifact/registered' || e.t === 'artifact/published' || e.t === 'batch/settled') return 'result'
  return 'control'
}

function belongsToBatch(e: Event, batchId: string): boolean {
  if (e.t === 'batch/fired') return e.batch.id === batchId
  if (e.t === 'batch/settled') return e.batchId === batchId
  if (e.t === 'artifact/registered') return e.artifact.batchId === batchId
  if ('cardId' in e && typeof e.cardId === 'string') return e.cardId.startsWith(`${batchId}#`)
  if ('runId' in e && typeof e.runId === 'string') return e.runId.startsWith(`${batchId}#`)
  return false
}

function reviewGateCycles(rows: { e: Event; index: number }[], state: State): ReviewGateCycle[] {
  const cycles: ReviewGateCycle[] = []
  for (const { e } of rows) {
    if (e.t === 'run/review_requested') {
      const run = state.runs.get(e.runId)
      if (!run) continue
      cycles.push({ cardId: run.cardId, runId: e.runId, round: cycles.filter(cycle => cycle.cardId === run.cardId).length + 1, requestedAt: e.at, status: 'pending' })
    } else if (e.t === 'card/review_approved' || e.t === 'card/changes_requested') {
      const cycle = [...cycles].reverse().find(row => row.runId === e.runId)
      if (!cycle) continue
      cycle.status = e.t === 'card/review_approved' ? 'approved' : 'changes'; cycle.decidedAt = e.at; cycle.note = e.note
      if (e.t === 'card/changes_requested') cycle.targetCardId = e.targetCardId
    }
  }
  return cycles
}

export function TaskReplay({ api, agents, id, runId, toast }: { api: TasksApi & LedgerApi; agents: AgentRow[]; id: string; runId?: string; toast: (m: string) => void }) {
  const [events, setEvents] = useState<Event[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([])
  const [artifactBatch, setArtifactBatch] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [eventFilter, setEventFilter] = useState<EventFilter>('all')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let stop = false
    const loadEvents = async () => {
      try {
        const next = await api.taskEvents(id)
        if (!stop) { setEvents(next as Event[]); setError('') }
      } catch (e) { if (!stop) setError(String((e as Error).message ?? e)) }
    }
    const loadSnapshot = async () => {
      try {
        const next = await api.taskSnapshot(id, runId)
        if (!stop) { setEvents(next.events as Event[]); setArtifacts(next.artifacts); setArtifactBatch(next.batchId); setError('') }
      } catch (e) { if (!stop) setError(String((e as Error).message ?? e)) }
    }
    void loadSnapshot(); const t = window.setInterval(loadEvents, 2500)
    return () => { stop = true; window.clearInterval(t) }
  }, [api, id, runId])

  const upto = cursor === null ? events.length : Math.min(cursor, events.length)
  const full = useMemo(() => fold(events), [events])
  const now = useMemo(() => cursor === null ? full : fold(events.slice(0, upto)), [events, upto, cursor, full])
  const task: TaskSpec | undefined = full.tasks.get(id)
  const batches = [...full.batches.values()].filter(b => b.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
  const selId = runId ?? batches[0]?.id
  const batchFull: Batch | undefined = selId ? full.batches.get(selId) : undefined
  const batchNow: Batch | undefined = selId ? now.batches.get(selId) : undefined

  useEffect(() => {
    let stop = false
    if (!selId) { setArtifacts([]); setArtifactBatch(null); return }
    const load = () => api.taskArtifacts(id, selId).then(a => { if (!stop) { setArtifacts(a); setArtifactBatch(selId) } }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    if (artifactBatch !== selId) void load()
    const t = window.setInterval(load, 3000)
    return () => { stop = true; window.clearInterval(t) }
  }, [api, id, selId, artifactBatch])

  useEffect(() => {
    const cards = batchFull?.cardIds.map(cid => full.cards.get(cid)).filter(Boolean) as Card[] | undefined
    if (!cards?.length) { setSelectedCard(null); return }
    if (!selectedCard || !cards.some(c => c.id === selectedCard)) {
      const best = cards.find(c => c.status === 'running' || c.status === 'blocked' || c.status === 'review') ?? [...cards].reverse().find(c => c.runIds.length) ?? cards[0]
      setSelectedCard(best.id)
    }
  }, [batchFull?.id, events.length])

  useEffect(() => {
    if (!playing) { window.clearTimeout(timer.current); return }
    if (upto >= events.length) { setPlaying(false); setCursor(null); return }
    timer.current = window.setTimeout(() => setCursor(c => (c ?? 0) + 1), 700)
    return () => window.clearTimeout(timer.current)
  }, [playing, upto, events.length])

  const agentName = (aid: string) => agents.find(a => a.id === aid)?.name ?? aid
  if (!task) return <div className="dtc-empty">{error || (events.length ? '没有这个任务' : <><span className="dtc-spin" /> 读取事件流…</>)}</div>

  const cardsNow = batchNow ? batchNow.cardIds.map(cid => now.cards.get(cid)).filter(Boolean) as Card[] : []
  const cardsFull = batchFull ? batchFull.cardIds.map(cid => full.cards.get(cid)).filter(Boolean) as Card[] : []
  const selected = selectedCard ? full.cards.get(selectedCard) : undefined
  const bst = batchFull ? batchStatus(full, batchFull) : undefined
  const stopAt = cursor !== null ? events[upto - 1]?.at : undefined
  const total = cardsFull.length ? dur(cardsFull.find(c => c.startedAt)?.startedAt, batchFull?.settled?.at ?? [...cardsFull].reverse().find(c => c.endedAt)?.endedAt) : ''
  const batchEvents = batchFull ? events.map((e, index) => ({ e, index })).filter(x => belongsToBatch(x.e, batchFull.id)) : []
  const visibleBatchEvents = batchEvents.filter(({ index }) => index < upto)
  const filteredEvents = batchEvents.filter(({ e }) => eventFilter === 'all' || eventGroup(e) === eventFilter)
  const reviewCycles = reviewGateCycles(visibleBatchEvents, now)
  const reworkCycles = reviewCycles.filter(cycle => cycle.status === 'changes')
  const lastCard = [...cardsFull].reverse().find(c => c.summary)
  const lastRun = lastCard ? cardRun(full, lastCard) : undefined
  const metricCards = cursor === null ? cardsFull : cardsNow
  const doneCount = metricCards.filter(card => card.status === 'done').length
  const activeCount = metricCards.filter(card => card.status === 'running' || card.status === 'blocked' || card.status === 'review').length
  const dependencyCount = cardsFull.reduce((sum, card) => sum + card.deps.length, 0)
  const claimCount = batchEvents.filter(({ e }) => e.t === 'run/claimed').length
  const gateCount = reviewCycles.filter(cycle => cycle.status === 'pending').length
  const gateApproved = reviewCycles.filter(cycle => cycle.status === 'approved').length
  const gateChanges = reviewCycles.filter(cycle => cycle.status === 'changes').length
  const eventStep = batchEvents.filter(({ index }) => index < upto).length
  const progress = metricCards.length ? Math.round(doneCount / metricCards.length * 100) : 0

  const stepTo = (n: number) => { setPlaying(false); const v = Math.max(1, Math.min(n, events.length)); setCursor(v >= events.length ? null : v) }
  const refreshArtifacts = async () => { if (selId) { setArtifacts(await api.taskArtifacts(id, selId)); setArtifactBatch(selId) } }

  return (
    <div className="dtc-cartoon">
      <header className="dtc-cartoon-head">
        <button className="dtc-cartoon-back" onClick={() => go('tasks')} title="返回任务中心">←</button>
        <div className="dtc-cartoon-logo">🛠️</div>
        <div className="dtc-cartoon-title"><span>DSH TASK STUDIO</span><h1>{task.title}</h1><small>{batchFull ? `${batchFull.id} · ${cardsFull.length} 个角色${total ? ` · ${total}` : ''}` : '还没运行'}</small></div>
        <div className="dtc-cartoon-live"><i />SQLite 事件内核在线</div>
        <div className="dtc-cartoon-actions">
          {batches.length > 1 ? <select value={selId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)}>{batches.map(b => <option key={b.id} value={b.id}>{b.id === batches[0].id ? '这次运行' : '之前'} · {fmt(b.firedAt)} · {BS[batchStatus(full, b)].label}</option>)}</select> : null}
          <button className="dtc-btn pri" onClick={async () => { const { runId: rid } = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${rid}`) }}>▶ 再跑一次</button>
          {batchFull && (bst === 'run' || bst === 'park') ? <button className="dtc-btn" onClick={async () => { await api.cancelRun(batchFull.id); toast('已取消') }}>取消</button> : null}
          <button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); go('tasks') }}>删除</button>
        </div>
      </header>
      {error ? <div className="dtc-err">{error}</div> : null}

      <section className="dtc-cartoon-summary">
        <div><span>事项组进度</span><strong>{doneCount} / {metricCards.length}</strong><div className="track"><i style={{ width: `${progress}%` }} /></div></div>
        <div><span>活跃角色</span><strong>{activeCount}</strong><em>{cardsFull.length} 个预置 Agent</em></div>
        <div><span>依赖边</span><strong>{dependencyCount}</strong><em>按 handoff 顺序放行</em></div>
        <div><span>领取尝试</span><strong>{claimCount}</strong><em>真实 run/claimed</em></div>
        <div><span>人工闸门</span><strong>{reviewCycles.length}</strong><em>{gateCount ? `${gateCount} 个待决策` : gateApproved ? `${gateApproved} 个已批准` : gateChanges ? `${gateChanges} 次退回` : '尚未创建'}</em></div>
      </section>

      <main className="dtc-cpanel dtc-cworkspace dtc-cworkspace-top">
        <div className="dtc-cpanel-head"><div><b>任务依赖图</b><small>角色节点、依赖 Gate、人工 Gate 与返工轮次来自同一条事件流</small></div><code>{batchFull?.id ?? '尚未创建'}</code></div>
        <div className="dtc-ccanvas">
          {cardsNow.length ? <div className="dtc-cflow">{cardsNow.map(card => {
            const run = cardRun(now, card)
            const parents = card.deps.map(dep => now.cards.get(dep)).filter(Boolean) as Card[]
            const dependencyOpen = parents.length > 0 && parents.every(parent => parent.status === 'done')
            const gates = reviewCycles.filter(cycle => cycle.cardId === card.id)
            const latestGate = gates[gates.length - 1]
            const attempts = card.runIds.map(rid => now.runs.get(rid)).filter(Boolean) as Run[]
            return <div className="dtc-cflow-step" key={card.id}>
              {parents.length ? <div className={`dtc-dependency-gate ${dependencyOpen ? 'open' : 'waiting'}`}><span className="diamond">◇</span><div><b>依赖 Gate</b><small>{dependencyOpen ? 'handoff 已封存' : `等待 ${parents.map(parent => agentName(parent.agentId)).join('、')}`}</small></div><em>{dependencyOpen ? 'OPEN' : 'WAIT'}</em><i>→</i></div> : null}
              <button className={`dtc-node dtc-cnode s-${card.status} ${selectedCard === card.id ? 'selected' : ''}`} onClick={() => setSelectedCard(card.id)}>
                {card.status === 'running' ? <span className="dtc-claim-lock">🔐 CLAIMED</span> : null}
                <div className="dtc-cnode-top"><i style={{ background: ROLE_COLORS[card.index % ROLE_COLORS.length] }}>{ROLE_ICONS[card.index % ROLE_ICONS.length]}</i><div><b>{agentName(card.agentId)}</b><small>{task.participants[card.index]?.brief || `角色 ${card.index + 1}`}</small></div><span className={`dtc-pill ${pillOf(card.status)}`}>{CARD[card.status]}</span></div>
                <div className="dtc-cnode-meta"><span>Attempt {Math.max(1, card.runIds.length)}</span><span>{card.startedAt ? dur(card.startedAt, card.endedAt ?? stopAt) : '未开始'}</span><span>{run?.sessionCreatedAt ? 'Session 已创建' : run ? '已领取' : '未领取'}</span></div>
                {attempts.length > 1 ? <div className="dtc-attempt-strip">{attempts.map(attempt => { const gate = reviewCycles.find(cycle => cycle.runId === attempt.id); const state = gate?.status === 'changes' ? '返工' : gate?.status === 'approved' ? '通过' : RUN[attempt.outcome ?? attempt.status] ?? attempt.status; return <span key={attempt.id} className={gate?.status ?? ''}>A{attempt.attempt} · {state}</span> })}</div> : null}
                {run?.status === 'blocked' ? <div className="q">? {run.question}</div> : null}
              </button>
              {latestGate ? <div className={`dtc-human-gate ${latestGate.status}`}><i>→</i><span className="diamond">◇</span><div><b>人工验收 Gate #{latestGate.round}</b><small>{latestGate.status === 'pending' ? '等待人工决策' : latestGate.status === 'approved' ? '已批准，允许结算' : `已退回 ${agentName(full.cards.get(latestGate.targetCardId ?? latestGate.cardId)?.agentId ?? '')}`}</small></div><em>{latestGate.status === 'pending' ? 'PENDING' : latestGate.status === 'approved' ? 'APPROVED' : 'CHANGES'}</em></div> : null}
            </div>
          })}</div> : <div className="dtc-empty">这个时刻还没有运行。</div>}
          {reworkCycles.length ? <div className="dtc-rework-map"><b>↩ 返工回路</b>{reworkCycles.map(cycle => { const source = full.cards.get(cycle.cardId); const target = full.cards.get(cycle.targetCardId ?? cycle.cardId); return <button key={cycle.runId} onClick={() => target && setSelectedCard(target.id)}><span>Gate #{cycle.round}</span><strong>{source ? agentName(source.agentId) : '验收'} </strong><i>CHANGES_REQUESTED</i><strong> {target ? agentName(target.agentId) : '原角色'}</strong><small>{cycle.note}</small></button> })}</div> : null}
          <div className="dtc-cstep"><b>{String(eventStep).padStart(2, '0')} / {String(batchEvents.length).padStart(2, '0')}</b><div className="track"><i style={{ width: `${batchEvents.length ? eventStep / batchEvents.length * 100 : 0}%` }} /></div><span>{cursor === null ? '现在 · 实时跟随' : `回放到 ${fmt(stopAt)}`}</span></div>
        </div>
      </main>

      <section className="dtc-cartoon-layout">
        <aside className="dtc-cpanel dtc-croles">
          <div className="dtc-cpanel-head"><div><b>角色与状态</b><small>真实 Agent presence</small></div><span>PRESENCE</span></div>
          <div className="dtc-crole-list">{cardsNow.map(card => <button key={card.id} className={selectedCard === card.id ? 'selected' : ''} onClick={() => setSelectedCard(card.id)}>
            <i style={{ background: ROLE_COLORS[card.index % ROLE_COLORS.length] }}>{ROLE_ICONS[card.index % ROLE_ICONS.length]}</i><span><b>{agentName(card.agentId)}</b><small>角色 {card.index + 1} · {CARD[card.status]}</small></span><em className={`s-${card.status}`} />
          </button>)}</div>
          <div className="dtc-control-list"><h4>CONTROL NODES</h4><div><i>◇</i><span><b>依赖 Gate</b><small>{dependencyCount} 条依赖边</small></span><em>{cardsNow.filter(card => card.deps.length && card.deps.every(dep => now.cards.get(dep)?.status === 'done')).length}/{dependencyCount}</em></div><div><i>🚪</i><span><b>人工验收 Gate</b><small>{reworkCycles.length ? `${reworkCycles.length} 次返工` : '没有返工'}</small></span><em>{gateCount ? `${gateCount} 待决` : gateApproved ? `${gateApproved} 通过` : gateChanges ? `${gateChanges} 退回` : '未创建'}</em></div></div>
          <div className="dtc-clegend"><b>状态来自事件折叠</b><br />claimed → running；blocked / review 单独表达；完成后释放下游依赖。</div>
        </aside>

        <aside className="dtc-cpanel dtc-cstream">
          <div className="dtc-cpanel-head"><div><b>事件流原语</b><small>append-only · 可回放 · 可审计</small></div><span>{batchEvents.length} EVENTS</span></div>
          <div className="dtc-cevent-tools">{FILTERS.map(filter => <button key={filter.id} className={eventFilter === filter.id ? 'on' : ''} onClick={() => setEventFilter(filter.id)}>{filter.label}</button>)}</div>
          <div className="dtc-activity-list">{[...filteredEvents].reverse().map(({ e, index }) => { const actor = ACTOR[actorOf(e)]; const group = eventGroup(e); return <button key={index} className={`dtc-activity-row g-${group} ${index >= upto ? 'off' : ''} ${index === upto - 1 ? 'cur' : ''}`} onClick={() => stepTo(index + 1)}>
            <span className="dot">{group === 'process' ? '›' : group === 'result' ? '✓' : '•'}</span><span className="copy"><b>{e.t}</b><span>{describe(e, full, agentName)}</span><small>{fmt(e.at)} · event #{index + 1}</small></span><span className={`dtc-pill ${actor.cls}`}>{actor.label}</span>
          </button>})}</div>
          <div className="dtc-replayctl"><button className="dtc-btn sm" onClick={() => stepTo(Math.max(1, upto - 1))} disabled={upto <= 1}>←</button><button className={`dtc-btn sm ${playing ? 'pri' : ''}`} onClick={() => { if (upto >= events.length) setCursor(Math.max(1, batchEvents[0]?.index ?? 0)); setPlaying(value => !value) }}>{playing ? '暂停' : '播放'}</button><button className="dtc-btn sm" onClick={() => stepTo(upto + 1)} disabled={upto >= events.length}>→</button><button className="dtc-btn sm" onClick={() => { setPlaying(false); setCursor(null) }} disabled={cursor === null}>现在</button><span className="dtc-faint">{upto}/{events.length}</span></div>
        </aside>
      </section>

      {selected ? <div className="dtc-cartoon-drawer"><CardEvidence api={api} taskId={id} batchId={batchFull?.id} card={selected} parents={selected.deps.map(dep => full.cards.get(dep)).filter(Boolean) as Card[]} reworkTargets={cardsFull.filter(card => card.index <= selected.index)} gates={reviewCycles.filter(cycle => cycle.cardId === selected.id)} runs={selected.runIds.map(rid => full.runs.get(rid)).filter(Boolean) as Run[]} artifacts={artifacts.filter(a => a.cardId === selected.id)} agentName={agentName(selected.agentId)} labelOf={agentName} toast={toast} refreshArtifacts={refreshArtifacts} /></div> : null}

      {batchFull && bst && bst !== 'run' && bst !== 'park' ? <ResultPanel api={api} taskId={id} batchId={batchFull.id} status={bst} summary={lastCard?.summary} metadata={lastRun?.metadata} artifacts={artifacts} toast={toast} refresh={refreshArtifacts} /> : null}

      <details className="dtc-cpanel dtc-cartoon-details"><summary>任务书与运行边界</summary><div className="dtc-hand">{task.brief}</div><div className="dtc-kv"><span className="k">工作区</span><span className="dtc-mono">{task.cwd}</span><span className="k">触发</span><span>{task.trigger.kind === 'cron' ? cronHuman(task.trigger.expr) : '单次'}</span><span className="k">超时</span><span>{Math.round(task.timeoutSec / 60)} 分钟 / 角色</span><span className="k">失败后</span><span>{task.onFail === 'retry' ? `自动重试，最多 ${task.maxTries} 次` : '停下'}</span></div></details>
    </div>
  )
}

function ResultPanel({ api, taskId, batchId, status, summary, metadata, artifacts, toast, refresh }: { api: TasksApi; taskId: string; batchId: string; status?: keyof typeof BS; summary?: string; metadata?: Record<string, unknown>; artifacts: ArtifactView[]; toast: (m: string) => void; refresh: () => Promise<void> }) {
  const links = publicUrls(summary, metadata ? JSON.stringify(metadata) : undefined)
  return <section className="dtc-result">
    <div className="dtc-result-head"><div><span className="eyebrow">RUN RESULT</span><h2>{status === 'done' ? '任务已完成' : status === 'bad' ? '任务未完成' : status === 'park' ? '正在等待输入' : status === 'review' ? '正在等待人工验收' : '任务正在运行'}</h2></div>{status ? <span className={`dtc-pill ${BS[status].cls}`}>{BS[status].label}</span> : null}</div>
    <div className="dtc-result-grid"><div><h3>最终交接</h3>{links.length ? <div className="dtc-public-results"><b>公网结果</b>{links.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">{links.length > 1 ? `打开结果 ${index + 1}` : '打开公网结果'} ↗</a>)}</div> : null}<div className="dtc-result-copy">{summary || <span className="dtc-faint">最后一个角色交卷后，结果会显示在这里。</span>}</div>{metadata ? <pre className="dtc-meta">{JSON.stringify(metadata, null, 2)}</pre> : null}</div>
      <div><h3>交付产物 <span className="dtc-faint">{artifacts.length}</span></h3><ArtifactList api={api} taskId={taskId} batchId={batchId} artifacts={artifacts} toast={toast} refresh={refresh} empty="还没有登记产物。新任务会把 task_complete 的 artifacts 保存成可访问副本。" /></div>
    </div>
  </section>
}

function CardEvidence({ api, taskId, batchId, card, parents, reworkTargets, gates, runs, artifacts, agentName, labelOf, toast, refreshArtifacts }: { api: TasksApi & LedgerApi; taskId: string; batchId?: string; card: Card; parents: Card[]; reworkTargets: Card[]; gates: ReviewGateCycle[]; runs: Run[]; artifacts: ArtifactView[]; agentName: string; labelOf: (id: string) => string; toast: (m: string) => void; refreshArtifacts: () => Promise<void> }) {
  const latest = runs[runs.length - 1]
  const [runId, setRunId] = useState<string | undefined>(latest?.id)
  const [tab, setTab] = useState<'handoff' | 'claim' | 'ledger' | 'gate' | 'artifacts'>('handoff')
  const [reviewNote, setReviewNote] = useState('')
  const [reworkTarget, setReworkTarget] = useState(card.deps[0] ?? card.id)
  const [busy, setBusy] = useState(false)
  const run = runs.find(r => r.id === runId) ?? latest
  const latestGate = gates[gates.length - 1]
  useEffect(() => { setRunId(latest?.id) }, [card.id, runs.length])
  useEffect(() => { setReworkTarget(card.deps[0] ?? card.id) }, [card.id])
  const { ledger, error } = useLedger(api, tab === 'ledger' ? run?.sessionId : undefined, run?.status === 'running' || run?.status === 'blocked')
  const decide = async (decision: 'approve' | 'changes') => {
    setBusy(true)
    try { await api.reviewCard(card.id, decision, reviewNote, decision === 'changes' ? reworkTarget : undefined); toast(decision === 'approve' ? '已验收通过' : `已退回 ${labelOf(reworkTargets.find(target => target.id === reworkTarget)?.agentId ?? '')}`); setReviewNote('') }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return <div className="dtc-panel dtc-evidence">
    <div className="dtc-evidence-head"><div className="dtc-selected-avatar">{ROLE_ICONS[card.index % ROLE_ICONS.length]}</div><div><span className="eyebrow">SELECTED ROLE</span><h2>{agentName}</h2><small className="dtc-faint">角色 {card.index + 1} · {card.id}</small></div><span className={`dtc-pill ${pillOf(card.status)}`}>{CARD[card.status]}</span><span className="sp" />
      {run?.sessionId ? <button className="dtc-btn sm" onClick={() => { closeConsole(); void api.openSession(run.sessionId) }}>打开会话</button> : null}
    </div>
    {runs.length > 1 ? <div className="dtc-chips">{runs.map(r => <button key={r.id} className={`dtc-chip ${r.id === run?.id ? 'on' : ''}`} onClick={() => setRunId(r.id)}>尝试 {r.attempt} · {RUN[r.outcome ?? r.status] ?? r.status}</button>)}</div> : null}
    <div className="dtc-tabs"><button className={tab === 'handoff' ? 'on' : ''} onClick={() => setTab('handoff')}>交接 Handoff</button><button className={tab === 'claim' ? 'on' : ''} onClick={() => setTab('claim')}>领取 Claim</button><button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>会话工具</button><button className={tab === 'gate' ? 'on' : ''} onClick={() => setTab('gate')}>闸门 Gate</button><button className={tab === 'artifacts' ? 'on' : ''} onClick={() => setTab('artifacts')}>产物证据 {artifacts.length}</button></div>
    {tab === 'handoff' ? <div className="dtc-tabbody">
      <div className="dtc-cartoon-note"><h4>📮 本次运行收到的上游交接</h4>{parents.length ? <ul>{parents.map(parent => <li key={parent.id}><b>角色 {parent.index + 1}</b><span>{parent.summary || '上游尚未交卷'}</span></li>)}</ul> : <p>入口角色没有父交接，直接读取任务书。</p>}</div>
      <h3 className="dtc-section-label">本角色交接输出</h3>{run?.summary ? <div className="dtc-hand">{run.summary}</div> : <div className="dtc-empty">还没有交接单。</div>}
      {run?.error ? <div className="dtc-err">{run.error}</div> : null}
      {run?.status === 'blocked' ? <div className="dtc-ask"><b>? {run.question}</b><div className="dtc-note">在这个会话里回答后会自动继续。</div></div> : null}
    </div> : null}
    {tab === 'claim' ? <div className="dtc-tabbody"><div className="dtc-cartoon-note"><h4>🔐 真实领取记录</h4><p>本地 SQLite 版由单一调度器串行领取，避免同一进程重复启动；这里展示真实 run/claimed 与会话边界，不伪造分布式租约。</p></div><div className="dtc-kv dtc-runfacts"><span className="k">Run</span><span className="dtc-mono">{run?.id || '—'}</span><span className="k">尝试</span><span>{run?.attempt ?? 0} / {card.runIds.length || 1}</span><span className="k">领取</span><span>{fmt(run?.startedAt) || '—'}</span><span className="k">会话创建</span><span>{fmt(run?.sessionCreatedAt) || '等待中'}</span><span className="k">提示词发送</span><span>{fmt(run?.promptDispatchedAt) || '等待中'}</span><span className="k">Session</span><span className="dtc-mono">{run?.sessionId || '—'}</span></div></div> : null}
    {tab === 'ledger' ? <div className="dtc-tabbody">{error ? <div className="dtc-err">{error}</div> : ledger ? <TurnLedgerView ledger={ledger} compact /> : run?.sessionId ? <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div> : <div className="dtc-empty">没有会话。</div>}</div> : null}
    {tab === 'gate' ? <div className="dtc-tabbody"><div className={`dtc-cartoon-gate ${card.status === 'review' ? 'pending' : latestGate?.status ?? ''}`}><span>{card.status === 'review' ? '🚪' : latestGate?.status === 'approved' ? '✅' : latestGate?.status === 'changes' ? '↩' : '🪁'}</span><div><b>{card.status === 'review' ? '正在等待人工验收' : latestGate?.status === 'approved' ? '人工闸门已批准' : latestGate?.status === 'changes' ? `已退回 ${labelOf(reworkTargets.find(target => target.id === latestGate.targetCardId)?.agentId ?? '')}` : '这个角色没有请求人工闸门'}</b><p>{card.status === 'review' ? '批准前不会放行下游，也不会结算整个任务组。退回时可选择从哪个上游角色重新开始。' : latestGate?.status === 'approved' ? '审批事件已写入事件流，下游可以继续。' : latestGate?.status === 'changes' ? latestGate.note : '只有 Agent 调用 task_request_review 后才会创建控制节点。'}</p></div></div>{gates.length ? <div className="dtc-gate-history"><h4>闸门历史</h4>{gates.map(gate => <div key={gate.runId}><span>Gate #{gate.round}</span><b>{gate.status === 'pending' ? '等待决策' : gate.status === 'approved' ? '通过' : `退回 ${labelOf(reworkTargets.find(target => target.id === gate.targetCardId)?.agentId ?? '')}`}</b><small>{fmt(gate.requestedAt)}{gate.note ? ` · ${gate.note}` : ''}</small></div>)}</div> : null}{card.status === 'review' ? <div className="dtc-review"><textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="验收意见；退回修改时必填" /><label className="dtc-rework-target">退回到<select value={reworkTarget} onChange={e => setReworkTarget(e.target.value)}>{reworkTargets.map(target => <option value={target.id} key={target.id}>{target.index + 1}. {labelOf(target.agentId)}{target.id === card.deps[0] ? '（默认）' : ''}</option>)}</select></label><div className="dtc-chips"><button className="dtc-btn pri" disabled={busy} onClick={() => decide('approve')}>通过并放行</button><button className="dtc-btn danger" disabled={busy || !reviewNote.trim()} onClick={() => decide('changes')}>退回并开启返工轮次</button></div></div> : null}</div> : null}
    {tab === 'artifacts' ? <div className="dtc-tabbody"><ArtifactList api={api} taskId={taskId} batchId={batchId} artifacts={artifacts} toast={toast} refresh={refreshArtifacts} empty="这个角色没有登记产物。" /></div> : null}
  </div>
}

function ArtifactList({ api, taskId, batchId, artifacts, toast, refresh, empty }: { api: TasksApi; taskId: string; batchId?: string; artifacts: ArtifactView[]; toast: (m: string) => void; refresh: () => Promise<void>; empty: string }) {
  const [busy, setBusy] = useState('')
  const blobFor = async (a: ArtifactView) => {
    const { base64 } = await api.artifactContent(taskId, a.id, batchId)
    const raw = atob(base64); const data = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
    return URL.createObjectURL(new Blob([data], { type: a.mime }))
  }
  const preview = async (a: ArtifactView) => {
    const tab = window.open('', '_blank')
    setBusy(a.id)
    try { const url = await blobFor(a); if (tab) tab.location.href = url; else window.open(url, '_blank', 'noopener') }
    catch (e) { tab?.close(); toast(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  const download = async (a: ArtifactView) => {
    setBusy(a.id)
    try { const url = await blobFor(a); const link = document.createElement('a'); link.href = url; link.download = a.name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000) }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  const publish = async (a: ArtifactView) => {
    if (!window.confirm(`把 ${a.name} 发布为任何人都可访问的公网链接?`)) return
    setBusy(a.id)
    try { const { publicUrl } = await api.publishArtifact(taskId, a.id); await refresh(); await navigator.clipboard?.writeText(publicUrl); toast('已发布，公网链接已复制') }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  if (!artifacts.length) return <div className="dtc-empty dtc-art-empty">{empty}</div>
  return <div className="dtc-artifacts">{artifacts.map(a => <div className="dtc-artifact" key={a.id}>
    <div className="file">{a.mime.startsWith('image/') ? '▧' : a.mime === 'text/html' ? '◇' : '▤'}</div><div className="info"><b>{a.name}</b><span>{bytes(a.size)} · SHA256 {a.sha256.slice(0, 10)}…</span><span className="dtc-mono" title={a.originalPath}>{a.originalPath}</span></div>
    <div className="badges">{a.legacy ? <span className="dtc-pill dtc-p-warn">历史路径</span> : <span className="dtc-pill dtc-p-ok">已保存副本</span>}{a.publicUrl ? <a href={a.publicUrl} target="_blank" rel="noreferrer">公网链接 ↗</a> : null}</div>
    <div className="actions"><button className="dtc-btn sm" disabled={busy === a.id} onClick={() => preview(a)}>预览</button><button className="dtc-btn sm" disabled={busy === a.id} onClick={() => download(a)}>下载</button>{!a.legacy && (a.mime === 'text/html' || /\.html?$/i.test(a.name)) && !a.publicUrl ? <button className="dtc-btn sm pri" disabled={busy === a.id} onClick={() => publish(a)}>发布公网</button> : null}</div>
  </div>)}</div>
}
