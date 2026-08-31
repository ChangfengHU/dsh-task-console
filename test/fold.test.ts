import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actorOf, describe, foldTurns, type Event } from '../src/fold.ts'

test('foldTurns classifies mcp / skill / native / ask calls and sums usage', () => {
  const t0 = 1_700_000_000_000
  const ev = [
    { type: 'agent/inbox/spliced', time: t0, data: { inserted: [{ role: 'user', content: [{ type: 'text', text: '修一下出口' }] }] } },
    { type: 'request/context', time: t0 + 1, data: { provider: 'codex-local', model: 'gpt-5.6-terra' } },
    { type: 'turn/start', time: t0 + 2, data: { turn: 1 } },
    { type: 'step/start', time: t0 + 3, data: { turn: 1, step: 1 } },
    { type: 'tool/call', time: t0 + 100, data: { turn: 1, step: 1, callId: 'c1', name: 'skill', arguments: '{"name":"fleet-proxy-switch"}' } },
    { type: 'tool/result', time: t0 + 150, data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '<skill_content>…' }] }] } } },
    { type: 'assistant/message', time: t0 + 900, data: { message: { content: [{ type: 'text', text: '先看状态' }] }, usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 10 } } },
    { type: 'step/end', time: t0 + 901, data: { turn: 1, step: 1 } },
    { type: 'step/start', time: t0 + 1000, data: { turn: 1, step: 2 } },
    { type: 'tool/call', time: t0 + 1100, data: { turn: 1, step: 2, callId: 'c2', name: 'mcp__vyibc-fleet__vyibc-fleet_status', arguments: '{}' } },
    { type: 'tool/result', time: t0 + 1600, data: { message: { source: { callId: 'c2' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"ok":true,"nodes":[]}' }] }] } } },
    { type: 'tool/call', time: t0 + 1700, data: { turn: 1, step: 2, callId: 'c3', name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', time: t0 + 1750, data: { message: { source: { callId: 'c3' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'exit code 1: nope' }] }] } } },
    { type: 'tool/call', time: t0 + 1800, data: { turn: 1, step: 2, callId: 'c4', name: 'ask_user_question', arguments: '{"questions":[{"question":"继续?"}]}' } },
    { type: 'assistant/message', time: t0 + 2000, data: { message: { content: [{ type: 'text', text: '问一下' }] }, usage: { inputTokens: 2000, outputTokens: 30 } } },
    { type: 'step/end', time: t0 + 2001, data: { turn: 1, step: 2 } },
    { type: 'turn/end', time: t0 + 2100, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const l = foldTurns('s-1', ev, 'fleet-ops')
  assert.equal(l.turns.length, 1); assert.equal(l.turns[0].user, '修一下出口'); assert.equal(l.turns[0].steps.length, 2)
  assert.equal(l.turns[0].steps[0].model, 'gpt-5.6-terra')
  const kinds = l.turns[0].steps.flatMap(s => s.tools).map(t => t.kind)
  assert.deepEqual(kinds, ['skill', 'mcp', 'native', 'ask'])
  assert.equal(l.turns[0].steps[1].tools[0].server, 'vyibc-fleet'); assert.equal(l.turns[0].steps[1].tools[0].name, 'vyibc-fleet_status'); assert.equal(l.turns[0].steps[1].tools[0].ms, 500)
  assert.equal(l.turns[0].steps[1].tools[1].ok, false)
  assert.deepEqual(l.totals.byServer, { 'vyibc-fleet': 1 }); assert.deepEqual(l.totals.skills, ['fleet-proxy-switch'])
  assert.equal(l.totals.input, 3000); assert.equal(l.totals.output, 80); assert.equal(l.totals.mcp, 1); assert.equal(l.totals.ask, 1); assert.equal(l.totals.ms, 2098)
})

test('event stream rows say who moved and read as one line', () => {
  const e1: Event = { t: 'run/fired', at: 'x', run: { id: 'r', taskId: 'T', by: 'cron', legs: ['a'] } }
  const e2: Event = { t: 'leg/blocked', at: 'x', runId: 'r', leg: 0, question: '改 5901?' }
  const e3: Event = { t: 'leg/resumed', at: 'x', runId: 'r', leg: 0 }
  assert.equal(actorOf(e1), 'clock'); assert.equal(actorOf(e2), 'agent'); assert.equal(actorOf(e3), 'person')
  assert.equal(describe(e2, id => id, () => '装机员'), '装机员 停下来问:改 5901?')
  assert.equal(describe(e1, id => id), '到点触发,1 段排队')
})
