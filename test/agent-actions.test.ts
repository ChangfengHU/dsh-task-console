import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actionCandidates, actionDefaults, renderAction, validateActions } from '../src/agent-actions.ts'
import { readActions, saveActions } from '../src/agent-action-store.ts'
import { readSpec, validateSpec, writePreset } from '../src/presets.ts'
import { TaskConsoleService } from '../src/service.ts'
import { sendCurrentAction } from '../src/client/action-dispatch.ts'

const raw = { id: 'hello', name: '问候', description: '参数化消息', template: '{{target}} · {{count}} · {{enabled}}', parameters: [
  { key: 'target', label: '目标', type: 'text', required: true },
  { key: 'count', label: '数量', type: 'number', required: true, default: 1 },
  { key: 'enabled', label: '启用', type: 'boolean', required: true, default: false },
] }
const action = validateActions([raw])[0]
const spec = validateSpec({ id: 'worker', name: '测试角色', tools: [], skills: [] })
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dtc-actions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writePreset(spec, [], [], root)
  return { root, dir: join(root, 'worker') }
}
test('action defaults, typed values and one-pass interpolation; nothing is evaluated', () => {
  assert.deepEqual(actionDefaults(action), { target: '', count: 1, enabled: false })
  assert.equal(renderAction(action, { target: '{{count}} $& <script>' }), '[Action: 问候 · hello]\n{{count}} $& <script> · 1 · 否')
  assert.throws(() => renderAction(action, {}), /请填写目标/)
  assert.throws(() => renderAction(action, { target: 'ok', count: '1' }), /有效数字/)
  assert.throws(() => renderAction(action, { target: 'ok', enabled: 'true' }), /参数格式/)
  assert.throws(() => renderAction(action, { target: 'ok', extra: 3 }), /未定义/)
  assert.throws(() => renderAction(action, { target: 'ok', count: Infinity }), /有效数字/)
})
test('invalid configuration fails closed, including duplicate identifiers and unknown placeholders', () => {
  assert.throws(() => validateActions([raw, raw]), /唯一/)
  assert.throws(() => validateActions([{ ...raw, id: '../escape' }]), /id/)
  assert.throws(() => validateActions([{ ...raw, parameters: [...raw.parameters, raw.parameters[0]] }]), /唯一/)
  assert.throws(() => validateActions([{ ...raw, template: '{{other}}' }]), /未定义/)
  assert.throws(() => validateActions([{ ...raw, template: '{{target} {{count}} {{enabled}}' }]), /格式错误/)
  assert.throws(() => validateActions([{ ...raw, template: '{{target}}' }]), /每个参数/)
  assert.throws(() => validateActions(Array(21).fill(raw)), /20/)
})
test('sidecar CRUD CAS and atomic preset rewrites preserve Actions without altering executable spec', async t => {
  const { root, dir } = await fixture(t)
  const before = await readFile(join(dir, 'agent.cordis.yml'), 'utf8')
  const empty = await readActions(dir)
  const saved = await saveActions(dir, [action], empty.revision)
  assert.equal(saved.actions[0].id, 'hello')
  assert.deepEqual(await readSpec(dir), spec)
  assert.equal(await readFile(join(dir, 'agent.cordis.yml'), 'utf8'), before)
  await assert.rejects(saveActions(dir, [], empty.revision), /其他页面/)
  await Promise.all([writePreset(spec, [], [], root), saveActions(dir, [{ ...action, name: '更新' }], saved.revision)])
  assert.equal((await readActions(dir)).actions[0].name, '更新')
  const latest = await readActions(dir)
  await saveActions(dir, [], latest.revision)
  assert.deepEqual((await readActions(dir)).actions, [])
})
test('concurrent editors cannot silently overwrite each other', async t => {
  const { dir } = await fixture(t)
  const { revision } = await readActions(dir)
  const outcomes = await Promise.allSettled([saveActions(dir, [action], revision), saveActions(dir, [], revision)])
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1)
})
test('role context uses persisted headers, rejects role/revision drift; prepare never invokes an agent', async t => {
  const { dir } = await fixture(t)
  const saved = await saveActions(dir, [action], (await readActions(dir)).revision)
  const service = Object.create(TaskConsoleService.prototype)
  const services: any = {
    agentPresets: { list: async () => [{ id: 'worker', path: join(dir, 'agent.cordis.yml'), trust: 'user' }] },
    sessionPersistence: { list: async () => [{ id: 'unrelated-name', agentPreset: 'worker', createdAt: 1 }] },
    sessions: { list: () => [] },
  }
  Object.defineProperty(service, 'ctx', { value: { get: (key: string) => services[key], agents: { create: () => assert.fail('preview must never execute') } } })
  assert.equal(JSON.parse(await service.agentActions(JSON.stringify({ sessionId: 'unrelated-name' }))).agentId, 'worker')
  assert.equal(JSON.parse(await service.agentActions(JSON.stringify({ sessionId: 'agent-worker-forged' }))).agentId, null)
  await assert.rejects(service.agentActions(JSON.stringify({ sessionId: 'unrelated-name', agentId: 'other' })), /不匹配/)
  const query = { agentId: 'worker', sessionId: 'unrelated-name', actionId: 'hello', values: { target: 'world' }, revision: saved.revision }
  assert.match(JSON.parse(await service.prepareAgentAction(JSON.stringify(query))).text, /world/)
  await assert.rejects(service.prepareAgentAction(JSON.stringify({ ...query, revision: 'stale' })), /已更新/)
  await assert.rejects(service.saveAgentActions(JSON.stringify({ agentId: 'worker', revision: saved.revision, actions: [] })), /不可写/)
})
test('current Action dispatch uses native session prompt once, no new session; switched sessions rejected', async () => {
  const calls: unknown[] = []
  let current = 'session-1'
  const scope = {}
  const ctx = { sessions: { list: { getSnapshot: () => ({ current }) }, scope: () => scope, sessionOf: (actual: unknown) => {
    assert.equal(actual, scope)
    return { sessionId: 'session-1', prompt: async (...args: unknown[]) => { calls.push(args); return { ok: true, value: { accepted: true } } } }
  } } }
  await sendCurrentAction(ctx, 'session-1', 'previewed message')
  assert.deepEqual(calls, [[[ { type: 'text', text: 'previewed message' } ], 'queue']])
  current = 'session-2'
  await assert.rejects(sendCurrentAction(ctx, 'session-1', 'not sent'), /已切换会话/)
  assert.equal(calls.length, 1)
})
test('current role search only yields its actions; packaged browser examples validate without a fixed host/account', async () => {
  const catalog = { agentId: 'worker', name: '角色', revision: 'r', actions: [action], writable: true }
  assert.equal(actionCandidates(catalog, 'hello')[0].section, 'Actions · 角色')
  assert.deepEqual(actionCandidates(catalog, 'other'), [])
  assert.deepEqual(actionCandidates(null, ''), [])
  const seed = JSON.parse(await readFile(new URL('../presets/browser-manager-actions.json', import.meta.url), 'utf8'))
  assert.equal(validateActions(seed.actions).length, 5)
  assert.doesNotMatch(JSON.stringify(seed), /\d{1,3}(?:\.\d{1,3}){3}|@gmail/)
})
