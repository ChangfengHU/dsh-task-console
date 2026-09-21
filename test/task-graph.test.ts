import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold, type Event, type TaskSpec } from '../src/fold.ts'
import { buildTaskGraph, layoutTaskGraph, type GraphReviewCycle } from '../src/task-graph.ts'

test('task graph makes role and gate nodes a real DAG while keeping rework as a feedback overlay', () => {
  const task: TaskSpec = { id: 'T', title: '三角色协同', brief: 'plan, implement, review', trigger: { kind: 'once' }, participants: [{ agentId: 'planner' }, { agentId: 'executor' }], cwd: '/tmp', timeoutSec: 600, onFail: 'stop', maxTries: 2, enabled: true, createdAt: '1' }
  const events: Event[] = [
    { t: 'task/created', at: '1', taskId: 'T', task },
    { t: 'batch/fired', at: '2', taskId: 'T', batch: { id: 'b', by: 'manual', cards: [{ id: 'b#0', agentId: 'planner', deps: [] }, { id: 'b#1', agentId: 'executor', deps: ['b#0'] }] } },
    { t: 'run/claimed', at: '3', taskId: 'T', cardId: 'b#0', runId: 'p', sessionId: 'sp', attempt: 1 },
    { t: 'run/completed', at: '4', taskId: 'T', runId: 'p', summary: '计划完成' },
    { t: 'card/ready', at: '5', taskId: 'T', cardId: 'b#1' },
    { t: 'run/claimed', at: '6', taskId: 'T', cardId: 'b#1', runId: 'e1', sessionId: 'se1', attempt: 1 },
    { t: 'run/review_requested', at: '7', taskId: 'T', runId: 'e1', summary: '请验收', reviewer: 'reviewer' },
  ]
  const state = fold(events)
  const cycles: GraphReviewCycle[] = [{ cardId: 'b#1', round: 1, status: 'changes', mode: 'agent', reviewerId: 'reviewer', targetCardId: 'b#1', note: '补键盘交互' }, { cardId: 'b#1', round: 2, status: 'approved', mode: 'agent', reviewerId: 'reviewer' }]
  const graph = buildTaskGraph([...state.cards.values()], state, cycles, id => id)

  assert.deepEqual(graph.nodes.filter(node => node.kind === 'role').map(node => node.title), ['planner', 'executor'])
  assert.equal(graph.nodes.find(node => node.kind === 'reviewer')?.title, 'reviewer')
  assert.equal(graph.nodes.filter(node => node.kind === 'gate').length, 3)
  assert.ok(graph.edges.some(edge => edge.from === 'role:b#0' && edge.to === 'gate:ready:b#1' && edge.kind === 'dependency'))
  assert.ok(graph.edges.some(edge => edge.kind === 'feedback' && edge.from.startsWith('reviewer:') && edge.to === 'role:b#1'))

  const positioned = layoutTaskGraph(graph)
  for (const edge of positioned.edges.filter(edge => edge.kind !== 'feedback')) {
    assert.ok(positioned.positions.get(edge.from)!.x < positioned.positions.get(edge.to)!.x, `${edge.id} must point forward`)
  }
  const feedback = positioned.edges.find(edge => edge.kind === 'feedback')!
  assert.ok(positioned.positions.get(feedback.from)!.x > positioned.positions.get(feedback.to)!.x, 'feedback is visibly backward but not part of DAG ordering')
})

test('upstream review changes unroll durable runs into new rounds without creating a cycle', () => {
  const task: TaskSpec = { id: 'T3', title: '多轮返工', brief: 'plan, implement, review', trigger: { kind: 'once' }, participants: [{ agentId: 'planner' }, { agentId: 'executor' }, { agentId: 'reviewer' }], cwd: '/tmp', timeoutSec: 600, onFail: 'stop', maxTries: 2, enabled: true, createdAt: '2026-01-01T00:00:01Z' }
  const events: Event[] = [
    { t: 'task/created', at: '2026-01-01T00:00:01Z', taskId: 'T3', task },
    { t: 'batch/fired', at: '2026-01-01T00:00:02Z', taskId: 'T3', batch: { id: 'b3', by: 'manual', cards: [{ id: 'b3#0', agentId: 'planner', deps: [] }, { id: 'b3#1', agentId: 'executor', deps: ['b3#0'] }, { id: 'b3#2', agentId: 'reviewer', deps: ['b3#1'] }] } },
  ]
  const addRound = (round: number, base: number) => {
    const at = (offset: number) => `2026-01-01T00:00:${String(base + offset).padStart(2, '0')}Z`
    events.push(
      { t: 'run/claimed', at: at(0), taskId: 'T3', cardId: 'b3#0', runId: `p${round}`, sessionId: `sp${round}`, attempt: round },
      { t: 'run/completed', at: at(1), taskId: 'T3', runId: `p${round}`, summary: `计划 ${round}` },
      { t: 'card/ready', at: at(2), taskId: 'T3', cardId: 'b3#1' },
      { t: 'run/claimed', at: at(3), taskId: 'T3', cardId: 'b3#1', runId: `e${round}`, sessionId: `se${round}`, attempt: round },
      { t: 'run/completed', at: at(4), taskId: 'T3', runId: `e${round}`, summary: `实现 ${round}` },
      { t: 'card/ready', at: at(5), taskId: 'T3', cardId: 'b3#2' },
      { t: 'run/claimed', at: at(6), taskId: 'T3', cardId: 'b3#2', runId: `r${round}`, sessionId: `sr${round}`, attempt: round },
      { t: 'run/review_requested', at: at(7), taskId: 'T3', runId: `r${round}`, summary: `验收 ${round}` },
    )
  }
  addRound(1, 3)
  events.push({ t: 'card/changes_requested', at: '2026-01-01T00:00:11.900Z', taskId: 'T3', cardId: 'b3#2', runId: 'r1', note: '补齐空状态', targetCardId: 'b3#0' })
  // The kernel claim is second-precision and can look older than the browser
  // decision even though it was appended afterwards.
  addRound(2, 11)
  events.push({ t: 'card/changes_requested', at: '2026-01-01T00:00:20Z', taskId: 'T3', cardId: 'b3#2', runId: 'r2', note: '补齐键盘路径', targetCardId: 'b3#0' })
  addRound(3, 21)
  events.push({ t: 'card/review_approved', at: '2026-01-01T00:00:29Z', taskId: 'T3', cardId: 'b3#2', runId: 'r3', note: '通过' })
  const state = fold(events)
  const cycles: GraphReviewCycle[] = [
    { cardId: 'b3#2', runId: 'r1', round: 1, status: 'changes', mode: 'human', targetCardId: 'b3#0', note: '补齐空状态', requestedAt: '2026-01-01T00:00:10Z', decidedAt: '2026-01-01T00:00:11.900Z' },
    { cardId: 'b3#2', runId: 'r2', round: 2, status: 'changes', mode: 'human', targetCardId: 'b3#0', note: '补齐键盘路径', requestedAt: '2026-01-01T00:00:19Z', decidedAt: '2026-01-01T00:00:20Z' },
    { cardId: 'b3#2', runId: 'r3', round: 3, status: 'approved', mode: 'human', requestedAt: '2026-01-01T00:00:28Z', decidedAt: '2026-01-01T00:00:29Z' },
  ]
  const graph = buildTaskGraph([...state.cards.values()], state, cycles, id => id)

  assert.equal(graph.mode, 'rounds')
  assert.equal(graph.nodes.filter(node => node.round).length, 15)
  assert.deepEqual(graph.nodes.filter(node => node.cardId === 'b3#0' && node.kind === 'role').map(node => node.runId), ['p1', 'p2', 'p3'])
  assert.deepEqual(graph.edges.filter(edge => edge.kind === 'rework').map(edge => edge.to), ['round:2:role:b3#0', 'round:3:role:b3#0'])
  assert.equal(graph.edges.some(edge => edge.kind === 'feedback'), false)

  const incoming = new Map(graph.nodes.map(node => [node.id, 0]))
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as string[]]))
  for (const edge of graph.edges) { incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1); outgoing.get(edge.from)?.push(edge.to) }
  const queue = graph.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id)
  let visited = 0
  for (let cursor = 0; cursor < queue.length; cursor++) { visited++; for (const next of outgoing.get(queue[cursor]) ?? []) { incoming.set(next, (incoming.get(next) ?? 1) - 1); if (incoming.get(next) === 0) queue.push(next) } }
  assert.equal(visited, graph.nodes.length, 'unrolled rework graph must remain acyclic')

  const positioned = layoutTaskGraph(graph)
  for (const edge of graph.edges.filter(edge => edge.kind === 'rework')) assert.ok(positioned.positions.get(edge.from)!.y < positioned.positions.get(edge.to)!.y, `${edge.id} must advance to a lower round lane`)
})
