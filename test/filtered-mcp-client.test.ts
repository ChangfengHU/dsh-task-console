import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertToolArguments, publicToolName } from '../src/filtered-mcp-client.ts'

test('filtered MCP public names match the DSH naming contract', () => {
  assert.equal(publicToolName('vault-agent', 'get_config'), 'mcp__vault-agent__get_config')
  const lossy = publicToolName('vault-agent', 'a tool with a very long name '.repeat(4))
  assert.match(lossy, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(lossy.length, 64)
})

test('MCP argument policy admits scoped keys and rejects unrelated keys', () => {
  const rule = { valuesOrPrefixes: { key: ['clash:lines', 'ssh:host-'] } }
  assert.doesNotThrow(() => assertToolArguments('get_config', rule, { key: 'clash:lines' }))
  assert.doesNotThrow(() => assertToolArguments('get_config', rule, { key: 'ssh:host-1-2-3-4' }))
  assert.throws(() => assertToolArguments('get_config', rule, { key: 'service:github' }), /policy denied/)
})

test('MCP argument policy checks optional URL patterns when supplied', () => {
  const rule = { patterns: { id: '^host-(?:[0-9]{1,3}-){3}[0-9]{1,3}$', vncUrl: '^https://vnc-' } }
  assert.doesNotThrow(() => assertToolArguments('register_node', rule, { id: 'host-1-2-3-4' }))
  assert.doesNotThrow(() => assertToolArguments('register_node', rule, { id: 'host-1-2-3-4', vncUrl: 'https://vnc-1-2-3-4.vyibc.com/' }))
  assert.throws(() => assertToolArguments('register_node', rule, { id: 'other' }), /policy denied/)
})
