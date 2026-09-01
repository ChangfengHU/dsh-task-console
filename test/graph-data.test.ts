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
