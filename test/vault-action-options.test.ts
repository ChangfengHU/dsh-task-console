import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fleetActionOptions } from '../src/fleet-action-options.ts'
import { optionPage } from '../src/action-options.ts'
import { validateActions, renderAction } from '../src/agent-actions.ts'

const actions = validateActions(JSON.parse(await readFile(new URL('../presets/fleet-task-actions.json', import.meta.url), 'utf8')))
const parameter = actions[0].parameters[0]
const config = { args: ['/trusted/browser-manager/server.mjs'] }
test('onboarding candidates use only Vault SSH directory; no Fleet membership or secret reads', async () => {
  const calls: any[] = []
  const load = async (name: string) => {
    assert.equal(name, 'transport')
    return { request: async (...args: any[]) => {
      calls.push(args)
      return { result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, configs: [
        { key: 'ssh:host-129-213-30-236', description: 'DO-NOT-EXPOSE', password: 'DO-NOT-EXPOSE' },
        { key: 'ssh:managed-host-129-213-30-236' },
        { key: 'ssh:fleet-operator-key' }, { key: 'ssh:host-999-1-1-1' },
        { key: 'ssh:host-129-213-30-236-retired' }, { key: 'file:host-129-213-30-236' },
        ...Array.from({ length: 25 }, (_, i) => ({ key: `ssh:host-192-0-2-${i+1}` })),
      ] }) }] } }
    } }
  }
  assert.equal(parameter.source, 'vault.ssh-nodes')
  const result = await fleetActionOptions(config, parameter, {}, load, true)
  assert.equal(result.items.length, 26)
  assert.equal(result.items.filter(x => x.value === '129.213.30.236').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-EXPOSE|password/)
  assert.equal(optionPage(result.items, '', 2).items.length, 6)
  assert.equal(optionPage(result.items, '129.213').total, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['/mcp/vault', { jsonrpc:'2.0', id:'onboard-candidates', method:'tools/call', params:{name:'vyibc-vault_list_configs',arguments:{}} }, true])
  assert.match(renderAction(actions[0], { ip: '192.0.2.200' }), /192\.0\.2\.200/)
})
test('Vault source rejects unrelated Actions and invalid upstream metadata without fallback', async () => {
  const never = async () => { throw Error('must not load') }
  await assert.rejects(fleetActionOptions(config, parameter, {}, never, false), /尚未允许/)
  await assert.rejects(fleetActionOptions(config, { ...parameter, binding: undefined }, {}, never, true), /尚未允许/)
  for (const response of [{ error: { message: 'private' } }, {result:{isError:true}}, {result:{content:[]}}]) {
    await assert.rejects(fleetActionOptions(config, parameter, {}, async () => ({ request: async () => response }), true), /vault-directory/)
  }
})
