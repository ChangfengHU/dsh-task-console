/**
 * The task model, folded from an append-only event stream. Pure — shared by
 * host and browser so the replay a person scrubs through is computed by the
 * same code the dispatcher runs on.
 *
 * Shapes follow hermes' kanban tables, minus process spawning:
 *
 *   Task   a template: brief + ordered participants + trigger
 *   Batch  one firing of a task (hermes has no template layer; a cron there
 *          creates fresh cards — a batch is exactly that set of fresh cards)
 *   Card   one agent doing one thing inside a batch; `deps` are card ids that
 *          must be done before it is ready (the wizard makes a chain)
 *   Run    one attempt at a card = one real session; retries add runs
 *   Event  a replay/read projection; normalized SQLite rows own scheduling
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
  /** Frozen at creation — every card reads it verbatim. */
  brief: string
  trigger: Trigger
  participants: Participant[]
  /** Static chains are kept for historical tasks; dynamic rounds materialize one DB-backed round at a time. */
  graphMode?: 'static-chain' | 'dynamic-rounds'
  cwd: string
  timeoutSec: number
  onFail: 'stop' | 'retry'
  /** Consecutive-failure limit per card before it gives up (hermes' circuit breaker). */
  maxTries: number
  enabled: boolean
  createdAt: string
}

export type BlockKind = 'needs_input' | 'dependency' | 'capability' | 'transient'

export type RunStatus = 'running' | 'blocked' | 'done' | 'failed' | 'timed_out' | 'crashed' | 'cancelled'
export type RunOutcome = 'completed' | 'review' | 'changes_requested' | 'blocked' | 'crashed' | 'timed_out' | 'failed' | 'protocol_violation' | 'cancelled'

export interface Run {
  id: string
  cardId: string
  batchId: string
  taskId: string
  attempt: number
  /** Agent preset that actually executed this attempt (reviewers may differ from the card owner). */
  profileId?: string
  sessionId: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  outcome?: RunOutcome
  /** The handoff: what the next card receives. */
  summary?: string
  question?: string
  blockKind?: BlockKind
  /** Explicit task_block closes this run; ask_user_question only pauses it. */
  terminalBlock?: boolean
  error?: string
  /** Structured completion data supplied by the worker. */
  metadata?: Record<string, unknown>
  sessionCreatedAt?: string
  promptDispatchedAt?: string
  nudges: number
}

export type CardStatus = 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'review' | 'failed' | 'cancelled'

export interface Card {
  id: string
  batchId: string
  taskId: string
  /** Position in the chain, for display. */
  index: number
  agentId: string
  kind?: 'agent' | 'gate'
  role?: 'planner' | 'executor' | 'reviewer' | 'gate'
  round?: number
  brief?: string
  deps: string[]
  status: CardStatus
  currentRunId?: string
  runIds: string[]
  consecutiveFailures: number
  blockRecurrences: number
  lastBlockReason?: string
  /** The summary of the run that finished this card. */
  summary?: string
  /** Why the previous review submission was returned. */
  reviewNote?: string
  error?: string
  startedAt?: string
  endedAt?: string
}

export interface Batch {
  id: string
  taskId: string
  firedAt: string
  by: 'cron' | 'manual' | 'retry'
  cardIds: string[]
  settled?: { at: string; outcome: 'done' | 'failed' | 'cancelled' }
}

/** A file explicitly delivered by a run (or safely discovered from an old handoff). */
export interface Artifact {
  id: string
  taskId: string
  batchId: string
  cardId: string
  runId: string
  sessionId: string
  name: string
  mime: string
  size: number
  sha256: string
  createdAt: string
  originalPath: string
  /** Host-only location of the immutable snapshot. Legacy rows point at the original file. */
  storagePath: string
  legacy?: boolean
  publicUrl?: string
  /** Explicitly selected by the final planner. Compatibility rows are marked separately in the read projection. */
  final?: boolean
  finalSource?: 'explicit' | 'compatibility'
  finalizedAt?: string
}

export type Event =
  | { t: 'task/created'; at: string; taskId: string; task: TaskSpec }
  | { t: 'task/enabled'; at: string; taskId: string; enabled: boolean }
  | { t: 'task/deleted'; at: string; taskId: string }
  | { t: 'batch/fired'; at: string; taskId: string; batch: { id: string; by: Batch['by']; cards: CardSeed[] } }
  | { t: 'card/created'; at: string; taskId: string; batchId: string; card: CardSeed }
  | { t: 'gate/opened'; at: string; taskId: string; cardId: string }
  | { t: 'card/ready'; at: string; taskId: string; cardId: string }
  | { t: 'run/claimed'; at: string; taskId: string; cardId: string; runId: string; sessionId: string; attempt: number; profileId?: string }
  | { t: 'run/session_created'; at: string; taskId: string; runId: string; sessionId: string }
  | { t: 'run/prompt_dispatched'; at: string; taskId: string; runId: string; messageId: string }
  | { t: 'run/blocked'; at: string; taskId: string; runId: string; kind: BlockKind; reason: string; terminal?: boolean }
  | { t: 'run/resumed'; at: string; taskId: string; runId: string }
  | { t: 'run/nudged'; at: string; taskId: string; runId: string }
  | { t: 'run/completed'; at: string; taskId: string; runId: string; summary: string; metadata?: Record<string, unknown> }
  | { t: 'run/review_requested'; at: string; taskId: string; runId: string; summary: string; metadata?: Record<string, unknown>; reviewer?: string }
  | { t: 'run/failed' | 'run/timed_out' | 'run/crashed' | 'run/cancelled'; at: string; taskId: string; runId: string; outcome?: RunOutcome; error?: string }
  | { t: 'card/review_approved'; at: string; taskId: string; cardId: string; runId: string; note?: string }
  | { t: 'card/changes_requested'; at: string; taskId: string; cardId: string; runId: string; note: string; targetCardId?: string; reviewer?: string }
  | { t: 'card/gave_up'; at: string; taskId: string; cardId: string; error: string }
  | { t: 'card/cancelled'; at: string; taskId: string; cardId: string }
  | { t: 'artifact/registered'; at: string; taskId: string; artifact: Artifact }
  | { t: 'artifact/finalized'; at: string; taskId: string; batchId: string; artifactId: string; artifactCardId: string; cardId: string; runId: string; sha256: string }
  | { t: 'artifact/published'; at: string; taskId: string; artifactId: string; publicUrl: string }
  | { t: 'batch/settled'; at: string; taskId: string; batchId: string; outcome: 'done' | 'failed' | 'cancelled' }

export interface State {
  tasks: Map<string, TaskSpec>
  batches: Map<string, Batch>
  cards: Map<string, Card>
  runs: Map<string, Run>
  artifacts: Map<string, Artifact>
}

export interface CardSeed {
  id: string
  agentId: string
  brief?: string
  deps: string[]
  kind?: Card['kind']
  role?: Card['role']
  round?: number
}

/** How many times the same block reason may recur on one card before it gives up (hermes BLOCK_RECURRENCE_LIMIT). */
export const BLOCK_RECURRENCE_LIMIT = 3

export function fold(events: Event[]): State {
  const s: State = { tasks: new Map(), batches: new Map(), cards: new Map(), runs: new Map(), artifacts: new Map() }
  const finishRun = (r: Run, status: RunStatus, outcome: RunOutcome, at: string, error?: string) => {
    r.status = status; r.outcome = outcome; r.endedAt = at; if (error) r.error = error
    const c = s.cards.get(r.cardId); if (c && c.currentRunId === r.id) c.currentRunId = undefined
    return c
  }
  for (const e of events) {
    switch (e.t) {
      case 'task/created': s.tasks.set(e.task.id, e.task); break
      case 'task/enabled': { const t = s.tasks.get(e.taskId); if (t) s.tasks.set(t.id, { ...t, enabled: e.enabled }); break }
      case 'task/deleted': {
        s.tasks.delete(e.taskId)
        for (const b of [...s.batches.values()]) if (b.taskId === e.taskId) s.batches.delete(b.id)
        for (const c of [...s.cards.values()]) if (c.taskId === e.taskId) s.cards.delete(c.id)
        for (const r of [...s.runs.values()]) if (r.taskId === e.taskId) s.runs.delete(r.id)
        for (const a of [...s.artifacts.values()]) if (a.taskId === e.taskId) s.artifacts.delete(a.id)
        break
      }
      case 'batch/fired': {
        s.batches.set(e.batch.id, { id: e.batch.id, taskId: e.taskId, firedAt: e.at, by: e.batch.by, cardIds: e.batch.cards.map(c => c.id) })
        e.batch.cards.forEach((c, i) => s.cards.set(c.id, { ...c, id: c.id, batchId: e.batch.id, taskId: e.taskId, index: i, agentId: c.agentId, brief: c.brief, deps: c.deps, status: c.deps.length ? 'todo' : 'ready', runIds: [], consecutiveFailures: 0, blockRecurrences: 0 }))
        break
      }
      case 'card/created': {
        const b = s.batches.get(e.batchId)
        if (!b || s.cards.has(e.card.id)) break
        const index = b.cardIds.length
        b.cardIds.push(e.card.id)
        s.cards.set(e.card.id, { ...e.card, batchId: e.batchId, taskId: e.taskId, index, status: e.card.deps.length ? 'todo' : 'ready', runIds: [], consecutiveFailures: 0, blockRecurrences: 0 })
        break
      }
      case 'gate/opened': { const c = s.cards.get(e.cardId); if (c?.kind === 'gate') { c.status = 'done'; c.endedAt = e.at; c.summary = 'Gate opened after its dependencies completed.' } break }
      case 'card/ready': { const c = s.cards.get(e.cardId); if (c && ['todo', 'ready', 'blocked'].includes(c.status)) { c.status = 'ready'; c.error = undefined } break }
      case 'run/claimed': {
        const c = s.cards.get(e.cardId); if (!c) break
        s.runs.set(e.runId, { id: e.runId, cardId: c.id, batchId: c.batchId, taskId: e.taskId, attempt: e.attempt, profileId: e.profileId ?? c.agentId, sessionId: e.sessionId, startedAt: e.at, status: 'running', nudges: 0 })
        c.runIds.push(e.runId); c.currentRunId = e.runId; c.status = 'running'; c.startedAt ??= e.at; c.error = undefined
        break
      }
      case 'run/session_created': { const r = s.runs.get(e.runId); if (r) { r.sessionId = e.sessionId; r.sessionCreatedAt = e.at } break }
      case 'run/prompt_dispatched': { const r = s.runs.get(e.runId); if (r) r.promptDispatchedAt = e.at; break }
      case 'run/blocked': {
        const r = s.runs.get(e.runId); if (!r) break
        r.status = 'blocked'; r.blockKind = e.kind; r.question = e.reason; r.terminalBlock = !!e.terminal
        if (e.terminal) r.endedAt = e.at
        const c = s.cards.get(r.cardId); if (c) {
          c.status = 'blocked'
          if (e.terminal && c.currentRunId === r.id) c.currentRunId = undefined
          if (c.lastBlockReason === e.reason) c.blockRecurrences++; else { c.lastBlockReason = e.reason; c.blockRecurrences = 1 }
        }
        break
      }
      case 'run/resumed': { const r = s.runs.get(e.runId); if (!r) break; r.status = 'running'; r.question = undefined; r.terminalBlock = false; const c = s.cards.get(r.cardId); if (c) c.status = 'running'; break }
      case 'run/nudged': { const r = s.runs.get(e.runId); if (r) r.nudges++; break }
      case 'run/completed': case 'run/review_requested': {
        const r = s.runs.get(e.runId); if (!r) break
        r.summary = e.summary; r.metadata = e.metadata
        const c = finishRun(r, 'done', e.t === 'run/completed' ? 'completed' : 'review', e.at)
        if (c) { c.status = e.t === 'run/completed' ? 'done' : 'review'; c.summary = e.summary; c.endedAt = e.at; c.consecutiveFailures = 0; c.blockRecurrences = 0 }
        break
      }
      case 'card/review_approved': {
        const c = s.cards.get(e.cardId)
        if (c && c.status === 'review') { c.status = 'done'; c.reviewNote = e.note; c.endedAt = e.at }
        break
      }
      case 'card/changes_requested': {
        const c = s.cards.get(e.cardId)
        if (c && (c.status === 'review' || c.status === 'running')) {
          const reviewRun = s.runs.get(e.runId)
          if (reviewRun && !reviewRun.endedAt) {
            reviewRun.status = 'done'; reviewRun.outcome = 'changes_requested'; reviewRun.summary = e.note; reviewRun.endedAt = e.at
          }
          const target = e.targetCardId ? s.cards.get(e.targetCardId) : c
          if (!target || target.batchId !== c.batchId || target.index > c.index) break
          for (const affected of s.cards.values()) {
            if (affected.batchId !== c.batchId || affected.index < target.index || affected.index > c.index) continue
            affected.status = affected.id === target.id ? 'ready' : 'todo'
            affected.currentRunId = undefined; affected.summary = undefined; affected.endedAt = undefined; affected.error = undefined
            affected.reviewNote = affected.id === target.id ? e.note : undefined
          }
        }
        break
      }
      case 'run/failed': case 'run/timed_out': case 'run/crashed': case 'run/cancelled': {
        const r = s.runs.get(e.runId); if (!r) break
        const status = e.t.slice(4) as RunStatus
        const outcome = e.outcome ?? (status === 'failed' ? 'failed' : status === 'timed_out' ? 'timed_out' : status === 'crashed' ? 'crashed' : 'cancelled')
        const c = finishRun(r, status, outcome, e.at, e.error)
        if (c) {
          if (status === 'cancelled') { c.status = 'cancelled'; c.endedAt = e.at }
          else { c.consecutiveFailures++; c.status = 'ready'; c.error = e.error }   // back to ready; the dispatcher decides retry vs gave_up
        }
        break
      }
      case 'card/gave_up': { const c = s.cards.get(e.cardId); if (c) { c.status = 'failed'; c.error = e.error; c.endedAt = e.at } break }
      case 'card/cancelled': { const c = s.cards.get(e.cardId); if (c && c.status !== 'done') { c.status = 'cancelled'; c.endedAt = e.at } break }
      case 'artifact/registered': s.artifacts.set(e.artifact.id, e.artifact); break
      case 'artifact/finalized': {
        for (const a of s.artifacts.values()) if (a.batchId === e.batchId) { a.final = a.id === e.artifactId; if (!a.final) { a.finalSource = undefined; a.finalizedAt = undefined } }
        const a = s.artifacts.get(e.artifactId); if (a) { a.final = true; a.finalSource = 'explicit'; a.finalizedAt = e.at }
        break
      }
      case 'artifact/published': { const a = s.artifacts.get(e.artifactId); if (a) a.publicUrl = e.publicUrl; break }
      case 'batch/settled': { const b = s.batches.get(e.batchId); if (b) b.settled = { at: e.at, outcome: e.outcome }; break }
    }
  }
  return s
}

/** Cards whose deps are all done and that are still waiting — what the dispatcher may claim. */
export function readyCards(s: State): Card[] {
  const out: Card[] = []
  for (const c of s.cards.values()) {
    if (c.kind === 'gate') continue
    if (c.status !== 'todo' && c.status !== 'ready') continue
    if (c.deps.every(d => s.cards.get(d)?.status === 'done')) out.push(c)
  }
  return out
}

export type BatchStatus = 'run' | 'park' | 'review' | 'done' | 'bad'

export function batchStatus(s: State, b: Batch): BatchStatus {
  const cards = b.cardIds.map(id => s.cards.get(id)).filter(Boolean) as Card[]
  if (cards.some(c => c.status === 'blocked')) return 'park'
  if (b.settled) return b.settled.outcome === 'done' ? 'done' : 'bad'
  if (cards.some(c => c.status === 'failed' || c.status === 'cancelled')) return 'bad'
  if (cards.some(c => c.status === 'review')) return 'review'
  if (cards.length && cards.every(c => c.status === 'done')) return 'done'
  return 'run'
}

/** The run currently representing a card: the live one, else the latest. */
export function cardRun(s: State, c: Card): Run | undefined {
  return (c.currentRunId && s.runs.get(c.currentRunId)) || (c.runIds.length ? s.runs.get(c.runIds[c.runIds.length - 1]) : undefined)
}

/** Who moved: the host dispatcher, the agent itself, a person, or the clock. */
export function actorOf(e: Event, s?: State): 'dispatcher' | 'agent' | 'person' | 'clock' {
  switch (e.t) {
    case 'task/created': case 'task/enabled': case 'task/deleted': case 'card/review_approved': case 'artifact/published': return 'person'
    case 'card/changes_requested': {
      if (e.reviewer) return 'agent'
      const run = s?.runs.get(e.runId)
      const card = s?.cards.get(e.cardId)
      return run?.profileId && card && run.profileId !== card.agentId ? 'agent' : 'person'
    }
    case 'batch/fired': return e.batch.by === 'cron' ? 'clock' : 'person'
    case 'run/blocked': case 'run/completed': case 'run/review_requested': case 'artifact/registered': case 'artifact/finalized': return 'agent'
    case 'run/resumed': return 'person'
    case 'run/cancelled': return 'person'
    default: return 'dispatcher'
  }
}

/** One line a person can read for each event. */
export function describe(e: Event, s: State, agentName: (id: string) => string): string {
  const who = (runId: string) => { const r = s.runs.get(runId); const c = r && s.cards.get(r.cardId); return r?.profileId ? agentName(r.profileId) : c ? agentName(c.agentId) : runId }
  const card = (cardId: string) => { const c = s.cards.get(cardId); return c ? agentName(c.agentId) : cardId }
  switch (e.t) {
    case 'task/created': return `建卡「${e.task.title}」,${e.task.participants.map(p => agentName(p.agentId)).join(' → ')}`
    case 'task/enabled': return e.enabled ? '启用时间表' : '停用时间表'
    case 'task/deleted': return '删除任务'
    case 'batch/fired': return `${({ cron: '到点', manual: '手动', retry: '重试' })[e.batch.by]}触发,${e.batch.cards.length} 张卡排好队`
    case 'card/created': return `数据库新增${e.card.kind === 'gate' ? '闸门' : '角色'}:${e.card.role ?? card(e.card.id)}`
    case 'gate/opened': return `闸门 ${e.cardId} 放行`
    case 'card/ready': return `${card(e.cardId)} 可以开始了(上一位已交卷)`
    case 'run/claimed': return `${e.profileId ? agentName(e.profileId) : card(e.cardId)} 开工${e.attempt > 1 ? `(第 ${e.attempt} 次)` : ''}`
    case 'run/session_created': return `${who(e.runId)} 的会话已创建:${e.sessionId}`
    case 'run/prompt_dispatched': return `任务书已发给 ${who(e.runId)}`
    case 'run/blocked': return `${who(e.runId)} 停下来${e.kind === 'needs_input' ? '问' : '等'}:${e.reason}`
    case 'run/resumed': return `${who(e.runId)} 收到回答,继续`
    case 'run/nudged': return `${who(e.runId)} 没交卷就停了,催一次`
    case 'run/completed': return `${who(e.runId)} 交卷(${e.summary.length} 字交接单)`
    case 'run/review_requested': return `${who(e.runId)} 提交验收(${e.summary.length} 字)`
    case 'card/review_approved': return `${card(e.cardId)} 验收通过${e.note ? ':' + e.note : ''}`
    case 'card/changes_requested': {
      const run = s.runs.get(e.runId)
      const reviewed = s.cards.get(e.cardId)
      const reviewer = e.reviewer ?? (run?.profileId && run.profileId !== reviewed?.agentId ? run.profileId : undefined)
      const target = card(e.targetCardId ?? e.cardId)
      return reviewer ? `${agentName(reviewer)} 退回 ${target}:${e.note}` : e.targetCardId && e.targetCardId !== e.cardId ? `${card(e.cardId)} 退回到 ${target}:${e.note}` : `${card(e.cardId)} 被退回修改:${e.note}`
    }
    case 'run/failed': return `${who(e.runId)} 失败${e.outcome === 'protocol_violation' ? '(没按协议交卷)' : ''}${e.error ? ':' + e.error : ''}`
    case 'run/timed_out': return `${who(e.runId)} 超时${e.error ? ':' + e.error : ''}`
    case 'run/crashed': return `${who(e.runId)} 进程没了${e.error ? ':' + e.error : ''}`
    case 'run/cancelled': return `${who(e.runId)} 取消`
    case 'card/gave_up': return `${card(e.cardId)} 连续失败,放弃:${e.error}`
    case 'card/cancelled': return `${card(e.cardId)} 未开始,取消`
    case 'artifact/registered': return `${card(e.artifact.cardId)} 登记产物:${e.artifact.name}`
    case 'artifact/finalized': return `${card(e.cardId)} 确认最终产物:${s.artifacts.get(e.artifactId)?.name ?? e.artifactId}`
    case 'artifact/published': return `产物已发布:${s.artifacts.get(e.artifactId)?.name ?? e.artifactId}`
    case 'batch/settled': return ({ done: '这次运行完成', failed: '这次运行失败', cancelled: '这次运行取消' })[e.outcome]
  }
}

// ── legacy (0.2–0.4) event stream → this model ───────────────────────────

/** Old-shape events, kept only for migration. */
type LegacyEvent = { t: string; at: string; [k: string]: any }

/** Convert a 0.2–0.4 `leg/*` stream into batch/card/run events. Idempotent on new-shape input. */
export function migrate(events: LegacyEvent[]): Event[] {
  const out: Event[] = []
  const legs = new Map<string, { taskId: string; agents: string[]; tries: number[] }>()   // old runId → info
  for (const e of events) {
    switch (e.t) {
      case 'task/created': out.push({ t: 'task/created', at: e.at, taskId: e.task.id, task: e.task }); break
      case 'task/enabled': case 'task/deleted': out.push(e as Event); break
      case 'run/fired': {
        if (e.run?.cards) { out.push(e as Event); break }   // already new
        const agents: string[] = e.run.legs; const cards = agents.map((agentId, i) => ({ id: `${e.run.id}#${i}`, agentId, deps: i ? [`${e.run.id}#${i - 1}`] : [] }))
        legs.set(e.run.id, { taskId: e.run.taskId, agents, tries: agents.map(() => 0) })
        out.push({ t: 'batch/fired', at: e.at, taskId: e.run.taskId, batch: { id: e.run.id, by: e.run.by, cards } })
        break
      }
      case 'leg/spawned': { const l = legs.get(e.runId); if (!l) break; l.tries[e.leg] = e.tries; out.push({ t: 'run/claimed', at: e.at, taskId: l.taskId, cardId: `${e.runId}#${e.leg}`, runId: `${e.runId}#${e.leg}#${e.tries}`, sessionId: e.sessionId, attempt: e.tries }); break }
      case 'leg/blocked': { const l = legs.get(e.runId); if (!l) break; out.push({ t: 'run/blocked', at: e.at, taskId: l.taskId, runId: `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}`, kind: 'needs_input', reason: e.question }); break }
      case 'leg/resumed': { const l = legs.get(e.runId); if (!l) break; out.push({ t: 'run/resumed', at: e.at, taskId: l.taskId, runId: `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}` }); break }
      case 'leg/done': { const l = legs.get(e.runId); if (!l) break; out.push({ t: 'run/completed', at: e.at, taskId: l.taskId, runId: `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}`, summary: e.handoff ?? '' }); break }
      case 'leg/failed': case 'leg/timed_out': case 'leg/lost': case 'leg/cancelled': {
        const l = legs.get(e.runId); if (!l) break
        const runId = `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}`
        if (e.t === 'leg/cancelled' && !l.tries[e.leg]) { out.push({ t: 'card/cancelled', at: e.at, taskId: l.taskId, cardId: `${e.runId}#${e.leg}` }); break }
        const t = e.t === 'leg/lost' ? 'run/crashed' : e.t === 'leg/timed_out' ? 'run/timed_out' : e.t === 'leg/cancelled' ? 'run/cancelled' : 'run/failed'
        out.push({ t, at: e.at, taskId: l.taskId, runId, error: e.error } as Event)
        if (t !== 'run/cancelled') out.push({ t: 'card/gave_up', at: e.at, taskId: l.taskId, cardId: `${e.runId}#${e.leg}`, error: e.error ?? t })
        break
      }
      case 'run/settled': { const l = legs.get(e.runId); if (!l) { out.push(e as Event); break } out.push({ t: 'batch/settled', at: e.at, taskId: l.taskId, batchId: e.runId, outcome: e.outcome }); break }
      default: out.push(e as Event)
    }
  }
  return out
}

// ── turn ledger (folded from a session's own log) ────────────────────────

export interface ToolRow { callId: string; name: string; kind: 'mcp' | 'skill' | 'native' | 'ask' | 'task'; server?: string; args: string; result: string; ok: boolean; ms: number; at: string }
export interface StepRow { step: number; provider?: string; model?: string; at: string; ms: number; usage: { input: number; output: number; reasoning: number; cacheRead: number }; tools: ToolRow[]; text: string }
export interface TurnRow { turn: number; at: string; endedAt?: string; reason?: string; user: string; steps: StepRow[] }
export interface TurnLedger { sessionId: string; agentPreset?: string; turns: TurnRow[]; totals: { turns: number; steps: number; mcp: number; skill: number; native: number; ask: number; task: number; input: number; output: number; ms: number; byServer: Record<string, number>; skills: string[] } }

const preview = (s: unknown, n: number) => { const t = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }

export function foldTurns(sessionId: string, events: any[], agentPreset?: string): TurnLedger {
  const turns: TurnRow[] = []
  const byCall = new Map<string, ToolRow & { _t?: number }>()
  const totals: TurnLedger['totals'] = { turns: 0, steps: 0, mcp: 0, skill: 0, native: 0, ask: 0, task: 0, input: 0, output: 0, ms: 0, byServer: {}, skills: [] }
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
        const kind: ToolRow['kind'] = name.endsWith('ask_user_question') ? 'ask' : /^task_(complete|block|request_review)$/.test(name) ? 'task' : m ? 'mcp' : name === 'skill' ? 'skill' : 'native'
        const row: ToolRow & { _t?: number } = { callId: d.callId, name: m ? m[2] : name, kind, server: m?.[1], args: preview(d.arguments, 240), result: '', ok: true, ms: 0, at: iso(e.time), _t: e.time }
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
        row.result = preview(txt, 400); row.ms = e.time - (row._t ?? e.time); delete row._t
        row.ok = !/"ok":\s*false|^error|exit code [1-9]|Traceback|failed/i.test(txt.slice(0, 200))
        break
      }
      case 'step/end': if (step && !step.ms) step.ms = e.time - +new Date(step.at); step = undefined; break
      case 'turn/end': if (cur) { cur.endedAt = iso(e.time); cur.reason = d.reason?.kind; totals.ms += e.time - +new Date(cur.at) } cur = undefined; break
    }
  }
  return { sessionId, agentPreset, turns, totals }
}
