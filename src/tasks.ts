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

// ── shapes + fold live in ./fold.ts (pure, shared with the browser) ──────

export { actorOf, describe, fold, foldTurns, runStatus } from './fold.ts'
export type { Event, Leg, LegStatus, Participant, Run, State, TaskSpec, ToolRow, StepRow, TurnRow, TurnLedger, Trigger } from './fold.ts'
import { fold, type Event, type Run, type State, type TaskSpec, type Trigger, type Participant } from './fold.ts'

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
