import test from 'node:test'
import assert from 'node:assert/strict'
import { agentMentionSource } from '../src/client/agent-mentions.ts'
import { makeActionSnippet } from '../src/action-snippet.ts'
import { validateActions } from '../src/agent-actions.ts'

test('draft hydration and edits supersede pending recovery without dropping the latest revision', async t => {
  const names = ['window', 'document', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame'] as const
  const globals = new Map(names.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const storage = new Map<string, string>(), cleanups: (() => void)[] = []
  const document = new EventTarget() as any; document.querySelectorAll = () => []
  const install = (k: string, value: any) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value })
  install('window', new EventTarget()); install('document', document)
  install('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  install('requestAnimationFrame', () => 1); install('cancelAnimationFrame', () => {})
  t.after(() => { cleanups.forEach(f => f()); for (const [k, d] of globals) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k] } })
  const action = validateActions([{ id: 'echo', name: '回声', description: '', template: '{{ip}} {{count}}', parameters: [
    { key: 'ip', label: 'IP', type: 'text', required: true }, { key: 'count', label: '数量', type: 'number', required: true },
  ] }])[0]
  const native = { current: 's', byId: { s: { agentPreset: 'browser', blank: false } } }
  let state = { draft: '', draftRev: 0, phase: 'plain' }, calls = 0
  const listeners = new Set<() => void>(), claims: any[] = []
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const f of listeners) f() }
  const input = { state: { getSnapshot: () => state, subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } } }, notify: () => {}, setDraft: (draft: string) => publish({ draft, draftRev: state.draftRev + 1 }) }
  const scope: any = { bail: (_scope: any, _event: string, request: any) => { claims.push(request); publish({ phase: 'claimed', draftRev: state.draftRev + 1 }); return true } }
  const ctx: any = {
    get: () => ({ input: { for: () => input } }), effect: (fn: () => () => void) => cleanups.push(fn()),
    sessions: { list: { getSnapshot: () => native, subscribe: () => () => {} }, scope: () => scope },
  }
  let release!: () => void
  const pending = new Promise<void>(r => { release = r })
  const api: any = {
    agents: async () => [{ id: 'browser', name: 'Browser', actionCount: 1 }], workflowCatalog: async () => [],
    agentActions: async () => { if (++calls === 1) await pending; return { agentId: 'browser', name: 'Browser', actions: [action], revision: 'r1' } },
  }
  const source = agentMentionSource(ctx, async () => api, () => {})
  const tick = () => new Promise(r => setTimeout(r, 0))
  source.warm({ sessionId: 's' }); await tick()
  assert.equal(calls, 0, 'An empty shell before native hydration must not start a lookup')
  const original = makeActionSnippet(action, '@回声 ').text
  input.setDraft(original); await tick(); assert.equal(calls, 1)
  input.setDraft(original.replace('【IP】', '192.0.2.1')); await tick()
  release(); await tick(); await tick()
  assert.equal(calls, 2, 'The revision that arrived during the old lookup needs a new recovery')
  assert.equal(claims.length, 1); assert.equal(claims[0].span.draftRev, 2)
  assert.equal(state.phase, 'claimed'); assert.equal(state.draft, '@回声 192.0.2.1 【数量】')
  assert.ok(!storage.get('dtc:action-draft:s')?.includes('192.0.2.1'), 'Recovery metadata copied prompt values')
})
