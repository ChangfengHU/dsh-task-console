import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { ScheduleLedger } from '../src/scheduler.ts'
import { cronMatches, nextFire, parseCron } from '../src/cron.ts'

const at = (s: string) => Date.parse(`2026-09-09T${s}:00Z`)
const spec: TaskSpec = { id: 'scheduled-test', title: 'Test only', brief: 'Read fixture only', trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' }, participants: [{ agentId: 'a' }], cwd: '/tmp', timeoutSec: 60, onFail: 'stop', maxTries: 1, enabled: true, createdAt: new Date(at('08:01')).toISOString() }
async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'tc-schedule-'))
  const store = new EventStore(root); await store.load()
  const ledger = new ScheduleLedger(store)
  t.after(async () => { store.kernel.db.close(); await rm(root, { recursive: true, force: true }) })
  await store.append({ t: 'task/created', taskId: spec.id, task: spec, at: spec.createdAt })
  return { store, ledger, root }
}

test('cron respects named timezones and advances by UTC minutes across DST', () => {
  const c = parseCron('0 16 * * *')!
  assert.equal(cronMatches(c, new Date(at('08:00')), 'Asia/Shanghai'), true)
  assert.equal(cronMatches(c, new Date(at('08:00')), 'UTC'), false)
  assert.equal(nextFire(parseCron('30 1 * * *')!, new Date('2026-11-01T05:31:00Z'), 'America/New_York')?.toISOString(), '2026-11-01T06:30:00.000Z')
})

test('schedule persists unique claims, coalesces downtime and atomically joins Batch creation', async t => {
  const { store, ledger } = await setup(t)
  ledger.sync(spec, at('08:01'))
  assert.equal(ledger.claim(spec, at('08:59')), undefined)
  const claim = ledger.claim(spec, at('11:15'))!
  assert.ok(claim)
  const second = new ScheduleLedger(store)
  assert.equal(second.claim(spec, at('11:15')), undefined)
  assert.equal((ledger.view(spec.id).rows[0] as any).coalesced_from, at('09:00'))
  await store.createBatch(spec, { t: 'batch/fired', taskId: spec.id, at: new Date(at('11:15')).toISOString(), batch: { id: claim.batchId, by: 'cron', cards: [{ id: `${claim.batchId}#0`, agentId: 'a', deps: [] }] } }, claim)
  assert.equal((ledger.view(spec.id).rows[0] as any).status, 'dispatched')
  second.failed(claim, at('11:16'), 'failure after dispatch must not repeat business work')
  assert.equal((ledger.view(spec.id).rows[0] as any).status, 'dispatched')
  assert.equal(second.claim(spec, at('12:00')), undefined)
  assert.equal((ledger.view(spec.id).rows[0] as any).status, 'skipped')
  assert.equal(store.s.batches.size, 1)
  await assert.rejects(store.createBatch(spec, { t: 'batch/fired', taskId: spec.id, at: new Date(at('12:01')).toISOString(), batch: { id: 'manual-overlap', by: 'manual', cards: [] } }), /上一轮/)
})

test('lost dispatch leases recover with the same Batch id; old claim cannot commit', async t => {
  const { store, ledger } = await setup(t)
  ledger.sync(spec, at('08:01'))
  const first = ledger.claim(spec, at('09:00'))!
  const restarted = new ScheduleLedger(store), second = restarted.claim(spec, at('09:03'))!
  assert.equal(first.batchId, second.batchId); assert.notEqual(first.token, second.token)
  const event = { t: 'batch/fired' as const, taskId: spec.id, at: new Date(at('09:03')).toISOString(), batch: { id: first.batchId, by: 'cron' as const, cards: [] } }
  await assert.rejects(store.createBatch(spec, event, first), /租约已失效/)
  assert.equal(store.s.batches.size, 0)
  await store.createBatch(spec, event, second)
  assert.equal(store.s.batches.size, 1)
})

test('pause invalidates pending claims; resume starts fresh and history is paginated', async t => {
  const { store, ledger } = await setup(t)
  ledger.sync(spec, at('08:01'))
  const first = ledger.claim(spec, at('09:00'))!
  ledger.sync({ ...spec, enabled: false }, at('09:01'))
  await assert.rejects(store.createBatch(spec, { t: 'batch/fired', taskId: spec.id, at: spec.createdAt, batch: { id: first.batchId, by: 'cron', cards: [] } }, first), /租约/)
  ledger.sync(spec, at('12:30'))
  assert.equal(ledger.claim(spec, at('12:31')), undefined)
  assert.equal((ledger.view(spec.id).state as any).next_at, at('13:00'))
  for (let i = 0; i < 13; i++) {
    const now = at('13:00') + i * 3600_000, claim = ledger.claim(spec, now)!
    store.kernel.db.prepare("UPDATE dsh_schedule_fires SET status='failed' WHERE id=?").run(claim.id)
  }
  assert.equal(ledger.view(spec.id).total, 14)
  assert.equal(ledger.view(spec.id, 2).rows.length, 4)
})
