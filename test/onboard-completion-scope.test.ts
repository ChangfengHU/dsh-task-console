import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseCompletionScope, type FleetToolResult } from '../src/fleet-onboard-tools.ts'

test('ten passed stages are explicitly base provisioning, not full Fleet acceptance', () => {
  const receipt = { phase: 'complete', current_stage: 10, report_available: true } as FleetToolResult
  const result = baseCompletionScope(receipt)
  assert.equal(result.base_complete, true)
  assert.equal(result.full_node_acceptance, 'not_evaluated')
  assert.equal(result.completion_scope, 'base-provisioning')
  assert.deepEqual(result.remaining_acceptance, ['browser-management', 'runner-registration-and-first-probe', 'fleet-readback', 'requested-login-policy'])
  assert.equal(receipt.completion_scope, undefined)
})

test('missing report, incomplete stages and blocked operations never acquire base success', () => {
  for (const change of [{report_available:false}, {current_stage:9}, {phase:'blocked'}, {phase:'running'}]) {
    const result = baseCompletionScope({phase:'complete',current_stage:10,report_available:true,...change} as FleetToolResult)
    assert.equal(result.base_complete, false)
    assert.equal(result.full_node_acceptance, 'not_evaluated')
  }
})
