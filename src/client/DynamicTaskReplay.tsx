import { useEffect, useMemo, useRef, useState } from 'react'
import { graphEventLabel, replayGraph, type GraphEventRow, type GraphFrame, type GraphRunPhase, type GraphSnapshot, type GraphTaskRow } from '../graph-data.ts'
import type { AgentRow, ArtifactView, Batch, TaskSpec } from '../wire.ts'
import { finalArtifact, groupArtifacts, type ArtifactActor } from '../artifact-delivery.ts'
import { go } from './Console.tsx'
import { ArtifactDelivery, FinalArtifactActions } from './ArtifactDelivery.tsx'
import type { TasksApi } from './TasksView.tsx'
import { TurnLedgerView, useLedger } from './TurnLedger.tsx'

const epoch = (value?: number | null) => value ? new Date(value * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
const STATUS: Record<string, string> = { todo: '等依赖', ready: '就绪', running: '运行中', blocked: '阻塞', review: '待验收', done: '完成', archived: '归档', triage: '需处理' }
const ROLE: Record<string, { label: string; icon: string }> = {
  planner: { label: '规划者', icon: '🦊' }, executor: { label: '执行者', icon: '🐻' }, reviewer: { label: '评估者', icon: '🦉' }, gate: { label: '闸门', icon: '◇' },
}
const PHASES: { id: GraphRunPhase; short: string; label: string }[] = [
  { id: 'claimed', short: '领', label: '已领取' }, { id: 'bound', short: '绑', label: '已绑定' }, { id: 'session_created', short: '会', label: '会话建立' },
  { id: 'prompt_dispatched', short: '令', label: '任务书发送' }, { id: 'heartbeat', short: '活', label: '心跳续租' }, { id: 'completed', short: '完', label: '执行完成' },
]

const short = (value: unknown) => typeof value === 'string' ? value.length > 32 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value : '—'
const eventEffect = (event: GraphEventRow, frame: GraphFrame) => {
  const p = event.payload
  const run = event.run_id === null ? undefined : frame.runs.find(row => row.id === event.run_id)
  switch (event.kind) {
    case 'created': return { icon: '＋', title: '新 Task 出现在 DAG', copy: '数据库新增一行 tasks；因此页面新增一个真实节点。', facts: ['tasks +1', event.task_id] }
    case 'linked': return { icon: '↗', title: '新依赖箭头出现', copy: '数据库新增一行 task_links；父子节点之间现在出现真实连线。', facts: ['task_links +1', `${short(p.parent_id)} → ${short(event.task_id)}`] }
    case 'promoted': return { icon: '●', title: '依赖满足，节点进入就绪', copy: '没有新增节点或连线；当前 Task 的状态由等依赖推进为 ready。', facts: ['tasks.status = ready', event.task_id] }
    case 'claimed': return { icon: '▶', title: '角色领取任务并开始运行', copy: '同一节点变为运行中，并新增一行真实 task_runs。', facts: [`task_runs +1 · Run #${event.run_id}`, `lease → ${epoch(Number(p.expires) || run?.claim_expires)}`] }
    case 'run_bound': return { icon: '⛓', title: 'DSH Run 已绑定', copy: '没有新增 Task/Link；当前节点的运行阶段推进到“已绑定”。', facts: [`Run #${event.run_id}`, `external_run_id = ${short(p.external_run_id)}`] }
    case 'session_created': return { icon: '▣', title: 'Agent 会话已建立', copy: '没有新增 Task/Link；同一节点亮起“会话”阶段，并可从 Run 打开会话。', facts: [`Run #${event.run_id}`, `session_id = ${short(p.session_id ?? run?.session_id)}`] }
    case 'prompt_dispatched': return { icon: '✉', title: '任务书已发送给 Agent', copy: '没有新增 Task/Link；同一节点亮起“发令”阶段，消息 ID 成为运行证据。', facts: [`Run #${event.run_id}`, `message_id = ${short(p.message_id ?? run?.message_id)}`] }
    case 'heartbeat': return { icon: '♥', title: 'Agent 心跳续租', copy: '没有新增 Task/Link；运行节点产生脉冲，更新最后心跳与 CAS 租约证据。', facts: [`last_heartbeat_at = ${epoch(Number(p.last_heartbeat_at) || run?.last_heartbeat_at)}`, `claim_expires = ${typeof p.claim_expires === 'number' ? epoch(p.claim_expires) : '旧事件未记录精确值'}`] }
    case 'gate_opened': return { icon: '◇', title: '系统闸门放行', copy: '闸门节点变为完成；它不会创建 Agent Run，下游随后才能进入 ready。', facts: ['tasks.status = done', event.task_id] }
    case 'completed': return { icon: '✓', title: '当前角色执行完成', copy: '运行节点变为完成，task_runs 写入结果；依赖它的下游随后才会推进。', facts: [`Run #${event.run_id}`, `summary = ${short(p.summary)}`] }
    case 'artifact_registered': return { icon: '▤', title: '一个不可变产物版本已保存', copy: '页面的交付区现在出现这个版本；同 SHA256 的评估快照会合并为核验证据。', facts: [`artifact = ${short(p.name)}`, `SHA256 = ${short(p.sha256)}`] }
    case 'artifact_finalized': return { icon: '★', title: '规划者确认最终产物', copy: '这一步把过程版本升级为最终交付；顶部预览、下载和发布入口现在可用。', facts: [`artifact_id = ${short(p.artifact_id)}`, `SHA256 = ${short(p.sha256)}`] }
    case 'artifact_published': return { icon: '↗', title: '最终产物已发布公网', copy: '产物内容没有变化；页面增加可复制、可直接打开的公网验收地址。', facts: [`artifact_id = ${short(p.artifact_id)}`, `URL = ${short(p.public_url)}`] }
    default: return { icon: '•', title: graphEventLabel(event), copy: '当前步骤更新数据库证据；页面已聚焦到受影响的节点。', facts: [`task_events.id = ${event.id}`, event.task_id] }
  }
}

function DbDag({ frame, selected, current, onSelect, nameOf }: { frame: GraphFrame; selected: string | null; current?: GraphEventRow; onSelect: (id: string) => void; nameOf: (id: string | null) => string }) {
  const [zoom, setZoom] = useState(1)
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
  const roundRows = Math.max(1, Math.ceil(Math.max(0, ordered.length - 1) / 4))
  const width = ordered.length > 1 ? 1180 : 760
  const height = Math.max(250, roundRows * 150 + 170)
  const positions = new Map(ordered.map((task, index) => {
    if (index === 0) return [task.id, { x: 28, y: 40 }]
    const row = Math.floor((index - 1) / 4); const within = (index - 1) % 4 + 1
    const column = row % 2 === 0 ? within : 4 - within
    return [task.id, { x: 28 + column * 226, y: 40 + row * 150 + (task.node_kind === 'gate' ? 16 : 0) }]
  }))
  return <div className="dtc-dbdag-scroll"><div className="dtc-dbdag-tools"><span>拖动图面查看完整依赖</span><div><button className="dtc-btn sm" aria-label="缩小 DAG" onClick={() => setZoom(value => Math.max(.55, Number((value - .15).toFixed(2))))}>−</button><b>{Math.round(zoom * 100)}%</b><button className="dtc-btn sm" aria-label="放大 DAG" onClick={() => setZoom(value => Math.min(1.75, Number((value + .15).toFixed(2))))}>＋</button><button className="dtc-btn sm" onClick={() => setZoom(1)}>适配</button></div></div><div className="dtc-dbdag-viewport"><div className="dtc-dbdag-scale" style={{ width: width * zoom, height: height * zoom }}><div className="dtc-dbdag" style={{ width, height, transform: `scale(${zoom})` }}>
    {Array.from({ length: roundRows }, (_, row) => <div key={row} className="dtc-dbround" style={{ top: 20 + row * 150 }}><b>ROUND {String(row + 1).padStart(2, '0')}</b></div>)}
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`${frame.links.length} 条数据库依赖`}>
      <defs><marker id="db-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" /></marker></defs>
      {frame.links.map(link => {
        const a = positions.get(link.parent_id); const b = positions.get(link.child_id); if (!a || !b) return null
        const aw = byId.get(link.parent_id)?.node_kind === 'gate' ? 142 : 178; const bw = byId.get(link.child_id)?.node_kind === 'gate' ? 142 : 178
        const sameRow = Math.abs(a.y - b.y) < 30
        let path = ''; let labelX = 0; let labelY = 0
        if (sameRow) {
          const right = b.x > a.x; const sx = right ? a.x + aw : a.x; const tx = right ? b.x : b.x + bw; const sy = a.y + 48; const ty = b.y + 48; const bend = Math.max(18, Math.abs(tx - sx) / 2)
          path = `M${sx} ${sy} C${sx + (right ? bend : -bend)} ${sy},${tx + (right ? -bend : bend)} ${ty},${tx} ${ty}`; labelX = (sx + tx) / 2; labelY = Math.min(sy, ty) - 9
        } else {
          const sx = a.x + aw / 2; const sy = a.y + 96; const tx = b.x + bw / 2; const ty = b.y
          path = `M${sx} ${sy} C${sx} ${sy + 34},${tx} ${ty - 34},${tx} ${ty}`; labelX = (sx + tx) / 2 + 8; labelY = (sy + ty) / 2
        }
        return <g key={`${link.parent_id}>${link.child_id}`}><title>{`${link.parent_id} 依赖 ${link.child_id}`}</title><path className="dtc-dbdag-edge" d={path} markerEnd="url(#db-arrow)" /></g>
      })}
    </svg>
    {ordered.map(task => { const pos = positions.get(task.id)!; const role = ROLE[task.role ?? task.node_kind] ?? { label: task.role ?? '角色', icon: '●' }; const runs = frame.runs.filter(run => run.task_id === task.id); const run = runs.at(-1); const focused = current?.task_id === task.id; const assignee = nameOf(task.assignee); const assigneeLabel = task.node_kind === 'gate' ? '系统闸门 · 无 Agent Run' : assignee === role.label ? '已绑定 Agent' : assignee; const phase = run ? PHASES.find(item => item.id === run.phase)?.label ?? run.phase : ''; return <button key={task.id} className={`dtc-dbnode k-${task.node_kind} s-${task.status} ${selected === task.id ? 'selected' : ''} ${focused ? `event-focus ev-${current.kind}` : ''}`} style={{ left: pos.x, top: pos.y }} onClick={() => onSelect(task.id)}>
      <i>{role.icon}</i><span><b>{role.label}{task.round ? ` · 第 ${task.round} 轮` : ''}</b><small>{assigneeLabel}</small><em>{run ? `Run #${run.id} · ${phase} · ${run.evidence.length}/${PHASES.length} 证据` : '尚未生成 Agent Run'}</em></span><strong>{STATUS[task.status] ?? task.status}</strong>
    </button> })}
  </div></div></div></div>
}

/** The durable index from one task batch to each real DSH session. Gates deliberately do not appear here. */
function RunDirectory({ api, frame, taskId, batchId, selectedSessionId, nameOf, onSelectNode }: { api: TasksApi; frame: GraphFrame; taskId: string; batchId: string; selectedSessionId?: string; nameOf: (id: string | null) => string; onSelectNode: (id: string) => void }) {
  const taskById = new Map(frame.tasks.map(task => [task.id, task]))
  const rows = [...frame.runs].filter(run => run.session_id).sort((a, b) => a.id - b.id)
  const rounds = new Map<number, typeof rows>()
  for (const run of rows) {
    const round = taskById.get(run.task_id)?.round ?? 0
    const group = rounds.get(round) ?? []
    group.push(run); rounds.set(round, group)
  }
  const trace = (sessionId: string, taskNodeId: string) => {
    onSelectNode(taskNodeId)
    go(`tasks/${taskId}/runs/${batchId}?session=${encodeURIComponent(sessionId)}`)
  }
  return <section className="dtc-cpanel dtc-run-directory">
    <div className="dtc-cpanel-head"><div><b>Runs & Sessions</b><small>{rows.length} 个真实 DSH 会话；Gate 是控制节点，不会生成会话</small></div><code>{rows.length} SESSIONS</code></div>
    {rows.length ? <div className="dtc-session-rounds">{[...rounds.entries()].sort(([a], [b]) => a - b).map(([round, group]) => <div className="dtc-session-round" key={round}><b>ROUND {String(round || 1).padStart(2, '0')}</b>{group.map(run => {
      const task = taskById.get(run.task_id)
      const role = ROLE[task?.role ?? 'executor'] ?? ROLE.executor
      const selected = run.session_id === selectedSessionId
      return <div className={`dtc-session-row ${selected ? 'selected' : ''}`} key={run.id}><button type="button" className="dtc-session-copy" onClick={() => trace(run.session_id!, run.task_id)}><i>{role.icon}</i><span><b>{role.label} · Run #{run.id}</b><small>{nameOf(run.profile)} · {run.status} · {epoch(run.started_at)}</small><code>{run.session_id}</code></span></button><div className="dtc-session-actions"><button className="dtc-btn sm" onClick={() => trace(run.session_id!, run.task_id)}>Trace</button><button className="dtc-btn sm pri" onClick={() => void api.openSession(run.session_id!)}>打开会话 ↗</button></div></div>
    })}</div>)}</div> : <div className="dtc-empty">尚未创建 Agent Session。角色领取后会在此出现。</div>}
  </section>
}

function SessionTrace({ api, sessionId, onOpen }: { api: TasksApi; sessionId: string; onOpen: () => void }) {
  const { ledger, error } = useLedger(api, sessionId, false)
  return <section className="dtc-cpanel dtc-session-trace"><div className="dtc-cpanel-head"><div><b>Session Trace</b><small>此处只展示当前选中的一个 Session 的模型、Skill、MCP 与工具轨迹</small></div><button className="dtc-btn sm pri" onClick={onOpen}>打开会话 ↗</button></div><code className="dtc-session-trace-id">{sessionId}</code>{error ? <div className="dtc-err">{error}</div> : ledger ? <TurnLedgerView ledger={ledger} compact /> : <div className="dtc-empty"><span className="dtc-spin" /> 读取 Session Trace…</div>}</section>
}

export function DynamicTaskReplay({ api, agents, task, batches, batchId, sessionId, toast }: { api: TasksApi; agents: AgentRow[]; task: TaskSpec; batches: Batch[]; batchId: string; sessionId?: string; toast: (text: string) => void }) {
  const [data, setData] = useState<GraphSnapshot | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([])
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [dagFullscreen, setDagFullscreen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    let stop = false
    const load = () => Promise.all([api.taskGraph(task.id, batchId), api.taskArtifacts(task.id, batchId)]).then(([next, nextArtifacts]) => { if (!stop) { setData(next); setArtifacts(nextArtifacts); setError(''); setSelected(cur => next.live.runs.find(row => row.session_id === sessionId)?.task_id ?? (cur && next.live.tasks.some(row => row.id === cur) ? cur : next.live.tasks.find(row => ['running', 'blocked', 'ready'].includes(row.status))?.id ?? next.live.tasks.at(-1)?.id ?? null)) } }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    void load(); const poll = window.setInterval(load, 2500)
    return () => { stop = true; window.clearInterval(poll) }
  }, [api, task.id, batchId, sessionId])
  const events = data?.events ?? []
  const step = cursor === null ? events.length : Math.min(cursor, events.length)
  const frame = useMemo(() => !data ? { tasks: [], links: [], runs: [] } : cursor === null ? data.live : replayGraph(data.events, step), [data, cursor, step])
  const current = step ? events[step - 1] : undefined
  useEffect(() => { if (cursor !== null && current?.task_id) setSelected(current.task_id) }, [cursor, step, current?.task_id])
  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!playing) return
    if (step >= events.length) { setPlaying(false); setCursor(null); return }
    timer.current = window.setTimeout(() => setCursor(step + 1), Math.round(900 / speed))
    return () => window.clearTimeout(timer.current)
  }, [playing, step, events.length, speed])
  useEffect(() => {
    if (!dagFullscreen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDagFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dagFullscreen])
  const nameOf = (id: string | null) => id ? agents.find(agent => agent.id === id)?.name ?? id : '系统'
  if (!data) return <div className="dtc-empty">{error || <><span className="dtc-spin" /> 读取 SQLite 图数据…</>}</div>
  const node = frame.tasks.find(row => row.id === selected) ?? frame.tasks.at(-1)
  const parents = node ? frame.links.filter(link => link.child_id === node.id).map(link => frame.tasks.find(row => row.id === link.parent_id)).filter(Boolean) as GraphTaskRow[] : []
  const children = node ? frame.links.filter(link => link.parent_id === node.id).map(link => frame.tasks.find(row => row.id === link.child_id)).filter(Boolean) as GraphTaskRow[] : []
  const runs = node ? frame.runs.filter(run => run.task_id === node.id) : []
  const effect = current ? eventEffect(current, frame) : undefined
  const artifactActors: ArtifactActor[] = data.live.tasks.map(row => {
    const reviewSummary = [...data.live.runs].reverse().find(run => run.task_id === row.id)?.summary ?? ''
    const decision = row.role === 'reviewer' ? (/返工|退回|changes.requested/i.test(reviewSummary) ? 'changes' : /通过|approved/i.test(reviewSummary) ? 'approved' : undefined) : undefined
    return { cardId: row.id, role: row.role ?? undefined, round: row.round ?? undefined, name: nameOf(row.assignee), ...(decision ? { decision } : {}) }
  })
  const artifactProjection = events.some(event => event.kind === 'artifact_registered')
  const visibleArtifacts = cursor === null ? artifacts : artifacts.filter(artifact => {
    const registered = events.slice(0, step).some(event => event.kind === 'artifact_registered' && event.payload.artifact_id === artifact.id)
    return artifactProjection ? registered : Math.floor(Date.parse(artifact.createdAt) / 1000) <= (current?.created_at ?? 0)
  }).map(artifact => {
    if (!artifact.final) return artifact
    const finalized = artifact.finalSource === 'explicit'
      ? events.slice(0, step).some(event => event.kind === 'artifact_finalized' && event.payload.artifact_id === artifact.id)
      : step >= events.length || (data.batch.settledAt ?? Infinity) <= (current?.created_at ?? 0)
    return finalized ? artifact : { ...artifact, final: undefined, finalSource: undefined, finalizedAt: undefined }
  })
  const groups = groupArtifacts(visibleArtifacts, artifactActors)
  const final = finalArtifact(groups)
  const refreshArtifacts = async () => setArtifacts(await api.taskArtifacts(task.id, batchId))
  const finalSummary = [...data.live.tasks].filter(row => row.role === 'planner').flatMap(row => data.live.runs.filter(run => run.task_id === row.id)).filter(run => run.summary).at(-1)?.summary ?? undefined
  const done = frame.tasks.filter(row => row.status === 'done').length
  const rounds = frame.tasks.filter(row => row.node_kind === 'gate').length
  const seek = (next: number) => { setPlaying(false); setCursor(Math.max(0, Math.min(next, events.length))) }
  return <div className="dtc-cartoon dtc-dbtruth">
    <header className="dtc-cartoon-head"><button className="dtc-cartoon-back" onClick={() => go('tasks')}>←</button><div className="dtc-cartoon-logo">▦</div><div className="dtc-cartoon-title"><span>数据库回放</span><h1>{task.title}</h1><small>{batchId} · tasks / task_links / task_runs / task_events</small></div><div className="dtc-cartoon-live"><i />{cursor === null ? 'SQLite 实时态' : `历史事件 #${step}`}</div><FinalArtifactActions compact api={api} taskId={task.id} batchId={batchId} group={final} toast={toast} refresh={refreshArtifacts} /><div className="dtc-cartoon-actions">{batches.length > 1 ? <select value={batchId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)}>{batches.map(batch => <option key={batch.id} value={batch.id}>{batch.id}</option>)}</select> : null}<button className="dtc-btn pri" onClick={async () => { const next = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${next.runId}`) }}>▶ 再跑一次</button>{!data.batch.outcome ? <button className="dtc-btn" onClick={async () => { await api.cancelRun(batchId); toast('已取消运行') }}>取消</button> : null}<button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); go('tasks') }}>删除</button></div></header>
    {error ? <div className="dtc-err">{error}</div> : null}
    <section className="dtc-cartoon-summary dtc-dag-summary"><div><span>真实 Tasks</span><strong>{frame.tasks.length}</strong><em>{done} 完成 · {frame.tasks.length - done} 未完成</em></div><div><span>真实 Links</span><strong>{frame.links.length}</strong><em>只计 task_links 行</em></div><div><span>真实 Runs</span><strong>{frame.runs.length}</strong><em>Gate 永远是 0 Run</em></div><div><span>Rounds</span><strong>{rounds}</strong><em>每个真实 Gate 对应一轮</em></div></section>
    <RunDirectory api={api} frame={data.live} taskId={task.id} batchId={batchId} selectedSessionId={sessionId} nameOf={nameOf} onSelectNode={setSelected} />
    {sessionId ? <SessionTrace api={api} sessionId={sessionId} onOpen={() => void api.openSession(sessionId)} /> : null}
    <section className={`dtc-dag-cockpit ${dagFullscreen ? 'dtc-dag-fullscreen' : ''}`}><main className="dtc-cpanel dtc-dag-panel"><div className="dtc-cpanel-head"><div><b>数据库有向无环图</b><small>节点=tasks 行；箭头=task_links 行；页面不补角色、不补边</small></div><div className="dtc-dag-head-actions"><code>{frame.tasks.length}N / {frame.links.length}E</code><button className="dtc-btn sm" onClick={() => setDagFullscreen(value => !value)}>{dagFullscreen ? '退出全屏' : '全屏 DAG'}</button></div></div>{effect && current ? <div key={current.id} className={`dtc-event-effect kind-${current.kind}`}><span className="dtc-event-effect-icon">{effect.icon}</span><div><small>当前事件 · STEP {step}</small><b>{effect.title}</b><p>{effect.copy}</p></div><dl>{effect.facts.map((fact, index) => <div key={index}><dt>{index ? '证据' : '变更'}</dt><dd>{fact}</dd></div>)}</dl></div> : <div className="dtc-event-effect idle"><span className="dtc-event-effect-icon">○</span><div><small>回放起点</small><b>尚未写入数据库事件</b><p>点击下一步后，第一个真实 Task 才会出现在 DAG。</p></div></div>}{frame.tasks.length ? <DbDag frame={frame} selected={node?.id ?? null} current={cursor === null ? undefined : current} onSelect={setSelected} nameOf={nameOf} /> : <div className="dtc-empty">事件 #0：数据库还没有 Task 行。</div>}
      <div className={`dtc-replaybar ${playing ? 'playing' : ''}`}><div className="dtc-replay-now"><span>{cursor === null ? '实时数据库' : playing ? '自动回放中' : '历史快照'}</span><b>{String(step).padStart(2, '0')} / {String(events.length).padStart(2, '0')}</b><small>{current ? `${epoch(current.created_at)} · ${graphEventLabel(current)}` : '尚未发生事件'}</small></div><div className="dtc-replay-actions"><button onClick={() => seek(0)} disabled={!step}>从头</button><button onClick={() => seek(step - 1)} disabled={!step}>←</button><button className="play" onClick={() => { if (step >= events.length) setCursor(0); setPlaying(value => !value) }}>{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button><button onClick={() => seek(step + 1)} disabled={step >= events.length}>→</button></div><label className="dtc-replay-range"><span>task_events.id</span><input type="range" min="0" max={events.length} value={step} onChange={e => seek(Number(e.target.value))} /><output>{step}</output></label><div className="dtc-replay-tail"><label>速度<select value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option></select></label><button className="live" disabled={cursor === null} onClick={() => { setPlaying(false); setCursor(null) }}>● 回到实时</button></div></div>
    </main>{!dagFullscreen ? <aside className="dtc-cpanel dtc-dag-inspector"><div className="dtc-cpanel-head"><div><b>数据库行检查器</b><small>当前回放时刻可见的真实证据</small></div>{node ? <span>{node.node_kind.toUpperCase()}</span> : null}</div>{node ? <div className="dtc-dbinspect"><h2>{(ROLE[node.role ?? node.node_kind] ?? ROLE.executor).icon} {(ROLE[node.role ?? node.node_kind] ?? ROLE.executor).label} {node.round}</h2><p className="dtc-mono">{node.id}</p><dl><dt>tasks.status</dt><dd>{node.status}</dd><dt>assignee</dt><dd>{nameOf(node.assignee)}</dd><dt>created_at</dt><dd>{epoch(node.created_at)}</dd><dt>completed_at</dt><dd>{epoch(node.completed_at)}</dd><dt>父依赖</dt><dd>{parents.map(row => `${row.role}${row.round}`).join('、') || '无'}</dd><dt>子节点</dt><dd>{children.map(row => `${row.role}${row.round}`).join('、') || '尚未写入'}</dd></dl><h3>task_runs ({runs.length})</h3>{runs.length ? runs.map(run => <button key={run.id} className="dtc-dbrun" onClick={() => run.session_id && api.openSession(run.session_id)}><b>Run #{run.id} · {run.status}</b><span className="dtc-dbrun-phase">{PHASES.map(phase => <i key={phase.id} className={run.evidence.includes(phase.id) ? 'on' : ''}>{phase.label}</i>)}</span><small>{nameOf(run.profile)} · {epoch(run.started_at)}{run.session_id ? ' · 打开会话 ↗' : ''}</small>{run.external_run_id ? <code>external: {run.external_run_id}</code> : null}{run.session_id ? <code>session: {run.session_id}</code> : null}{run.message_id ? <code>message: {run.message_id}</code> : null}{run.last_heartbeat_at ? <code>heartbeat: {epoch(run.last_heartbeat_at)} · lease: {epoch(run.claim_expires)}</code> : null}{run.summary ? <p>{run.summary}</p> : null}</button>) : <div className="dtc-clegend">Gate 和尚未领取的 Task 没有 Run 行。</div>}</div> : <div className="dtc-empty">这个时刻没有节点。</div>}</aside> : null}</section>
    <ArtifactDelivery api={api} taskId={task.id} batchId={batchId} artifacts={visibleArtifacts} actors={artifactActors} summary={finalSummary} toast={toast} refresh={refreshArtifacts} empty="执行者调用 task_complete(artifacts) 后，版本会随数据库事件出现在这里。" />
    <details className="dtc-cpanel dtc-timeline"><summary><span><b>Canonical task_events</b><small>点击任一事件，把同一个渲染器还原到该事务之后</small></span><em>{events.length} ROWS</em></summary><div className="dtc-activity-list">{[...events].reverse().map((event, index) => { const eventStep = events.length - index; return <button key={event.id} className={`dtc-activity-row ${eventStep > step ? 'off' : ''} ${eventStep === step ? 'cur' : ''}`} onClick={() => seek(eventStep)}><span className="dot" /><span className="copy"><b>{graphEventLabel(event)}</b><span>{event.kind}</span><small>{epoch(event.created_at)} · task_events.id={event.id}</small></span><span className="dtc-pill dtc-p-grey">DB</span></button> })}</div></details>
    <details className="dtc-cpanel dtc-cartoon-details"><summary>任务书与运行边界</summary><div className="dtc-hand">{task.brief}</div><div className="dtc-kv"><span className="k">工作区</span><span className="dtc-mono">{task.cwd}</span><span className="k">超时</span><span>{Math.round(task.timeoutSec / 60)} 分钟 / 角色</span><span className="k">失败策略</span><span>{task.onFail === 'retry' ? `最多重试 ${task.maxTries} 次` : '失败后停止'}</span></div></details>
  </div>
}
