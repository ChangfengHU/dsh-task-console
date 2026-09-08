/** Display-only labels. Persisted IDs and route values always remain unchanged. */
const beijing = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function executionTime(iso?: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '时间未知'
  const parts = Object.fromEntries(beijing.formatToParts(new Date(iso)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function executionCode(id: string): string {
  return `#${id.replace(/^b-(?:chat-)?/, '').slice(0, 8).toUpperCase()}`
}

export function executionLabel(batch: { id: string; firedAt?: string }): string {
  return `${executionTime(batch.firedAt)} · ${executionCode(batch.id)}`
}
