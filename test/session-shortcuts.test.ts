import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SessionShortcuts, shortcutChange } from '../src/session-shortcuts.ts'
import { readFile } from 'node:fs/promises'
import { Script, runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { patchSessionShortcuts } from '../scripts/patch-session-shortcuts.mjs'

test('Session marks are independent, durable, idempotent and never change native tables', () => {
  const db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE original_history(id TEXT PRIMARY KEY); INSERT INTO original_history VALUES ('keep')")
    const store = new SessionShortcuts(db), eligible = new Set(['s1', 's2'])
    const set = (kind: 'pinned' | 'favorite', value: boolean, expected: boolean, at: number) => store.set({ sessionId: 's1', kind, value, expected }, eligible, at)
    set('pinned', true, false, 10); set('favorite', true, false, 11); set('pinned', true, false, 12)
    assert.deepEqual(new SessionShortcuts(db).list(), [{ sessionId: 's1', pinned: true, favorite: true, pinnedAt: 10, favoriteAt: 11 }])
    const reopened = new Database(db.serialize())
    try { assert.deepEqual(new SessionShortcuts(reopened).list(), store.list()) } finally { reopened.close() }
    set('pinned', false, true, 13)
    assert.equal(store.list()[0].favorite, true)
    assert.equal(store.list(new Set(['s1'])).length, 0, 'archived and internal marks stay hidden')
    assert.equal(store.list().length, 1, 'visibility does not delete marks')
    set('favorite', false, true, 14)
    assert.deepEqual(store.list(), [])
    assert.equal(db.prepare('SELECT count(*) n FROM original_history').get().n, 1)
  } finally { db.close() }
})

test('marks reject unknown/internal targets, malformed inputs and stale expected state', () => {
  const db = new Database(':memory:'), store = new SessionShortcuts(db)
  try {
    const change = { sessionId: 's1', kind: 'pinned', value: true, expected: false }
    assert.throws(() => store.set(change, new Set()))
    for (const raw of [null, {}, { ...change, kind: 'deleted' }, { ...change, value: 'true' }, { ...change, sessionId: '../s1' }, { ...change, title: 'not stored' }]) assert.throws(() => shortcutChange(raw))
    store.set(change, new Set(['s1']))
    assert.throws(() => store.set({ ...change, value: false, expected: false }, new Set(['s1'])))
    assert.equal(store.list()[0].pinned, true)
  } finally { db.close() }
})

test('shortcut groups reuse native metadata, exclude archived/internal/subagent/blank/missing sessions and do not move folders', async () => {
  const source = await readFile(new URL('../src/client/session-shortcuts.tsx', import.meta.url), 'utf8')
  const { code } = await transform(source.slice(source.indexOf('export function shortcutRows'), source.indexOf('export function installSessionShortcuts')).replaceAll('export function', 'function'), { loader: 'ts' })
  const shortcutRows = runInNewContext(code + ';shortcutRows')
  const rows = ['visible', 'archived', 'internal', 'child', 'blank', 'missing'].map(sessionId => ({ sessionId, pinned: true, favorite: true, pinnedAt: 1, favoriteAt: 1 }))
  const sessions = { byId: { visible: { displayTitle: 'Original title' }, archived: {}, internal: {}, child: { origin: 'subagent' }, blank: { blank: true } } }
  const workspaces = { archivedSessionIds: ['archived'], internalSessionIds: ['internal'], items: [{ sessionIds: ['visible'] }] }
  const before = JSON.stringify({ sessions, workspaces, rows })
  assert.equal(JSON.stringify(shortcutRows(rows, sessions, workspaces).map((r: any) => r.sessionId)), '["visible"]')
  assert.equal(JSON.stringify({ sessions, workspaces, rows }), before)
})

test('supported native sidebar bridge is additive, syntactically valid, idempotent and fail-closed', async () => {
  const root = process.env.DSH_INSTALL_ROOT ?? '/home/claude/.local/lib/node_modules/@deepseek-ai/dsh'
  const path = `${root}/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
  let source = await readFile(path, 'utf8')
  if (source.includes('dtc:session-shortcuts-v1')) source = await readFile(`${path}.dtc-session-shortcuts-backup`, 'utf8')
  const patched = patchSessionShortcuts(source)
  new Script(patched)
  assert.equal(patchSessionShortcuts(patched), patched)
  assert.ok(patched.includes('if (id === "archive") onArchive(node.id);'))
  assert.ok(patched.includes('archivedSessionIds: undiscoverableSessionIds'))
  assert.throws(() => patchSessionShortcuts(source.replace('const sessionMenuItems = [', 'const changedMenu = [')))
  assert.throws(() => patchSessionShortcuts('/* dtc:session-shortcuts-v1 */'))
})

test('recent sessions span folders, sort actual activity, and preserve hidden-session policy', async () => {
  const source = await readFile(new URL('../src/client/session-shortcuts.tsx', import.meta.url), 'utf8')
  const { code } = await transform(source.slice(source.indexOf('export function shortcutRows'), source.indexOf('export function installSessionShortcuts')).replaceAll('export function', 'function'), { loader: 'ts' })
  const recent = runInNewContext(code + ';recentSessionRows')
  const sessions = { byId: { old: { updatedAt: 1 }, recent: { updatedAt: 20 }, tie: { updatedAt: 20 }, unknown: {}, child: { origin: 'subagent', updatedAt: 50 }, blank: { blank: true, updatedAt: 60 }, archived: { updatedAt: 70 }, internal: { updatedAt: 80 } } }
  const workspaces = { items: [{ id: 'folder-a', sessionIds: ['old'] }, { id: 'folder-b', sessionIds: ['recent'] }], archivedSessionIds: ['archived'], internalSessionIds: ['internal'] }
  const before = JSON.stringify({ sessions, workspaces })
  assert.equal(JSON.stringify(recent(sessions, workspaces).map((r: any) => r.sessionId)), '["recent","tie","old","unknown"]')
  assert.equal(JSON.stringify({ sessions, workspaces }), before)
  sessions.byId.old.updatedAt = 100
  assert.equal(recent(sessions, workspaces)[0].sessionId, 'old')
})

test('client uses narrow RPCs, keeps failed writes honest, and ignores stale refresh responses', async () => {
  const source = await readFile(new URL('../src/client/session-shortcuts.tsx', import.meta.url), 'utf8')
  const snippet = source.slice(source.indexOf('export function shortcutRows'), source.indexOf('\nfunction MarkIcon')).replaceAll('export function', 'function')
  const { code } = await transform(snippet, { loader: 'ts' })
  const win = new EventTarget() as any, doc = new EventTarget() as any
  doc.visibilityState = 'visible'; doc.createElement = () => ({ remove() {} }); doc.head = { append() {} }
  const reads: any[] = [], timers = new Set<unknown>()
  const sessions = { byId: { s1: { displayTitle: 'Existing' } } }
  const ctx = { sessions: { list: { getSnapshot: () => sessions, subscribe: () => () => {} } }, workspaces: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }, slots: { inject() {} } }
  const dispose = runInNewContext(code + ';installSessionShortcuts(ctx)', {
    window: win, document: doc, ctx, Event, AbortController, crypto: { randomUUID: () => 'fixture' }, CSS: '', KEY: '__DSHSessionShortcuts__', EVENT: 'dtc:session-shortcuts', SessionShortcuts() {}, console,
    setInterval: (f: unknown) => { timers.add(f); return f }, clearInterval: (f: unknown) => timers.delete(f), setTimeout: (f: unknown) => { timers.add(f); return f }, clearTimeout: (f: unknown) => timers.delete(f),
    fetch: (url: string, options: any) => new Promise(resolve => reads.push({ url, options, resolve })),
  })
  const bridge = win.__DSHSessionShortcuts__
  const respond = (i: number, rows: any[], ok = true) => reads[i].resolve({ ok, status: ok ? 200 : 503, json: async () => ({ result: { ok: true, value: JSON.stringify(rows) } }) })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  try {
    respond(0, []); await flush()
    assert.equal(bridge.getSnapshot().ready, true)
    const pin = bridge.set('s1', 'pinned', true)
    assert.equal(reads[1].url, '/api/taskConsole/setSessionShortcut')
    assert.deepEqual(JSON.parse(JSON.parse(reads[1].options.body).payload.args.payload), { sessionId: 's1', kind: 'pinned', value: true, expected: false })
    win.dispatchEvent(new Event('focus')); assert.equal(reads.length, 2, 'no competing refresh while saving')
    const pinned = [{ sessionId: 's1', pinned: true, favorite: false, pinnedAt: 10, favoriteAt: 0 }]
    respond(1, pinned); await pin
    const favorite = bridge.set('s1', 'favorite', true); respond(2, [], false); await favorite
    assert.ok(bridge.getSnapshot().error.includes('503'))
    assert.equal(bridge.getSnapshot().rows[0].favorite, false)
    const oldRead = bridge.refresh(), unpin = bridge.set('s1', 'pinned', false)
    respond(4, []); await unpin
    respond(3, pinned); await oldRead
    assert.equal(bridge.getSnapshot().rows.length, 0, 'late refresh cannot revive a removed pin')
    assert.ok(reads.every(r => r.url.startsWith('/api/taskConsole/') && !r.url.includes('session.prompt')))
  } finally { dispose() }
  assert.equal(timers.size, 0)
  assert.equal(win.__DSHSessionShortcuts__, undefined)
})
