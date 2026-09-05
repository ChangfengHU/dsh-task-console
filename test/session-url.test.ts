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
