/**
 * Five-field cron, dependency-free and shared by both faces (the client
 * renders "每 10 分钟 · 下次 03:10" from the same code the host fires on).
 *
 * @module dsh-task-console/cron
 */

function field(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const step = m[3] ? Number(m[3]) : 1
    let lo: number, hi: number
    if (m[1] === '*') { lo = min; hi = max } else { lo = Number(m[1]); hi = m[2] ? Number(m[2]) : (m[3] ? max : lo) }
    if (lo < min || hi > max || lo > hi || step < 1) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number> }

/** Parse a 5-field cron expression; null when malformed. */
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = field(parts[0], 0, 59), hour = field(parts[1], 0, 23), dom = field(parts[2], 1, 31), month = field(parts[3], 1, 12), dow = field(parts[4].replace(/7/g, '0'), 0, 6)
  if (!minute || !hour || !dom || !month || !dow) return null
  return { minute, hour, dom, month, dow }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true } catch { return false }
}

export function cronMatches(c: Cron, d: Date, timeZone?: string): boolean {
  if (timeZone) {
    let formatter = formatters.get(timeZone)
    if (!formatter) { formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }); formatters.set(timeZone, formatter) }
    const parts = Object.fromEntries(formatter.formatToParts(d).map(p => [p.type, p.value]))
    return c.minute.has(+parts.minute) && c.hour.has(+parts.hour) && c.dom.has(+parts.day) && c.month.has(+parts.month) && c.dow.has(new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day)).getUTCDay())
  }
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.dom.has(d.getDate()) && c.month.has(d.getMonth() + 1) && c.dow.has(d.getDay())
}

/** Next matching minute strictly after `from`, or null within 366 days. */
export function nextFire(c: Cron, from = new Date(), timeZone?: string): Date | null {
  const d = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, d, timeZone)) return d
    d.setTime(d.getTime() + 60_000)
  }
  return null
}

export function cronHuman(expr: string): string {
  const c = parseCron(expr); if (!c) return '不是合法的 5 段 cron'
  const p = expr.trim().split(/\s+/)
  const hm = () => `${String([...c.hour][0]).padStart(2, '0')}:${String([...c.minute][0]).padStart(2, '0')}`
  if (p[0].startsWith('*/') && p[1] === '*') return `每 ${p[0].slice(2)} 分钟`
  if (p[0] === '0' && p[1] === '*') return '每小时整点'
  if (/^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) {
    if (p[4] === '1-5') return `工作日 ${hm()}`
    if (/^\d$/.test(p[4])) return `每周${'日一二三四五六'[Number(p[4]) % 7]} ${hm()}`
    if (p[2] === '*' && p[3] === '*') return `每天 ${hm()}`
  }
  return expr.trim()
}
