import type { AgentAction, ActionParameter } from './agent-actions.ts'

export interface SnippetSlot { key: string; label: string; start: number; end: number; marker: string; parameter: ActionParameter; removed?: boolean }
/** Only the visible selected session establishes an existing role; no sticky fallback. */
export function confirmedActionRole(snapshot: any, sessionId: string): string | null {
  return snapshot?.current === sessionId && typeof snapshot.byId?.[sessionId]?.agentPreset === 'string' ? snapshot.byId[sessionId].agentPreset : null
}
export function makeActionSnippet(action: AgentAction, prefix = '') {
  const slots: SnippetSlot[] = []
  let text = prefix, cursor = 0
  for (const m of action.template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    text += action.template.slice(cursor, m.index)
    const p = action.parameters.find(p => p.key === m[1])!
    const marker = `【${p.label}】`
    const value = p.default === undefined ? marker : typeof p.default === 'boolean' ? (p.default ? '是' : '否') : String(p.default)
    slots.push({ key: p.key, label: p.label, start: text.length, end: text.length + value.length, marker, parameter: p })
    text += value; cursor = m.index! + m[0].length
  }
  return { text: text + action.template.slice(cursor), slots }
}
/** Follow native textarea edits; no second draft model or DOM value writes. */
export function trackSnippetEdit(slots: SnippetSlot[], before: string, after: string, selected: number): SnippetSlot[] {
  let start = 0, end = before.length, nextEnd = after.length
  const focus = slots[selected], change = after.length - before.length
  // Repeated delimiters can make a global diff attribute typing to the next slot
  // (e.g. typing an underscore just before the template's underscore). Keep an
  // edit inside the selected field when both unchanged surrounding ranges match.
  if (focus && !focus.removed && focus.end + change >= focus.start &&
      before.slice(0, focus.start) === after.slice(0, focus.start) &&
      before.slice(focus.end) === after.slice(focus.end + change)) {
    start = focus.start; end = focus.end; nextEnd = focus.end + change
  } else {
    while (start < end && start < nextEnd && before[start] === after[start]) start++
    while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  }
  const delta = nextEnd - end
  return slots.map((s, i) => {
    if (s.removed) return s
    if (start >= s.start && end <= s.end && (start < s.end || i === selected)) return { ...s, end: s.end + delta }
    if (s.end <= start) return s
    if (s.start >= end) return { ...s, start: s.start + delta, end: s.end + delta }
    return { ...s, removed: true }
  })
}
export function snippetError(slot: SnippetSlot, text: string): string | null {
  if (slot.removed) return null
  const value = text.slice(slot.start, slot.end).trim()
  if (value === slot.marker || (!value && slot.parameter.required)) return `请填写${slot.label}`
  if (value && slot.parameter.type === 'number' && !Number.isFinite(Number(value))) return `${slot.label}需要填写数字`
  if (value && slot.parameter.type === 'boolean' && !['是','否','true','false'].includes(value)) return `${slot.label}请填写是或否`
  return null
}
