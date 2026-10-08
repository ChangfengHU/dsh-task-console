import type { ActionParameter } from './agent-actions.ts'

export interface ActionOption { value: string; label: string; detail?: string; disabled?: boolean }
export interface ActionOptionPage { items: ActionOption[]; page: number; pages: number; total: number; notice?: string }
export interface ActionOptionQuery { agentId?: string; taskId?: string; sessionId?: string; actionId: string; revision: string; parameter: string; values: Record<string, unknown>; search?: string; page?: number }
/** Exact identity only: suggestions are not mandatory, fuzzy matches cannot pick accounts. */
export function resolveAccountOption(items: ActionOption[], input: string): ActionOption {
  const value = input.trim(), id = value.match(/(?:^|accountId=)(gemini_[a-f0-9]{8,64})(?:$|\s)/)?.[1]
  const matches = items.filter(c => c.value === value || (id
    ? c.value.match(/(?:^|accountId=)(gemini_[a-f0-9]{8,64})(?:$|\s)/)?.[1] === id
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && c.label.toLowerCase() === value.toLowerCase()))
  if (matches.length !== 1) throw Error(matches.length ? '邮箱对应多个金库账号，请填写明确的 accountId' : '未找到指定金库账号，请填写完整邮箱或 accountId；未执行登录')
  if (matches[0].disabled) throw Error('指定金库账号当前不可用；未换号、未执行登录')
  return matches[0]
}
export function optionPage(items: ActionOption[], search = '', page = 1, notice?: string): ActionOptionPage {
  if (typeof search !== 'string' || search.length > 500 || !Number.isInteger(page) || page < 1 || page > 10000) throw Error('候选查询参数无效')
  const q = search.trim().toLowerCase()
  const rows = items.filter(r => !q || `${r.label} ${r.detail ?? ''} ${r.value}`.toLowerCase().includes(q))
  const pages = Math.max(1, Math.ceil(rows.length / 20))
  return { items: rows.slice((page - 1) * 20, page * 20), page, pages, total: rows.length, ...(notice ? { notice } : {}) }
}
export const ACTION_SOURCES = [
  { id: 'vault.ssh-nodes', label: '金库 SSH 机器（装机 Task，可手填新 IP）', tool: 'browser_fleet_inventory' },
  { id: 'fleet.nodes', label: 'Fleet 机器（可手填新 IP）', tool: 'browser_fleet_inventory' },
  { id: 'fleet.gemini-accounts', label: '授权 Gemini 账号来源', tool: 'browser_login_candidates' },
] as const
export function sourceTool(p: ActionParameter): string {
  const source = ACTION_SOURCES.find(s => s.id === p.source)
  if (!source) throw Error('未注册的只读候选来源')
  return source.tool
}
