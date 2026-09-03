import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/agent-tool-fence.ts'

test('selected-tool fence hides current inherited tools and guards later registrations', () => {
  let filter: { allow?: string[]; deny?: string[] } | undefined
  let guard: ((exec: { name: string }) => string | undefined) | undefined
  const local = new Set(['ask_user_question', 'todo_write', 'skill', 'fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report'])
  const inherited = new Set(['bash', 'mcp__vyibc-fleet__vyibc-fleet_node_detail', ...local])
  apply({ tools: {
    schemas: () => [...inherited].map(name => ({ name })),
    restrict: (candidate: typeof filter) => { filter = candidate },
    guard: (candidate: typeof guard) => { guard = candidate },
  } } as any, { selected: [...local] })
  const requestHeaderTools = () => [
    ...[...inherited].filter(name => !filter?.deny?.includes(name)),
  ].sort()

  assert.deepEqual(requestHeaderTools(), [...local].sort())
  inherited.add('schedule_create')
  inherited.add('mcp__vyibc-fleet__vyibc-fleet_node_audit')
  assert.equal(guard?.({ name: 'fleet_onboard_start' }), undefined)
  assert.match(guard?.({ name: 'schedule_create' }) ?? '', /not been granted/)
  assert.match(guard?.({ name: 'mcp__vyibc-fleet__vyibc-fleet_node_audit' }) ?? '', /not been granted/)
  assert.ok(!requestHeaderTools().includes('bash'))
})

test('legacy deny fences remain loadable until presets are explicitly regenerated', () => {
  let seen: unknown
  apply({ tools: { restrict: (candidate: unknown) => { seen = candidate } } } as any, { deny: ['bash', 'bash'] })
  assert.deepEqual(seen, { deny: ['bash'] })
})
