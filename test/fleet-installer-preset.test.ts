import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { renderComposition, validateSpec } from '../src/presets.ts'

const source = new URL('../presets/fleet-installer/task-console.json', import.meta.url)
const skillSources = new URL('../presets/fleet-installer/skills.sources.json', import.meta.url)

test('managed installer declares the reviewed canonical Skill revision', async () => {
  const manifest = JSON.parse(await readFile(skillSources, 'utf8'))
  assert.equal(manifest.version, 1)
  assert.match(manifest.repository, /^https:\/\/github\.com\/ChangfengHU\/linux-clash-skill$/)
  assert.equal(manifest.revision, 'a4dba3d993024abed6b45b0da864c37ec0a2e419')
  assert.equal('revisionPending' in manifest, false)
  assert.deepEqual(manifest.skills.map((row: any) => row.name).sort(), ['fleet-node-onboard', 'linux-browser-vnc', 'linux-clash-skill'])
  assert.ok(manifest.skills.every((row: any) => row.path === `skills/${row.name}`))
})

test('managed installer preset exposes conversation + deterministic runtime, never arbitrary host execution', async () => {
  const spec = validateSpec(JSON.parse(await readFile(source, 'utf8')))
  assert.deepEqual(spec.tools, ['ask-user', 'todo', 'fleet-onboard-runtime'])
  assert.equal(spec.permissionPreset, 'danger-full-access')
  for (const unsafe of ['bash', 'fs', 'fs-search', 'jobs', 'str-replace-editor']) assert.ok(!spec.tools.includes(unsafe))
  for (const name of ['fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report']) assert.match(spec.persona, new RegExp(name))
  assert.doesNotMatch(spec.persona, /通过 bash|执行 systemctl|运行 .*\.sh|任何目标侧闸门失败都停止/)
  assert.match(spec.persona, /绝不得构造 inventory/)
  assert.deepEqual(spec.mcpTools, {})
  assert.deepEqual(spec.mcpPolicy, {})
})

test('managed installer composition is secret-free and request-header surface is locally scoped', async () => {
  const spec = validateSpec(JSON.parse(await readFile(source, 'utf8')))
  const hosts = [
    { sourceEntryId: 'host-vault', serverName: 'vault', tools: ['vyibc-vault_list_configs', 'vyibc-vault_get_config'], live: true, config: { headers: { Authorization: 'Bearer vault-secret' }, url: 'https://vault.invalid' } },
    { sourceEntryId: 'host-fleet', serverName: 'vyibc-fleet', tools: ['vyibc-fleet_node_detail', 'vyibc-fleet_node_audit', 'vyibc-fleet_disable_node'], live: true, config: { headers: { Authorization: 'Bearer fleet-secret' }, url: 'https://fleet.invalid' } },
  ]
  const preview = renderComposition(spec, hosts)
  for (const name of ['ask_user_question', 'todo_write', 'skill', 'fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report']) {
    assert.match(preview.yml, new RegExp(`\\s- ${name}`))
  }
  assert.doesNotMatch(preview.yml, /\s- bash|\s- mcp__/)
  assert.match(preview.yml, /dsh-tool-ask-user/)
  assert.match(preview.yml, /dsh-task-console\/fleet-onboard-tools/)
  assert.doesNotMatch(preview.yml, /sourceEntryId:|vault-secret|fleet-secret|Authorization|headers:|https:\/\/.*\.invalid/)
  assert.doesNotMatch(preview.yml, /vyibc-vault_|vyibc-fleet_/)
})
