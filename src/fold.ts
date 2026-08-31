/**
 * Pure fold of the task event stream — shared by host and browser, so the
 * board a person scrubs through in the replay is computed by exactly the
 * code the host runs. No node imports here.
 *
 * @module dsh-task-console/fold
 */

export type Trigger = { kind: 'once' } | { kind: 'cron'; expr: string }

export interface Participant {
  agentId: string
  /** This participant's share of the work, appended to the brief. */
  brief?: string
}

export interface TaskSpec {
  id: string
  title: string
  /** Frozen at creation — every leg reads it verbatim. */
  brief: string
  trigger: Trigger
  participants: Participant[]
  cwd: string
  timeoutSec: number
  onFail: 'stop' | 'retry'
  maxTries: number
  enabled: boolean
  createdAt: string
}

export type LegStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'timed_out' | 'lost' | 'cancelled'

export interface Leg {
  agentId: string
  status: LegStatus
  tries: number
  sessionId?: string
  startedAt?: string
  endedAt?: string
  /** The last assistant text of the leg — what the next leg receives. */
  handoff?: string
  /** Set while the agent waits on ask_user_question. */
  question?: string
  error?: string
}

export interface Run {
  id: string
  taskId: string
  firedAt: string
  by: 'cron' | 'manual' | 'retry'
  legs: Leg[]
  settled?: { at: string; outcome: 'done' | 'failed' | 'cancelled' }
}

export type Event =
  | { t: 'task/created'; at: string; task: TaskSpec }
  | { t: 'task/enabled'; at: string; taskId: string; enabled: boolean }
  | { t: 'task/deleted'; at: string; taskId: string }
  | { t: 'run/fired'; at: string; run: { id: string; taskId: string; by: Run['by']; legs: string[] } }
  | { t: 'leg/spawned'; at: string; runId: string; leg: number; sessionId: string; tries: number }
  | { t: 'leg/blocked'; at: string; runId: string; leg: number; question: string }
  | { t: 'leg/resumed'; at: string; runId: string; leg: number }
  | { t: 'leg/done'; at: string; runId: string; leg: number; handoff: string }
  | { t: 'leg/failed' | 'leg/timed_out' | 'leg/lost' | 'leg/cancelled'; at: string; runId: string; leg: number; error?: string }
  | { t: 'run/settled'; at: string; runId: string; outcome: 'done' | 'failed' | 'cancelled' }

export interface State {
  tasks: Map<string, TaskSpec>
  runs: Map<string, Run>
}

export function fold(events: Event[]): State {
  const tasks = new Map<string, TaskSpec>()
  const runs = new Map<string, Run>()
  for (const e of events) {
    switch (e.t) {
      case 'task/created': tasks.set(e.task.id, e.task); break
      case 'task/enabled': { const t = tasks.get(e.taskId); if (t) tasks.set(t.id, { ...t, enabled: e.enabled }); break }
      case 'task/deleted': tasks.delete(e.taskId); for (const r of [...runs.values()]) if (r.taskId === e.taskId) runs.delete(r.id); break
      case 'run/fired': runs.set(e.run.id, { id: e.run.id, taskId: e.run.taskId, firedAt: e.at, by: e.run.by, legs: e.run.legs.map(agentId => ({ agentId, status: 'queued', tries: 0 })) }); break
      case 'run/settled': { const r = runs.get(e.runId); if (r) r.settled = { at: e.at, outcome: e.outcome }; break }
      default: {
        const r = runs.get(e.runId); const l = r?.legs[e.leg]; if (!l) break
        if (e.t === 'leg/spawned') Object.assign(l, { status: 'running', sessionId: e.sessionId, startedAt: e.at, tries: e.tries, question: undefined, error: undefined, endedAt: undefined })
        else if (e.t === 'leg/blocked') Object.assign(l, { status: 'blocked', question: e.question })
        else if (e.t === 'leg/resumed') Object.assign(l, { status: 'running', question: undefined })
        else if (e.t === 'leg/done') Object.assign(l, { status: 'done', handoff: e.handoff, endedAt: e.at, question: undefined })
        else Object.assign(l, { status: e.t.slice(4) as LegStatus, endedAt: e.at, error: e.error, question: undefined })
      }
    }
  }
  return { tasks, runs }
}

export function runStatus(r: Run): 'run' | 'park' | 'done' | 'bad' {
  if (r.legs.some(l => l.status === 'blocked')) return 'park'
  if (r.legs.some(l => l.status === 'running')) return 'run'
  if (r.settled?.outcome === 'done' || r.legs.every(l => l.status === 'done')) return 'done'
  if (r.settled || r.legs.some(l => ['failed', 'timed_out', 'lost', 'cancelled'].includes(l.status))) return 'bad'
  return 'run'
}

/** Who moved: the host dispatcher, the agent itself, or a person. Mirrors the replay's "谁动的手" column. */
export function actorOf(e: Event): 'dispatcher' | 'agent' | 'person' | 'clock' {
  switch (e.t) {
    case 'task/created': case 'task/enabled': case 'task/deleted': return 'person'
    case 'run/fired': return (e.run.by === 'cron') ? 'clock' : 'person'
    case 'leg/blocked': case 'leg/done': return 'agent'
    case 'leg/resumed': return 'person'
    default: return 'dispatcher'
  }
}

/** One line a person can read for each event. */
export function describe(e: Event, agentName: (id: string) => string, legAgent?: (runId: string, leg: number) => string): string {
  const who = (runId: string, leg: number) => legAgent ? legAgent(runId, leg) : `第 ${leg + 1} 段`
  switch (e.t) {
    case 'task/created': return `建卡「${e.task.title}」,${e.task.participants.map(p => agentName(p.agentId)).join(' → ')}`
    case 'task/enabled': return e.enabled ? '启用时间表' : '停用时间表'
    case 'task/deleted': return '删除任务'
    case 'run/fired': return `${({ cron: '到点', manual: '手动', retry: '重试' })[e.run.by]}触发,${e.run.legs.length} 段排队`
    case 'leg/spawned': return `${who(e.runId, e.leg)} 开工${e.tries > 1 ? `(第 ${e.tries} 次)` : ''},会话 ${e.sessionId}`
    case 'leg/blocked': return `${who(e.runId, e.leg)} 停下来问:${e.question}`
    case 'leg/resumed': return `${who(e.runId, e.leg)} 收到回答,继续`
    case 'leg/done': return `${who(e.runId, e.leg)} 交卷(${e.handoff.length} 字交接单)`
    case 'leg/failed': return `${who(e.runId, e.leg)} 失败${e.error ? ':' + e.error : ''}`
    case 'leg/timed_out': return `${who(e.runId, e.leg)} 超时${e.error ? ':' + e.error : ''}`
    case 'leg/lost': return `${who(e.runId, e.leg)} 丢失${e.error ? ':' + e.error : ''}`
    case 'leg/cancelled': return `${who(e.runId, e.leg)} 取消`
    case 'run/settled': return ({ done: '运行完成', failed: '运行失败', cancelled: '运行取消' })[e.outcome]
  }
}

// ── turn ledger (folded from a session's own log) ───────────────────────

export interface ToolRow {
  callId: string
  name: string
  kind: 'mcp' | 'skill' | 'native' | 'ask'
  server?: string
  args: string
  result: string
  ok: boolean
  ms: number
  at: string
}

export interface StepRow {
  step: number
  provider?: string
  model?: string
  at: string
  ms: number
  usage: { input: number; output: number; reasoning: number; cacheRead: number }
  tools: ToolRow[]
  text: string
}

export interface TurnRow {
  turn: number
  at: string
  endedAt?: string
  reason?: string
  user: string
  steps: StepRow[]
}

export interface TurnLedger {
  sessionId: string
  agentPreset?: string
  turns: TurnRow[]
  totals: { turns: number; steps: number; mcp: number; skill: number; native: number; ask: number; input: number; output: number; ms: number; byServer: Record<string, number>; skills: string[] }
}

const preview = (s: unknown, n: number) => { const t = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }

/** Fold a raw dsh session event log into turns → steps → tool calls. */
export function foldTurns(sessionId: string, events: any[], agentPreset?: string): TurnLedger {
  const turns: TurnRow[] = []
  const byCall = new Map<string, ToolRow>()
  const totals: TurnLedger['totals'] = { turns: 0, steps: 0, mcp: 0, skill: 0, native: 0, ask: 0, input: 0, output: 0, ms: 0, byServer: {}, skills: [] }
  let cur: TurnRow | undefined, step: StepRow | undefined
  let model: { provider?: string; model?: string } = {}
  let pendingUser = ''
  const iso = (t: number) => new Date(t).toISOString()
  for (const e of events) {
    const d = e.data ?? {}
    switch (e.type) {
      case 'agent/inbox/spliced': { const txt = (d.inserted ?? []).flatMap((m: any) => (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text)).join('\n'); if (txt) pendingUser = txt; break }
      case 'user/message': { if (d.source?.kind === 'user' || !d.source) { const txt = (d.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'); if (txt && !txt.startsWith('<system-reminder>')) pendingUser = txt } break }
      case 'request/context': model = { provider: d.provider, model: d.model }; break
      case 'turn/start': cur = { turn: d.turn, at: iso(e.time), user: pendingUser, steps: [] }; pendingUser = ''; turns.push(cur); totals.turns++; break
      case 'step/start': if (!cur) { cur = { turn: d.turn ?? turns.length + 1, at: iso(e.time), user: pendingUser, steps: [] }; turns.push(cur); totals.turns++ }
        step = { step: d.step, ...model, at: iso(e.time), ms: 0, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, tools: [], text: '' }; cur.steps.push(step); totals.steps++; break
      case 'assistant/message': {
        if (!step) break
        const u = d.usage ?? {}
        step.usage.input += u.inputTokens ?? 0; step.usage.output += u.outputTokens ?? 0; step.usage.reasoning += u.reasoningTokens ?? 0; step.usage.cacheRead += u.cacheReadTokens ?? 0
        totals.input += u.inputTokens ?? 0; totals.output += u.outputTokens ?? 0
        const txt = (d.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
        if (txt) step.text = txt
        if (!step.ms) step.ms = e.time - +new Date(step.at)
        break
      }
      case 'tool/call': {
        const name = String(d.name ?? '')
        const m = /^mcp__(.+?)__(.+)$/.exec(name)
        const kind: ToolRow['kind'] = name.endsWith('ask_user_question') ? 'ask' : m ? 'mcp' : name === 'skill' ? 'skill' : 'native'
        const row: ToolRow = { callId: d.callId, name: m ? m[2] : name, kind, server: m?.[1], args: preview(d.arguments, 240), result: '', ok: true, ms: 0, at: iso(e.time) }
        ;(row as any)._t = e.time
        byCall.set(d.callId, row); step?.tools.push(row)
        totals[kind]++
        if (m) totals.byServer[m[1]] = (totals.byServer[m[1]] ?? 0) + 1
        if (kind === 'skill') { try { const n = JSON.parse(d.arguments ?? '{}').name; if (n && !totals.skills.includes(n)) totals.skills.push(n) } catch { /* ignore */ } }
        break
      }
      case 'tool/result': {
        const id = d.message?.source?.callId; const row = id && byCall.get(id); if (!row) break
        const parts = (d.message?.content ?? []).flatMap((c: any) => c.type === 'tool-result' ? (c.content ?? []) : [c])
        const txt = parts.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
        row.result = preview(txt, 400); row.ms = e.time - (row as any)._t; delete (row as any)._t
        row.ok = !/"ok":\s*false|^error|exit code [1-9]|Traceback|failed/i.test(txt.slice(0, 200))
        break
      }
      case 'step/end': if (step && !step.ms) step.ms = e.time - +new Date(step.at); step = undefined; break
      case 'turn/end': if (cur) { cur.endedAt = iso(e.time); cur.reason = d.reason?.kind; totals.ms += e.time - +new Date(cur.at) } cur = undefined; break
    }
  }
  return { sessionId, agentPreset, turns, totals }
}
