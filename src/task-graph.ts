import type { Card, Run, State } from './fold.ts'

export interface GraphReviewCycle {
  cardId: string
  round: number
  status: 'pending' | 'approved' | 'changes'
  mode: 'human' | 'agent'
  reviewerId?: string
  targetCardId?: string
  note?: string
  runId?: string
  requestedAt?: string
  decidedAt?: string
}

export type TaskGraphNodeKind = 'terminal' | 'role' | 'reviewer' | 'human' | 'gate'
export type TaskGraphEdgeKind = 'flow' | 'dependency' | 'rework' | 'feedback'

export interface TaskGraphNode {
  id: string
  kind: TaskGraphNodeKind
  title: string
  subtitle: string
  status: string
  cardId?: string
  agentId?: string
  runId?: string
  round?: number
  gateType?: 'release' | 'decision'
  meta?: string
}

export interface TaskGraphEdge {
  id: string
  from: string
  to: string
  kind: TaskGraphEdgeKind
  label?: string
}

export interface TaskGraph {
  nodes: TaskGraphNode[]
  edges: TaskGraphEdge[]
  mode?: 'generic' | 'rounds'
}

export interface PositionedTaskGraph extends TaskGraph {
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
}

const finished = (card?: Card) => card?.status === 'done'

const strictThreeRoleChain = (cards: Card[]) => cards.length === 3
  && cards[0].deps.length === 0
  && cards[1].deps.length === 1 && cards[1].deps[0] === cards[0].id
  && cards[2].deps.length === 1 && cards[2].deps[0] === cards[1].id

function buildRoundGraph(cards: Card[], state: State, cycles: GraphReviewCycle[], agentName: (id: string) => string): TaskGraph | undefined {
  if (!strictThreeRoleChain(cards)) return
  const [planner, executor, reviewer] = cards
  const decisions = cycles.filter(cycle => cycle.cardId === reviewer.id)
  if (!decisions.length || decisions.some(cycle => cycle.status === 'changes' && cycle.targetCardId !== planner.id)) return

  const changes = decisions.filter(cycle => cycle.status === 'changes' && cycle.decidedAt).sort((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''))
  // Core claims are timestamped to whole seconds, while browser decisions keep
  // milliseconds. A claim made immediately after a decision can therefore
  // look a few milliseconds older; comparing epoch seconds preserves the
  // durable event order at that transition boundary.
  const second = (iso: string) => Math.floor(+new Date(iso) / 1000)
  const roundOf = (startedAt: string) => 1 + changes.filter(cycle => second(cycle.decidedAt ?? '') <= second(startedAt)).length
  const runsByRound = new Map<string, Map<number, Run>>()
  for (const card of cards) {
    const grouped = new Map<number, Run>()
    for (const runId of card.runIds) {
      const run = state.runs.get(runId)
      if (!run || (run.profileId ?? card.agentId) !== card.agentId) continue
      grouped.set(roundOf(run.startedAt), run)
    }
    runsByRound.set(card.id, grouped)
  }
  const runAt = (card: Card, round: number) => runsByRound.get(card.id)?.get(round)
  const latestRunRound = Math.max(1, ...[...runsByRound.values()].flatMap(rows => [...rows.keys()]))
  const roundCount = Math.max(latestRunRound, changes.length + 1)
  const finalDecision = decisions.find(cycle => cycle.round === roundCount)
  const allDone = cards.every(finished) && finalDecision?.status === 'approved'
  const nodes: TaskGraphNode[] = [
    { id: 'terminal:start', kind: 'terminal', title: 'START', subtitle: '调度器触发', status: 'open' },
    { id: 'terminal:finish', kind: 'terminal', title: 'DONE', subtitle: allDone ? '第三轮验收通过' : '等待当前轮收敛', status: allDone ? 'done' : 'waiting' },
  ]
  const edges: TaskGraphEdge[] = []

  for (let round = 1; round <= roundCount; round++) {
    const plannerRun = runAt(planner, round)
    const executorRun = runAt(executor, round)
    const reviewerRun = runAt(reviewer, round)
    const decision = decisions.find(cycle => cycle.round === round)
    const plannerDone = plannerRun?.status === 'done' && plannerRun.outcome === 'completed'
    const roleStatus = (card: Card, run: typeof plannerRun) => run?.status ?? (round === roundCount ? card.status : 'waiting')
    const plannerId = `round:${round}:role:${planner.id}`
    const releaseId = `round:${round}:gate:release`
    const executorId = `round:${round}:role:${executor.id}`
    const reviewerId = `round:${round}:role:${reviewer.id}`
    const decisionId = `round:${round}:gate:decision`

    nodes.push(
      { id: plannerId, kind: 'role', title: agentName(planner.agentId), subtitle: `规划者 · 第 ${round} 轮`, status: roleStatus(planner, plannerRun), cardId: planner.id, agentId: planner.agentId, runId: plannerRun?.id, round, meta: plannerRun ? `RUN ${plannerRun.attempt}` : '等待领取' },
      { id: releaseId, kind: 'gate', title: `执行闸门 G${round}`, subtitle: plannerDone ? '规划完成，已统一放开' : '等待规划者放开', status: plannerDone ? 'open' : 'waiting', cardId: planner.id, runId: plannerRun?.id, round, gateType: 'release', meta: plannerDone ? 'OPEN' : 'WAIT' },
      { id: executorId, kind: 'role', title: agentName(executor.agentId), subtitle: `执行者 · 第 ${round} 轮`, status: roleStatus(executor, executorRun), cardId: executor.id, agentId: executor.agentId, runId: executorRun?.id, round, meta: executorRun ? `RUN ${executorRun.attempt}` : '依赖闸门' },
      { id: reviewerId, kind: 'reviewer', title: agentName(reviewer.agentId), subtitle: `评估者 · 第 ${round} 轮`, status: roleStatus(reviewer, reviewerRun), cardId: reviewer.id, agentId: reviewer.agentId, runId: reviewerRun?.id, round, meta: reviewerRun ? `RUN ${reviewerRun.attempt}` : '等待执行交接' },
      { id: decisionId, kind: 'gate', title: `验收决策 D${round}`, subtitle: decision?.status === 'changes' ? '不通过，生成下一轮' : decision?.status === 'approved' ? '通过，流程收敛' : '等待通过 / 退回', status: decision?.status ?? 'waiting', cardId: reviewer.id, runId: decision?.runId, round, gateType: 'decision', meta: decision?.status === 'changes' ? `REWORK #${round}` : decision?.status?.toUpperCase() ?? 'WAIT' },
    )
    edges.push(
      { id: `${plannerId}>${releaseId}`, from: plannerId, to: releaseId, kind: 'flow', label: '创建并放开' },
      { id: `${releaseId}>${executorId}`, from: releaseId, to: executorId, kind: 'dependency', label: '依赖 Gate' },
      { id: `${executorId}>${reviewerId}`, from: executorId, to: reviewerId, kind: 'dependency', label: 'handoff' },
      { id: `${reviewerId}>${decisionId}`, from: reviewerId, to: decisionId, kind: 'flow', label: '提交验收' },
    )
    if (round === 1) edges.push({ id: `terminal:start>${plannerId}`, from: 'terminal:start', to: plannerId, kind: 'flow' })
    if (decision?.status === 'changes' && round < roundCount) {
      edges.push({ id: `${decisionId}>round:${round + 1}:role:${planner.id}`, from: decisionId, to: `round:${round + 1}:role:${planner.id}`, kind: 'rework', label: `返工 #${round}${decision.note ? ` · ${decision.note}` : ''}` })
    } else if (round === roundCount) {
      edges.push({ id: `${decisionId}>terminal:finish`, from: decisionId, to: 'terminal:finish', kind: 'flow', label: decision?.status === 'approved' ? '批准' : '批准后放行' })
    }
  }
  return { nodes, edges, mode: 'rounds' }
}

/**
 * Build the visible execution DAG from durable cards and review decisions.
 * Legacy same-card feedback is an audit overlay. Upstream rework is instead
 * unrolled into a new round whose forward edge remains part of the real DAG.
 */
export function buildTaskGraph(cards: Card[], state: State, cycles: GraphReviewCycle[], agentName: (id: string) => string): TaskGraph {
  const rounds = buildRoundGraph(cards, state, cycles, agentName)
  if (rounds) return rounds
  const nodes: TaskGraphNode[] = [
    { id: 'terminal:start', kind: 'terminal', title: 'START', subtitle: '调度器触发', status: 'open' },
    { id: 'terminal:finish', kind: 'terminal', title: 'DONE', subtitle: cards.length && cards.every(finished) ? '全部闸门已放行' : '等待流程收敛', status: cards.length && cards.every(finished) ? 'done' : 'waiting' },
  ]
  const edges: TaskGraphEdge[] = []
  const output = new Map<string, string>()
  const byId = new Map(cards.map(card => [card.id, card]))

  for (const card of cards) {
    const depsOpen = card.deps.every(dep => finished(byId.get(dep) ?? state.cards.get(dep)))
    const gateId = `gate:ready:${card.id}`
    const roleId = `role:${card.id}`
    nodes.push({
      id: gateId,
      kind: 'gate',
      title: card.deps.length ? 'Handoff Gate' : '启动闸门',
      subtitle: card.deps.length ? `${card.deps.length} 条依赖${depsOpen ? '已满足' : '等待中'}` : '任务已进入就绪队列',
      status: depsOpen ? 'open' : 'waiting',
      cardId: card.id,
      meta: depsOpen ? 'OPEN' : 'WAIT',
    })
    nodes.push({ id: roleId, kind: 'role', title: agentName(card.agentId), subtitle: `角色 ${card.index + 1}`, status: card.status, cardId: card.id, agentId: card.agentId, meta: `${card.runIds.length || 0} RUN` })
    edges.push({ id: `${gateId}>${roleId}`, from: gateId, to: roleId, kind: 'flow' })

    const cardCycles = cycles.filter(cycle => cycle.cardId === card.id)
    const latest = cardCycles[cardCycles.length - 1]
    if (!latest) {
      output.set(card.id, roleId)
      continue
    }

    const reviewerId = latest.mode === 'agent' ? `reviewer:${card.id}:${latest.reviewerId ?? 'agent'}` : `human:${card.id}`
    const changes = cardCycles.filter(cycle => cycle.status === 'changes').length
    nodes.push({
      id: reviewerId,
      kind: latest.mode === 'agent' ? 'reviewer' : 'human',
      title: latest.mode === 'agent' ? agentName(latest.reviewerId ?? 'reviewer') : '人工验收',
      subtitle: latest.mode === 'agent' ? '评估者' : 'Human in the loop',
      status: latest.status,
      cardId: card.id,
      agentId: latest.reviewerId,
      meta: `${cardCycles.length} 次评审${changes ? ` · ${changes} 次退回` : ''}`,
    })
    const reviewGateId = `gate:review:${card.id}`
    nodes.push({
      id: reviewGateId,
      kind: 'gate',
      title: `Review Gate #${latest.round}`,
      subtitle: latest.status === 'approved' ? '评审通过，允许下游领取' : latest.status === 'changes' ? '已退回，等待返工收敛' : '等待评审决策',
      status: latest.status,
      cardId: card.id,
      meta: latest.status.toUpperCase(),
    })
    edges.push(
      { id: `${roleId}>${reviewerId}`, from: roleId, to: reviewerId, kind: 'flow', label: '提交评审' },
      { id: `${reviewerId}>${reviewGateId}`, from: reviewerId, to: reviewGateId, kind: 'flow', label: latest.status === 'approved' ? '批准' : latest.status === 'changes' ? '退回后重审' : '决策中' },
    )
    output.set(card.id, reviewGateId)

    for (const cycle of cardCycles.filter(row => row.status === 'changes')) {
      const targetId = cycle.targetCardId && byId.has(cycle.targetCardId) ? cycle.targetCardId : card.id
      edges.push({ id: `feedback:${card.id}:${cycle.round}`, from: reviewerId, to: `role:${targetId}`, kind: 'feedback', label: `Gate #${cycle.round} 返工` })
    }
  }

  for (const card of cards) {
    const gateId = `gate:ready:${card.id}`
    if (card.deps.length) {
      for (const parentId of card.deps) {
        const source = output.get(parentId)
        if (source) edges.push({ id: `${source}>${gateId}`, from: source, to: gateId, kind: 'dependency', label: 'handoff' })
      }
    } else {
      edges.push({ id: `terminal:start>${gateId}`, from: 'terminal:start', to: gateId, kind: 'flow' })
    }
  }

  const parents = new Set(cards.flatMap(card => card.deps))
  for (const card of cards.filter(row => !parents.has(row.id))) {
    const source = output.get(card.id)
    if (source) edges.push({ id: `${source}>terminal:finish`, from: source, to: 'terminal:finish', kind: 'flow' })
  }

  return { nodes, edges, mode: 'generic' }
}

export function layoutTaskGraph(graph: TaskGraph): PositionedTaskGraph {
  if (graph.mode === 'rounds') {
    const rounds = Math.max(1, ...graph.nodes.map(node => node.round ?? 0))
    const positions = new Map<string, { x: number; y: number }>()
    const columns = [250, 478, 706, 934, 1162]
    for (const node of graph.nodes) {
      if (node.id === 'terminal:start') positions.set(node.id, { x: 22, y: 64 })
      else if (node.id === 'terminal:finish') positions.set(node.id, { x: 1390, y: 64 + (rounds - 1) * 166 })
      else if (node.round) {
        const column = node.gateType === 'release' ? 1 : node.gateType === 'decision' ? 4 : node.cardId?.endsWith('#0') ? 0 : node.cardId?.endsWith('#1') ? 2 : 3
        positions.set(node.id, { x: columns[column], y: 64 + (node.round - 1) * 166 })
      }
    }
    return { ...graph, positions, width: 1608, height: Math.max(360, rounds * 166 + 76) }
  }
  const flowEdges = graph.edges.filter(edge => edge.kind !== 'feedback')
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]))
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as string[]]))
  for (const edge of flowEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const level = new Map<string, number>()
  const queue = graph.nodes.filter(node => !incoming.get(node.id)).map(node => node.id)
  for (const id of queue) level.set(id, 0)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]
    for (const next of outgoing.get(id) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(id) ?? 0) + 1))
      incoming.set(next, (incoming.get(next) ?? 1) - 1)
      if (!incoming.get(next)) queue.push(next)
    }
  }
  for (const node of graph.nodes) if (!level.has(node.id)) level.set(node.id, 0)

  const layers = new Map<number, TaskGraphNode[]>()
  for (const node of graph.nodes) {
    const n = level.get(node.id) ?? 0
    layers.set(n, [...(layers.get(n) ?? []), node])
  }
  const maxRows = Math.max(1, ...[...layers.values()].map(rows => rows.length))
  const maxLevel = Math.max(0, ...level.values())
  const rowPitch = 142
  const columnPitch = 238
  const height = Math.max(360, maxRows * rowPitch + 120 + (graph.edges.some(edge => edge.kind === 'feedback') ? 64 : 0))
  const width = Math.max(860, maxLevel * columnPitch + 280)
  const positions = new Map<string, { x: number; y: number }>()
  for (const [column, rows] of layers) {
    const blockHeight = (rows.length - 1) * rowPitch
    rows.forEach((node, index) => positions.set(node.id, { x: 42 + column * columnPitch, y: Math.round((height - blockHeight) / 2 - 52 + index * rowPitch) }))
  }
  return { ...graph, positions, width, height }
}
