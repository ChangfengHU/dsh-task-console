import { parameterVisible, type AgentAction } from '../agent-actions.ts'
import { makeActionSnippet, restoreSnippet, snippetDefault, snippetError, snippetProgress, trackSnippetEdit, reconcileSnippet, snippetValues, type SnippetProgress } from '../action-snippet.ts'
import { optionPage, type ActionOptionPage } from '../action-options.ts'
import { actionOptionPopup } from './action-options.ts'

/** Session-owned native input bridge. DOM is used only for focus/selection, never draft writes. */
export function installActionSnippet(ctx: any, sessionId: string, action: AgentAction, prefix: string, input: any, options: { restored?: boolean; saved?: SnippetProgress; save?: (progress: SnippetProgress | null) => void; isCurrentRole?: () => boolean; candidates?: (parameter: string, values: Record<string, string>, search: string, page: number) => Promise<ActionOptionPage> } = {}) {
  const original = makeActionSnippet(action, prefix)
  const text = input.state.getSnapshot().draft
  const restored = options.restored ? restoreSnippet(action, prefix, text, options.saved) : { slots: original.slots, current: 0, filling: original.slots.length > 0 }
  let { slots, current, filling } = restored, previous = text
  if (options.restored && Array.isArray(options.saved?.edited) && options.saved.edited.length) {
    const before = snippetValues(slots, text)
    for (const index of options.saved.edited) { const slot = slots[index]; if (slot) before[slot.key] = '\0changed-before-catalog' }
    const reconciled = reconcileSnippet(slots, text, before)
    slots = reconciled.slots; previous = reconciled.text
    if (previous !== text) input.setDraft(previous)
  }
  let live = true
  let focusFrame = 0, focusEpoch = 0
  let compositionUntil = 0
  const save = () => options.save?.(previous.startsWith(prefix) ? snippetProgress(previous, slots, current, filling) : null)
  const active = () => live && ctx.sessions.list.getSnapshot().current === sessionId && options.isCurrentRole?.() !== false && input.state.getSnapshot().draft.startsWith(prefix)
  const field = () => [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-phase]')].find(el => !el.disabled && el.getClientRects().length && el.value === input.state.getSnapshot().draft)
  let candidateEpoch = 0, timer: ReturnType<typeof setTimeout> | undefined
  let filtering = false
  const popup = actionOptionPopup(field, value => { if (active()) { replace(value); advance(false) } }, page => { void showCandidates(page, filtering) })
  const cancelCandidates = () => { candidateEpoch++; clearTimeout(timer); popup.hide() }
  const showCandidates = async (page = 1, filter = false) => {
    clearTimeout(timer)
    const slot = slots[current], epoch = ++candidateEpoch, draft = input.state.getSnapshot().draft
    if (!active() || !filling || !slot || slot.removed || slot.inactive || !slot.parameter.source && !slot.parameter.choices) { popup.hide(); return }
    filtering = filter
    const raw = draft.slice(slot.start, slot.end), search = !filter || raw === slot.marker ? '' : raw.trim()
    const initial = optionPage((slot.parameter.choices ?? []).map(value => ({ value, label: value })), search, page)
    popup.show(slot.label, initial, slot.parameter.source ? '正在读取候选…' : '')
    if (!slot.parameter.source) return
    try {
      if (!options.candidates) throw Error('候选来源暂不可用')
      const result = await options.candidates(slot.key, snippetValues(slots, draft), search, page)
      if (epoch === candidateEpoch && active() && filling && input.state.getSnapshot().draft === draft) popup.show(slot.label, result)
    } catch (e) {
      if (epoch === candidateEpoch && active() && input.state.getSnapshot().draft === draft) popup.show(slot.label, optionPage([]), (e as Error).message)
    }
  }
  const queueCandidates = () => { cancelCandidates(); if (active() && filling) timer = setTimeout(() => { void showCandidates(1, true) }, 180) }
  const replace = (value: string) => {
    const slot = slots[current], draft = input.state.getSnapshot().draft
    if (slot && !slot.removed && !slot.inactive) input.setDraft(draft.slice(0, slot.start) + value + draft.slice(slot.end))
  }
  const select = (index: number) => {
    if (!active()) return
    const slot = slots[index]
    if (!slot || slot.removed || slot.inactive) return
    current = index; filling = true; save()
    cancelCandidates()
    const epoch = ++focusEpoch
    cancelAnimationFrame(focusFrame)
    const focus = (attempt = 0) => {
      if (epoch !== focusEpoch || !active() || !filling || current !== index) return
      const el = field()
      if (el) {
        el.focus(); el.setSelectionRange(slots[index].start, slots[index].end)
        // Choices must mount against the same native revision as the selection.
        // In particular, accepting a default changes the draft before React paints.
        void showCandidates()
      }
      else if (attempt < 30) focusFrame = requestAnimationFrame(() => focus(attempt + 1))
    }
    // Native setDraft may commit after the next frame, particularly following a
    // dependent-field reset. Wait for the matching DOM revision, not a one-shot
    // frame; typing or a newer selection cancels this request.
    focusFrame = requestAnimationFrame(() => focus())
    const value = snippetDefault(slot.parameter)
    const visible = slots.filter(s => !s.removed && !s.inactive)
    input.notify('info', `${visible.indexOf(slot) + 1}/${visible.length} · ${slot.label}${value === undefined ? '' : `（默认：${value}${slot.parameter.acceptDefaultOnEnter === false ? '，需明确填写' : ''}）`} · Enter / Tab ${value === undefined || slot.parameter.acceptDefaultOnEnter === false ? '' : '接受默认并'}下一项，Shift+Tab 上一项；填完后再确认发送`)
  }
  const error = () => {
    const text = input.state.getSnapshot().draft
    if (!text.startsWith(prefix)) return null
    const values = snippetValues(slots, text)
    for (const slot of slots) {
      const p = slot.parameter, conditionUnknown = !!p.visibleWhen && !Object.hasOwn(values, p.visibleWhen.key)
      const parents = [...(p.dependsOn ?? []), ...(p.visibleWhen ? [p.visibleWhen.key] : [])]
      if (parents.length && (conditionUnknown || parameterVisible(p, values)) && (slot.removed || parents.some(k => !Object.hasOwn(values, k)))) return '联动字段的草稿位置已丢失，请重新选择此 Action；原文保留'
    }
    for (const slot of slots) { const e = snippetError(slot, text); if (e) return e }
    if (original.slots.some(s => (s.parameter.default === undefined || s.parameter.acceptDefaultOnEnter === false) && text.includes(s.marker))) return '还有占位符未填写'
    return null
  }
  const off = input.state.subscribe(() => {
    const text = input.state.getSnapshot().draft
    if (text === previous) return
    focusEpoch++; cancelAnimationFrame(focusFrame)
    if (text === original.text) { slots = original.slots; current = 0; filling = !!slots.length }
    else if (text.startsWith(prefix) && previous.startsWith(prefix)) {
      const before = snippetValues(slots, previous)
      const reconciled = reconcileSnippet(trackSnippetEdit(slots, previous, text, current), text, before)
      slots = reconciled.slots
      if (reconciled.text !== text) { previous = reconciled.text; input.setDraft(reconciled.text); save(); queueCandidates(); return }
    }
    else { slots = slots.map(s => ({ ...s, removed: true })); filling = false }
    previous = text
    save()
    queueCandidates()
  })
  const advance = (back: boolean) => {
    const direction = back ? -1 : 1
    let next = current + direction
    while (next >= 0 && next < slots.length && (slots[next].removed || slots[next].inactive)) next += direction
    if (next >= 0 && next < slots.length) { select(next); return }
    if (back) { select(current); return }
    const incomplete = slots.findIndex(s => snippetError(s, input.state.getSnapshot().draft))
    if (incomplete >= 0) { select(incomplete); return }
    filling = false; cancelCandidates(); save()
    requestAnimationFrame(() => { const el = field(); if (active() && !filling && el) el.setSelectionRange(el.value.length, el.value.length) })
    input.notify('info', '占位符已填写。可继续修改提示词，再按 Enter 或点击发送。')
  }
  const key = (event: KeyboardEvent) => {
    if (!active() || event.isComposing || event.keyCode === 229 || Date.now() <= compositionUntil || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key === 'Enter')) return
    const el = field()
    if (event.target !== el || !el) return
    if (event.key === 'Escape' && popup.visible()) { event.preventDefault(); event.stopImmediatePropagation(); cancelCandidates(); return }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && filling && popup.visible()) { event.preventDefault(); event.stopImmediatePropagation(); popup.move(event.key === 'ArrowDown' ? 1 : -1); return }
    if (!['Enter', 'Tab'].includes(event.key)) return
    if (!filling) {
      const first = slots.findIndex(s => snippetError(s, el.value))
      if (first < 0) return
      event.preventDefault(); event.stopImmediatePropagation(); select(first); return
    }
    event.preventDefault(); event.stopImmediatePropagation()
    // Honour a mouse selection of an earlier placeholder as well as our last jump.
    const at = slots.findIndex(s => !s.removed && !s.inactive && el.selectionStart >= s.start && el.selectionEnd <= s.end)
    if (at >= 0) current = at
    if (!event.shiftKey) {
      const choice = popup.selected()
      if (choice !== undefined) { replace(choice); advance(false); return }
      const message = slots[current] && snippetError(slots[current], el.value)
      if (message) { input.notify('error', message); select(current); return }
      const slot = slots[current], value = slot && snippetDefault(slot.parameter)
      if (slot && !slot.removed && value !== undefined && el.value.slice(slot.start, slot.end) === slot.marker) {
        input.setDraft(el.value.slice(0, slot.start) + value + el.value.slice(slot.end))
      }
    }
    advance(event.shiftKey)
  }
  document.addEventListener('keydown', key, true)
  let composing: EventTarget | null = null
  const compositionStart = (e: Event) => { if (e.target === field()) { composing = e.target; compositionUntil = Infinity } }
  const compositionEnd = (e: Event) => { if (e.target === composing) { composing = null; compositionUntil = Date.now() + 20 } }
  document.addEventListener('compositionstart', compositionStart, true)
  document.addEventListener('compositionend', compositionEnd, true)
  const clicked = (e: Event) => {
    const el = field()
    if (!active() || e.target !== el || !el) { if (!(e.target as Element)?.closest?.('.dtc-action-options')) cancelCandidates(); return }
    const index = slots.findIndex(s => !s.removed && !s.inactive && el.selectionStart >= s.start && el.selectionEnd <= s.end)
    if (index >= 0) select(index)
  }
  document.addEventListener('pointerup', clicked, true)
  window.addEventListener('resize', popup.position)
  const stopRole = ctx.sessions.list.subscribe(() => { if (!active()) cancelCandidates() })
  const validate = async () => {
    const draft = input.state.getSnapshot().draft, values = snippetValues(slots, draft)
    for (const slot of slots.filter(s => !s.removed && !s.inactive && s.parameter.source === 'fleet.gemini-accounts')) {
      const value = draft.slice(slot.start, slot.end).trim()
      const result = await options.candidates?.(slot.key, values, value, 1)
      if (!active() || input.state.getSnapshot().draft !== draft) throw Error('草稿或角色已变化，请重新确认')
      if (!result?.items.some(c => !c.disabled && c.value === value)) throw Error('指定账号来源当前不可用，请重新选择；未执行登录')
    }
  }
  save()
  const frame = requestAnimationFrame(() => requestAnimationFrame(() => { if (filling) select(current); else if (active()) input.notify('info', '提示词已填入，可修改后发送。') }))
  return { error, active, validate, dispose: () => { live = false; off(); stopRole(); cancelCandidates(); cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); window.removeEventListener('resize', popup.position); document.removeEventListener('pointerup', clicked, true); document.removeEventListener('keydown', key, true); document.removeEventListener('compositionstart', compositionStart, true); document.removeEventListener('compositionend', compositionEnd, true) } }
}
