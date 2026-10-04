import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchAppEpisode, readAppBinding } from '../src/app-episodes.ts'

test('App actions isolate episodes, replay success once and fail closed after unknown starts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tc-episode-'))
  const saved = process.env.DSH_HOME; process.env.DSH_HOME = home
  t.after(async () => { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved; await rm(home, { recursive: true }) })
  const preset = join(home, 'preset'), workspace = join(home, 'workspace')
  await mkdir(preset); await mkdir(workspace); await mkdir(join(home, 'apps'))
  const receipt = { displayName: 'Test', version: '1', status: 'installed', enabled: true, managedAgents: ['studio'], episodeActions: true }
  const receiptPath = join(home, 'apps/studio-app.json')
  await writeFile(receiptPath, JSON.stringify(receipt))
  await writeFile(join(preset, 'app-owner.json'), JSON.stringify({ appId: 'studio-app', workspace }))
  await writeFile(join(workspace, 'STUDIO_RUNTIME.json'), JSON.stringify({ workspaceRoot: workspace, privatePath: '/private/host-resource' }))
  const input = { presetPath: join(preset, 'agent.cordis.yml'), agentId: 'studio', requestId: 'request-00000000001', actionId: 'create', revision: 'r1', text: 'create a new episode' }
  let starts = 0
  const start = async (text: string, cwd: string, sessionId: string) => {
    starts++; assert.match(cwd, /\/episodes\/[0-9a-f]{24}$/); assert.match(text, /隔离工作目录/)
    assert.equal(JSON.parse(await readFile(join(cwd, 'STUDIO_RUNTIME.json'), 'utf8')).workspaceRoot, cwd)
    return { sessionId, model: 'fixed/model' }
  }
  const one = await launchAppEpisode(input, start), replay = await launchAppEpisode(input, start)
  assert.equal(starts, 1); assert.deepEqual(replay, one)
  assert.equal(JSON.parse(await readFile(join(one.workspace, 'DSH_SESSION.json'), 'utf8')).state, 'started')
  await assert.rejects(launchAppEpisode({ ...input, text: 'changed' }, start), /内容已改变/)
  const two = await launchAppEpisode({ ...input, requestId: 'request-00000000002' }, start)
  assert.notEqual(two.workspace, one.workspace); assert.notEqual(two.sessionId, one.sessionId)
  const unknown = { ...input, requestId: 'request-00000000003' }
  await assert.rejects(launchAppEpisode(unknown, async () => { throw Error('disconnected') }), /disconnected/)
  await assert.rejects(launchAppEpisode(unknown, start), /结果未确认/); assert.equal(starts, 2)
  await writeFile(receiptPath, JSON.stringify({ ...receipt, enabled: false }))
  assert.equal((await readAppBinding(input.presetPath, 'studio'))?.enabled, false)
  await assert.rejects(launchAppEpisode({ ...input, requestId: 'request-00000000004' }, start), /not enabled/)
  await writeFile(receiptPath, JSON.stringify({ ...receipt, managedAgents: ['other'] }))
  await assert.rejects(launchAppEpisode(input, start), /not enabled/)
  await writeFile(receiptPath, JSON.stringify(receipt))
  await assert.rejects(launchAppEpisode({ ...input, requestId: '../bad' }, start), /Invalid/)
})
