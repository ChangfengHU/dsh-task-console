import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { readActions } from '../src/agent-action-store.ts'
import { renderAction } from '../src/agent-actions.ts'
import { renderComposition, validateSpec } from '../src/presets.ts'

test('manual membership action is reusable, validated and has no preselected node', async () => {
  const { actions } = await readActions(new URL('../presets/fleet-ops/',import.meta.url).pathname)
  assert.equal(actions.length,1)
  assert.throws(()=>renderAction(actions[0],{}),/机器 IP/)
  assert.ok(renderAction(actions[0],{ip:'192.0.2.31'}).includes('192.0.2.31'))
  assert.ok(renderAction(actions[0],{ip:'192.0.2.45'}).includes('192.0.2.45'))
})

test('fleet operator regenerates MCP references without embedding host credentials', async () => {
  const spec=validateSpec(JSON.parse(await readFile(new URL('../presets/fleet-ops/task-console.json',import.meta.url),'utf8')))
  const hosts=Object.keys(spec.mcpTools).map(serverName=>({serverName,live:true,sourceEntryId:`host-${serverName}`,tools:[serverName==='vyibc-fleet'?'vyibc-fleet_recycle_node':'vyibc-vault_ssh_access'],config:{headers:{Authorization:'Bearer fixture-never-copy'}}}))
  const {yml}=renderComposition(spec,hosts)
  assert.match(yml,/sourceEntryId: host-vyibc-vault/)
  assert.match(yml,/recycle_node/)
  assert.doesNotMatch(yml,/fixture-never-copy|Authorization/)
})
