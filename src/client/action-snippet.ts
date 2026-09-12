import type { AgentAction } from '../agent-actions.ts'
import { makeActionSnippet, restoreSnippet, snippetDefault, snippetError, snippetProgress, trackSnippetEdit, type SnippetProgress } from '../action-snippet.ts'

/** Session-owned native input bridge. DOM is used only for focus/selection, never draft writes. */
export function installActionSnippet(ctx: any, sessionId: string, action: AgentAction, prefix: string, input: any, options: { restored?: boolean; saved?: SnippetProgress; save?: (progress: SnippetProgress | null) => void } = {}) {
  const original = makeActionSnippet(action, prefix)
  const text = input.state.getSnapshot().draft
  const restored = options.restored ? restoreSnippet(action, prefix, text, options.saved) : { slots: original.slots, current: 0, filling: original.slots.length > 0 }
  let { slots, current, filling } = restored, previous = text
  let live = true
  let compositionUntil = 0
  const save = () => options.save?.(previous.startsWith(prefix) ? snippetProgress(previous, slots, current, filling) : null)
  const active = () => live && ctx.sessions.list.getSnapshot().current === sessionId && input.state.getSnapshot().draft.startsWith(prefix)
  const field = () => [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-phase]')].find(el => !el.disabled && el.getClientRects().length && el.value === input.state.getSnapshot().draft)
  const select = (index: number) => {
    if (!active()) return
    const slot = slots[index]
    if (!slot || slot.removed) return
    current = index; filling = true; save()
    const focus = () => { if (!active() || current !== index) return; const el = field(); if (el) { el.focus(); el.setSelectionRange(slots[index].start, slots[index].end) } }
    if (field()) focus(); else requestAnimationFrame(focus)
    const value = snippetDefault(slot.parameter)
    input.notify('info', `${index + 1}/${slots.length} · ${slot.label}${value === undefined ? '' : `（默认：${value}）`} · Enter / Tab ${value === undefined ? '' : '接受默认并'}下一项，Shift+Tab 上一项；填完后再确认发送`)
  }
  const error = () => {
    const text = input.state.getSnapshot().draft
    if (!text.startsWith(prefix)) return null
    for (const slot of slots) { const e = snippetError(slot, text); if (e) return e }
    if (original.slots.some(s => s.parameter.default === undefined && text.includes(s.marker))) return '还有占位符未填写'
    return null
  }
  const off = input.state.subscribe(() => {
    const text = input.state.getSnapshot().draft
    if (text === previous) return
    if (text === original.text) { slots = original.slots; current = 0; filling = !!slots.length }
    else if (text.startsWith(prefix) && previous.startsWith(prefix)) slots = trackSnippetEdit(slots, previous, text, current)
    else { slots = slots.map(s => ({ ...s, removed: true })); filling = false }
    previous = text
    save()
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
      const slot = slots[current], value = slot && snippetDefault(slot.parameter)
      if (slot && !slot.removed && value !== undefined && el.value.slice(slot.start, slot.end) === slot.marker) {
        input.setDraft(el.value.slice(0, slot.start) + value + el.value.slice(slot.end))
      }
    }
    const direction = event.shiftKey ? -1 : 1
    let next = current + direction
    while (next >= 0 && next < slots.length && slots[next].removed) next += direction
    if (next >= 0 && next < slots.length) { select(next); return }
    if (event.shiftKey) { select(current); return }
    const incomplete = slots.findIndex(s => snippetError(s, input.state.getSnapshot().draft))
    if (incomplete >= 0) { select(incomplete); return }
    filling = false
    save()
    requestAnimationFrame(() => { const currentField = field(); if (active() && !filling && currentField) currentField.setSelectionRange(currentField.value.length, currentField.value.length) })
    input.notify('info', '占位符已填写。可继续修改提示词，再按 Enter 或点击发送。')
  }
  document.addEventListener('keydown', key, true)
  let composing: EventTarget | null = null
  const compositionStart = (e: Event) => { if (e.target === field()) { composing = e.target; compositionUntil = Infinity } }
  const compositionEnd = (e: Event) => { if (e.target === composing) { composing = null; compositionUntil = Date.now() + 20 } }
  document.addEventListener('compositionstart', compositionStart, true)
  document.addEventListener('compositionend', compositionEnd, true)
  save()
  const frame = requestAnimationFrame(() => requestAnimationFrame(() => { if (filling) select(current); else if (active()) input.notify('info', '提示词已填入，可修改后发送。') }))
  return { error, active, dispose: () => { live = false; off(); cancelAnimationFrame(frame); document.removeEventListener('keydown', key, true); document.removeEventListener('compositionstart', compositionStart, true); document.removeEventListener('compositionend', compositionEnd, true) } }
}
