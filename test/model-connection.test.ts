import test from 'node:test'
import assert from 'node:assert/strict'
import { foldTurns } from '../src/fold.ts'
import { TaskConsoleService } from '../src/service.ts'

const start = { type: 'turn/start', time: 1000, data: { turn: 1 } }
const error = (willRetry = true, message = 'Reconnecting... 3/5', time = 2000) => ({ type: 'assistant/chunk', time, data: { chunk: { type: 'block-end', block: {
  type: 'codex-action', actionType: 'error', protocolEvent: 'error', snapshot: {
    error: { message, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'secret-token-value' }, willRetry, threadId: 'private-thread', turnId: 'private-turn',
  },
} } } })
const action = (category: string, actionType: string, time = 3000) => ({ type: 'assistant/chunk', time, data: { chunk: { type: 'block-end', block: { type: 'codex-action', category, actionType } } } })

test('real reconnect envelope projects bounded retry evidence without private payloads', () => {
  const ledger = foldTurns('s', [start, error()])
  assert.equal(ledger.connection?.status, 'reconnecting')
  assert.deepEqual(ledger.connection?.retry, { attempt: 3, limit: 5 })
  assert.equal(ledger.connection?.reason, 'stream_disconnected')
  assert.equal(ledger.turns[0].connection?.status, 'reconnecting')
  assert.equal(ledger.connection?.lastProgressAt, undefined)
  assert.doesNotMatch(JSON.stringify(ledger), /secret-token|private-thread|private-turn/)
  assert.equal(foldTurns('s', [start, error(true, 'Reconnecting... 5/5')]).connection?.status, 'reconnecting')
})

test('context, tool results and lifecycle do not imply model or production recovery', () => {
  const events = [start, error(), action('context', 'context/injected'), action('lifecycle', 'thread/start'),
    { type: 'request/context', time: 4000, data: {} },
    { type: 'tool/result', time: 5000, data: {} },
    { type: 'agent/inbox/spliced', time: 6000, data: {} }]
  const c = foldTurns('s', events).connection
  assert.equal(c?.status, 'reconnecting')
  assert.equal(c?.lastProgressAt, undefined)
  assert.equal(c?.lastEventAt, new Date(6000).toISOString())
  const resumed = foldTurns('s', [...events, action('action', 'custom_tool_call', 7000)]).connection
  assert.equal(resumed?.status, 'resumed')
  assert.equal(resumed?.lastProgressAt, new Date(7000).toISOString())
})

test('model output proves resumption; terminal failure stays terminal until a fresh turn', () => {
  const text = { type: 'assistant/chunk', time: 3000, data: { chunk: { type: 'text-delta', text: 'Continue' } } }
  assert.equal(foldTurns('s', [start, error(), text]).connection?.status, 'resumed')
  const events = [start, error(false, 'credentials: secret-token-value'), text]
  const failed = foldTurns('s', events)
  assert.equal(failed.connection?.status, 'failed')
  assert.equal(failed.connection?.retry, undefined)
  assert.doesNotMatch(JSON.stringify(failed), /secret-token/)
  const next = foldTurns('s', [...events, { ...start, time: 4000, data: { turn: 2 } }])
  assert.equal(next.connection?.status, 'unknown')
  assert.equal(next.turns[0].connection?.status, 'failed')
  assert.equal(next.turns[1].connection?.status, 'unknown')
})

test('turn end closes pending reconnect without claiming resumed production', () => {
  assert.equal(foldTurns('s', [start, error(), { type: 'turn/end', time: 4000, data: { reason: { kind: 'completed' } } }]).connection?.status, 'ended')
  assert.equal(foldTurns('s', [start, error(), { type: 'turn/end', time: 4000, data: { reason: { kind: 'failed' } } }]).connection?.status, 'failed')
  assert.equal(foldTurns('s', []).connection?.status, 'unknown')
})

for (const cold of [true, false]) test(`sessionTurns exposes connection evidence from ${cold ? 'persisted' : 'live'} log without activation`, async () => {
  const service = Object.create(TaskConsoleService.prototype)
  const session = { header: { agentPreset: 'worker' }, events: [start, error()] }
  const services = cold ? { sessionPersistence: { inspect: async () => session } } : { sessions: { get: () => session } }
  Object.defineProperty(service, 'ctx', { value: { get: (name: string) => services[name] } })
  const response = JSON.parse(await service.sessionTurns(JSON.stringify({ sessionId: 's' })))
  assert.equal(response.connection.status, 'reconnecting')
  assert.equal(response.agentPreset, 'worker')
  assert.deepEqual(response.turns[0].connection.retry, { attempt: 3, limit: 5 })
})

test('missing retry flag and malformed counters do not invent a terminal diagnosis or retry budget', () => {
  const notification = error()
  delete (notification.data.chunk.block.snapshot as any).willRetry
  assert.equal(foldTurns('s', [start, notification]).connection?.status, 'unknown')
  assert.equal(foldTurns('s', [start, error(true, 'Reconnecting... 9/5')]).connection?.retry, undefined)
  assert.equal(foldTurns('s', [start, error(true, 'Reconnecting... 3/5 secret-token')]).connection?.retry, undefined)
})
