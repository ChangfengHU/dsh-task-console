import type { SnippetProgress } from '../action-snippet.ts'

export interface ActionDraft {
  agentId: string
  actionId: string
  revision: string
  prefix: string
  newSession: boolean
  progress?: SnippetProgress
}
const key = (sessionId: string) => `dtc:action-draft:${sessionId}`
/** Tab/session-scoped UI metadata; the native input remains the only prompt store. */
export function readActionDraft(sessionId: string): ActionDraft | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(sessionId)) ?? 'null')
    if (value && ['agentId', 'actionId', 'revision', 'prefix'].every(k => typeof value[k] === 'string') &&
        value.prefix.startsWith('@') && value.prefix.endsWith(' ') && typeof value.newSession === 'boolean') return value
  } catch { /* storage unavailable or invalid: resolve only against the live roster */ }
}
export function writeActionDraft(sessionId: string, value?: ActionDraft) {
  try { if (value) sessionStorage.setItem(key(sessionId), JSON.stringify(value)); else sessionStorage.removeItem(key(sessionId)) } catch { /* native draft still survives */ }
}
