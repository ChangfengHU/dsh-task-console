/**
 * Tasks, runs, and the event stream they are folded from.
 *
 * The board is never stored: `events.jsonl` is append-only and every
 * screen is `fold(events)`. A run is one firing of a task; each participant
 * gets one leg, and a leg is one real session on that agent's preset. The
 * only two things a leg receives are the task brief and the upstream leg's
 * handoff — no shared memory, no peeking at other legs.
 *
 * @module dsh-task-console/tasks
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── shapes ──────────────────────────────────────────────────────────────

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

// ── store ───────────────────────────────────────────────────────────────

export function storeDir(home = homedir()): string {
  return join(process.env.DSH_HOME ?? join(home, '.dsh'), 'task-console')
}

/** Append-only JSONL with the fold kept in memory. */
export class EventStore {
  private events: Event[] = []
  private state: State = { tasks: new Map(), runs: new Map() }
  private queue: Promise<void> = Promise.resolve()

  private readonly dir: string

  constructor(dir = storeDir()) { this.dir = dir }

  get file(): string { return join(this.dir, 'events.jsonl') }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    let text = ''
    try { text = await readFile(this.file, 'utf8') } catch { /* first run */ }
    this.events = text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Event] } catch { return [] } })
    this.state = fold(this.events)
  }

  all(): Event[] { return this.events }
  get tasks(): Map<string, TaskSpec> { return this.state.tasks }
  get runs(): Map<string, Run> { return this.state.runs }

  /** Serialized append: the fold is updated only after the line is on disk. */
  append(e: Event): Promise<void> {
    const next = this.queue.then(async () => {
      await appendFile(this.file, JSON.stringify(e) + '\n', { mode: 0o600 })
      this.events.push(e)
      this.state = fold(this.events)
    })
    this.queue = next.catch(() => undefined)
    return next
  }
}

// ── cron (shared with the client) ──────────────────────────────────────

export { cronHuman, cronMatches, nextFire, parseCron, type Cron } from './cron.ts'
import { parseCron } from './cron.ts'

// ── the message a leg receives ───────────────────────────────────────────

/** The one user message a leg gets: brief, its part, the upstream handoff. */
export function legMessage(task: TaskSpec, run: Run, leg: number, upstream?: { agentName: string; handoff: string }): string {
  const p = task.participants[leg]
  const lines = [`# 任务:${task.title} · ${run.id} · 第 ${leg + 1}/${task.participants.length} 段`, '', '[TASK]', task.brief.trim()]
  if (p?.brief?.trim()) lines.push('', '[YOUR PART]', p.brief.trim())
  if (upstream) lines.push('', `[UPSTREAM HANDOFF from ${upstream.agentName}]`, upstream.handoff.trim() || '(上游没有留下交接单)')
  lines.push('', '交卷:把「产物 / 干了什么 / 下游注意」写在你的最后一条回复里,它会原样交给下一段。拿不准且不可逆的事,用 ask_user_question 停下来问。')
  return lines.join('\n')
}

export function validateTask(raw: unknown, agentIds: Set<string>): TaskSpec {
  const s = (raw ?? {}) as Partial<TaskSpec>
  const brief = String(s.brief ?? '').trim()
  if (brief.length < 4) throw new Error('任务书至少写一句')
  const title = String(s.title ?? '').trim() || brief.split(/[,,;。\n]/)[0].slice(0, 26)
  const participants = (Array.isArray(s.participants) ? s.participants : []).map(p => ({ agentId: String((p as Participant).agentId ?? ''), ...((p as Participant).brief ? { brief: String((p as Participant).brief) } : {}) })).filter(p => p.agentId)
  if (!participants.length) throw new Error('至少一个参与者')
  for (const p of participants) if (!agentIds.has(p.agentId)) throw new Error(`没有这个 Agent:${p.agentId}`)
  let trigger: Trigger = { kind: 'once' }
  if ((s.trigger as Trigger)?.kind === 'cron') {
    const expr = String((s.trigger as { expr?: string }).expr ?? '').trim()
    if (!parseCron(expr)) throw new Error('cron 表达式不合法(要 5 段)')
    trigger = { kind: 'cron', expr }
  }
  const timeoutSec = Math.min(Math.max(Number(s.timeoutSec) || 1800, 60), 6 * 3600)
  const onFail = s.onFail === 'retry' ? 'retry' : 'stop'
  return {
    id: String(s.id ?? '') || `T-${Date.now().toString(36)}`,
    title, brief, trigger, participants,
    cwd: String(s.cwd ?? '').trim() || homedir(),
    timeoutSec, onFail,
    maxTries: onFail === 'retry' ? Math.min(Math.max(Number(s.maxTries) || 2, 1), 5) : 1,
    enabled: true,
    createdAt: new Date().toISOString(),
  }
}
