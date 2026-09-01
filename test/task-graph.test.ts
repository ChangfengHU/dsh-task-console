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
