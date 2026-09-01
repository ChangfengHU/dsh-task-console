import type { Card, State } from './fold.ts'

export interface GraphReviewCycle {
  cardId: string
  round: number
  status: 'pending' | 'approved' | 'changes'
  mode: 'human' | 'agent'
  reviewerId?: string
  targetCardId?: string
  note?: string
}

export type TaskGraphNodeKind = 'terminal' | 'role' | 'reviewer' | 'human' | 'gate'
export type TaskGraphEdgeKind = 'flow' | 'dependency' | 'feedback'

export interface TaskGraphNode {
  id: string
  kind: TaskGraphNodeKind
  title: string
  subtitle: string
  status: string
  cardId?: string
  agentId?: string
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
}

export interface PositionedTaskGraph extends TaskGraph {
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
}

const finished = (card?: Card) => card?.status === 'done'

/**
 * Build the visible execution DAG from durable cards and review decisions.
 * Feedback/rework edges are audit overlays and are deliberately excluded from
 * dependency ordering, otherwise a rework loop would stop being a DAG.
 */
export function buildTaskGraph(cards: Card[], state: State, cycles: GraphReviewCycle[], agentName: (id: string) => string): TaskGraph {
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

  return { nodes, edges }
}

export function layoutTaskGraph(graph: TaskGraph): PositionedTaskGraph {
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
