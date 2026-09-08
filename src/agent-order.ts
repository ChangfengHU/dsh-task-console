import type { AgentRow } from './wire.ts'

/** Creation is immutable. Legacy first-use fallback is explicitly labelled, not an invented creation date. */
export function sortAgents(rows: AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => (b.createdAt ?? b.firstUsedAt ?? '').localeCompare(a.createdAt ?? a.firstUsedAt ?? '') || a.id.localeCompare(b.id))
}

export const AGENT_EXPAND = 'agent-list:expand'
export const AGENT_COLLAPSE = 'agent-list:collapse'

export function agentCandidates(rows: AgentRow[], query: string, expanded: boolean) {
  const q = query.trim().toLowerCase()
  const matches = sortAgents(rows).filter(a => !a.broken && (!q || `${a.name} ${a.id}`.toLowerCase().includes(q)))
  const visible = q || expanded ? matches : matches.slice(0, 5)
  const items = visible.map(a => ({ name: a.name, description: a.description || a.id, hint: '交给 Agent', value: a.id, section: 'Agent' }))
  if (!q && matches.length > 5) items.push({ name: expanded ? '收起 Agent' : `展开更多 Agent（共 ${matches.length} 个）`, description: '新建优先；历史 Agent 按首次使用时间补充排序', hint: expanded ? '只显示 5 个' : '显示全部', value: expanded ? AGENT_COLLAPSE : AGENT_EXPAND, section: 'Agent' })
  return items
}
