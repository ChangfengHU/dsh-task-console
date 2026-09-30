import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSkillAsset, parseAssets, portableHostConfig, remapPath, stageHostConfigs, writeSkillAsset, profilePatchPath, type ConfigAssets } from '../src/config-assets.ts'
import { createEnvelope, parseEnvelope, taskConfig } from '../src/config-migration.ts'
import { TaskConsoleService } from '../src/service.ts'
import { TaskActions } from '../src/task-actions.ts'
import { EventStore } from '../src/tasks.ts'
import { taskRunMode } from '../src/client/task-run-mode.ts'

const empty = (): ConfigAssets => ({ schema: 'dsh-task-console/assets-v1', skills: [], hostConfigs: [], requirements: [], models: { defaultSelection: null, providers: [] } })
const agent: any = { id: 'migration-worker', name: 'Worker', description: '', persona: 'Fixture', model: 'fixture/model', effort: '', permissionPreset: 'workspace-write', tools: [], mcpTools: { 'fixture-mcp': ['read'] }, mcpPolicy: { 'fixture-mcp': { read: { requiredArguments: ['target'] } } }, skills: ['fixture-skill'] }
const action: any = { id: 'inspect', name: 'Inspect', description: '', template: 'Inspect {{target}}', parameters: [{ key: 'target', label: 'Target', type: 'text', required: true }] }
async function temp() { return realpath(await mkdtemp(join(tmpdir(), 'dsh-asset-test-'))) }
async function fixtureSkill(root: string) {
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'SKILL.md'), '---\nname: fixture-skill\ndescription: fixture\n---\nRead only.\n')
  await writeFile(join(root, 'scripts', 'inspect.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(join(root, 'pixel.bin'), Buffer.from([0, 255, 1, 128]))
  await writeFile(join(root, '.gitignore'), '__pycache__/\n')
  return collectSkillAsset('fixture-skill', root)
}

test('complete Skill bytes, executable mode and config digest round-trip; history absent', async () => {
  const root = await temp()
  try {
    const asset = await fixtureSkill(join(root, 'source')), assets = empty(); assets.skills = [asset]
    const payload = { agents: [{ spec: agent, actions: [action] }], tasks: [], assets }
    const envelope = createEnvelope(payload, 'test'), parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)))
    const dir = await writeSkillAsset(parsed.payload.assets!.skills[0], join(root, 'target'))
    assert.deepEqual(await readFile(join(dir, 'pixel.bin')), Buffer.from([0, 255, 1, 128]))
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '__pycache__/\n')
    assert.equal((await stat(join(dir, 'scripts', 'inspect.sh'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(dir, 'SKILL.md'))).mode & 0o777, 0o600)
    assert.deepEqual(parsed.payload.agents[0].spec.mcpPolicy, agent.mcpPolicy)
    envelope.payload.assets!.skills[0].files[0].base64 = 'eA=='
    assert.throws(() => parseEnvelope(envelope), /SHA256/)
    await assert.rejects(() => writeSkillAsset(asset, join(root, 'target')), /已存在/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reject traversal, case collisions, file/directory collisions and symlink resources', async () => {
  const root = await temp()
  try {
    const asset = await fixtureSkill(join(root, 'source')), assets = empty()
    for (const path of ['../outside', '/outside', 'C:\\outside', 'a/../b', 'a//b', '.env', 'a\u0000b']) {
      assets.skills = [{ ...asset, files: [{ ...asset.files[0], path }] }]
      assert.throws(() => parseAssets(assets), /路径/)
    }
    assets.skills = [{ ...asset, files: [...asset.files, { ...asset.files[0], path: 'skill.md' }] }]
    assert.throws(() => parseAssets(assets), /重复/)
    assets.skills = [{ ...asset, files: [...asset.files, { ...asset.files[0], path: 'scripts' }] }]
    assert.throws(() => parseAssets(assets), /冲突/)
    await symlink(join(root, 'source', 'SKILL.md'), join(root, 'source', 'link.md'))
    await assert.rejects(() => collectSkillAsset('fixture-skill', join(root, 'source')), /软链接/)
    await symlink(join(root, 'source'), join(root, 'linked-target'))
    await assert.rejects(() => writeSkillAsset(asset, join(root, 'linked-target')), /普通目录/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('MCP/model credentials and opaque argv become references; plaintext cannot be imported', () => {
  const raw = { serverName: 'fixture-mcp', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer fixture-secret' }, env: { TOKEN: 'fixture-secret' }, args: ['--token', 'fixture-secret'], apiKey: 'fixture-secret' }
  const row = portableHostConfig('fixture-mcp', '@deepseek-ai/dsh-mcp-client', 'mcp', raw, false, ['read'])
  assert.equal(JSON.stringify(row).includes('fixture-secret'), false)
  assert.equal(row.secrets.length, 4)
  const assets = empty(); assets.hostConfigs = [row]
  assert.deepEqual(parseAssets(assets).hostConfigs[0], row)
  row.config.apiKey = 'plaintext'
  assert.throws(() => parseAssets(assets), /密钥值/)
  const url = portableHostConfig('url', '@deepseek-ai/dsh-mcp-client', 'mcp', { url: 'https://user:password@example.test/mcp?token=secret' })
  assert.equal(url.config.url, null)
  assert.equal(JSON.stringify(url).includes('password'), false)
  const model = portableHostConfig('model', 'model', 'model', { maxTokens: 4096, max_output_tokens: 1024, tokenBudget: 10000, token: 123456 })
  assert.equal(model.config.maxTokens, 4096)
  assert.equal(model.config.max_output_tokens, 1024)
  assert.equal(model.config.tokenBudget, 10000)
  assert.equal(model.config.token, null)
})

test('patch staging preserves live config/comments, backs up and never activates imported services', async () => {
  const root = await temp(), file = join(root, 'profile', 'cordis.patch.yml')
  try {
    await mkdir(join(root, 'profile'))
    const before = '# keep comment\n- insert:\n    - id: existing\n      name: example\n      config:\n        apiKey: fixture-private-value\n'
    await writeFile(file, before)
    const rows = [portableHostConfig('existing', 'example', 'model', {}), portableHostConfig('new-mcp', '@deepseek-ai/dsh-mcp-client', 'mcp', { serverName: 'new-mcp', url: 'https://example.test/mcp' })]
    assert.deepEqual(await stageHostConfigs(file, rows, join(root, 'backup'), new Set()), ['new-mcp'])
    const after = await readFile(file, 'utf8')
    assert.match(after, /keep comment/); assert.match(after, /fixture-private-value/); assert.match(after, /disabled: true/)
    assert.equal(await readFile(join(root, 'backup', 'cordis.patch.yml.before'), 'utf8'), before)
    assert.deepEqual(await stageHostConfigs(file, rows, join(root, 'backup2'), new Set()), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('path remapping is longest-prefix and segment-aware; isolated DSH_HOME is respected', () => {
  assert.equal(remapPath('/home/claude/work/a', { '/home/claude': '/Users/a', '/home/claude/work': '/Users/b' }), '/Users/b/a')
  assert.equal(remapPath('/home/claudette/a', { '/home/claude': '/Users/a' }), '/home/claudette/a')
  assert.throws(() => remapPath('/x', { relative: '/target' }), /绝对路径/)
  assert.equal(profilePatchPath(['dsh', '--profile=custom'], '/isolated'), '/isolated/profiles/custom/cordis.patch.yml')
})

test('plugin policy and Studio configuration are retained, never inserted as a duplicate host service', async () => {
  const root = await temp(), assets = empty()
  try {
    assets.hostConfigs = [portableHostConfig('studio-task-console', 'dsh-task-console', 'plugin', { standardMaxSteps: 24, workflowModules: [{ path: '/source/adapter.mjs', sha256: 'a'.repeat(64) }], taskFallbackModel: 'provider/model' }), portableHostConfig('studio-runtime', 'dsh-task-console/studio-runtime', 'plugin', { storyboardCompilerScript: '/source/compiler.py', vaultTokenFile: '/private/token' })]
    const parsed = parseAssets(assets)
    assert.equal((parsed.hostConfigs[0].config.workflowModules as any[])[0].path, '/source/adapter.mjs')
    assert.equal(parsed.hostConfigs[1].config.vaultTokenFile, null)
    assert.deepEqual(await stageHostConfigs(join(root, 'profile.yml'), parsed.hostConfigs, join(root, 'backup'), new Set()), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('service imports into a fresh isolated machine: Skills, MCP references, Actions, paths, no runs; repeat is safe', async () => {
  const root = await temp(), oldDsh = process.env.DSH_HOME, oldAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = join(root, 'dsh'); process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const store = new EventStore(join(root, 'store')); await store.load()
  try {
    const asset = await fixtureSkill(join(root, 'source')), assets = empty()
    assets.skills = [asset, { ...asset, agentId: agent.id }]
    assets.hostConfigs = [portableHostConfig('fixture-mcp', '@deepseek-ai/dsh-mcp-client', 'mcp', { serverName: 'fixture-mcp', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private-fixture' } }, false, ['read'])]
    assets.requirements = [{ module: '@deepseek-ai/dsh-mcp-client', version: 'test' }]
    const originalTask: any = { id: 'T-import', title: 'Import test', brief: 'Run read-only inspection', participants: [{ agentId: agent.id }], cwd: '/remote/work', trigger: { kind: 'once' }, timeoutSec: 60, onFail: 'stop', maxTries: 1, origin: { source: 'task-chat', signalId: 'never-export-this-receipt', decision: 'create' } }
    const envelope = createEnvelope({ agents: [{ spec: agent, actions: [action] }], tasks: [taskConfig(originalTask, [action])], assets }, 'test')
    const json = JSON.stringify(envelope)
    assert.doesNotMatch(json, /never-export-this-receipt|private-fixture/)
    const roster: any[] = []
    const ctx = { loader: { entries: () => [] }, tools: { schemas: () => [] }, get: (key: string) => key === 'agentPresets' ? { list: async () => roster } : undefined }
    const service: any = Object.create(TaskConsoleService.prototype)
    Object.defineProperty(service, 'ctx', { value: ctx })
    service.ready = Promise.resolve(); service.pendingConfigImports = new Map(); service.runner = { store }; service.creator = { actions: new TaskActions(service.runner) }
    const preview = JSON.parse(await service.previewLocalConfigImport(JSON.stringify({ json, pathMappings: { '/remote/work': root } })))
    assert.equal(preview.tasks[0].cwd, root)
    assert.equal(store.tasks.size, 0, 'preview has no writes')
    const withoutAssets = JSON.parse(await service.previewLocalConfigImport(JSON.stringify({ json, installAssets: false })))
    assert.deepEqual(withoutAssets.agents[0].missingSkills, ['fixture-skill'])
    const result = JSON.parse(await service.applyConfigImport(JSON.stringify({ importId: preview.importId })))
    assert.deepEqual(result.importedTasks, ['T-import']); assert.equal(result.schedulesEnabled, false)
    const imported = store.tasks.get('T-import')!
    assert.equal(imported.enabled, false); assert.equal(imported.cwd, root); assert.equal(imported.origin, undefined)
    assert.equal(taskRunMode(imported), 'parameters')
    assert.deepEqual(service.creator.actions.read(imported.id).actions, [action])
    assert.equal(store.s.batches.size, 0); assert.equal(store.s.runs.size, 0)
    const preset = join(process.env.DSH_HOME!, '.agent-presets', agent.id)
    assert.match(await readFile(join(preset, 'agent.cordis.yml'), 'utf8'), /sourceEntryId: fixture-mcp/)
    assert.equal(await readFile(join(preset, 'skills', 'fixture-skill', 'SKILL.md'), 'utf8'), await readFile(join(root, 'source', 'SKILL.md'), 'utf8'))
    assert.match(await readFile(profilePatchPath(), 'utf8'), /disabled: true/)
    roster.push({ id: agent.id, trust: 'user', path: join(preset, 'agent.cordis.yml') })
    const again = JSON.parse(await service.previewLocalConfigImport(JSON.stringify({ json })))
    const second = JSON.parse(await service.applyConfigImport(JSON.stringify({ importId: again.importId })))
    assert.equal(second.importedAgents.length, 0); assert.equal(second.importedTasks.length, 0)
    assert.equal(store.s.batches.size, 0)
    const external: any = { ...imported, id: 'T-external', configMigration: { digest: envelope.digest.value, workflowKind: 'external' } }
    await store.append({ t: 'task/created', at: new Date().toISOString(), taskId: external.id, task: external })
    assert.equal(taskRunMode(external), 'external')
    await assert.rejects(() => service.fireTask(JSON.stringify({ id: external.id })), /执行权限/)
  } finally {
    store.kernel.db.close(); if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh
    if (oldAgents === undefined) delete process.env.DSH_AGENTS_HOME; else process.env.DSH_AGENTS_HOME = oldAgents
    await rm(root, { recursive: true, force: true })
  }
})
