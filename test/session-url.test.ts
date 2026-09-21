import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transform } from 'esbuild'

test('opening a session URL consumes the request before synchronous list notifications', async () => {
  const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function installSessionUrlSync'), source.indexOf('\nfunction useHeavy'))
  const { code } = await transform(fn, { loader: 'ts' })
  const listeners = new Set<() => void>()
  const snapshot = { current: undefined as string | undefined, byId: { selected: {} }, ids: ['selected'] }
  let opened = 0
  const ctx = {
    sessions: { list: { getSnapshot: () => snapshot, subscribe: (f: () => void) => { listeners.add(f); return () => listeners.delete(f) } },
      open: (id: string) => { opened++; assert.ok(opened < 3, 'recursive session open'); snapshot.current = id; for (const f of listeners) f() } },
    workspaces: { list: { getSnapshot: () => ({}), subscribe: () => () => undefined } },
  }
  const scope = vm.createContext({ ctx, URL, HASH_PREFIX: '#/tc', window: { location: { href: 'https://dsh.example/?session=selected', hash: '' }, addEventListener() {}, removeEventListener() {} }, history: { replaceState() {} }, document: { title: '' } })
  vm.runInContext(code + '\ninstallSessionUrlSync(ctx)', scope)
  assert.equal(opened, 1)
  assert.equal(snapshot.current, 'selected')
})

test('history traversal re-notifies Agent route readers and restores the addressed native session', async () => {
  const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function installSessionUrlSync'), source.indexOf('\nfunction useHeavy'))
  const { code } = await transform(fn, { loader: 'ts' })
  const listeners = new Map<string, Set<() => void>>()
  const snapshot = { current: 'first', byId: { first: {}, second: {} }, ids: ['first', 'second'] }
  let routeEvents = 0
  const location = { href: 'https://dsh.example/?session=first', hash: '' }
  const win = { location,
    addEventListener: (k: string, f: () => void) => { const set = listeners.get(k) ?? new Set(); set.add(f); listeners.set(k, set) },
    removeEventListener: (k: string, f: () => void) => listeners.get(k)?.delete(f),
    dispatchEvent: (e: { type: string }) => { if (e.type === 'hashchange') routeEvents++; for (const fn of listeners.get(e.type) ?? []) fn() },
  }
  const ctx = {
    sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined }, open: (id: string) => { snapshot.current = id } },
    workspaces: { list: { getSnapshot: () => ({}), subscribe: () => () => undefined } },
  }
  const scope = vm.createContext({ ctx, URL, HASH_PREFIX: '#/tc', window: win, HashChangeEvent: class { constructor(public type: string) {} }, history: { replaceState() {} }, document: { title: '' } })
  vm.runInContext(code + '\nconst dispose=installSessionUrlSync(ctx)', scope)
  location.href = 'https://dsh.example/#/tc/agents/worker?tab=sessions&page=2'; location.hash = '#/tc/agents/worker?tab=sessions&page=2'
  win.dispatchEvent({ type: 'popstate' })
  assert.equal(routeEvents, 1)
  location.href = 'https://dsh.example/?session=second'; location.hash = ''
  win.dispatchEvent({ type: 'popstate' })
  assert.equal(snapshot.current, 'second')
  vm.runInContext('dispose()', scope)
  assert.equal(listeners.get('popstate')?.size, 0)
})
