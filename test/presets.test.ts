import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mask, permissionOf, readSpec, removePreset, renderComposition, validateSpec, writePreset } from '../src/presets.ts'

const base = { id: 'inspector', name: '巡检员', description: '只看不动', persona: '你是巡检员。\n只读。', model: 'codex-local/gpt-5.6-mini', effort: 'medium' as const }

test('validateSpec rejects bad ids and keeps only known native tools', () => {
  assert.throws(() => validateSpec({ ...base, id: '../x' }), /id/)
  assert.throws(() => validateSpec({ ...base, id: 'Inspector' }), /id/)
  const spec = validateSpec({ ...base, tools: ['bash', 'nope', 'bash'], mcp: ['vault'], skills: ['a'] })
  assert.deepEqual(spec.tools, ['bash'])
  assert.deepEqual(spec.mcpTools, { vault: ['*'] })
  assert.deepEqual(spec.mcpPolicy, {})
})

test('renderComposition lists only chosen rows and renames a live host MCP', () => {
  const spec = validateSpec({ ...base, tools: ['ask-user', 'fs-search'], mcpTools: { vault: ['get_config'], ghost: ['status'] }, skills: ['linux-clash-skill'] })
  const out = renderComposition(spec, [{ serverName: 'vault', tools: ['get_config', 'delete_config'], live: true, config: { serverName: 'vault', transport: 'streamable-http', url: 'https://x/mcp/vault', headers: { Authorization: 'Bearer sd@secret' } } }])
  assert.match(out.yml, /dsh-tool-ask-user/)
  assert.match(out.yml, /dsh-tool-fs-search/)
  assert.doesNotMatch(out.yml, /dsh-tool-bash/)
  assert.match(out.yml, /agent-tool-fence/)
  assert.match(out.yml, /filtered-mcp-client/)
  assert.match(out.yml, /allowedTools:\n\s+- get_config/)
  const allowedBlock = out.yml.slice(out.yml.indexOf('    allowedTools:'), out.yml.indexOf('\n\n', out.yml.indexOf('    allowedTools:')))
  assert.doesNotMatch(allowedBlock, /delete_config/)
  assert.match(out.yml, /serverName: vault-inspector/)
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

test('the inherited fence keeps selected preset-local shadows visible to child chats', () => {
  const preview = renderComposition(
    { ...base, tools: ['ask-user'], mcpTools: {}, mcpPolicy: {}, skills: [] },
    [],
    ['ask_user_question', 'publish_public_html'],
  )
  const fence = preview.yml.slice(preview.yml.indexOf('inherited-tool-fence'))
  assert.doesNotMatch(fence, /ask_user_question/)
  assert.match(fence, /publish_public_html/)
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
  assert.deepEqual((await readdir(path)).sort(), ['agent.cordis.yml', 'preset.yml', 'skills', 'task-console.json'])
  assert.match(await readFile(join(path, 'preset.yml'), 'utf8'), /name: "巡检员"/)
  assert.equal((await readFile(join(path, 'skills', 'linux-clash-skill', 'SKILL.md'), 'utf8')).includes('body'), true)
  assert.deepEqual(await readSpec(path), spec)
  // a second save without skills clears the stale copy
  await writePreset({ ...spec, skills: [] }, [], [], presetRoot)
  assert.deepEqual((await readdir(path)).sort(), ['agent.cordis.yml', 'preset.yml', 'task-console.json'])
  await removePreset('inspector', presetRoot)
  assert.deepEqual(await readdir(presetRoot), [])
  await assert.rejects(removePreset('../x', presetRoot))
})
