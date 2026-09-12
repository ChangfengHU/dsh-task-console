import type { AgentAction } from '../agent-actions.ts'
import { makeActionSnippet, snippetError, trackSnippetEdit } from '../action-snippet.ts'

/** Session-owned native input bridge. DOM is used only for focus/selection, never draft writes. */
export function installActionSnippet(ctx: any, sessionId: string, action: AgentAction, prefix: string, input: any) {
  const original = makeActionSnippet(action, prefix)
  original.text = input.state.getSnapshot().draft
  let slots = original.slots, previous = original.text, current = 0, filling = slots.length > 0
  let live = true
  let compositionUntil = 0
  const active = () => live && ctx.sessions.list.getSnapshot().current === sessionId && input.state.getSnapshot().draft.startsWith(prefix)
  const field = () => [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-phase]')].find(el => !el.disabled && el.getClientRects().length && el.value === input.state.getSnapshot().draft)
  const select = (index: number) => {
    if (!active()) return
    const el = field(), slot = slots[index]
    if (!el || !slot || slot.removed) return
    current = index; filling = true; el.focus(); el.setSelectionRange(slot.start, slot.end)
    input.notify('info', `${slot.label} · Enter / Tab 下一项，Shift+Tab 上一项；填完后再确认发送`)
  }
  const error = () => {
    const text = input.state.getSnapshot().draft
    if (!text.startsWith(prefix)) return null
    for (const slot of slots) { const e = snippetError(slot, text); if (e) return e }
    if (original.slots.some(s => text.includes(s.marker))) return '还有占位符未填写'
    return null
  }
  const off = input.state.subscribe(() => {
    const text = input.state.getSnapshot().draft
    if (text === previous) return
    if (text === original.text) { slots = original.slots; current = 0; filling = !!slots.length }
    else if (text.startsWith(prefix) && previous.startsWith(prefix)) slots = trackSnippetEdit(slots, previous, text, current)
    else { slots = slots.map(s => ({ ...s, removed: true })); filling = false }
    previous = text
  })
  const key = (event: KeyboardEvent) => {
    if (!active() || event.isComposing || event.keyCode === 229 || Date.now() <= compositionUntil || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key === 'Enter')) return
    const el = field()
    if (event.target !== el || !el || !['Enter', 'Tab'].includes(event.key)) return
    if (!filling) {
      const first = slots.findIndex(s => snippetError(s, el.value))
      if (first < 0) return
      event.preventDefault(); event.stopImmediatePropagation(); select(first); return
    }
    event.preventDefault(); event.stopImmediatePropagation()
    // Honour a mouse selection of an earlier placeholder as well as our last jump.
    const at = slots.findIndex(s => !s.removed && el.selectionStart >= s.start && el.selectionEnd <= s.end)
    if (at >= 0) current = at
    if (!event.shiftKey) {
      const message = slots[current] && snippetError(slots[current], el.value)
      if (message) { input.notify('error', message); select(current); return }
    }
    const direction = event.shiftKey ? -1 : 1
    let next = current + direction
    while (next >= 0 && next < slots.length && slots[next].removed) next += direction
    if (next >= 0 && next < slots.length) { select(next); return }
    if (event.shiftKey) { select(current); return }
    const incomplete = slots.findIndex(s => snippetError(s, el.value))
    if (incomplete >= 0) { select(incomplete); return }
    filling = false; el.setSelectionRange(el.value.length, el.value.length)
    input.notify('info', '占位符已填写。可继续修改提示词，再按 Enter 或点击发送。')
  }
  document.addEventListener('keydown', key, true)
  const compositionStart = (e: Event) => { if (e.target === field()) compositionUntil = Infinity }
  const compositionEnd = (e: Event) => { if (e.target === field()) compositionUntil = Date.now() + 20 }
  document.addEventListener('compositionstart', compositionStart, true)
  document.addEventListener('compositionend', compositionEnd, true)
  const frame = requestAnimationFrame(() => requestAnimationFrame(() => { if (slots.length) select(0); else if (active()) input.notify('info', '提示词已填入，可修改后发送。') }))
  return { error, dispose: () => { live = false; off(); cancelAnimationFrame(frame); document.removeEventListener('keydown', key, true); document.removeEventListener('compositionstart', compositionStart, true); document.removeEventListener('compositionend', compositionEnd, true) } }
}
