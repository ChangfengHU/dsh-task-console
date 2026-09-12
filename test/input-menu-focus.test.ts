import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { patchActionSubmit, patchInputMenu } from '../scripts/patch-input-menu.mjs'

test('menu focus patch rejects unknown/partial hosts and is idempotent', () => {
  assert.throws(() => patchInputMenu('unknown'), /Unsupported/)
  assert.throws(() => patchInputMenu('dtcMenuFocusMoved'), /Incomplete/)
  const minimal = [
    'const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);',
    'const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);',
    'if (hl && next.source === hl.source && next.index === hl.index) return state;',
    'highlight: next\n',
  ].join('\n')
  const patched = patchInputMenu(minimal)
  assert.equal(patchInputMenu(patched), patched)
  assert.match(patched, /dtcMenuFocusMoved: true/)
})

test('Action submit patch is version anchored and idempotent', () => {
  assert.throws(() => patchActionSubmit('unknown'), /Unsupported/)
  assert.throws(() => patchActionSubmit('dtcActionAdjudication'), /Incomplete/)
  const patched = patchActionSubmit('if (trimmed.startsWith("/")) {')
  assert.equal(patchActionSubmit(patched), patched)
})

test('native input machine adjudicates restored @ for keyboard AND Send, only with plugin active', { skip: !process.env.DSH_INSTALL_ROOT }, async () => {
  const file = join(process.env.DSH_INSTALL_ROOT!, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
  const source = patchActionSubmit(await readFile(file, 'utf8'))
  const start = source.indexOf('//#region lib/types/client/input/machine.js'), end = source.indexOf('//#endregion', start)
  assert.ok(start > 0 && end > start)
  let active = true
  const { InputMachine } = runInNewContext(source.slice(start, end) + '\n({InputMachine})', { AbortController, document: { documentElement: { hasAttribute: () => active } } })
  const enter = (draft: string) => {
    const machine = new InputMachine()
    machine.dispatch({ type: 'draft-changed', draft })
    return machine.dispatch({ type: 'enter', mode: 'queue' })[0].type
  }
  assert.equal(enter('@新增浏览器 IP 【数量】'), 'adjudicate')
  assert.equal(enter('/help'), 'adjudicate')
  assert.equal(enter('ordinary message'), 'default-sink')
  active = false
  assert.equal(enter('@ordinary mention'), 'default-sink')
})

// Exercise the actual supported host's pure reducer, not a second implementation.
test('native reducer: ready order, user movement, search reset, errors and stale replies', { skip: !process.env.DSH_INSTALL_ROOT }, async () => {
  const file = join(process.env.DSH_INSTALL_ROOT!, 'node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js')
  const source = patchInputMenu(await readFile(file, 'utf8'))
  const start = source.indexOf('//#region lib/types/core/menu.js'), end = source.indexOf('//#endregion', start)
  assert.ok(start > 0 && end > start)
  const { seedGroups, menuReduce } = runInNewContext(source.slice(start, end) + '\n({seedGroups, menuReduce})')
  const hit = { query: '', trigger: '@', position: 'leading' }
  const fresh = () => menuReduce(seedGroups({ generation: 0, open: false }, [{ name: 'Agent' }, { name: 'reference' }]), { type: 'hit', hit })
  const settle = (s: any, source: string, count = 2) => menuReduce(s, { type: 'source-settled', generation: s.generation, source, items: Array(count).fill({ name: source }) })
  const focus = (s: any) => s.highlight && `${s.highlight.source}:${s.highlight.index}`
  let s = settle(fresh(), 'reference')
  assert.equal(focus(s), 'reference:0')
  s = settle(s, 'Agent')
  assert.equal(focus(s), 'Agent:0')
  s = menuReduce(s, { type: 'move', dir: 1 }); assert.equal(focus(s), 'Agent:1')
  s = menuReduce(s, { type: 'move', dir: 1 }); assert.equal(focus(s), 'reference:0')
  s = menuReduce(s, { type: 'move', dir: -1 }); assert.equal(focus(s), 'Agent:1')
  s = settle(fresh(), 'reference')
  s = menuReduce(s, { type: 'move', dir: 1 })
  assert.equal(focus(settle(s, 'Agent')), 'reference:1', 'Late results stole explicit keyboard selection')
  s = menuReduce(s, { type: 'hit', hit: { ...hit, query: 'new' } })
  s = settle(settle(s, 'reference'), 'Agent'); assert.equal(focus(s), 'Agent:0')
  const stale = menuReduce(s, { type: 'source-settled', generation: s.generation - 1, source: 'Agent', items: [] })
  assert.equal(stale, s)
  s = menuReduce(s, { type: 'source-failed', generation: s.generation, source: 'Agent' }); assert.equal(focus(s), 'reference:0')
  assert.equal(focus(settle(settle(fresh(), 'Agent'), 'reference')), 'Agent:0')
  assert.equal(focus(settle(settle(fresh(), 'Agent', 0), 'reference')), 'reference:0')
  s = settle(fresh(), 'reference', 1); s = menuReduce(s, { type: 'move', dir: 1 })
  assert.equal(focus(settle(s, 'Agent')), 'reference:0', 'Single-item navigation must also count as explicit')
})
