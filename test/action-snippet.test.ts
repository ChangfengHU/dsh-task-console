import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmedActionRole, makeActionSnippet, snippetError, trackSnippetEdit } from '../src/action-snippet.ts'
import { agentMentionSource } from '../src/client/agent-mentions.ts'
import { validateActions } from '../src/agent-actions.ts'

const action = validateActions([{ id: 'create', name: '新增', description: '', template: '在 {{ip}} 新增 {{count}} 个；自动登录 {{login}}', parameters: [
  { key: 'ip', label: '机器 IP', type: 'text', required: true },
  { key: 'count', label: '数量', type: 'number', required: true, default: 1 },
  { key: 'login', label: '登录', type: 'boolean', required: true, default: true },
] }])[0]
test('snippet slots include editable defaults and exact selections, no evaluation', () => {
  const s = makeActionSnippet(action, '@新增 ')
  assert.equal(s.text, '@新增 在 【机器 IP】 新增 1 个；自动登录 是')
  assert.deepEqual(s.slots.map(p => s.text.slice(p.start, p.end)), ['【机器 IP】', '1', '是'])
  assert.equal(snippetError(s.slots[0], s.text), '请填写机器 IP')
  assert.equal(snippetError(s.slots[1], s.text), null)
})
test('typed replacement, continued typing, defaults and shifts stay attached to their fields', () => {
  const s = makeActionSnippet(action, '@新增 ')
  let before = s.text, after = before.replace('【机器 IP】', '192.0.2.1')
  let slots = trackSnippetEdit(s.slots, before, after, 0)
  assert.equal(after.slice(slots[0].start, slots[0].end), '192.0.2.1')
  assert.equal(after.slice(slots[1].start, slots[1].end), '1')
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
test('inactive session, unknown role and an old current pointer cannot provide an Action owner', () => {
  const s = { current: 's2', byId: { s1: { agentPreset: 'browser' }, s2: {} } }
  assert.equal(confirmedActionRole(s, 's1'), null)
  assert.equal(confirmedActionRole(s, 's2'), null)
  assert.equal(confirmedActionRole({ ...s, current: undefined }, 's1'), null)
  assert.equal(confirmedActionRole({ ...s, current: 's1' }, 's1'), 'browser')
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
  let state: any = { current: 'browser-session', byId: { 'browser-session': { agentPreset: 'browser' }, 'other-session': { agentPreset: 'other' }, 'new-session': {} } }
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
  state.current = 'browser-session'; release = () => undefined
  const pending = names('browser-session')
  await new Promise(resolve => setTimeout(resolve, 0))
  state.current = 'other-session'; release!()
  assert.deepEqual(await pending, [])
})
