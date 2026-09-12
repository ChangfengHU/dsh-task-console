import type { AgentAction, ActionParameter } from './agent-actions.ts'

export interface SnippetSlot { key: string; label: string; start: number; end: number; marker: string; parameter: ActionParameter; removed?: boolean }
export const snippetDefault = (p: ActionParameter) => p.default === undefined ? undefined : typeof p.default === 'boolean' ? (p.default ? '是' : '否') : String(p.default)
/** Resolve only configured defaults, in one literal pass; never evaluate prompt text. */
export function resolveSnippetDefaults(action: AgentAction, text: string): string {
  const defaults = new Map(action.parameters.filter(p => p.default !== undefined).map(p => [`【${p.label}】`, snippetDefault(p)!]))
  if (!defaults.size) return text
  const escaped = [...defaults.keys()].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return text.replace(new RegExp(escaped.join('|'), 'g'), marker => defaults.get(marker)!)
}
/** Only the visible selected session establishes an existing role; no sticky fallback. */
export function confirmedActionRole(snapshot: any, sessionId: string): string | null {
  const session = snapshot?.byId?.[sessionId]
  // A reused blank session carries the deployment default, not a user's choice.
  return snapshot?.current === sessionId && session?.blank !== true && typeof session?.agentPreset === 'string' ? session.agentPreset : null
}

export interface SnippetProgress {
  fingerprint: string
  ranges: { start: number; end: number; removed?: boolean }[]
  current: number
  filling: boolean
}
// A staleness check, not authentication. Store only coordinates, never prompt values.
function fingerprint(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `${text.length}:${hash >>> 0}`
}
export function snippetProgress(text: string, slots: SnippetSlot[], current: number, filling: boolean): SnippetProgress {
  return { fingerprint: fingerprint(text), ranges: slots.map(({ start, end, removed }) => ({ start, end, ...(removed ? { removed } : {}) })), current, filling }
}
export function restoreSnippet(action: AgentAction, prefix: string, text: string, saved?: SnippetProgress) {
  const original = makeActionSnippet(action, prefix)
  if (saved?.fingerprint === fingerprint(text) && Array.isArray(saved.ranges) && saved.ranges.length === original.slots.length &&
      Number.isInteger(saved.current) && saved.current >= 0 && saved.current < Math.max(1, saved.ranges.length) && typeof saved.filling === 'boolean' &&
      saved.ranges.every(r => r && Number.isInteger(r.start) && Number.isInteger(r.end) && (r.removed === true || r.start >= prefix.length && r.end >= r.start && r.end <= text.length))) {
    return { slots: original.slots.map((s, i) => { const { start, end, removed } = saved.ranges[i]; return { ...s, start, end, ...(removed === true ? { removed } : {}) } }), current: saved.current, filling: saved.filling }
  }
  // Old native drafts have no range metadata. Recover remaining literal markers
  // without guessing where already-edited text fields end or rewriting the draft.
  let cursor = prefix.length
  const slots = original.slots.map(s => {
    const start = text.indexOf(s.marker, cursor)
    if (start < 0) return { ...s, removed: true }
    cursor = start + s.marker.length
    return { ...s, start, end: cursor }
  })
  const current = slots.findIndex(s => !s.removed)
  return { slots, current: Math.max(0, current), filling: current >= 0 }
}
export function makeActionSnippet(action: AgentAction, prefix = '') {
  const slots: SnippetSlot[] = []
  let text = prefix, cursor = 0
  for (const m of action.template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    text += action.template.slice(cursor, m.index)
    const p = action.parameters.find(p => p.key === m[1])!
    const marker = `【${p.label}】`
    const value = marker
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
  if (value === slot.marker) return slot.parameter.default === undefined ? `请填写${slot.label}` : null
  if (!value && slot.parameter.required) return `请填写${slot.label}`
  if (value && slot.parameter.type === 'number' && !Number.isFinite(Number(value))) return `${slot.label}需要填写数字`
  if (value && slot.parameter.type === 'boolean' && !['是','否','true','false'].includes(value)) return `${slot.label}请填写是或否`
  return null
}
