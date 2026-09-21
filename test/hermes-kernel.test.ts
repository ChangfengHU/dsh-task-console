import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { HERMES_COMPAT_VERSION, HermesKernel } from '../src/hermes-kernel.ts'

const tempDb = async () => join(await mkdtemp(join(tmpdir(), 'dsh-hermes-kernel-')), 'kanban.db')

test('kernel initializes the Hermes core tables in WAL mode and preserves the old event log', async () => {
  const path = await tempDb()
  const old = new Database(path)
  old.exec(`CREATE TABLE task_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    task_id TEXT,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`)
  old.prepare(`INSERT INTO task_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)`).run('task/created', 'T-old', '2026-09-01T00:00:00Z', '{}')
  old.close()

  const kernel = new HermesKernel(path)
  const tables = (kernel.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(row => row.name)
  for (const name of ['tasks', 'task_links', 'task_comments', 'task_events', 'task_runs', 'task_attachments', 'kanban_notify_subs', 'dsh_events']) assert.ok(tables.includes(name), name)
  assert.equal(kernel.db.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(kernel.db.pragma('foreign_keys', { simple: true }), 1)
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS n FROM dsh_events').get().n, 1)
  assert.equal(kernel.db.prepare(`SELECT value FROM dsh_meta WHERE key = 'hermes_compat_version'`).get().value, HERMES_COMPAT_VERSION)
  kernel.close()
})

test('kernel enforces dependencies and a CAS claim has one winner across connections', async () => {
  const path = await tempDb(); let now = 100
  const a = new HermesKernel(path, { now: () => now, claimer: () => 'a' })
  const b = new HermesKernel(path, { now: () => now, claimer: () => 'b' })
  a.createTask({ id: 'parent', title: 'plan', assignee: 'planner' })
  a.createTask({ id: 'child', title: 'implement', assignee: 'implementer', parents: ['parent'] })
  assert.equal(a.getTask('child')!.status, 'todo')
  assert.equal(a.claimTask('child'), undefined)

  const first = a.claimTask('parent')
  assert.ok(first)
  assert.equal(b.claimTask('parent'), undefined)
  assert.equal(a.completeTask('parent', { expectedRunId: first!.run.id, summary: 'spec ready', metadata: { acceptance: 10 } }), true)
  assert.equal(b.getTask('child')!.status, 'ready')
  assert.ok(a.listEvents('parent').some(event => event.kind === 'claimed'))
  assert.ok(a.listEvents('child').some(event => event.kind === 'promoted'))
  a.close(); b.close()
})

test('kernel CAS admits exactly one winner across ten independent claimers', async () => {
  const path = await tempDb()
  const owner = new HermesKernel(path)
  owner.createTask({ id: 'race', title: 'race', assignee: 'worker' })
  const contenders = Array.from({ length: 10 }, (_, index) => new HermesKernel(path, { claimer: () => `worker-${index}` }))
  const claims = await Promise.all(contenders.map(async kernel => kernel.claimTask('race')))
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(owner.listRuns('race').length, 1)
  assert.equal(owner.listEvents('race').filter(event => event.kind === 'claimed').length, 1)
  contenders.forEach(kernel => kernel.close()); owner.close()
})

test('kernel heartbeat renews a finite lease and later permits stale reclaim', async () => {
  const path = await tempDb(); let now = 100
  const kernel = new HermesKernel(path, { now: () => now, isPidAlive: () => false })
  kernel.createTask({ id: 'lease', title: 'lease', assignee: 'worker' })
  const claim = kernel.claimTask('lease', { ttlSeconds: 10 })!
  now = 109
  assert.equal(kernel.heartbeat('lease', claim.run.id, claim.lock, 10), true)
  assert.deepEqual(JSON.parse(kernel.listEvents('lease').at(-1)?.payload ?? '{}'), { last_heartbeat_at: 109, claim_expires: 119 })
  now = 111
  assert.equal(kernel.releaseStaleClaims(), 0)
  now = 120
  assert.equal(kernel.releaseStaleClaims(), 1)
  assert.equal(kernel.getTask('lease')!.status, 'ready')
  kernel.close()
})

test('kernel runs the Hermes same-card implementer-reviewer rework loop with four durable runs', async () => {
  const path = await tempDb(); let now = 1_000
  const kernel = new HermesKernel(path, { now: () => now++, claimer: () => `worker-${now}` })
  kernel.createTask({ id: 'work', title: 'implement', body: 'Meet AC1-AC10', assignee: 'implementer', workspacePath: '/tmp/work' })

  const implement1 = kernel.claimTask('work')!
  assert.equal(kernel.requestReview('work', { expectedRunId: implement1.run.id, reviewer: 'reviewer', summary: '9 passed', metadata: { tests: 9 } }), true)
  assert.equal(kernel.getTask('work')!.status, 'review')
  assert.equal(kernel.getTask('work')!.assignee, 'reviewer')

  const review1 = kernel.claimTask('work', { fromReview: true })!
  const returned = kernel.requestChanges('work', { expectedRunId: review1.run.id, reason: 'AC1 empty-list test is missing' })
  assert.deepEqual(returned, { ok: true, implementer: 'implementer' })
  assert.equal(kernel.getTask('work')!.status, 'ready')
  assert.equal(kernel.getTask('work')!.assignee, 'implementer')

  const implement2 = kernel.claimTask('work')!
  assert.equal(kernel.buildWorkerContext('work').includes('AC1 empty-list test is missing'), true)
  assert.equal(kernel.requestReview('work', { expectedRunId: implement2.run.id, reviewer: 'reviewer', summary: '10 passed', metadata: { tests: 10 } }), true)
  const review2 = kernel.claimTask('work', { fromReview: true })!
  assert.equal(kernel.completeTask('work', { expectedRunId: review2.run.id, summary: 'approved', metadata: { tests: 10, rework_verified: true } }), true)

  const runs = kernel.listRuns('work')
  assert.deepEqual(runs.map(run => [run.profile, run.outcome]), [
    ['implementer', 'review_requested'],
    ['reviewer', 'changes_requested'],
    ['implementer', 'review_requested'],
    ['reviewer', 'completed'],
  ])
  assert.equal(kernel.getTask('work')!.status, 'done')
  assert.equal(kernel.listEvents('work').filter(event => ['review_requested', 'changes_requested', 'completed'].includes(event.kind)).length, 4)
  kernel.close()
})

test('kernel preserves review source when reclaiming an expired reviewer and builds parent handoff context', async () => {
  const path = await tempDb(); let now = 10_000
  const kernel = new HermesKernel(path, { now: () => now, claimer: () => 'host:1:x', isPidAlive: () => false })
  kernel.createTask({ id: 'parent', title: 'parent', assignee: 'planner' })
  let run = kernel.claimTask('parent')!
  kernel.completeTask('parent', { expectedRunId: run.run.id, summary: 'SPEC.md with ten criteria', metadata: { artifact: 'SPEC.md' } })
  kernel.createTask({ id: 'child', title: 'child', assignee: 'implementer', parents: ['parent'] })
  run = kernel.claimTask('child', { ttlSeconds: 10 })!
  kernel.requestReview('child', { expectedRunId: run.run.id, reviewer: 'reviewer', summary: 'ready for review' })
  const reviewer = kernel.claimTask('child', { fromReview: true, ttlSeconds: 10 })!
  now += 11
  assert.equal(kernel.releaseStaleClaims(), 1)
  assert.equal(kernel.getTask('child')!.status, 'review')
  assert.equal(kernel.listRuns('child').at(-1)!.outcome, 'reclaimed')
  const context = kernel.buildWorkerContext('child')
  assert.match(context, /Parent task results/)
  assert.match(context, /SPEC\.md with ten criteria/)
  assert.match(context, /"artifact":"SPEC\.md"/)
  assert.ok(kernel.listEvents('child').some(event => event.kind === 'reclaimed'))
  assert.ok(kernel.claimTask('child', { fromReview: true }))
  kernel.close()
})
