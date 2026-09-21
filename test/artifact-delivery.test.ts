import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalArtifact, groupArtifacts, withFinalArtifact } from '../src/artifact-delivery.ts'
import type { Artifact, Batch, Card } from '../src/fold.ts'

const card = (id: string, role: Card['role'], round: number): Card => ({ id, batchId: 'b', taskId: 'T', index: round, agentId: role ?? 'agent', deps: [], status: 'done', runIds: [], consecutiveFailures: 0, blockRecurrences: 0, role, round })
const artifact = (id: string, cardId: string, sha256: string, createdAt: string): Artifact => ({ id, taskId: 'T', batchId: 'b', cardId, runId: `${cardId}#1`, sessionId: `s-${id}`, name: 'index.html', mime: 'text/html', size: 10, sha256, createdAt, originalPath: '/work/index.html', storagePath: `/store/${id}` })

test('artifact delivery compatibility picks the latest executor and groups reviewer snapshots by SHA', () => {
  const cards = [card('e1', 'executor', 1), card('r1', 'reviewer', 1), card('e2', 'executor', 2), card('r2', 'reviewer', 2)]
  const batch: Batch = { id: 'b', taskId: 'T', firedAt: '2026-09-01T00:00:00Z', by: 'manual', cardIds: cards.map(row => row.id), settled: { at: '2026-09-01T00:05:00Z', outcome: 'done' } }
  const rows = withFinalArtifact([
    artifact('a1', 'e1', 'sha-v1', '2026-09-01T00:01:00Z'), artifact('a2', 'r1', 'sha-v1', '2026-09-01T00:02:00Z'),
    artifact('a3', 'e2', 'sha-v2', '2026-09-01T00:03:00Z'), artifact('a4', 'r2', 'sha-v2', '2026-09-01T00:04:00Z'),
  ], cards, batch)
  assert.equal(rows.find(row => row.final)?.id, 'a3')
  assert.equal(rows.find(row => row.final)?.finalSource, 'compatibility')
  const groups = groupArtifacts(rows, cards.map(row => ({ cardId: row.id, role: row.role, round: row.round, name: row.agentId })))
  assert.equal(groups.length, 2)
  assert.equal(finalArtifact(groups)?.entries.length, 2)
})
