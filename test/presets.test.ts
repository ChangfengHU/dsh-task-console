import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mask, permissionOf, readSpec, removePreset, renderComposition, syncPresetSkills, validateSpec, verifyPresetSkills, writePreset } from '../src/presets.ts'

const base = { id: 'inspector', name: '巡检员', description: '只看不动', persona: '你是巡检员。\n只读。', model: 'codex-local/gpt-5.6-mini', effort: 'medium' as const, permissionPreset: 'workspace-write' as const }

test('validateSpec rejects bad ids and keeps only known native tools', () => {
  assert.throws(() => validateSpec({ ...base, id: '../x' }), /id/)
  assert.throws(() => validateSpec({ ...base, id: 'Inspector' }), /id/)
  const spec = validateSpec({ ...base, tools: ['bash', 'nope', 'bash'], mcp: ['vault'], skills: ['a'] })
  assert.deepEqual(spec.tools, ['bash'])
  assert.deepEqual(spec.mcpTools, { vault: ['*'] })
  assert.deepEqual(spec.mcpPolicy, {})
  assert.equal(validateSpec({ ...base, permissionPreset: undefined }).permissionPreset, 'workspace-write')
  assert.equal(validateSpec({ ...base, permissionPreset: 'danger-full-access' }).permissionPreset, 'danger-full-access')
})

test('renderComposition lists only chosen rows and renames a live host MCP', () => {
  const spec = validateSpec({ ...base, tools: ['ask-user', 'fs-search'], mcpTools: { vault: ['get_config'], ghost: ['status'] }, skills: ['linux-clash-skill'] })
  const out = renderComposition(spec, [{ sourceEntryId: 'host-vault', serverName: 'vault', tools: ['get_config', 'delete_config'], live: true, config: { serverName: 'vault', transport: 'streamable-http', url: 'https://x/mcp/vault', headers: { Authorization: 'Bearer sd@secret' } } }])
  assert.match(out.yml, /dsh-tool-ask-user/)
  assert.match(out.yml, /dsh-tool-fs-search/)
  assert.doesNotMatch(out.yml, /dsh-tool-bash/)
  assert.match(out.yml, /agent-tool-fence/)
  assert.match(out.yml, /filtered-mcp-client/)
  assert.match(out.yml, /allowedTools:\n\s+- get_config/)
  const allowedBlock = out.yml.slice(out.yml.indexOf('    allowedTools:'), out.yml.indexOf('\n\n', out.yml.indexOf('    allowedTools:')))
  assert.doesNotMatch(allowedBlock, /delete_config/)
  assert.match(out.yml, /serverName: vault-inspector/)
  assert.match(out.yml, /sourceEntryId: host-vault/)
  assert.doesNotMatch(out.yml, /Authorization|headers:|sd@secret|https:\/\/x/)
  assert.deepEqual(out.renamed, [{ from: 'vault', to: 'vault-inspector' }])
  assert.match(out.yml, /ghost: 宿主里没有/)
  assert.match(out.yml, /customSkillDirs/)
  assert.match(out.yml, /!!js/)
  assert.match(out.yml, /text: \|-\n {6}你是巡检员。\n {6}只读。/)
  assert.equal(out.permission, 'limited-write')
})

test('renderComposition supplies the required todo policy', () => {
  const preview = renderComposition({ ...base, tools: ['todo'], mcpTools: {}, mcpPolicy: {}, skills: [] }, [])
  assert.match(preview.yml, /tool-todo[\s\S]*allowParallelInProgress: true/)
})

test('the inherited fence fails closed without naming selected local or current host tools', () => {
  const preview = renderComposition(
    { ...base, tools: ['ask-user'], mcpTools: {}, mcpPolicy: {}, skills: [] },
    [],
    ['ask_user_question', 'publish_public_html'],
  )
  const fence = preview.yml.slice(preview.yml.indexOf('inherited-tool-fence'))
  assert.match(fence, /allow: \[\]/)
  assert.doesNotMatch(fence, /ask_user_question|publish_public_html/)
})

test('permission is derived from tools, not declared', () => {
  const f = () => false
  assert.equal(permissionOf({ tools: ['ask-user'], mcpTools: {} }, f), 'read-only')
  assert.equal(permissionOf({ tools: ['ask-user'], mcpTools: { fleet: ['status'] } }, () => true), 'limited-write')
  assert.equal(permissionOf({ tools: ['bash'], mcpTools: {} }, f), 'write')
})

test('mask hides bearer tokens and url credentials', () => {
  const s = mask("headers:\n  Authorization: Bearer sd@123456*\nurl: https://u:p@host/x\ntoken: abc")
  assert.doesNotMatch(s, /123456/)
  assert.doesNotMatch(s, /u:p@/)
  assert.doesNotMatch(s, /abc/)
})

test('writePreset lays out the directory, copies chosen skills, and readSpec round-trips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-'))
  const lib = join(root, 'lib'); await mkdir(join(lib, 'linux-clash-skill'), { recursive: true })
  await writeFile(join(lib, 'linux-clash-skill', 'SKILL.md'), '---\nname: linux-clash-skill\ndescription: clash\n---\nbody')
  const spec = validateSpec({ ...base, tools: ['bash'], mcpTools: {}, skills: ['linux-clash-skill'] })
  const presetRoot = join(root, 'presets')
  const { path } = await writePreset(spec, [], [{ name: 'linux-clash-skill', dir: join(lib, 'linux-clash-skill'), description: '', root: 'x' }], presetRoot)
  assert.equal(path, join(presetRoot, 'inspector'))
  assert.deepEqual((await readdir(path)).sort(), ['agent.cordis.yml', 'preset.yml', 'skills', 'skills.lock.json', 'task-console.json'])
  assert.match(await readFile(join(path, 'preset.yml'), 'utf8'), /name: "巡检员"/)
  assert.equal((await readFile(join(path, 'skills', 'linux-clash-skill', 'SKILL.md'), 'utf8')).includes('body'), true)
  assert.deepEqual((await verifyPresetSkills(spec, [{ name: 'linux-clash-skill', dir: join(lib, 'linux-clash-skill'), description: '', root: 'x' }], path)).map(row => row.status), ['in-sync'])
  assert.deepEqual(await readSpec(path), spec)
  await writeFile(join(lib, 'linux-clash-skill', 'SKILL.md'), '---\nname: linux-clash-skill\ndescription: clash\n---\nnew body')
  assert.deepEqual((await verifyPresetSkills(spec, [{ name: 'linux-clash-skill', dir: join(lib, 'linux-clash-skill'), description: '', root: 'x' }], path)).map(row => row.status), ['source-drift'])
  await writeFile(join(path, 'skills', 'linux-clash-skill', 'SKILL.md'), 'locally edited')
  assert.deepEqual((await verifyPresetSkills(spec, [{ name: 'linux-clash-skill', dir: join(lib, 'linux-clash-skill'), description: '', root: 'x' }], path)).map(row => row.status), ['source-and-copy-drift'])
  // a second save without skills clears the stale copy
  await writePreset({ ...spec, skills: [] }, [], [], presetRoot)
  assert.deepEqual((await readdir(path)).sort(), ['agent.cordis.yml', 'preset.yml', 'skills.lock.json', 'task-console.json'])
  await removePreset('inspector', presetRoot)
  assert.deepEqual(await readdir(presetRoot), [])
  await assert.rejects(removePreset('../x', presetRoot))
})

test('writePreset fails before replacing a working preset when a selected Skill source vanished', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-atomic-'))
  const presetRoot = join(root, 'presets')
  const original = validateSpec({ ...base, tools: ['ask-user'], mcpTools: {}, skills: [] })
  const { path } = await writePreset(original, [], [], presetRoot)
  const originalYml = await readFile(join(path, 'agent.cordis.yml'), 'utf8')
  await assert.rejects(writePreset({ ...original, persona: 'replacement', skills: ['missing'] }, [], [], presetRoot), /Skill 不存在/)
  assert.equal(await readFile(join(path, 'agent.cordis.yml'), 'utf8'), originalYml)
  assert.deepEqual(await readSpec(path), original)
})

test('managed Skill copies and hashes ignore interpreter cache files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-skill-cache-'))
  const source = join(root, 'source', 'demo')
  const preset = join(root, 'preset')
  await mkdir(join(source, '__pycache__'), { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '# Demo\n')
  await writeFile(join(source, '__pycache__', 'demo.cpython-39.pyc'), 'machine-local-cache')
  await mkdir(preset, { recursive: true })
  const spec = validateSpec({ id: 'demo', name: 'Demo', description: '', persona: '', skills: ['demo'], tools: [], mcpTools: {}, mcpPolicy: {} })
  await syncPresetSkills(spec, [{ name: 'demo', description: '', dir: source, root: 'test' }], preset)
  await assert.rejects(access(join(preset, 'skills', 'demo', '__pycache__')))
  await writeFile(join(source, '__pycache__', 'demo.cpython-39.pyc'), 'changed-cache')
  assert.equal((await verifyPresetSkills(spec, [{ name: 'demo', description: '', dir: source, root: 'test' }], preset))[0].status, 'in-sync')
})
