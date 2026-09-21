import test from 'node:test'
import assert from 'node:assert/strict'
import { agentHistory, firstAgentUse, historyQuery, type AgentSessionHeader } from '../src/agent-history.ts'
import { agentCandidates, sortAgents, AGENT_EXPAND, AGENT_COLLAPSE } from '../src/agent-order.ts'
import { fold, type TaskSpec, type Batch, type Card, type Run } from '../src/fold.ts'
import type { AgentRow } from '../src/wire.ts'

const at = (n: number) => `2026-09-${String(n).padStart(2, '0')}T00:00:00.000Z`
const header = (id: string, agentPreset: string, day = 1): AgentSessionHeader => ({ id, agentPreset, createdAt: Date.parse(at(day)) })
function fixture() {
  const st = fold([])
  const task = { id: 't1', title: 'Work', createdAt: at(1), participants: [{ agentId: 'worker' }], origin: { intakeSessionId: 'intake' }, enabled: true } as TaskSpec
  st.tasks.set(task.id, task)
  const b = { id: 'b1', taskId: 't1', firedAt: at(2), cardIds: ['c1'], turn: { participants: [{ agentId: 'worker' }], origin: { intakeSessionId: 'intake' } }, settled: { at: at(2), outcome: 'done' } } as Batch
  st.batches.set(b.id, b)
  st.cards.set('c1', { id: 'c1', taskId: 't1', batchId: 'b1', agentId: 'worker', runIds: ['r1', 'r2'], status: 'done' } as Card)
  st.runs.set('r1', { id: 'r1', taskId: 't1', batchId: 'b1', cardId: 'c1', profileId: 'worker', sessionId: 'work-session', startedAt: at(2), status: 'done' } as Run)
  st.runs.set('r2', { id: 'r2', taskId: 't1', batchId: 'b1', cardId: 'c1', profileId: 'reviewer', sessionId: 'review-session', startedAt: at(3), status: 'done' } as Run)
  const headers = [header('intake', 'creator'), header('work-session', 'worker', 2), header('review-session', 'reviewer', 3), header('direct', 'worker', 4), header('agent-worker-fake', 'other')]
  return { st, headers }
}
const query = (agentId: string, kind: 'sessions' | 'tasks' = 'sessions', page = 1, pageSize = 10) => historyQuery({ agentId, kind, page, pageSize })

test('creator sees the created task without inheriting worker sessions, deduplicated across origins', () => {
  const { st, headers } = fixture()
  const s = agentHistory(st, headers, query('creator'))
  assert.deepEqual(s.sessions.map(s => s.id), ['intake'])
  assert.equal(s.sessions[0].tasks.length, 1, 'task origin and batch origin share one link')
  const t = agentHistory(st, headers, query('creator', 'tasks'))
  assert.equal(t.tasks.length, 1)
  assert.deepEqual(t.tasks[0].relations, ['creator'])
  assert.equal(t.tasks[0].batchId, 'b1')
  assert.equal(t.tasks[0].executions, 1)
})

test('actual reviewer profile owns review sessions; names/prefixes do not establish ownership', () => {
  const { st, headers } = fixture()
  assert.deepEqual(agentHistory(st, headers, query('worker')).sessions.map(s => s.id), ['direct', 'work-session'])
  const reviewer = agentHistory(st, headers, query('reviewer'))
  assert.deepEqual(reviewer.sessions.map(s => s.id), ['review-session'])
  assert.equal(reviewer.counts.tasks, 1)
  assert.equal(reviewer.sessions[0].kind, 'task')
})

test('later turns replace template participants; links prefer the latest relevant execution', () => {
  const { st, headers } = fixture()
  for (let i = 2; i <= 3; i++) st.batches.set(`b${i}`, { id: `b${i}`, taskId: 't1', firedAt: at(i + 3), cardIds: [], turn: { objective: 'new turn', participants: [{ agentId: 'new-worker' }] } })
  const old = agentHistory(st, headers, query('worker', 'tasks')).tasks[0]
  assert.equal(old.batchId, 'b1'); assert.equal(old.executions, 1)
  const recent = agentHistory(st, headers, query('new-worker', 'tasks')).tasks[0]
  assert.equal(recent.batchId, 'b3'); assert.equal(recent.executions, 2)
})

test('dynamic cards, legacy runs and deleted task/session records retain honest relationships', () => {
  const { st, headers } = fixture()
  delete st.runs.get('r1')!.profileId
  st.cards.set('dynamic', { id: 'dynamic', taskId: 't1', batchId: 'b1', agentId: 'dynamic-worker', kind: 'agent', runIds: [] } as Card)
  assert.equal(agentHistory(st, headers, query('dynamic-worker', 'tasks')).total, 1)
  assert.equal(agentHistory(st, headers, query('worker')).sessions.find(s => s.id === 'work-session')?.kind, 'task')
  st.tasks.delete('t1')
  const missing = agentHistory(st, [], query('reviewer'))
  assert.equal(missing.sessions[0].available, false)
  assert.deepEqual(missing.sessions[0].tasks, [])
  assert.equal(missing.counts.tasks, 0)
})

test('server pages have stable ordering, no overlap, correct counts and boundary handling', () => {
  const { st } = fixture()
  const headers = Array.from({ length: 23 }, (_, i) => header(`s${i}`, 'many', (i % 5) + 1))
  const pages = [1, 2, 3].map(p => agentHistory(st, headers, query('many', 'sessions', p)))
  assert.deepEqual(pages.map(p => p.sessions.length), [10, 10, 3])
  assert.equal(new Set(pages.flatMap(p => p.sessions.map(s => s.id))).size, 23)
  assert.equal(pages[0].counts.sessions, 23)
  assert.equal(agentHistory(st, headers, query('many', 'sessions', 99)).page, 3)
  assert.equal(agentHistory(st, headers, query('absent')).total, 0)
  assert.equal(agentHistory(st, headers, query('absent')).pages, 1)
})

test('task pagination deduplicates creation and participation across repeated runs', () => {
  const { st, headers } = fixture()
  st.tasks.get('t1')!.participants.push({ agentId: 'creator' })
  for (let i = 2; i <= 22; i++) st.tasks.set(`t${i}`, { ...st.tasks.get('t1')!, id: `t${i}` })
  const a = agentHistory(st, headers, query('creator', 'tasks'))
  const b = agentHistory(st, headers, query('creator', 'tasks', 2))
  assert.equal(a.total, 22)
  assert.equal(a.tasks.length, 10); assert.equal(b.tasks.length, 10)
  assert.equal(new Set([...a.tasks, ...b.tasks].map(t => t.id)).size, 20)
  assert.deepEqual(a.tasks.find(t => t.id === 't1')?.relations, ['participant', 'creator'])
})

test('query rejects invalid kinds and unsafe page sizes', () => {
  for (const raw of [null, {}, { agentId: 'a', kind: 'logs' }, { agentId: 'a', kind: 'tasks', page: -1 }, { agentId: 'a', kind: 'tasks', pageSize: 51 }, { agentId: 'a', kind: 'tasks', page: '2' }]) assert.throws(() => historyQuery(raw))
})

test('creation ordering, five-row limit, expand/collapse and full roster search', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `Agent${i}`, description: '', createdAt: at(i + 1) } as AgentRow))
  assert.deepEqual(sortAgents(rows).map(a => a.id), ['a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1', 'a0'])
  const collapsed = agentCandidates(rows, '', false)
  assert.equal(collapsed.length, 6); assert.equal(collapsed[5].value, AGENT_EXPAND)
  assert.equal(agentCandidates(rows, '', true).length, 9)
  assert.equal(agentCandidates(rows, '', true).at(-1)?.value, AGENT_COLLAPSE)
  assert.deepEqual(agentCandidates(rows, 'AGENT0', false).map(x => x.value), ['a0'])
  assert.equal(agentCandidates(rows.slice(0, 5), '', false).length, 5)
  assert.equal(rows[0].id, 'a0', 'sorting does not mutate the shared roster')
})

test('historical ordering uses explicitly separate first-use metadata, never latest activity', () => {
  const uses = firstAgentUse([header('new', 'old', 6), header('old', 'old', 1)])
  assert.equal(uses.get('old'), at(1))
  const rows = [{ id: 'unknown' }, { id: 'old', firstUsedAt: uses.get('old') }, { id: 'new', createdAt: at(2) }] as AgentRow[]
  assert.deepEqual(sortAgents(rows).map(x => x.id), ['new', 'old', 'unknown'])
})
