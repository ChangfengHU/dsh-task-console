import { parameterVisible, validateValue, type AgentAction, type ActionParameter } from './agent-actions.ts'

export interface SnippetSlot { key: string; label: string; start: number; end: number; marker: string; parameter: ActionParameter; removed?: boolean; inactive?: boolean }
export const snippetDefault = (p: ActionParameter) => p.default === undefined ? undefined : typeof p.default === 'boolean' ? (p.default ? '是' : '否') : String(p.default)
/** Resolve only configured defaults, in one literal pass; never evaluate prompt text. */
export function resolveSnippetDefaults(action: AgentAction, text: string): string {
  const defaults = new Map(action.parameters.filter(p => p.default !== undefined && p.acceptDefaultOnEnter !== false).map(p => [`【${p.label}】`, snippetDefault(p)!]))
  if (!defaults.size) return text
  const escaped = [...defaults.keys()].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return text.replace(new RegExp(escaped.join('|'), 'g'), marker => defaults.get(marker)!)
}
/** Only the visible selected session establishes an existing role; no sticky fallback. */
export function confirmedActionRole(snapshot: any, sessionId: string, explicitRole?: string | null): string | null {
  const session = snapshot?.byId?.[sessionId]
  // A reused blank session carries the deployment default, not a user's choice.
  return snapshot?.current === sessionId && typeof session?.agentPreset === 'string' && (session.blank !== true || explicitRole === session.agentPreset) ? session.agentPreset : null
}

export interface SnippetProgress {
  fingerprint: string
  ranges: { start: number; end: number; removed?: boolean; inactive?: boolean }[]
  current: number
  filling: boolean
  edited?: number[]
}
// A staleness check, not authentication. Store only coordinates, never prompt values.
function fingerprint(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `${text.length}:${hash >>> 0}`
}
export function snippetProgress(text: string, slots: SnippetSlot[], current: number, filling: boolean): SnippetProgress {
  return { fingerprint: fingerprint(text), ranges: slots.map(({ start, end, removed, inactive }) => ({ start, end, ...(removed ? { removed } : {}), ...(inactive ? { inactive } : {}) })), current, filling }
}
/** Track native edits while the Action catalog is still loading. Coordinates and
 * changed field indices only: no parameter values or unverified Action schema.
 */
export function trackPendingSnippet(before: string, after: string, saved?: SnippetProgress): SnippetProgress | undefined {
  if (!saved || saved.fingerprint !== fingerprint(before) || !Array.isArray(saved.ranges) || !saved.ranges.every(r => Number.isInteger(r.start) && Number.isInteger(r.end) && (r.removed || r.start >= 0 && r.end >= r.start && r.end <= before.length))) return undefined
  let start = 0, end = before.length, nextEnd = after.length
  while (start < end && start < nextEnd && before[start] === after[start]) start++
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  // The persisted current field may be the last one, while the user edits an
  // earlier completed field before the catalog arrives. Include append-at-end
  // edits in that known range instead of assigning them to the static separator.
  const at = saved.ranges.findIndex(r => !r.removed && start >= r.start && end <= r.end)
  const ranges = trackSnippetEdit(saved.ranges as SnippetSlot[], before, after, at < 0 ? saved.current : at)
  const edited = new Set(Array.isArray(saved.edited) ? saved.edited.filter(i=>Number.isInteger(i) && i>=0 && i<ranges.length) : [])
  const touched = ranges.map((r,i) => !r.removed && before.slice(saved.ranges[i].start,saved.ranges[i].end) !== after.slice(r.start,r.end) ? i : -1).filter(i=>i>=0)
  touched.forEach(i=>edited.add(i))
  return { ...saved, fingerprint:fingerprint(after), ranges, current:touched[0] ?? saved.current, filling:touched.length ? true : saved.filling, edited:[...edited] }
}
export function restoreSnippet(action: AgentAction, prefix: string, text: string, saved?: SnippetProgress) {
  const original = makeActionSnippet(action, prefix)
  if (saved?.fingerprint === fingerprint(text) && Array.isArray(saved.ranges) && saved.ranges.length === original.slots.length &&
      Number.isInteger(saved.current) && saved.current >= 0 && saved.current < Math.max(1, saved.ranges.length) && typeof saved.filling === 'boolean' &&
      saved.ranges.every(r => r && Number.isInteger(r.start) && Number.isInteger(r.end) && (r.removed === true || r.start >= prefix.length && r.end >= r.start && r.end <= text.length))) {
    return { slots: original.slots.map((s, i) => { const { inactive: _inactive, removed: _removed, ...base } = s; const { start, end, removed, inactive } = saved.ranges[i]; return { ...base, start, end, ...(inactive === true ? { inactive } : {}), ...(removed === true ? { removed } : {}) } }), current: saved.current, filling: saved.filling }
  }
  // Old native drafts have no range metadata. Recover remaining literal markers
  // without guessing where already-edited text fields end or rewriting the draft.
  let cursor = prefix.length
  const slots = original.slots.map(s => {
    const hasMarker = text.indexOf(s.marker, cursor) >= 0
    const marker = hasMarker ? s.marker : s.inactive ? s.parameter.inactiveValue ?? '' : s.marker
    const start = marker ? text.indexOf(marker, cursor) : -1
    if (start < 0) return { ...s, removed: true }
    cursor = start + marker.length
    return { ...s, start, end: cursor, ...(hasMarker ? { inactive: false } : {}) }
  })
  const current = slots.findIndex(s => !s.removed && !s.inactive)
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
  return reconcileSnippet(slots, text + action.template.slice(cursor))
}
export function snippetValues(slots: SnippetSlot[], text: string): Record<string, string> {
  return Object.fromEntries(slots.filter(s => !s.removed && !s.inactive).map(s => {
    const raw = text.slice(s.start, s.end).trim()
    const value = raw === s.marker ? snippetDefault(s.parameter) ?? '' : raw
    return [s.key, s.parameter.type === 'boolean' ? value === '是' ? 'true' : value === '否' ? 'false' : value : value]
  }))
}
/** Conditional slots stay coordinate-addressable, but no longer ask for input.
 * Parent edits reset dependent intent in the native draft, including chained deps.
 */
export function reconcileSnippet(original: SnippetSlot[], initial: string, before?: Record<string, string>) {
  let slots = original, text = initial
  const values = snippetValues(slots, text)
  const changed = new Set(before ? Object.keys(values).filter(k => values[k] !== before[k]) : [])
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    if (s.removed) continue
    // A legacy draft may have lost an already-filled parent's coordinates. Do
    // not guess its value and silently erase a visible dependent field.
    if (s.parameter.visibleWhen && !Object.hasOwn(values, s.parameter.visibleWhen.key)) continue
    const enabled = parameterVisible(s.parameter, values)
    const invalidated = (s.parameter.dependsOn ?? []).some(k => changed.has(k))
    if (enabled === !s.inactive && !invalidated) continue
    const value = enabled ? s.marker : s.parameter.inactiveValue ?? ''
    const next = text.slice(0, s.start) + value + text.slice(s.end)
    slots = trackSnippetEdit(slots, text, next, i)
    slots[i] = { ...slots[i], inactive: !enabled }
    text = next; changed.add(s.key)
    if (enabled) values[s.key] = snippetDefault(s.parameter) ?? ''; else delete values[s.key]
  }
  return { slots, text }
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
  if (slot.removed || slot.inactive) return null
  const value = text.slice(slot.start, slot.end).trim()
  if (value === slot.marker) return slot.parameter.default === undefined || slot.parameter.acceptDefaultOnEnter === false ? `请填写${slot.label}` : null
  if (!value && slot.parameter.required) return `请填写${slot.label}`
  if (value && slot.parameter.type === 'number' && !Number.isFinite(Number(value))) return `${slot.label}需要填写数字`
  if (value && slot.parameter.type === 'boolean' && !['是','否','true','false'].includes(value)) return `${slot.label}请填写是或否`
  if (value) try { validateValue(slot.parameter, slot.parameter.type === 'number' ? Number(value) : slot.parameter.type === 'boolean' ? ['是', 'true'].includes(value) : value) } catch (e) { return (e as Error).message }
  return null
}
