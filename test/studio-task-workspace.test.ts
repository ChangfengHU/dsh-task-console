import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { TaskConsoleService, METHODS } from '../lib/index.js'


function serviceFixture(t: any) {
  const cwdPromise = mkdtemp(join(tmpdir(), 'studio-workspace-'))
  const receipt = { stage: 'visual', round: 1, batchId: 'batch-1', cardId: 'batch-1#s1-visual', sessionId: 'session-visual', summary: '人物动作图已登记，视觉质量尚未批准。', qualityApproved: false, manifest: { path: 'stages/r1/visual/manifest.json', sha256: '1'.repeat(64) }, outputs: [{ path: 'stages/r1/visual/pose.png', sha256: '', bytes: 5, media: { kind: 'image', width: 2, height: 2 } }] }
  const stageRows = [{ kind: 'stage:1:visual', payload: '' }]
  const db = { prepare(sql: string) { return { get: (...args: any[]) => sql.includes('sqlite_master') ? { yes: 1 } : sql.includes('kind=?') ? (args.at(-1) === 'stage:1:visual' ? { payload: JSON.stringify(receipt) } : undefined) : undefined, all: () => stageRows } } }
  const stageCard = { id: 'batch-1#s1-visual', role: 'studio-stage', round: 1, title: '视觉素材', status: 'done', deps: [], runIds: ['run-1'], error: undefined }
  const run = { id: 'run-1', status: 'completed', sessionId: 'session-visual', startedAt: '2026-09-28T12:00:00Z', endedAt: '2026-09-28T12:01:00Z', terminalBlock: false, summary: '交接完成' }
  const batch = { id: 'batch-1', taskId: 'task-1', firedAt: '2026-09-28T12:00:00Z', cardIds: [stageCard.id], settled: null }
  const task = { id: 'task-1', title: '样例短片', cwd: '', design: { evidenceContract: 'studio-video-v1', studioStages: [{ id: 'storyboard', agentId: 'editor' }, { id: 'visual', agentId: 'artist' }, { id: 'sound', agentId: 'audio' }] } }
  const store: any = { s: { tasks: new Map([[task.id, task]]), batches: new Map([[batch.id, batch]]), cards: new Map([[stageCard.id, stageCard]]), runs: new Map([[run.id, run]]) }, kernel: { db } }
  const instance: any = Object.create(TaskConsoleService.prototype); instance.runner = { store }
  t.after(async () => rm(await cwdPromise, { recursive: true, force: true }))
  return { instance, cwdPromise, receipt, stageRows }
}

test('stage workspace lists only task-scoped receipts and run state, with quality status kept false', async t => {
  assert.ok(METHODS.some(([name]) => name === 'studioTaskWorkspace'))
  assert.ok(METHODS.some(([name]) => name === 'studioStageArtifactContent'))
  const f = serviceFixture(t), receipt = f.receipt
  f.stageRows[0].payload = JSON.stringify(receipt)
  const result = JSON.parse(await f.instance.studioTaskWorkspace(JSON.stringify({ taskId: 'task-1', batchId: 'batch-1' })))
  assert.deepEqual(result.stages.map((s: any) => s.id), ['storyboard', 'visual', 'sound'])
  assert.equal(result.receipts.length, 1)
  assert.equal(result.receipts[0].outputs[0].path, 'stages/r1/visual/pose.png')
  assert.equal(result.receipts[0].qualityApproved, false)
  assert.equal(result.cards[0].runs[0].sessionId, 'session-visual')
  await assert.rejects(() => f.instance.studioTaskWorkspace(JSON.stringify({ taskId: 'task-1', batchId: 'other' })), /没有这个任务执行记录/)
})

test('stage preview requires receipt path and exact current SHA and enforces the browser-size limit', async t => {
  const f = serviceFixture(t), cwd = await f.cwdPromise
  await mkdir(join(cwd, 'stages/r1/visual'), { recursive: true })
  const bytes = Buffer.from('image')
  await writeFile(join(cwd, 'stages/r1/visual/pose.png'), bytes)
  const sha = createHash('sha256').update(bytes).digest('hex')
  f.receipt.outputs[0].sha256 = sha
  f.receipt.outputs[0].bytes = bytes.length
  f.stageRows[0].payload = JSON.stringify(f.receipt)
  f.instance.runner.store.s.tasks.get('task-1').cwd = cwd
  const args = { taskId: 'task-1', batchId: 'batch-1', stage: 'visual', round: 1, path: 'stages/r1/visual/pose.png', sha256: sha }
  const result = JSON.parse(await f.instance.studioStageArtifactContent(JSON.stringify(args)))
  assert.equal(Buffer.from(result.base64, 'base64').toString(), 'image')
  assert.equal(result.file.sha256, sha)
  await assert.rejects(() => f.instance.studioStageArtifactContent(JSON.stringify({ ...args, path: 'stages/r1/visual/other.png' })), /不在已登记/)
  await assert.rejects(() => f.instance.studioStageArtifactContent(JSON.stringify({ ...args, sha256: 'f'.repeat(64) })), /不在已登记/)
  f.receipt.outputs[0].bytes = 8 * 1024 * 1024 + 1
  f.stageRows[0].payload = JSON.stringify(f.receipt)
  await assert.rejects(() => f.instance.studioStageArtifactContent(JSON.stringify(args)), /超过 8 MiB/)
})
