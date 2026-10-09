import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'

test('lazy script route is registered before service recovery and never caches error responses', async () => {
  let rejectReady!: (error: Error) => void, enter!: () => void, route: any
  const ready = new Promise<void>((_, reject) => { rejectReady = reject })
  const entered = new Promise<void>(resolve => { enter = resolve })
  const ctx: any = {
    effect: (fn: () => unknown) => fn(),
    webServer: { register: (value: any) => { route = value; return () => {} } },
    plugin: async () => { enter() },
    get: () => ({ ready }),
  }
  const applying = apply(ctx)
  try {
    await entered
    assert.equal(route?.path, '/dsh-task-console/client-heavy.js')
    let status: number | undefined, headers: any, ended = false
    const response = {writeHead: (code: number, value: any) => {status = code; headers = value},end: () => {ended = true}}
    await route.handler({method:'POST'},response)
    assert.equal(status,405); assert.equal(headers['cache-control'],'no-store'); assert.equal(ended,true)
    // Source checkout deliberately has no compiled src/client-heavy.js.
    await route.handler({method:'GET'},response)
    assert.equal(status,404); assert.equal(headers['cache-control'],'no-store')
  } finally {
    rejectReady(new Error('fixture recovery stopped'))
    await assert.rejects(applying,/fixture recovery stopped/)
  }
})
