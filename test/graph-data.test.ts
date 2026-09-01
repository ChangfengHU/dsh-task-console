import assert from 'node:assert/strict'
import test from 'node:test'
import { replayGraph, type GraphEventRow } from '../src/graph-data.ts'

const event = (id: number, task: string, kind: string, payload: Record<string, unknown> = {}, run_id: number | null = null): GraphEventRow => ({ id, graph_id: 'b1', task_id: task, run_id, kind, payload, created_at: id })

test('DB replay never displays a task, link, or run before its canonical row event', () => {
  const events = [
    event(1, 'p1', 'created', { title: 'Planner 1', role: 'planner', round: 1, status: 'ready' }),
    event(2, 'p1', 'claimed', {}, 9),
    event(3, 'g1', 'created', { title: 'Gate 1', role: 'gate', node_kind: 'gate', round: 1, status: 'todo' }),
    event(4, 'g1', 'linked', { parent_id: 'p1' }),
  ]
  assert.deepEqual(replayGraph(events, 0), { tasks: [], links: [], runs: [] })
  assert.equal(replayGraph(events, 1).tasks.length, 1)
  assert.equal(replayGraph(events, 1).runs.length, 0)
  assert.equal(replayGraph(events, 2).runs.length, 1)
  assert.equal(replayGraph(events, 3).tasks.length, 2)
  assert.equal(replayGraph(events, 3).links.length, 0)
  assert.equal(replayGraph(events, 4).links.length, 1)
})

test('DB replay advances visible run evidence for bound, session, prompt, and heartbeat events', () => {
  const events = [
    event(1, 'p1', 'created', { title: 'Planner 1', role: 'planner', round: 1, status: 'ready' }),
    event(2, 'p1', 'claimed', { expires: 902 }, 9),
    event(3, 'p1', 'run_bound', { external_run_id: 'external-9', session_id: 'session-9' }, 9),
    event(4, 'p1', 'session_created', { session_id: 'session-9' }, 9),
    event(5, 'p1', 'prompt_dispatched', { message_id: 'message-9' }, 9),
    event(6, 'p1', 'heartbeat', { last_heartbeat_at: 6, claim_expires: 906 }, 9),
  ]
  assert.deepEqual(replayGraph(events, 2).runs[0].evidence, ['claimed'])
  assert.equal(replayGraph(events, 3).runs[0].phase, 'bound')
  assert.equal(replayGraph(events, 4).runs[0].phase, 'session_created')
  assert.equal(replayGraph(events, 5).runs[0].message_id, 'message-9')
  assert.deepEqual(replayGraph(events, 6).runs[0].evidence, ['claimed', 'bound', 'session_created', 'prompt_dispatched', 'heartbeat'])
  assert.equal(replayGraph(events, 6).runs[0].claim_expires, 906)
  const legacy = [...events.slice(0, 5), event(6, 'p1', 'heartbeat', {}, 9)]
  assert.equal(replayGraph(legacy).runs[0].claim_expires, null)
})
