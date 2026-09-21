import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { validateTaskActions, assertTaskActionLogin } from '../src/task-actions.ts'
import { actionCandidates } from '../src/agent-actions.ts'

const starter = JSON.parse(await readFile(new URL('../presets/fleet-task-actions.json', import.meta.url), 'utf8'))
test('Task Action schema validates reusable fleet example, rejects authority fields and unsafe defaults', () => {
  const actions = validateTaskActions(starter)
  assert.equal(actions[0].parameters.find(p => p.binding === 'ssh-password')?.default, undefined)
  assert.throws(() => validateTaskActions([{ ...starter[0], tools: ['ssh'] }]), /不能设置/)
  assert.throws(() => validateTaskActions([starter[0], { ...starter[0], id: 'second' }]), /默认/)
  assert.throws(() => validateTaskActions([{ ...starter[0], parameters: starter[0].parameters.map((p: any) => p.binding === 'ssh-password' ? { ...p, default: 'not-a-real-secret' } : p) }]), /密码/)
  assert.throws(() => validateTaskActions([{ ...starter[0], enabled: false }]), /默认/)
  assert.doesNotMatch(JSON.stringify(starter), /152\.70|129\.146|@gmail/)
  assert.deepEqual(actionCandidates({ agentId: null, taskId: 't', name: 'T', writable: true, revision: '1', actions: [{ ...actions[0], isDefault: false, enabled: false }] }, ''), [])
})

test('Task account intent narrows trusted provision/copy/resume without widening existing permissions', () => {
  const snapshot: any = { parameters: starter[0].parameters, values: { ip: '192.0.2.1', account: 'fixture@example.test · accountId=gemini_12345678 · #12345678' } }
  const args = { ip: '192.0.2.1', platform: 'gemini', accountId: 'gemini_12345678' }
  assert.doesNotThrow(() => assertTaskActionLogin(snapshot, 'browser_login_provision', args))
  assert.throws(() => assertTaskActionLogin(snapshot, 'browser_login_provision', { ...args, accountId: 'gemini_87654321' }), /指定金库/)
  assert.throws(() => assertTaskActionLogin(snapshot, 'browser_login_provision', { ...args, ip: '192.0.2.2' }), /明确目标/)
  assert.throws(() => assertTaskActionLogin(snapshot, 'browser_login_copy', args), /指定金库/)
  assert.throws(() => assertTaskActionLogin(snapshot, 'browser_login_resume', args), /指定金库/)
  assert.doesNotThrow(() => assertTaskActionLogin(snapshot, 'browser_login_resume', args, { args }))
  assert.doesNotThrow(() => assertTaskActionLogin(undefined, 'browser_login_copy', args))
})
