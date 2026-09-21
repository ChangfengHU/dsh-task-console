import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeRecipe } from '../src/workflow-recipes.ts'

test('v2 puts authoritative account acceptance last without adding a role or changing v1', () => {
  const plan = composeRecipe({ id: 'fleet-base-v2', login: 'provision-gemini' })
  assert.deepEqual(plan.participants.map(p => p.agentId), ['fleet-installer', 'fleet-runner-operator', 'browser-manager'])
  assert.match(plan.participants[2].brief!, /browser_login_acceptance/)
  assert.match(plan.participants[2].brief!, /20 分钟/)
  assert.match(plan.participants[2].brief!, /browserAcceptanceOperationId/)
  assert.doesNotMatch(JSON.stringify(plan), /152\.70\.155\.63/)
})

test('Fleet recipe has exactly three responsible roles and does not reword login boundaries', () => {
  const recipe = composeRecipe({ id: 'fleet-base-v1', login: 'provision-gemini' })
  assert.deepEqual(recipe.participants.map(p => p.agentId), ['fleet-installer', 'browser-manager', 'fleet-runner-operator'])
  assert.match(recipe.participants[1].brief!, /browser_login_provision/)
  assert.doesNotMatch(recipe.participants[1].brief!, /不得自动复制登录|不调用登录 provision/)
  assert.match(recipe.participants[2].brief!, /最后一位角色/)
  assert.doesNotMatch(JSON.stringify(recipe), /152\.70\.155\.63/)
  const preserved = composeRecipe({ id: 'fleet-base-v1', login: 'preserve' })
  assert.match(preserved.participants[1].brief!, /不调用登录 provision\/copy/)
  assert.throws(() => composeRecipe({ id: 'unknown', login: 'provision-gemini' } as any), /未知/)
})
