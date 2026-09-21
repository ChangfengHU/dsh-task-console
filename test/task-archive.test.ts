import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { TaskConsoleService } from '../src/service.ts'
import { ScheduleLedger } from '../src/scheduler.ts'

test('archive persists, excludes board listing, and preserves definitions, graph, receipts and histories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-archive-'))
  const store = new EventStore(root)
  try {
    await store.load()
    const task: TaskSpec = { id: 'old', title: 'fixture', brief: 'fixture history', trigger: { kind: 'once' }, participants: [{ agentId: 'a' }], cwd: root, timeoutSec: 60, onFail: 'stop', maxTries: 1, enabled: true, createdAt: '2026-09-10T00:00:00Z' }
    for (const id of ['old', 'installer', 'patrol']) await store.append({ t: 'task/created', at: task.createdAt, taskId: id, task: { ...task, id, enabled: id !== 'patrol' } })
    await store.createBatch(task, { t: 'batch/fired', at: task.createdAt, taskId: 'old', batch: { id: 'old-batch', by: 'manual', cards: [{ id: 'old-card', agentId: 'a', deps: [] }] } })
    const graph = store.graphSnapshot('old', 'old-batch')
    const service = Object.create(TaskConsoleService.prototype)
    service.ready = Promise.resolve()
    service.runner = { store, schedule: new ScheduleLedger(store) }
    const input = JSON.stringify({ ids: ['old', 'old'], archived: true })
    assert.equal(JSON.parse(await service.setTasksArchived(input)).changed, 1)
    assert.equal(JSON.parse(await service.setTasksArchived(input)).changed, 0)
    assert.deepEqual(JSON.parse(await service.tasks()).tasks.map((t: TaskSpec) => t.id), ['installer', 'patrol'])
    assert.equal(JSON.parse(await service.tasks()).runs.length, 0)
    const board = JSON.parse(await service.board())
    assert.equal(board.tasks.length, 3); assert.equal(board.batches.length, 1)
    assert.deepEqual(store.graphSnapshot('old', 'old-batch'), graph)
    assert.equal(store.tasks.get('installer')?.enabled, true)
    assert.equal(store.tasks.get('patrol')?.enabled, false)
    assert.equal(store.tasks.get('patrol')?.archivedAt, undefined)
    assert.equal(store.all().filter(e => e.t === 'task/archived').length, 1)
    await assert.rejects(store.append({ t: 'task/enabled', taskId: 'old', at: task.createdAt, enabled: true }), /归档/)
    const persisted = JSON.parse((store.kernel.db.prepare('SELECT spec_json FROM dsh_task_specs WHERE id=?').get('old') as any).spec_json)
    assert.ok(persisted.archivedAt); assert.equal(persisted.enabled, false)
    store.kernel.db.close()
    await store.load()
    assert.ok(store.tasks.get('old')?.archivedAt)
    assert.deepEqual(store.graphSnapshot('old', 'old-batch'), graph)
    await service.setTasksArchived(JSON.stringify({ ids: ['old'], archived: false }))
    assert.equal(JSON.parse(await service.tasks()).tasks.length, 3)
    assert.equal(store.tasks.get('old')?.enabled, false)
  } finally {
    if (store.kernel.db.open) store.kernel.db.close()
    await rm(root, { recursive: true, force: true })
  }
})
