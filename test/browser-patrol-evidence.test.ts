import test from 'node:test'
import assert from 'node:assert/strict'
import { browserPatrolEvidence } from '../src/browser-patrol-evidence.ts'
const input = { sessionId: 'task-browser-test', profileId: 'browser-manager', task: { design: { evidenceContract: 'browser-patrol-v1' } }, metadata: { verified: 999 } } as any
const at = '2026-09-09T06:00:00.000Z'
const b = { instance: 1, gemini: 'verified', account: { fingerprint: '01234567' }, checkedAt: at, expiresAt: '2026-09-09T06:03:00.000Z', loginAuthorized: true }
function fixture(assessment: any = b) {
  const pair = (seq: number, name: string, args: any, value: any) => [
    { type: 'tool/call', seq, data: { callId: `c${seq}`, name: `mcp__fleet-browser-browser-manager__${name}`, arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: seq + 1, data: { message: { content: [{ type: 'tool-result', toolCallId: `c${seq}`, content: [{ type: 'text', text: JSON.stringify(value) }] }] } } },
  ]
  return [...pair(1, 'browser_fleet_inventory', {}, { ok: true, nodes: [{ ip: '192.0.2.10', reachable: true, readAuthorized: true, browsers: [b] }] }),
    ...pair(3, 'browser_inspect', { ip: '192.0.2.10' }, { ip: '192.0.2.10', loginAssessment: { observedAt: at, browsers: [assessment] } })]
}
test('patrol gate trusts paired native results, not model-authored counts', () => {
  const r = browserPatrolEvidence(input, fixture())!
  assert.equal(r.counts?.verified, 1); assert.equal(r.failure, undefined)
  assert.equal(r.metadata?.browserPatrol.items[0].evidenceSeq, 4)
  const unpaired = fixture(); unpaired[3].data.message.content[0].toolCallId = 'invented'
  assert.match(browserPatrolEvidence(input, unpaired)!.failure!, /无法确认/)
  const shadow = fixture(); shadow[0].data.name = 'mcp__untrusted__browser_fleet_inventory'
  assert.match(browserPatrolEvidence(input, shadow)!.failure!, /缺少/)
})
test('unknown, old cookies and stale verifier cannot pass the completion gate', () => {
  for (const row of [{ ...b, gemini: 'unknown' }, { ...b, checkedAt: null }, { ...b, expiresAt: at }, { ...b, account: null }]) {
    const r = browserPatrolEvidence(input, fixture(row))!
    assert.equal(r.counts?.verified, 0); assert.equal(r.counts?.unknown, 1); assert.match(r.failure!, /不能绿色交卷/)
  }
})
test('missing or failed inventory cannot become an empty successful patrol', () => {
  assert.match(browserPatrolEvidence(input, [])!.failure!, /缺少/)
  const e = fixture(); e[1].data.message.content[0].isError = true
  assert.match(browserPatrolEvidence(input, e)!.failure!, /缺少/)
})
test('skipped authorization or an empty browser inventory cannot satisfy all-login acceptance', () => {
  const events = fixture()
  const part = events[1].data.message.content[0].content[0]
  const value = JSON.parse(part.text); value.nodes[0].readAuthorized = false; part.text = JSON.stringify(value)
  assert.equal(browserPatrolEvidence(input, events)!.counts?.skipped, 1)
  assert.match(browserPatrolEvidence(input, events)!.failure!, /不能绿色交卷/)
  value.nodes[0].browsers = []; part.text = JSON.stringify(value)
  assert.match(browserPatrolEvidence(input, events)!.failure!, /不能绿色交卷/)
})
test('the explicit business contract never affects legacy, list-only or other roles', () => {
  assert.equal(browserPatrolEvidence({ ...input, task: {} }, fixture()), undefined)
  assert.equal(browserPatrolEvidence({ ...input, profileId: 'other' }, fixture()), undefined)
})
test('own completed live verification receipt supplies missing legacy evidence, not polling timestamps or another session', () => {
  const e = fixture({ ...b, gemini: 'unknown', checkedAt: null })
  const id = 'a'.repeat(32)
  const receipt = { id, phase: 'complete', action: 'login-verify', updatedAt: at,
    args: { ip: '192.0.2.10', instance: 1, sessionId: input.sessionId }, result: { verification: {
      instance: 1, loginVerified: true, identity: { gemini: 'in', account: { source: 'gemini-account-control', fingerprint: '01234567' } },
      loginVerification: { status: 'verified', checkedAt: at, expiresAt: b.expiresAt },
    } } }
  const events = () => [...e,
    { type: 'tool/call', seq: 5, data: { callId: 'c5', name: 'mcp__fleet-browser-browser-manager__browser_status', arguments: JSON.stringify({ ip: receipt.args.ip, operationId: id }) } },
    { type: 'tool/result', seq: 6, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c5', content: [{ type: 'text', text: JSON.stringify(receipt) }] }] } } },
  ]
  assert.equal(browserPatrolEvidence(input, events())!.counts?.verified, 1)
  receipt.args.sessionId = 'other-session'
  assert.equal(browserPatrolEvidence(input, events())!.counts?.verified, 0)
  receipt.args.sessionId = input.sessionId; receipt.result.verification.loginVerification.expiresAt = at
  assert.equal(browserPatrolEvidence(input, events())!.counts?.verified, 0)
})
