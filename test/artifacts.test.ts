import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureArtifacts, discoverLegacyArtifacts, publishHtml, readArtifact } from '../src/artifacts.ts'
import { readPublishableHtml, safeUploadPart } from '../src/public-upload.ts'
import type { Run, TaskSpec } from '../src/fold.ts'

const taskAt = (cwd: string): TaskSpec => ({ id: 'T', title: 't', brief: 'make result', trigger: { kind: 'once' }, participants: [{ agentId: 'a' }], cwd, timeoutSec: 60, onFail: 'stop', maxTries: 1, enabled: true, createdAt: 'x' })
const runAt = (cwd: string): Run => ({ id: 'b#0#1', cardId: 'b#0', batchId: 'b', taskId: 'T', attempt: 1, sessionId: 's', startedAt: '1', endedAt: '2', status: 'done', outcome: 'completed', summary: `产物：\`${join(cwd, 'old.html')}\``, nudges: 0 })

test('artifacts: capture stores an immutable copy and refuses paths outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-art-'))
  const cwd = join(root, 'workspace'); const store = join(root, 'store')
  await mkdir(cwd); await writeFile(join(cwd, 'page.html'), '<h1>v1</h1>'); await writeFile(join(root, 'outside.txt'), 'no')
  const [artifact] = await captureArtifacts({ root: store, task: taskAt(cwd), batchId: 'b', cardId: 'b#0', runId: 'b#0#1', sessionId: 's', at: '2' }, ['page.html'])
  await writeFile(join(cwd, 'page.html'), '<h1>v2</h1>')
  assert.equal((await readArtifact(store, taskAt(cwd), artifact)).toString(), '<h1>v1</h1>')
  assert.equal(artifact.mime, 'text/html'); assert.equal(artifact.sha256.length, 64)
  await assert.rejects(() => captureArtifacts({ root: store, task: taskAt(cwd), batchId: 'b', cardId: 'b#0', runId: 'r2', sessionId: 's2', at: '3' }, ['../outside.txt']), /工作区内/)
})

test('artifacts: a valid path in an old handoff is projected as legacy, not copied or published', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tc-legacy-'))
  await writeFile(join(cwd, 'old.html'), '<p>old</p>')
  const rows = await discoverLegacyArtifacts(taskAt(cwd), [runAt(cwd)], new Set())
  assert.equal(rows.length, 1); assert.equal(rows[0].legacy, true); assert.equal(rows[0].publicUrl, undefined)
  assert.equal((await readArtifact(join(cwd, '.store'), taskAt(cwd), rows[0])).toString(), '<p>old</p>')
})

test('artifacts: public publishing is explicit, HTML-only, and returns the service URL', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST'); assert.match(String((init?.headers as any).Authorization), /^Bearer /)
    return new Response(JSON.stringify({ url: 'https://resource.example/result.html' }), { status: 200 })
  }) as typeof fetch
  try {
    const artifact = { id: 'a', taskId: 'T', batchId: 'b', cardId: 'c', runId: 'r', sessionId: 's', name: 'result.html', mime: 'text/html', size: 1, sha256: 'x', createdAt: '1', originalPath: '/x', storagePath: '/x' }
    const url = await publishHtml({ endpoint: 'https://upload.example', domain: 'https://resource.example', token: 'test-token' }, artifact, Buffer.from('x'))
    assert.equal(url, 'https://resource.example/result.html')
    await assert.rejects(() => publishHtml({ endpoint: 'https://upload.example', domain: 'https://resource.example', token: 'test-token' }, { ...artifact, name: 'x.txt', mime: 'text/plain' }, Buffer.from('x')), /只允许.*HTML/)
  } finally { globalThis.fetch = oldFetch }
})

test('public tool: only reads HTML below the configured workspace roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-public-'))
  const workspace = join(root, 'workspace'); await mkdir(workspace)
  const page = join(workspace, '原型 page.html'); const outside = join(root, 'outside.html')
  await writeFile(page, '<button>ok</button>'); await writeFile(outside, '<p>no</p>')
  const oldRoots = process.env.DSH_TASK_CONSOLE_PUBLISH_ROOTS
  process.env.DSH_TASK_CONSOLE_PUBLISH_ROOTS = workspace
  try {
    const file = await readPublishableHtml(page)
    assert.equal(file.data.toString(), '<button>ok</button>')
    assert.equal(safeUploadPart(file.name), '原型-page.html')
    await assert.rejects(() => readPublishableHtml(outside), /允许的工作区/)
    await assert.rejects(() => readPublishableHtml(join(workspace, 'missing.html')), /ENOENT/)
  } finally {
    if (oldRoots === undefined) delete process.env.DSH_TASK_CONSOLE_PUBLISH_ROOTS
    else process.env.DSH_TASK_CONSOLE_PUBLISH_ROOTS = oldRoots
  }
})
