import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmedActionRole, makeActionSnippet, resolveSnippetDefaults, restoreSnippet, snippetError, snippetProgress, trackSnippetEdit } from '../src/action-snippet.ts'
import { agentMentionSource } from '../src/client/agent-mentions.ts'
import { validateActions } from '../src/agent-actions.ts'

const action = validateActions([{ id: 'create', name: '新增', description: '', template: '在 {{ip}} 新增 {{count}} 个；自动登录 {{login}}', parameters: [
  { key: 'ip', label: '机器 IP', type: 'text', required: true },
  { key: 'count', label: '数量', type: 'number', required: true, default: 1 },
  { key: 'login', label: '登录', type: 'boolean', required: true, default: true },
] }])[0]
test('snippet slots include editable defaults and exact selections, no evaluation', () => {
  const s = makeActionSnippet(action, '@新增 ')
  assert.equal(s.text, '@新增 在 【机器 IP】 新增 【数量】 个；自动登录 【登录】')
  assert.deepEqual(s.slots.map(p => s.text.slice(p.start, p.end)), ['【机器 IP】', '【数量】', '【登录】'])
  assert.equal(snippetError(s.slots[0], s.text), '请填写机器 IP')
  assert.equal(snippetError(s.slots[1], s.text), null)
})
test('typed replacement, continued typing, defaults and shifts stay attached to their fields', () => {
  const s = makeActionSnippet(action, '@新增 ')
  let before = s.text, after = before.replace('【机器 IP】', '192.0.2.1')
  let slots = trackSnippetEdit(s.slots, before, after, 0)
  assert.equal(after.slice(slots[0].start, slots[0].end), '192.0.2.1')
  assert.equal(after.slice(slots[1].start, slots[1].end), '【数量】')
  before = after; after = before.slice(0, slots[0].end) + '0' + before.slice(slots[0].end)
  slots = trackSnippetEdit(slots, before, after, 0)
  assert.equal(after.slice(slots[0].start, slots[0].end), '192.0.2.10')
  before = after; after = before.slice(0, slots[1].start) + 'bad' + before.slice(slots[1].end)
  slots = trackSnippetEdit(slots, before, after, 1)
  assert.equal(snippetError(slots[1], after), '数量需要填写数字')
  before = after; after = before.slice(0, slots[0].start) + before.slice(slots[0].end)
  slots = trackSnippetEdit(slots, before, after, 0)
  assert.equal(snippetError(slots[0], after), '请填写机器 IP')
})
test('visible default placeholders resolve literally once and do not hide required inputs', () => {
  const s = makeActionSnippet(action)
  assert.equal(resolveSnippetDefaults(action, s.text), '在 【机器 IP】 新增 1 个；自动登录 是')
  assert.equal(resolveSnippetDefaults(action, s.text.replace('【数量】', '2').replace('【登录】', '否')), '在 【机器 IP】 新增 2 个；自动登录 否')
  const literal = validateActions([{ id: 'literal', name: '字面值', description: '', template: '{{a}} {{b}}', parameters: [
    { key: 'a', label: 'A (.*)', type: 'text', required: true, default: '【B】 $& {{b}}' },
    { key: 'b', label: 'B', type: 'text', required: true, default: 'end' },
  ] }])[0]
  assert.equal(resolveSnippetDefaults(literal, makeActionSnippet(literal).text), '【B】 $& {{b}} end')
})
test('inactive session, unknown role and an old current pointer cannot provide an Action owner', () => {
  const s = { current: 's2', byId: { s1: { agentPreset: 'browser' }, s2: {} } }
  assert.equal(confirmedActionRole(s, 's1'), null)
  assert.equal(confirmedActionRole(s, 's2'), null)
  assert.equal(confirmedActionRole({ ...s, current: undefined }, 's1'), null)
  assert.equal(confirmedActionRole({ ...s, current: 's1' }, 's1'), 'browser')
  assert.equal(confirmedActionRole({ current: 'blank', byId: { blank: { blank: true, agentPreset: 'browser' } } }, 'blank'), null)
})
test('typing the same delimiter as the template does not merge adjacent placeholders', () => {
  const a = validateActions([{ id: 'echo', name: '回声', description: '', template: '{{first}}_{{second}}', parameters: [
    { key: 'first', label: '目标', type: 'text', required: true }, { key: 'second', label: '新参数', type: 'text', required: true },
  ] }])[0]
  const s = makeActionSnippet(a)
  let before = s.text, slots = s.slots, filled = ''
  for (const c of 'ACTION_NEW') {
    filled += c
    const after = filled + '_【新参数】'
    slots = trackSnippetEdit(slots, before, after, 0); before = after
    assert.equal(after.slice(slots[0].start, slots[0].end), filled)
    assert.equal(after.slice(slots[1].start, slots[1].end), '【新参数】')
  }
})
test('candidate isolation covers roleless/other sessions, explicit new-role selection and stale replies', async t => {
  const oldWindow = globalThis.window
  globalThis.window = new EventTarget() as any
  const cleanups: (() => void)[] = []
  t.after(() => { cleanups.forEach(f => f()); globalThis.window = oldWindow })
  let state: any = { current: 'browser-session', byId: { 'browser-session': { agentPreset: 'browser' }, 'other-session': { agentPreset: 'other' }, 'new-session': {}, 'inherited-blank': { blank: true, agentPreset: 'browser' } } }
  let release: (() => void) | undefined
  const api: any = {
    agents: async () => [{ id: 'browser', name: '浏览器管理员', actionCount: 1, createdAt: '2026-01-01' }, { id: 'other', name: '其他角色' }],
    workflowCatalog: async () => [{ id: 'task', title: '工作流', brief: '' }],
    agentActions: async ({ agentId }: any) => { if (release) await new Promise<void>(r => { release = r }); return { agentId, name: agentId, revision: 'r', actions: agentId === 'browser' ? [action] : [], writable: true } },
  }
  const ctx = { sessions: { list: { getSnapshot: () => state, subscribe: () => () => undefined } }, effect: (fn: () => () => void) => cleanups.push(fn()) }
  const source = agentMentionSource(ctx, async () => api, () => undefined)
  const names = async (sid: string, query = '') => (await source.candidates({ sessionId: sid }, { query })).map(x => x.name)
  assert.ok((await names('browser-session')).includes('新增'))
  state.current = 'other-session'
  assert.ok(!(await names('other-session')).includes('新增'))
  assert.deepEqual(await names('browser-session'), [])
  state.current = 'new-session'
  assert.ok(!(await names('new-session')).includes('新增'))
  assert.ok((await names('new-session', 'browser/')).includes('新增'))
  assert.ok((await names('new-session')).includes('工作流'))
  state.current = 'inherited-blank'
  assert.ok(!(await names('inherited-blank')).includes('新增'), 'Inherited/reused blank is not explicit role consent')
  assert.ok((await names('inherited-blank', 'browser/')).includes('新增'))
  assert.ok(!(await names('inherited-blank')).includes('新增'), 'Clearing the explicit Agent choice must hide Actions again')
  state.current = 'browser-session'; release = () => undefined
  const pending = names('browser-session')
  await new Promise(resolve => setTimeout(resolve, 0))
  state.current = 'other-session'; release!()
  assert.deepEqual(await pending, [])
})

test('reload restores exact edited ranges and progress without storing parameter data', () => {
  const original = makeActionSnippet(action, '@新增 ')
  const text = original.text.replace('【机器 IP】', '192.0.2.1')
  const slots = trackSnippetEdit(original.slots, original.text, text, 0)
  const progress = snippetProgress(text, slots, 0, true)
  assert.ok(!JSON.stringify(progress).includes('192.0.2.1'))
  const restored = restoreSnippet(action, '@新增 ', text, progress)
  assert.equal(restored.current, 0); assert.equal(restored.filling, true)
  assert.deepEqual(restored.slots, slots)
  assert.equal(text.slice(restored.slots[0].start, restored.slots[0].end), '192.0.2.1')
  const complete = snippetProgress(text, slots, 2, false)
  assert.equal(restoreSnippet(action, '@新增 ', text, complete).filling, false)
})

test('legacy or stale metadata restores only actual remaining markers, never guessed field ranges', () => {
  const original = makeActionSnippet(action, '@新增 ')
  const text = original.text.replace('【机器 IP】', '192.0.2.1')
  for (const saved of [undefined, snippetProgress(original.text, original.slots, 0, true)]) {
    const restored = restoreSnippet(action, '@新增 ', text, saved)
    assert.equal(restored.current, 1)
    assert.equal(restored.slots[0].removed, true)
    assert.equal(text.slice(restored.slots[1].start, restored.slots[1].end), '【数量】')
    assert.equal(restored.filling, true)
  }
  const corrupted = { ...snippetProgress(text, original.slots, 0, true), ranges: [null, {}, {}] } as any
  assert.equal(restoreSnippet(action, '@新增 ', text, corrupted).current, 1)
})
