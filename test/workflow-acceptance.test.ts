import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { validateWorkflowCompletion } from '../src/workflow-acceptance.ts'

function fixture() {
  const now = 2_000_000, sessionId = 'task-example-current-3', requestId = 'accept-current', ip = '192.0.2.10'
  const id = createHash('sha256').update(JSON.stringify([sessionId, requestId])).digest('hex').slice(0, 32)
  const rows = [1, 2].map(instance => ({ instance, fingerprint: '1234abcd', firstCheckedAt: new Date(now - 1_200_000).toISOString(), checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 180_000).toISOString(), observedMs: 1_200_000, samples: 21 }))
  const job: any = { id, action: 'login-acceptance', phase: 'complete', args: { ip, platform: 'gemini', instances: [1, 2], sessionId, requestId }, result: { stable: true, criterion: 'gemini-background-stability-v1', probeVersion: 2, requiredMs: 1_200_000, startedAt: rows[0].firstCheckedAt, completedAt: rows[0].checkedAt, instances: rows } }
  const fleet: any = { nodes: [{ id: 'host-192-0-2-10', browsers: rows.map(r => ({ browserNo: r.instance, identities: { gemini: 'in' }, accounts: { gemini: { fingerprint: r.fingerprint, source: 'gemini-account-control' } }, loginVerification: { probeVersion: 2, status: 'verified', checkedAt: r.checkedAt, expiresAt: r.expiresAt } })) }] }
  const input: any = { task: { workflowRecipe: { id: 'fleet-base-v2', login: 'provision-gemini' } }, batch: { firedAt: new Date(now - 1_300_000).toISOString(), turn: { targets: [{ kind: 'fleet-node', id: ip }] } }, profileId: 'browser-manager', sessionId, metadata: { browserAcceptanceOperationId: id } }
  const deps = { now: () => now, receipt: async () => job, fleet: async () => fleet }
  return { job, fleet, input, deps }
}
test('managed workflow accepts actual same-session stability and current Fleet readback', async () => {
  const f = fixture(); await validateWorkflowCompletion(f.input, f.deps)
})
test('a summary or model-authored stable flag cannot replace a host receipt', async () => {
  const f = fixture(); f.input.metadata = { stable: true, loginVerified: true }
  await assert.rejects(validateWorkflowCompletion(f.input, f.deps), /缺少/)
})
test('wrong session/target, one browser, incomplete window and stale receipts are rejected', async () => {
  for (const change of [
    (f: any) => { f.job.args.sessionId = 'task-other' },
    (f: any) => { f.job.args.ip = '192.0.2.20' },
    (f: any) => { f.job.phase = 'blocked' },
    (f: any) => { f.job.args.instances = [1] },
    (f: any) => { f.job.result.requiredMs = 60_000 },
    (f: any) => { f.job.result.startedAt = 'invalid' },
    (f: any) => { f.job.result.instances[1].samples = 1 },
    (f: any) => { f.job.result.instances[1].expiresAt = new Date(0).toISOString() },
  ]) { const f = fixture(); change(f); await assert.rejects(validateWorkflowCompletion(f.input, f.deps), /验收未通过/) }
})
test('current Fleet disagreement blocks completion even after a stable historical receipt', async () => {
  const f = fixture(); f.fleet.nodes[0].browsers[1].identities.gemini = 'out'
  await assert.rejects(validateWorkflowCompletion(f.input, f.deps), /Fleet 当前/)
})
test('legacy, preserve and non-browser roles do not inherit Gemini business logic', async () => {
  for (const change of [
    (f: any) => { f.input.task.workflowRecipe.id = 'fleet-base-v1' },
    (f: any) => { f.input.task.workflowRecipe.login = 'preserve' },
    (f: any) => { f.input.profileId = 'fleet-installer' },
  ]) { const f = fixture(); change(f); f.deps.receipt = async () => { throw Error('must not read') }; await validateWorkflowCompletion(f.input, f.deps) }
})
