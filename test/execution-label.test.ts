import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionCode, executionLabel, executionTime } from '../src/execution-label.ts'

test('execution records show fixed Beijing dates and seconds, not the host timezone', () => {
  assert.equal(executionTime('2026-09-08T02:49:38.503Z'), '2026-09-08 10:49:38')
  assert.equal(executionTime('2026-09-07T22:49:38.503-04:00'), '2026-09-08 10:49:38')
  assert.equal(executionTime('2026-12-31T16:00:00Z'), '2027-01-01 00:00:00')
  assert.equal(executionTime('2026-03-08T07:30:00Z'), '2026-03-08 15:30:00')
  assert.equal(executionTime('bad timestamp'), '时间未知')
  assert.equal(executionTime(), '时间未知')
})

test('short display codes preserve the actual batch identity', () => {
  const batch = { id: 'b-chat-af090739b8c20765c932', firedAt: '2026-09-08T02:36:05.767Z' }
  assert.equal(executionLabel(batch), '2026-09-08 10:36:05 · #AF090739')
  assert.equal(batch.id, 'b-chat-af090739b8c20765c932')
  assert.equal(executionCode('b-chat-69621b7fc21efc5fff77'), '#69621B7F')
  assert.equal(executionCode('b-mtj1xwasjuv'), '#MTJ1XWAS')
})
