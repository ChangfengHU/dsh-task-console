import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { validateSpec } from '../src/presets.ts'

test('managed Task Agent has no business execution capability', async () => {
  const spec = validateSpec(JSON.parse(await readFile(new URL('../presets/task-intake/task-console.json', import.meta.url), 'utf8')))
  assert.equal(spec.id, 'task-intake')
  assert.deepEqual(spec.tools, [])
  assert.deepEqual(spec.mcpTools, {})
  assert.deepEqual(spec.skills, [])
  assert.equal(spec.permissionPreset, 'workspace-write')
  assert.equal(spec.model, 'llm-deepseek/qwen-plus-latest')
  assert.match(spec.persona, /不执行修复/)
  assert.match(spec.persona, /IP、机器、账号.*Task 身份/)
})
