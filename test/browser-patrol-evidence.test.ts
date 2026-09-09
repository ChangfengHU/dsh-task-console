import test from 'node:test'
import assert from 'node:assert/strict'
import { browserPatrolEvidence } from '../src/browser-patrol-evidence.ts'
const input = { profileId: 'browser-manager', task: { design: { evidenceContract: 'browser-patrol-v1' } }, metadata: { verified: 999 } } as any
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
test('the explicit business contract never affects legacy, list-only or other roles', () => {
  assert.equal(browserPatrolEvidence({ ...input, task: {} }, fixture()), undefined)
  assert.equal(browserPatrolEvidence({ ...input, profileId: 'other' }, fixture()), undefined)
})
