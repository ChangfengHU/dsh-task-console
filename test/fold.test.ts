import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actorOf, batchStatus, describe, fold, foldTurns, migrate, readyCards, type Event, type TaskSpec } from '../src/fold.ts'

const task: TaskSpec = { id: 'T-1', title: '接机', brief: '装 clash + VNC', trigger: { kind: 'once' }, participants: [{ agentId: 'installer' }, { agentId: 'inspector', brief: '验一遍' }], cwd: '/tmp', timeoutSec: 600, onFail: 'retry', maxTries: 2, enabled: true, createdAt: 'x' }
const fired: Event = { t: 'batch/fired', at: '2', taskId: 'T-1', batch: { id: 'b1', by: 'manual', cards: [{ id: 'b1#0', agentId: 'installer', deps: [] }, { id: 'b1#1', agentId: 'inspector', brief: '验一遍', deps: ['b1#0'] }] } }

test('fold: a chain of cards moves todo → ready → running → done as runs complete', () => {
  const ev: Event[] = [{ t: 'task/created', at: '1', taskId: 'T-1', task }, fired]
  let s = fold(ev)
  assert.equal(s.cards.get('b1#0')!.status, 'ready'); assert.equal(s.cards.get('b1#1')!.status, 'todo')
  assert.deepEqual(readyCards(s).map(c => c.id), ['b1#0'])
  ev.push({ t: 'run/claimed', at: '3', taskId: 'T-1', cardId: 'b1#0', runId: 'b1#0#1', sessionId: 's-1', attempt: 1 })
  s = fold(ev); assert.equal(s.cards.get('b1#0')!.status, 'running'); assert.equal(batchStatus(s, s.batches.get('b1')!), 'run')
  ev.push({ t: 'run/blocked', at: '4', taskId: 'T-1', runId: 'b1#0#1', kind: 'needs_input', reason: '改 5901?' })
  s = fold(ev); assert.equal(s.cards.get('b1#0')!.status, 'blocked'); assert.equal(batchStatus(s, s.batches.get('b1')!), 'park'); assert.equal(s.runs.get('b1#0#1')!.question, '改 5901?')
  ev.push({ t: 'run/resumed', at: '5', taskId: 'T-1', runId: 'b1#0#1' }, { t: 'run/completed', at: '6', taskId: 'T-1', runId: 'b1#0#1', summary: '产物:x' })
  s = fold(ev)
  assert.equal(s.cards.get('b1#0')!.status, 'done'); assert.equal(s.cards.get('b1#0')!.summary, '产物:x'); assert.equal(s.runs.get('b1#0#1')!.outcome, 'completed')
  assert.deepEqual(readyCards(s).map(c => c.id), ['b1#1'])   // deps satisfied
  ev.push({ t: 'card/ready', at: '6', taskId: 'T-1', cardId: 'b1#1' }, { t: 'run/claimed', at: '7', taskId: 'T-1', cardId: 'b1#1', runId: 'b1#1#1', sessionId: 's-2', attempt: 1 }, { t: 'run/completed', at: '8', taskId: 'T-1', runId: 'b1#1#1', summary: 'ok' }, { t: 'batch/settled', at: '8', taskId: 'T-1', batchId: 'b1', outcome: 'done' })
  s = fold(ev); assert.equal(batchStatus(s, s.batches.get('b1')!), 'done')
})

test('fold: failures count toward the breaker; gave_up marks the card failed; same-reason blocks recur', () => {
  const ev: Event[] = [{ t: 'task/created', at: '1', taskId: 'T-1', task }, fired,
    { t: 'run/claimed', at: '3', taskId: 'T-1', cardId: 'b1#0', runId: 'r1', sessionId: 's', attempt: 1 },
    { t: 'run/timed_out', at: '4', taskId: 'T-1', runId: 'r1', error: 'slow' }]
  let s = fold(ev)
  assert.equal(s.cards.get('b1#0')!.status, 'ready'); assert.equal(s.cards.get('b1#0')!.consecutiveFailures, 1); assert.equal(s.runs.get('r1')!.outcome, 'timed_out')
  ev.push({ t: 'run/claimed', at: '5', taskId: 'T-1', cardId: 'b1#0', runId: 'r2', sessionId: 's', attempt: 2 }, { t: 'run/failed', at: '6', taskId: 'T-1', runId: 'r2', outcome: 'protocol_violation', error: 'no terminal' }, { t: 'card/gave_up', at: '6', taskId: 'T-1', cardId: 'b1#0', error: 'no terminal' })
  s = fold(ev); assert.equal(s.cards.get('b1#0')!.status, 'failed'); assert.equal(s.cards.get('b1#0')!.consecutiveFailures, 2); assert.equal(s.runs.get('r2')!.outcome, 'protocol_violation')
  assert.equal(readyCards(s).length, 0)
  // block recurrence
  const ev2: Event[] = [{ t: 'task/created', at: '1', taskId: 'T-1', task }, fired, { t: 'run/claimed', at: '3', taskId: 'T-1', cardId: 'b1#0', runId: 'r1', sessionId: 's', attempt: 1 },
    { t: 'run/blocked', at: '4', taskId: 'T-1', runId: 'r1', kind: 'needs_input', reason: 'A' }, { t: 'run/resumed', at: '5', taskId: 'T-1', runId: 'r1' },
    { t: 'run/blocked', at: '6', taskId: 'T-1', runId: 'r1', kind: 'needs_input', reason: 'A' }, { t: 'run/resumed', at: '7', taskId: 'T-1', runId: 'r1' },
    { t: 'run/blocked', at: '8', taskId: 'T-1', runId: 'r1', kind: 'needs_input', reason: 'B' }]
  const s2 = fold(ev2); assert.equal(s2.cards.get('b1#0')!.blockRecurrences, 1); assert.equal(s2.cards.get('b1#0')!.lastBlockReason, 'B')
})

test('migrate: a 0.4 leg/* stream folds to the same picture', () => {
  const old = [
    { t: 'task/created', at: '1', task },
    { t: 'run/fired', at: '2', run: { id: 'r-9', taskId: 'T-1', by: 'manual', legs: ['installer', 'inspector'] } },
    { t: 'leg/spawned', at: '3', runId: 'r-9', leg: 0, sessionId: 's-1', tries: 1 },
    { t: 'leg/blocked', at: '4', runId: 'r-9', leg: 0, question: '改 5901?' },
    { t: 'leg/resumed', at: '5', runId: 'r-9', leg: 0 },
    { t: 'leg/done', at: '6', runId: 'r-9', leg: 0, handoff: '产物:x' },
    { t: 'leg/spawned', at: '7', runId: 'r-9', leg: 1, sessionId: 's-2', tries: 1 },
    { t: 'leg/timed_out', at: '8', runId: 'r-9', leg: 1, error: 'slow' },
    { t: 'run/settled', at: '9', runId: 'r-9', outcome: 'failed' },
  ]
  const s = fold(migrate(old))
  const b = s.batches.get('r-9')!; assert.ok(b); assert.deepEqual(b.cardIds, ['r-9#0', 'r-9#1'])
  assert.equal(s.cards.get('r-9#0')!.status, 'done'); assert.equal(s.cards.get('r-9#0')!.summary, '产物:x')
  assert.equal(s.cards.get('r-9#1')!.status, 'failed'); assert.equal(s.runs.get('r-9#1#1')!.outcome, 'timed_out')
  assert.equal(batchStatus(s, b), 'bad'); assert.equal(b.settled?.outcome, 'failed')
  assert.equal(s.cards.get('r-9#1')!.deps[0], 'r-9#0')
})

test('describe / actorOf read as one line with the right hand', () => {
  const s = fold([{ t: 'task/created', at: '1', taskId: 'T-1', task }, fired, { t: 'run/claimed', at: '3', taskId: 'T-1', cardId: 'b1#0', runId: 'r1', sessionId: 's', attempt: 1 }])
  const name = (id: string) => ({ installer: '装机员', inspector: '巡检员' })[id] ?? id
  const e: Event = { t: 'run/blocked', at: '4', taskId: 'T-1', runId: 'r1', kind: 'needs_input', reason: '改 5901?' }
  assert.equal(describe(e, s, name), '装机员 停下来问:改 5901?'); assert.equal(actorOf(e), 'agent')
  assert.equal(actorOf(fired), 'person'); assert.equal(describe(fired, s, name), '手动触发,2 张卡排好队')
  assert.equal(describe({ t: 'run/failed', at: '5', taskId: 'T-1', runId: 'r1', outcome: 'protocol_violation' }, s, name), '装机员 失败(没按协议交卷)')
})

test('foldTurns classifies task_* terminators as their own kind', () => {
  const t0 = 1_700_000_000_000
  const ev = [
    { type: 'turn/start', time: t0, data: { turn: 1 } }, { type: 'step/start', time: t0 + 1, data: { turn: 1, step: 1 } },
    { type: 'tool/call', time: t0 + 100, data: { callId: 'c1', name: 'mcp__vyibc-fleet__vyibc-fleet_status', arguments: '{}' } },
    { type: 'tool/result', time: t0 + 400, data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"ok":true}' }] }] } } },
    { type: 'tool/call', time: t0 + 500, data: { callId: 'c2', name: 'task_complete', arguments: '{"summary":"done"}' } },
    { type: 'tool/result', time: t0 + 510, data: { message: { source: { callId: 'c2' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"ok":true}' }] }] } } },
    { type: 'assistant/message', time: t0 + 600, data: { message: { content: [{ type: 'text', text: '交卷' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'step/end', time: t0 + 601, data: {} }, { type: 'turn/end', time: t0 + 700, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const l = foldTurns('s', ev)
  assert.deepEqual(l.turns[0].steps[0].tools.map(t => t.kind), ['mcp', 'task']); assert.equal(l.totals.task, 1); assert.equal(l.totals.mcp, 1)
})
