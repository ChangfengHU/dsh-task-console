/** Run detail: dependency graph first, selected-card evidence, and an always-visible activity stream. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cronHuman } from '../cron.ts'
import { actorOf, batchStatus, cardRun, describe, fold, type Batch, type Card, type Event, type Run, type State, type TaskSpec } from '../fold.ts'
import { buildTaskGraph, layoutTaskGraph, type PositionedTaskGraph, type TaskGraphNode } from '../task-graph.ts'
import type { AgentRow, ArtifactView } from '../wire.ts'
import { closeConsole, go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'
import { TurnLedgerView, useLedger, type LedgerApi } from './TurnLedger.tsx'

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`
const publicUrls = (...values: (string | undefined)[]) => [...new Set(values.join('\n').match(/https:\/\/[^\s<>"'`]+/g)?.map(url => url.replace(/[),.;:!?。，；：！？]+$/u, '')) ?? [])]
const CARD: Record<string, string> = { todo: '等上游', ready: '就绪', running: '进行中', blocked: '停车等人', done: '完成', review: '待验收', failed: '失败', cancelled: '取消' }
const RUN: Record<string, string> = { completed: '交卷', review: '提交验收', changes_requested: '退回修改', blocked: '停车', crashed: '进程没了', timed_out: '超时', failed: '失败', protocol_violation: '没按协议交卷', cancelled: '取消' }
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
  mode: 'human' | 'agent'
  reviewerId?: string
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
      cycles.push({ cardId: run.cardId, runId: e.runId, round: cycles.filter(cycle => cycle.cardId === run.cardId).length + 1, requestedAt: e.at, status: 'pending', mode: e.reviewer ? 'agent' : 'human', reviewerId: e.reviewer })
    } else if (e.t === 'card/review_approved' || e.t === 'card/changes_requested') {
      const cycle = [...cycles].reverse().find(row => row.cardId === e.cardId && row.status === 'pending')
      if (!cycle) continue
      cycle.status = e.t === 'card/review_approved' ? 'approved' : 'changes'; cycle.decidedAt = e.at; cycle.note = e.note
      if (e.t === 'card/changes_requested') cycle.targetCardId = e.targetCardId
    } else if (e.t === 'run/completed') {
      const run = state.runs.get(e.runId)
      if (!run) continue
      const cycle = [...cycles].reverse().find(row => row.cardId === run.cardId && row.mode === 'agent' && row.status === 'pending' && row.reviewerId === run.profileId)
      if (cycle) { cycle.status = 'approved'; cycle.decidedAt = e.at; cycle.note = e.summary }
    }
  }
  return cycles
}

function TaskDag({ graph, cards, selected, onSelect }: { graph: PositionedTaskGraph; cards: Card[]; selected: string | null; onSelect: (node: TaskGraphNode) => void }) {
  const [zoom, setZoom] = useState(.9)
  const viewport = useRef<HTMLDivElement | null>(null)
  const cardById = new Map(cards.map(card => [card.id, card]))
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const nodeWidth = 184
  const nodeHeight = 96
  const flowPath = (from: string, to: string) => {
    const a = graph.positions.get(from); const b = graph.positions.get(to)
    if (!a || !b) return ''
    const sx = a.x + nodeWidth; const sy = a.y + nodeHeight / 2; const tx = b.x; const ty = b.y + nodeHeight / 2; const bend = Math.max(34, (tx - sx) * .46)
    return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
  }
  const feedbackPath = (from: string, to: string, index: number) => {
    const a = graph.positions.get(from); const b = graph.positions.get(to)
    if (!a || !b) return ''
    const sx = a.x + nodeWidth / 2; const sy = a.y + nodeHeight; const tx = b.x + nodeWidth / 2; const ty = b.y + nodeHeight; const floor = graph.height - 30 - index * 16
    return `M ${sx} ${sy} C ${sx} ${floor}, ${tx} ${floor}, ${tx} ${ty}`
  }
  const icon = (node: TaskGraphNode) => {
    if (node.kind === 'gate') return '◇'
    if (node.kind === 'reviewer') return '🦉'
    if (node.kind === 'human') return '👤'
    if (node.kind === 'terminal') return node.id === 'terminal:start' ? '▶' : '✓'
    const card = node.cardId ? cardById.get(node.cardId) : undefined
    return ROLE_ICONS[(card?.index ?? 0) % ROLE_ICONS.length]
  }
  const feedback = graph.edges.filter(edge => edge.kind === 'feedback')
  const fitGraph = () => {
    const width = viewport.current?.clientWidth ?? graph.width
    const height = viewport.current?.clientHeight ?? graph.height
    setZoom(Math.max(.35, Math.min(1.15, +Math.min((width - 24) / graph.width, (height - 24) / graph.height).toFixed(2))))
  }
  return <div className="dtc-dag-wrap">
    <div className="dtc-dag-tools"><div className="dtc-dag-legend"><span><i className="role" />角色任务</span><span><i className="reviewer" />评估者</span><span><i className="gate" />控制闸门</span><span><i className="feedback" />历史返工</span></div><div className="dtc-dag-zoom"><button title="缩小" onClick={() => setZoom(value => Math.max(.35, +(value - .1).toFixed(2)))} disabled={zoom <= .35}>−</button><b>{Math.round(zoom * 100)}%</b><button title="放大" onClick={() => setZoom(value => Math.min(1.15, +(value + .1).toFixed(2)))} disabled={zoom >= 1.15}>＋</button><button title="完整显示全部节点" onClick={fitGraph}>全图</button></div></div>
    <div className="dtc-dag-viewport" ref={viewport}>
      <div className="dtc-dag-scaled" style={{ width: graph.width * zoom, height: graph.height * zoom }}>
        <div className="dtc-dag-surface" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
          <svg className="dtc-dag-edges" width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} aria-hidden="true">
            <defs><marker id="dtc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker><marker id="dtc-feedback-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
            {graph.edges.filter(edge => edge.kind !== 'feedback').map(edge => { const a = graph.positions.get(edge.from); const b = graph.positions.get(edge.to); if (!a || !b) return null; const sx = a.x + nodeWidth; const tx = b.x; const sy = a.y + nodeHeight / 2; const ty = b.y + nodeHeight / 2; return <g key={edge.id} className={`dtc-dag-edge ${edge.kind}`}><path d={flowPath(edge.from, edge.to)} markerEnd="url(#dtc-arrow)" />{edge.label ? <text x={(sx + tx) / 2} y={(sy + ty) / 2 - 8}>{edge.label}</text> : null}</g> })}
            {feedback.map((edge, index) => { const a = graph.positions.get(edge.from); const b = graph.positions.get(edge.to); if (!a || !b) return null; const floor = graph.height - 30 - index * 16; return <g key={edge.id} className="dtc-dag-edge feedback"><path d={feedbackPath(edge.from, edge.to, index)} markerEnd="url(#dtc-feedback-arrow)" /><text x={(a.x + b.x) / 2 + nodeWidth / 2} y={floor - 7}>{edge.label}</text></g> })}
          </svg>
          {graph.nodes.map(node => { const pos = graph.positions.get(node.id); if (!pos) return null; const card = node.cardId ? cardById.get(node.cardId) : undefined; return <button type="button" key={node.id} data-node-id={node.id} className={`dtc-dag-node k-${node.kind} s-${node.status} ${selected === node.id ? 'selected' : ''}`} style={{ left: pos.x, top: pos.y }} onClick={() => onSelect(node)}>
            <span className="dtc-dag-icon" style={node.kind === 'role' && card ? { background: ROLE_COLORS[card.index % ROLE_COLORS.length] } : undefined}>{icon(node)}</span><span className="dtc-dag-copy"><b>{node.title}</b><small>{node.subtitle}</small>{node.meta ? <em>{node.meta}</em> : null}</span><i className="dtc-dag-state">{node.status}</i>
          </button> })}
        </div>
      </div>
    </div>
    {feedback.length ? <div className="dtc-dag-feedback-note"><b>↩ {feedback.length} 条返工反馈边</b><span>红色虚线只表示历史退回，不参与 DAG 拓扑排序。</span></div> : null}
  </div>
}

export function TaskReplay({ api, agents, id, runId, toast }: { api: TasksApi & LedgerApi; agents: AgentRow[]; id: string; runId?: string; toast: (m: string) => void }) {
  const [events, setEvents] = useState<Event[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([])
  const [artifactBatch, setArtifactBatch] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [selectedGraphNode, setSelectedGraphNode] = useState<string | null>(null)
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
      setSelectedGraphNode(`role:${best.id}`)
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
  const eventStep = batchEvents.filter(({ index }) => index < upto).length
  const progress = metricCards.length ? Math.round(doneCount / metricCards.length * 100) : 0
  const graph = layoutTaskGraph(buildTaskGraph(cardsNow, now, reviewCycles, agentName))
  const selectedNode = graph.nodes.find(node => node.id === selectedGraphNode) ?? (selected ? graph.nodes.find(node => node.id === `role:${selected.id}`) : undefined)

  const stepTo = (n: number) => { setPlaying(false); const v = Math.max(1, Math.min(n, events.length)); setCursor(v >= events.length ? null : v) }
  const refreshArtifacts = async () => { if (selId) { setArtifacts(await api.taskArtifacts(id, selId)); setArtifactBatch(selId) } }
  const selectNode = (node: TaskGraphNode) => { setSelectedGraphNode(node.id); if (node.cardId) setSelectedCard(node.cardId) }

  return (
    <div className="dtc-cartoon">
      <header className="dtc-cartoon-head">
        <button className="dtc-cartoon-back" onClick={() => go('tasks')} title="返回任务中心">←</button>
        <div className="dtc-cartoon-logo">🛠️</div>
        <div className="dtc-cartoon-title"><span>DSH TASK STUDIO</span><h1>{task.title}</h1><small>{batchFull ? `${batchFull.id} · ${graph.nodes.filter(node => node.kind === 'role' || node.kind === 'reviewer' || node.kind === 'human').length} 个角色节点${total ? ` · ${total}` : ''}` : '还没运行'}</small></div>
        <div className="dtc-cartoon-live"><i />Hermes 0.20.4 兼容内核在线</div>
        <div className="dtc-cartoon-actions">
          {batches.length > 1 ? <select value={selId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)}>{batches.map(b => <option key={b.id} value={b.id}>{b.id === batches[0].id ? '这次运行' : '之前'} · {fmt(b.firedAt)} · {BS[batchStatus(full, b)].label}</option>)}</select> : null}
          <button className="dtc-btn pri" onClick={async () => { const { runId: rid } = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${rid}`) }}>▶ 再跑一次</button>
          {batchFull && (bst === 'run' || bst === 'park') ? <button className="dtc-btn" onClick={async () => { await api.cancelRun(batchFull.id); toast('已取消') }}>取消</button> : null}
          <button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); go('tasks') }}>删除</button>
        </div>
      </header>
      {error ? <div className="dtc-err">{error}</div> : null}

      <section className="dtc-cartoon-summary dtc-dag-summary">
        <div><span>事项组进度</span><strong>{doneCount} / {metricCards.length}</strong><div className="track"><i style={{ width: `${progress}%` }} /></div></div>
        <div><span>当前状态</span><strong>{bst ? BS[bst].label : '未运行'}</strong><em>{activeCount ? `${activeCount} 个角色等待处理` : total ? `总耗时 ${total}` : '等待首次调度'}</em></div>
        <div><span>DAG 结构</span><strong>{graph.nodes.length} 节点</strong><em>{dependencyCount} 条依赖 · {graph.nodes.filter(node => node.kind === 'gate').length} 个闸门</em></div>
        <div><span>运行证据</span><strong>{claimCount} Runs</strong><em>{reviewCycles.length} 次评审 · {reworkCycles.length} 次返工</em></div>
      </section>

      <section className="dtc-dag-cockpit">
        <main className="dtc-cpanel dtc-dag-panel">
          <div className="dtc-cpanel-head"><div><b>执行依赖 DAG</b><small>实线是可调度依赖；闸门是一等控制节点；红色虚线是历史返工反馈</small></div><code>{batchFull?.id ?? '尚未创建'}</code></div>
          {cardsNow.length ? <TaskDag graph={graph} cards={cardsNow} selected={selectedNode?.id ?? null} onSelect={selectNode} /> : <div className="dtc-empty">这个时刻还没有运行。</div>}
          <div className="dtc-cstep"><b>{String(eventStep).padStart(2, '0')} / {String(batchEvents.length).padStart(2, '0')}</b><div className="track"><i style={{ width: `${batchEvents.length ? eventStep / batchEvents.length * 100 : 0}%` }} /></div><span>{cursor === null ? '现在 · 实时跟随' : `回放到 ${fmt(stopAt)}`}</span></div>
        </main>

        <aside className="dtc-cpanel dtc-dag-inspector">
          <div className="dtc-cpanel-head"><div><b>节点检查器</b><small>点击图中角色或闸门，右侧证据同步切换</small></div>{selectedNode ? <span>{selectedNode.kind.toUpperCase()}</span> : null}</div>
          {selectedNode?.cardId && selected ? <CardEvidence focus={selectedNode.kind === 'gate' ? 'gate' : selectedNode.kind === 'reviewer' || selectedNode.kind === 'human' ? 'claim' : 'handoff'} preferredProfileId={selectedNode.agentId} api={api} taskId={id} batchId={batchFull?.id} card={selected} parents={selected.deps.map(dep => full.cards.get(dep)).filter(Boolean) as Card[]} reworkTargets={cardsFull.filter(card => card.index <= selected.index)} gates={reviewCycles.filter(cycle => cycle.cardId === selected.id)} runs={selected.runIds.map(rid => full.runs.get(rid)).filter(Boolean) as Run[]} artifacts={artifacts.filter(a => a.cardId === selected.id)} agentName={agentName(selected.agentId)} labelOf={agentName} toast={toast} refreshArtifacts={refreshArtifacts} /> : <div className="dtc-dag-terminal"><span>{selectedNode?.id === 'terminal:finish' ? '✓' : '▶'}</span><b>{selectedNode?.title ?? '选择一个节点'}</b><p>{selectedNode?.subtitle ?? '查看角色、闸门、Run 和交付证据。'}</p></div>}
        </aside>
      </section>

      <details className="dtc-cpanel dtc-timeline" open>
        <summary><span><b>事件流与时间回放</b><small>点击事件会把 DAG 回放到对应时刻</small></span><em>{batchEvents.length} EVENTS</em></summary>
        <div className="dtc-cevent-tools">{FILTERS.map(filter => <button key={filter.id} className={eventFilter === filter.id ? 'on' : ''} onClick={() => setEventFilter(filter.id)}>{filter.label}</button>)}</div>
        <div className="dtc-activity-list">{[...filteredEvents].reverse().map(({ e, index }) => { const actor = ACTOR[actorOf(e, full)]; const group = eventGroup(e); return <button key={index} className={`dtc-activity-row g-${group} ${index >= upto ? 'off' : ''} ${index === upto - 1 ? 'cur' : ''}`} onClick={() => stepTo(index + 1)}>
          <span className="dot">{group === 'process' ? '›' : group === 'result' ? '✓' : '•'}</span><span className="copy"><b>{e.t}</b><span>{describe(e, full, agentName)}</span><small>{fmt(e.at)} · event #{index + 1}</small></span><span className={`dtc-pill ${actor.cls}`}>{actor.label}</span>
        </button>})}</div>
        <div className="dtc-replayctl"><button className="dtc-btn sm" onClick={() => stepTo(Math.max(1, upto - 1))} disabled={upto <= 1}>←</button><button className={`dtc-btn sm ${playing ? 'pri' : ''}`} onClick={() => { if (upto >= events.length) setCursor(Math.max(1, batchEvents[0]?.index ?? 0)); setPlaying(value => !value) }}>{playing ? '暂停' : '播放'}</button><button className="dtc-btn sm" onClick={() => stepTo(upto + 1)} disabled={upto >= events.length}>→</button><button className="dtc-btn sm" onClick={() => { setPlaying(false); setCursor(null) }} disabled={cursor === null}>现在</button><span className="dtc-faint">{upto}/{events.length}</span></div>
      </details>

      {batchFull && bst && bst !== 'run' && bst !== 'park' ? <ResultPanel api={api} taskId={id} batchId={batchFull.id} status={bst} summary={lastCard?.summary} metadata={lastRun?.metadata} artifacts={artifacts} toast={toast} refresh={refreshArtifacts} /> : null}

      <details className="dtc-cpanel dtc-cartoon-details"><summary>任务书与运行边界</summary><div className="dtc-hand">{task.brief}</div><div className="dtc-kv"><span className="k">工作区</span><span className="dtc-mono">{task.cwd}</span><span className="k">触发</span><span>{task.trigger.kind === 'cron' ? cronHuman(task.trigger.expr) : '单次'}</span><span className="k">超时</span><span>{Math.round(task.timeoutSec / 60)} 分钟 / 角色</span><span className="k">失败后</span><span>{task.onFail === 'retry' ? `自动重试，最多 ${task.maxTries} 次` : '停下'}</span></div></details>
    </div>
  )
}

function ResultPanel({ api, taskId, batchId, status, summary, metadata, artifacts, toast, refresh }: { api: TasksApi; taskId: string; batchId: string; status?: keyof typeof BS; summary?: string; metadata?: Record<string, unknown>; artifacts: ArtifactView[]; toast: (m: string) => void; refresh: () => Promise<void> }) {
  const links = publicUrls(summary, metadata ? JSON.stringify(metadata) : undefined)
  return <section className="dtc-result">
    <div className="dtc-result-head"><div><span className="eyebrow">RUN RESULT</span><h2>{status === 'done' ? '任务已完成' : status === 'bad' ? '任务未完成' : status === 'park' ? '正在等待输入' : status === 'review' ? '正在等待评审' : '任务正在运行'}</h2></div>{status ? <span className={`dtc-pill ${BS[status].cls}`}>{BS[status].label}</span> : null}</div>
    <div className="dtc-result-grid"><div><h3>最终交接</h3>{links.length ? <div className="dtc-public-results"><b>公网结果</b>{links.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">{links.length > 1 ? `打开结果 ${index + 1}` : '打开公网结果'} ↗</a>)}</div> : null}<div className="dtc-result-copy">{summary || <span className="dtc-faint">最后一个角色交卷后，结果会显示在这里。</span>}</div>{metadata ? <pre className="dtc-meta">{JSON.stringify(metadata, null, 2)}</pre> : null}</div>
      <div><h3>交付产物 <span className="dtc-faint">{artifacts.length}</span></h3><ArtifactList api={api} taskId={taskId} batchId={batchId} artifacts={artifacts} toast={toast} refresh={refresh} empty="还没有登记产物。新任务会把 task_complete 的 artifacts 保存成可访问副本。" /></div>
    </div>
  </section>
}

type EvidenceTab = 'handoff' | 'claim' | 'ledger' | 'gate' | 'artifacts'

function CardEvidence({ api, taskId, batchId, card, parents, reworkTargets, gates, runs, artifacts, agentName, labelOf, toast, refreshArtifacts, focus = 'handoff', preferredProfileId }: { api: TasksApi & LedgerApi; taskId: string; batchId?: string; card: Card; parents: Card[]; reworkTargets: Card[]; gates: ReviewGateCycle[]; runs: Run[]; artifacts: ArtifactView[]; agentName: string; labelOf: (id: string) => string; toast: (m: string) => void; refreshArtifacts: () => Promise<void>; focus?: EvidenceTab; preferredProfileId?: string }) {
  const latest = (preferredProfileId ? [...runs].reverse().find(run => run.profileId === preferredProfileId) : undefined) ?? runs[runs.length - 1]
  const [runId, setRunId] = useState<string | undefined>(latest?.id)
  const [tab, setTab] = useState<EvidenceTab>(focus)
  const [reviewNote, setReviewNote] = useState('')
  const [reworkTarget, setReworkTarget] = useState(card.deps[0] ?? card.id)
  const [busy, setBusy] = useState(false)
  const run = runs.find(r => r.id === runId) ?? latest
  const latestGate = gates[gates.length - 1]
  const humanReviewPending = card.status === 'review' && latestGate?.mode !== 'agent'
  useEffect(() => { setRunId(latest?.id) }, [card.id, runs.length, preferredProfileId])
  useEffect(() => { setTab(focus) }, [card.id, focus])
  useEffect(() => { setReworkTarget(card.deps[0] ?? card.id) }, [card.id])
  const { ledger, error } = useLedger(api, tab === 'ledger' ? run?.sessionId : undefined, run?.status === 'running' || run?.status === 'blocked')
  const decide = async (decision: 'approve' | 'changes') => {
    setBusy(true)
    try { await api.reviewCard(card.id, decision, reviewNote, decision === 'changes' ? reworkTarget : undefined); toast(decision === 'approve' ? '已验收通过' : `已退回 ${labelOf(reworkTargets.find(target => target.id === reworkTarget)?.agentId ?? '')}`); setReviewNote('') }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  const unblock = async () => {
    setBusy(true)
    try { await api.unblockCard(card.id); toast('已解除阻塞；调度器将创建新的 Run') }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return <div className="dtc-panel dtc-evidence">
    <div className="dtc-evidence-head"><div className="dtc-selected-avatar">{ROLE_ICONS[card.index % ROLE_ICONS.length]}</div><div><span className="eyebrow">SELECTED ROLE</span><h2>{agentName}</h2><small className="dtc-faint">角色 {card.index + 1} · {card.id}{run?.profileId && run.profileId !== card.agentId ? ` · 本次执行 ${labelOf(run.profileId)}` : ''}</small></div><span className={`dtc-pill ${pillOf(card.status)}`}>{CARD[card.status]}</span><span className="sp" />
      {run?.sessionId ? <button className="dtc-btn sm" onClick={() => { closeConsole(); void api.openSession(run.sessionId) }}>打开会话</button> : null}
    </div>
    {runs.length > 1 ? <div className="dtc-chips">{runs.map(r => <button key={r.id} className={`dtc-chip ${r.id === run?.id ? 'on' : ''}`} onClick={() => setRunId(r.id)}>{labelOf(r.profileId ?? card.agentId)} · 尝试 {r.attempt} · {RUN[r.outcome ?? r.status] ?? r.status}</button>)}</div> : null}
    <div className="dtc-tabs"><button className={tab === 'handoff' ? 'on' : ''} onClick={() => setTab('handoff')}>交接 Handoff</button><button className={tab === 'claim' ? 'on' : ''} onClick={() => setTab('claim')}>领取 Claim</button><button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>会话工具</button><button className={tab === 'gate' ? 'on' : ''} onClick={() => setTab('gate')}>闸门 Gate</button><button className={tab === 'artifacts' ? 'on' : ''} onClick={() => setTab('artifacts')}>产物证据 {artifacts.length}</button></div>
    {tab === 'handoff' ? <div className="dtc-tabbody">
      <div className="dtc-cartoon-note"><h4>📮 本次运行收到的上游交接</h4>{parents.length ? <ul>{parents.map(parent => <li key={parent.id}><b>角色 {parent.index + 1}</b><span>{parent.summary || '上游尚未交卷'}</span></li>)}</ul> : <p>入口角色没有父交接，直接读取任务书。</p>}</div>
      <h3 className="dtc-section-label">本角色交接输出</h3>{run?.summary ? <div className="dtc-hand">{run.summary}</div> : <div className="dtc-empty">还没有交接单。</div>}
      {run?.error ? <div className="dtc-err">{run.error}</div> : null}
      {run?.status === 'blocked' ? <div className="dtc-ask"><b>? {run.question}</b>{run.terminalBlock ? <><div className="dtc-note">这个 Run 已经关闭。解除阻塞后会重新领取，并创建新的 Run 和 Session。</div><button className="dtc-btn pri" disabled={busy} onClick={unblock}>解除阻塞并新建 Run</button></> : <div className="dtc-note">这是会话内提问；在该 Session 回答后会继续同一个 Run。</div>}</div> : null}
    </div> : null}
    {tab === 'claim' ? <div className="dtc-tabbody"><div className="dtc-cartoon-note"><h4>🔐 真实领取记录</h4><p>Hermes 兼容内核使用 SQLite 事务和 CAS claim；每次执行、评审和返工都有独立 Run，并保留锁与 Session 的绑定。</p></div><div className="dtc-kv dtc-runfacts"><span className="k">Run</span><span className="dtc-mono">{run?.id || '—'}</span><span className="k">执行 Preset</span><span>{run ? labelOf(run.profileId ?? card.agentId) : '—'}</span><span className="k">尝试</span><span>{run?.attempt ?? 0} / {card.runIds.length || 1}</span><span className="k">领取</span><span>{fmt(run?.startedAt) || '—'}</span><span className="k">会话创建</span><span>{fmt(run?.sessionCreatedAt) || '等待中'}</span><span className="k">提示词发送</span><span>{fmt(run?.promptDispatchedAt) || '等待中'}</span><span className="k">Session</span><span className="dtc-mono">{run?.sessionId || '—'}</span></div></div> : null}
    {tab === 'ledger' ? <div className="dtc-tabbody">{error ? <div className="dtc-err">{error}</div> : ledger ? <TurnLedgerView ledger={ledger} compact /> : run?.sessionId ? <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div> : <div className="dtc-empty">没有会话。</div>}</div> : null}
    {tab === 'gate' ? <div className="dtc-tabbody">
      <div className={`dtc-cartoon-gate ${card.status === 'review' ? 'pending' : latestGate?.status ?? ''}`}><span>{card.status === 'review' ? '🚪' : latestGate?.status === 'approved' ? '✅' : latestGate?.status === 'changes' ? '↩' : '🪁'}</span><div><b>{humanReviewPending ? '正在等待人工验收' : card.status === 'review' && latestGate?.mode === 'agent' ? `等待 ${labelOf(latestGate.reviewerId ?? '')} 评审` : latestGate?.status === 'approved' ? `${latestGate.mode === 'agent' ? 'Agent 评审' : '人工闸门'}已批准` : latestGate?.status === 'changes' ? `已退回 ${labelOf(reworkTargets.find(target => target.id === latestGate.targetCardId)?.agentId ?? '')}` : '这个角色还没有创建评审闸门'}</b><p>{humanReviewPending ? '批准前不会放行下游，也不会结算整个任务组。退回时可选择从哪个上游角色重新开始。' : card.status === 'review' && latestGate?.mode === 'agent' ? '评估者将通过 CAS 领取同一张卡；通过或退回都会写入独立 Run。' : latestGate?.status === 'approved' ? '评审事件已写入事件流，下游可以继续。' : latestGate?.status === 'changes' ? latestGate.note : 'Agent 调用 task_request_review 后才会创建控制节点。'}</p></div></div>
      {gates.length ? <div className="dtc-gate-history"><h4>闸门历史</h4>{gates.map(gate => <div key={gate.runId}><span>Gate #{gate.round} · {gate.mode === 'agent' ? labelOf(gate.reviewerId ?? '') : '人工'}</span><b>{gate.status === 'pending' ? '等待决策' : gate.status === 'approved' ? '通过' : `退回 ${labelOf(reworkTargets.find(target => target.id === gate.targetCardId)?.agentId ?? '')}`}</b><small>{fmt(gate.requestedAt)}{gate.note ? ` · ${gate.note}` : ''}</small></div>)}</div> : null}
      {humanReviewPending ? <div className="dtc-review"><textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="验收意见；退回修改时必填" /><label className="dtc-rework-target">退回到<select value={reworkTarget} onChange={e => setReworkTarget(e.target.value)}>{reworkTargets.map(target => <option value={target.id} key={target.id}>{target.index + 1}. {labelOf(target.agentId)}{target.id === card.deps[0] ? '（默认）' : ''}</option>)}</select></label><div className="dtc-chips"><button className="dtc-btn pri" disabled={busy} onClick={() => decide('approve')}>通过并放行</button><button className="dtc-btn danger" disabled={busy || !reviewNote.trim()} onClick={() => decide('changes')}>退回并开启返工轮次</button></div></div> : null}
    </div> : null}
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
