import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskConsoleService } from '../src/service.ts'
import { fold } from '../src/fold.ts'

test('history reads lightweight headers and page-only cached titles, never loads transcripts or activates agents', async () => {
  const headers = Array.from({ length: 23 }, (_, i) => ({ id: `s-${i}`, agentPreset: 'worker', createdAt: 1700000000000 + i }))
  let lists = 0, cached = 0
  const services: Record<string, unknown> = {
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: {
      list: async () => { lists++; return headers },
      inspect: () => assert.fail('no full log'), load: () => assert.fail('no activation'), readFrom: () => assert.fail('no tail replay'),
    },
    sessionProjectionCache: { cachedSnapshot: () => { cached++; return { values: { title: 'Saved title' } } } },
  }
  const ctx = {
    // Cordis forbids un-injected property access; optional services use ctx.get.
    get sessions() { throw new Error('sessions accessed without injection') },
    agents: { get: () => undefined },
    get: (name: string) => services[name],
  }
  const service = Object.create(TaskConsoleService.prototype)
  Object.defineProperty(service, 'ctx', { value: ctx })
  service.runner = { store: { s: fold([]) } }
  service.ready = Promise.resolve()
  const page = JSON.parse(await service.agentHistory(JSON.stringify({ agentId: 'worker', kind: 'sessions', page: 2 })))
  assert.equal(page.total, 23); assert.equal(page.sessions.length, 10)
  assert.equal(page.sessions[0].title, 'Saved title')
  assert.equal(cached, 10); assert.equal(lists, 1)
  await service.agentHistory(JSON.stringify({ agentId: 'worker', kind: 'tasks' }))
  assert.equal(cached, 10); assert.equal(lists, 1)
})

test('missing optional title cache falls back honestly; failed header index is retryable, not an empty success', async () => {
  let attempts = 0
  const service = Object.create(TaskConsoleService.prototype)
  Object.defineProperty(service, 'ctx', { value: { agents: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? { list: async () => {
    if (++attempts === 1) throw new Error('index unavailable')
    return [{ id: 's', agentPreset: 'worker', createdAt: 1700000000000 }]
  } } : undefined } })
  service.ready = Promise.resolve(); service.runner = { store: { s: fold([]) } }
  const payload = JSON.stringify({ agentId: 'worker', kind: 'sessions' })
  await assert.rejects(service.agentHistory(payload), /index unavailable/)
  const page = JSON.parse(await service.agentHistory(payload))
  assert.equal(page.sessions[0].title, 'worker · 会话')
  assert.equal(attempts, 2)
})
