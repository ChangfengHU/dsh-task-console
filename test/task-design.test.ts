import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDesign } from '../src/task-design.ts'
import { cardMessage } from '../src/tasks.ts'

export const design = { scope: 'Read real inventory and preserve excluded resources',
  branches: [{ id: 'healthy', when: 'Current proof is valid', action: 'Reuse without writes', evidence: 'Fresh authoritative receipt' },
    { id: 'unknown', when: 'Proof is inconclusive', action: 'Recheck once; report unresolved', evidence: 'Actual failure reason, not a guessed login state' }],
  coordination: 'Independent items; serial writes to shared resources',
  failurePolicy: { isolateItems: true, maxAttempts: 2, stopConditions: ['Permission or user action is required'] },
  acceptance: ['Every discovered item has an evidence-linked outcome'] }
test('design requires explicit branches, bounded retry and testable acceptance', () => {
  assert.deepEqual(validateDesign(design), design)
  assert.throws(() => validateDesign(undefined), /branches/)
  assert.throws(() => validateDesign({ ...design, branches: [design.branches[0], design.branches[0]] }), /重复/)
  assert.throws(() => validateDesign({ ...design, acceptance: [] }), /acceptance/)
  assert.throws(() => validateDesign({ ...design, failurePolicy: { ...design.failurePolicy, maxAttempts: 999 } }), /failurePolicy/)
  assert.throws(() => validateDesign({ ...design, proxyRecovery: { agentId: 'invented' } }), /不支持的设计字段/)
})
test('execution receives the reviewed decision contract, not only a role list', () => {
  const text = cardMessage({ title: 'Test', brief: 'Inspect', participants: [{ agentId: 'a' }], design } as any,
    { index: 0 } as any, 'B', [])
  assert.match(text, /REVIEWED DECISION CONTRACT/)
  assert.match(text, /Actual failure reason/)
  assert.match(text, /不是自动执行的脚本/)
})
