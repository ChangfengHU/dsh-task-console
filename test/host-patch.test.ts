import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('host compatibility patch preserves a plugin-created Agent model before its first request', async () => {
  const source = await readFile(new URL('../scripts/patch-dsh-host.mjs', import.meta.url), 'utf8')
  assert.match(source, /const configured = agent\.options/)
  assert.match(source, /configured\.provider \?\? fallback\.provider/)
  assert.match(source, /configured\.reasoningEffort/)
  assert.match(source, /host-agent-model/)
})
