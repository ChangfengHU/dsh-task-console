import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/agent-tool-fence.ts'

test('exact allow fence hides unselected host tools and admits selected preset tools', () => {
  let filter: { allow?: string[]; deny?: string[] } | undefined
  const local = new Set(['ask_user_question', 'todo_write', 'skill', 'fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report'])
  const inherited = new Set(['bash', 'mcp__vyibc-fleet__vyibc-fleet_node_detail', ...local])
  apply({ tools: { restrict: (candidate: typeof filter) => { filter = candidate } } } as any, { allow: [...local] })
  const requestHeaderTools = () => [
    ...[...inherited].filter(name => filter?.allow?.includes(name) && !filter?.deny?.includes(name)),
  ].sort()

  assert.deepEqual(requestHeaderTools(), [...local].sort())
  inherited.add('schedule_create')
  inherited.add('mcp__vyibc-fleet__vyibc-fleet_node_audit')
  assert.deepEqual(requestHeaderTools(), [...local].sort())
  assert.ok(requestHeaderTools().includes('ask_user_question'))
  assert.ok(!requestHeaderTools().some(name => name === 'bash' || name.startsWith('schedule_') || name === 'mcp__vyibc-fleet__vyibc-fleet_node_audit'))
})

test('legacy deny fences remain loadable until presets are explicitly regenerated', () => {
  let seen: unknown
  apply({ tools: { restrict: (candidate: unknown) => { seen = candidate } } } as any, { deny: ['bash', 'bash'] })
  assert.deepEqual(seen, { deny: ['bash'] })
})
