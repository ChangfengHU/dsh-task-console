import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { legacyToolContextId, patchToolHistoryBundle, patchDeepseekStream, patchHistoryPersistence } from '../scripts/patch-history-ids.mjs'
import { restoreHistoryToolIds } from '../scripts/restore-history-tool-ids.mjs'

test('empty-ID calls pair by recorded source sequence, including parallel and paginated results', () => {
  const first = { type: 'tool/call', seq: 29 }
  const second = { type: 'tool/call', seq: 30 }
  const laterFirstResult = { type: 'tool/result', seq: 34, sourceEventSeqs: [29] }
  assert.notEqual(legacyToolContextId(first, ''), legacyToolContextId(second, ''))
  assert.equal(legacyToolContextId(laterFirstResult, '', true), legacyToolContextId(first, ''))
  assert.equal(legacyToolContextId({ seq: 32, sourceEventSeqs: [30] }, '', true), legacyToolContextId(second, ''))
  assert.equal(legacyToolContextId(first, 'provider-call'), 'provider-call')
  assert.deepEqual(first, { type: 'tool/call', seq: 29 })
})

test('missing, ambiguous and invalid result links remain distinct orphans', () => {
  for (const sourceEventSeqs of [undefined, [], [29,30], [35], [-1], ['29']]) {
    assert.equal(legacyToolContextId({ seq: 34, sourceEventSeqs }, '', true), 'legacy-empty-result:34')
  }
})

test('both exact UI bundle transforms are idempotent and execute their matching rules', () => {
  for (const trajectory of [false, true]) {
    const name = trajectory ? 'trajectoryToolDefinition' : 'toolDefinition'
    const source = `const ${name} = {match: event => {
if (event.type === "tool/call") return {id: String(event.data.callId),
\t\t\t\t\trole: "start"};
if (event.type === "tool/result") return {id: String(event.data.message.source.callId),
\t\t\t\t\trole: "update"};
return null; }};`
    const patched = patchToolHistoryBundle(source, trajectory)
    assert.equal(patchToolHistoryBundle(patched, trajectory), patched)
    const match = runInNewContext(`${patched}; ${name}.match`)
    assert.equal(match({ type: 'tool/call', seq: 4, data: { callId: '' } }).id,
      match({ type: 'tool/result', seq: 7, sourceEventSeqs: [4], data: { message: { source: { callId: '' } } } }).id)
  }
  assert.throws(() => patchToolHistoryBundle('unknown bundle'), /Unrecognized/)
})

test('stream patch retains a valid ID across empty fragments and rejects a missing final ID', () => {
  const source = `function delta(block, call) { if (call.id !== void 0) block.callId = call.id; }
function closeBlock(block) {
return block;
}`
  const patched = patchDeepseekStream(source)
  assert.equal(patchDeepseekStream(patched), patched)
  const api = runInNewContext(`${patched}; ({delta,closeBlock})`, { LlmError: Error })
  const block = { kind: 'tool-call', callId: 'call-original' }
  for (const id of ['', undefined, null]) api.delta(block, { id })
  assert.equal(api.closeBlock(block).callId, 'call-original')
  assert.throws(() => api.closeBlock({ kind: 'tool-call' }), /without a call id/)
  assert.equal(api.closeBlock({ kind: 'text' }).kind, 'text')
  assert.throws(() => patchDeepseekStream('unknown bundle'), /Unrecognized/)
})

function legacyEvents() {
  const block = { type: 'tool-call', id: '', name: 'inspect', arguments: '{}' }
  return [
    { type: 'assistant/chunk', seq: 0, data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'original-a', name: 'inspect', argumentsDelta: '{}' } } },
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block } } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { content: [block] } } },
    { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: '', name: 'inspect', arguments: '{}' } },
    { type: 'tool/result', seq: 4, sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: '' }, content: [{ type: 'tool-result', toolCallId: '', content: [{ type: 'text', text: 'actual receipt' }] }] } } },
  ]
}

test('cold history restores original streamed IDs without changing stored events or result content', () => {
  const events = legacyEvents()
  const original = JSON.stringify(events)
  const repaired = restoreHistoryToolIds(events)
  assert.equal(repaired[3].data.callId, 'original-a')
  assert.equal(repaired[4].data.message.source.callId, 'original-a')
  assert.equal(repaired[2].data.message.content[0].id, 'original-a')
  assert.equal(repaired[4].data.message.content[0].content[0].text, 'actual receipt')
  assert.equal(JSON.stringify(events), original)
  assert.deepEqual(restoreHistoryToolIds(repaired), repaired)
})

test('cold history refuses to invent an identity or associate a result without exact evidence', () => {
  const noStream = legacyEvents().slice(1)
  assert.throws(() => restoreHistoryToolIds(noStream), /missing or ambiguous/)
  const wrongResult = legacyEvents()
  wrongResult[4].sourceEventSeqs = [2]
  assert.throws(() => restoreHistoryToolIds(wrongResult), /missing or ambiguous/)
})

test('cold history separates identical parallel calls and reversed results by protocol order and exact links', () => {
  const events = legacyEvents()
  const firstDelta = events[0]
  const firstEnd = events[1]
  const message = events[2]
  const call = events[3]
  const result = events[4]
  const parallel = [
    firstDelta,
    firstEnd,
    { ...firstDelta, seq: 2, data: { ...firstDelta.data, chunk: { ...firstDelta.data.chunk, index: 1, id: 'original-b' } } },
    { ...firstEnd, seq: 3, data: { ...firstEnd.data, chunk: { ...firstEnd.data.chunk, index: 1 } } },
    { ...message, seq: 4, data: { ...message.data, message: { content: [message.data.message.content[0], message.data.message.content[0]] } } },
    { ...call, seq: 5 },
    { ...call, seq: 6 },
    { ...result, seq: 7, sourceEventSeqs: [6] },
    { ...result, seq: 8, sourceEventSeqs: [5] },
  ]
  const original = JSON.stringify(parallel)
  const repaired = restoreHistoryToolIds(parallel)
  assert.deepEqual(repaired.slice(5,7).map(event => event.data.callId), ['original-a', 'original-b'])
  assert.deepEqual(repaired.slice(7).map(event => event.data.message.source.callId), ['original-b', 'original-a'])
  assert.equal(JSON.stringify(parallel), original)
})

test('persistence patch restores both cold readers, requests a prefix and is idempotent', () => {
  const source = `function needsLegacyPrefix(event) { return false; }
function snapshotStoredEvents(events, id) { return events; }
function adoptStoredEvents(events, id) { return events; }`
  const patched = patchHistoryPersistence(source)
  assert.equal(patchHistoryPersistence(patched), patched)
  const api = runInNewContext(`${patched}; ({needsLegacyPrefix,snapshotStoredEvents,adoptStoredEvents})`)
  assert.equal(api.needsLegacyPrefix(legacyEvents()[4]), true)
  assert.equal(api.needsLegacyPrefix({ type: 'tool/call', data: { callId: 'valid' } }), false)
  for (const name of ['snapshotStoredEvents','adoptStoredEvents']) {
    assert.equal(api[name](legacyEvents(), 'session')[4].data.message.source.callId, 'original-a')
  }
  assert.throws(() => patchHistoryPersistence('unknown bundle'), /Unrecognized/)
})
