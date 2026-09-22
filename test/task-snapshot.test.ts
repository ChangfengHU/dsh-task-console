import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskConsoleService } from '../src/service.ts'

test('modern detail reads a bounded summary without visiting historical events', async () => {
  const service: any = Object.create(TaskConsoleService.prototype)
  const task = { id: 'task', graphMode: 'dynamic-rounds' }
  const batches = Array.from({ length: 30 }, (_, i) => ({ id: `batch-${i}`, taskId: 'task', firedAt: new Date(i * 1000).toISOString(), cardIds: ['card'], turn: { text: `request-${i}` }, archivedAt: i < 15 ? 'archived' : undefined }))
  service.runner = { store: { s: { tasks: new Map([['task', task]]), batches: new Map(batches.map(b => [b.id, b])) }, all() { throw Error('must not scan event history') } } }
  const read = async (batchId?: string) => JSON.parse(await service.taskSnapshot(JSON.stringify({ id: 'task', batchId, summary: true })))
  const latest = await read()
  assert.equal(latest.batchId, 'batch-29')
  assert.equal(latest.detail.total, 30)
  assert.equal(latest.detail.archived, 15)
  assert.equal(latest.detail.batches.length, 10)
  assert.deepEqual(latest.events, [])
  assert.equal(latest.detail.batches.filter((b: any) => b.turn).length, 1)
  const old = await read('batch-0')
  assert.equal(old.detail.batches.length, 10)
  assert.equal(old.detail.batches.find((b: any) => b.id === 'batch-0').turn.text, 'request-0')
  await assert.rejects(read('another-task-batch'), /不属于/)
})
