/**
 * The dispatcher — the host-resident loop that turns a fired batch into
 * runs. Deterministic: no model decides who goes next.
 *
 * One tick (hermes' `_dispatch_once`): reap runs whose session is gone →
 * promote cards whose deps are done → claim ready cards up to the
 * concurrency cap → start a root session on the card's agent preset with
 * the three terminator tools → watchdog. Every transition is an event.
 *
 * @module dsh-task-console/runner
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { captureArtifacts } from './artifacts.ts'
import { readSpec } from './presets.ts'
import { BLOCK_RECURRENCE_LIMIT, EventStore, NUDGE, cardMessage, cronMatches, parseCron, readyCards, type Batch, type BlockKind, type Card, type Run, type TaskSpec } from './tasks.ts'
import { registerWorkerTools } from './worker-tools.ts'

interface Flight {
  runId: string
  cardId: string
  taskId: string
  sessionId: string
  messageId: string
  consumed: boolean
  handle: any
  disposeTools?: () => void
  lastText: string
  /** Set by a terminator tool; the turn's end then finalizes the run. */
  terminal?: { kind: 'completed' | 'review' | 'blocked'; summary?: string; reason?: string; blockKind?: BlockKind; metadata?: Record<string, unknown> }
  pendingAsk?: string
  timer?: ReturnType<typeof setTimeout>
  timeoutSec: number
}

export interface RunnerOptions {
  maxInProgress?: number
  now?: () => number
}

export class TaskRunner {
  private readonly ctx: Context
  readonly store: EventStore
  private flights = new Map<string, Flight>()
  private ticker?: ReturnType<typeof setInterval>
  private firedMinute = new Map<string, string>()
  private disposeListener?: () => void
  private ticking = false
  readonly maxInProgress: number
  private readonly clock: () => number

  constructor(ctx: Context, store: EventStore, opts: RunnerOptions = {}) {
    this.ctx = ctx; this.store = store
    this.maxInProgress = opts.maxInProgress ?? 3
    this.clock = opts.now ?? (() => Date.now())
  }

  async start(): Promise<void> {
    await this.store.load()
    // Runs still live in the fold belonged to a previous process: they crashed.
    for (const r of this.store.s.runs.values()) {
      if (r.status === 'running' || r.status === 'blocked') await this.append({ t: 'run/crashed', taskId: r.taskId, runId: r.id, error: '宿主重启,会话不在了' })
    }
    await this.settleBatches()
    this.disposeListener = (this.ctx as any).on('session/event', (session: any, event: any) => this.onSessionEvent(session, event))
    this.ticker = setInterval(() => { void this.tick() }, 60_000)
    ;(this.ticker as any).unref?.()
    ;(this.ctx as any).effect?.(() => () => this.stop(), 'task-console: runner')
    await this.tick()
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.disposeListener?.()
    for (const f of this.flights.values()) { if (f.timer) clearTimeout(f.timer); f.disposeTools?.() }
  }

  private now(): string { return new Date(this.clock()).toISOString() }
  private append(e: any): Promise<void> { return this.store.append({ at: this.now(), ...e }) }

  // ── the tick ──────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.fireDueCron()
      await this.dispatch()
    } finally { this.ticking = false }
  }

  private async fireDueCron(): Promise<void> {
    const d = new Date(this.clock()); const key = d.toISOString().slice(0, 16)
    for (const task of this.store.tasks.values()) {
      if (task.trigger.kind !== 'cron' || !task.enabled) continue
      const c = parseCron(task.trigger.expr); if (!c || !cronMatches(c, d)) continue
      if (this.firedMinute.get(task.id) === key) continue
      this.firedMinute.set(task.id, key)
      await this.fire(task.id, 'cron').catch(err => console.warn('[task-console] cron fire failed:', err))
    }
  }

  /** Promote, claim, spawn — bounded by the in-progress cap. */
  private async dispatch(): Promise<void> {
    const s = this.store.s
    for (const c of readyCards(s)) if (c.status === 'todo') await this.append({ t: 'card/ready', taskId: c.taskId, cardId: c.id })
    let inProgress = [...this.store.s.runs.values()].filter(r => r.status === 'running' || r.status === 'blocked').length
    const ready = readyCards(this.store.s).sort((a, b) => a.batchId.localeCompare(b.batchId) || a.index - b.index)
    for (const c of ready) {
      if (inProgress >= this.maxInProgress) break
      const task = this.store.tasks.get(c.taskId); if (!task) continue
      const batch = this.store.s.batches.get(c.batchId); if (!batch || batch.settled) continue
      if (c.consecutiveFailures > 0 && (task.onFail !== 'retry' || c.consecutiveFailures >= task.maxTries)) {
        await this.append({ t: 'card/gave_up', taskId: c.taskId, cardId: c.id, error: c.error ?? `连续失败 ${c.consecutiveFailures} 次` })
        await this.settleBatches(); continue
      }
      await this.startRun(task, batch, c)
      inProgress++
    }
    await this.settleBatches()
  }

  /** Close batches whose cards are all terminal; cancel cards a failure made unreachable. */
  private async settleBatches(): Promise<void> {
    for (const b of this.store.s.batches.values()) {
      if (b.settled) continue
      const cards = b.cardIds.map(id => this.store.s.cards.get(id)).filter(Boolean) as Card[]
      if (!cards.length) continue
      const dead = cards.filter(c => c.status === 'failed' || c.status === 'cancelled')
      if (dead.length) {
        for (const c of cards) if (c.status === 'todo' || c.status === 'ready') await this.append({ t: 'card/cancelled', taskId: b.taskId, cardId: c.id })
        const stillLive = cards.some(c => c.status === 'running' || c.status === 'blocked')
        if (!stillLive) await this.append({ t: 'batch/settled', taskId: b.taskId, batchId: b.id, outcome: dead.some(c => c.status === 'failed') ? 'failed' : 'cancelled' })
        continue
      }
      if (cards.every(c => c.status === 'done')) await this.append({ t: 'batch/settled', taskId: b.taskId, batchId: b.id, outcome: 'done' })
    }
  }

  // ── firing ────────────────────────────────────────────────────────────

  /** Create a batch (one card per participant, chained) and dispatch. */
  async fire(taskId: string, by: Batch['by']): Promise<Batch> {
    const task = this.store.tasks.get(taskId)
    if (!task) throw new Error('没有这个任务')
    const batchId = `b-${this.clock().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const cards = task.participants.map((p, i) => ({ id: `${batchId}#${i}`, agentId: p.agentId, ...(p.brief ? { brief: p.brief } : {}), deps: i ? [`${batchId}#${i - 1}`] : [] }))
    await this.append({ t: 'batch/fired', taskId, batch: { id: batchId, by, cards } })
    const problem = await this.preflight(task)
    if (problem) {
      const first = cards[0]
      await this.append({ t: 'run/claimed', taskId, cardId: first.id, runId: `${first.id}#0`, sessionId: '', attempt: 0 })
      await this.append({ t: 'run/failed', taskId, runId: `${first.id}#0`, error: `预检不过:${problem}` })
      await this.append({ t: 'card/gave_up', taskId, cardId: first.id, error: `预检不过:${problem}` })
      await this.settleBatches()
    } else {
      await this.tick()
    }
    return this.store.s.batches.get(batchId)!
  }

  private async preflight(task: TaskSpec): Promise<string | null> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return '这个部署没有 preset 服务'
    for (const p of task.participants) {
      try { const r = await presets.resolve(p.agentId); if (r.broken) return `preset ${p.agentId} 坏了:${r.broken}` } catch { return `preset ${p.agentId} 不在名册上` }
    }
    try { const { stat } = await import('node:fs/promises'); if (!(await stat(task.cwd)).isDirectory()) return `工作目录不存在:${task.cwd}` } catch { return `工作目录不存在:${task.cwd}` }
    return null
  }

  // ── one run ───────────────────────────────────────────────────────────

  private async startRun(task: TaskSpec, batch: Batch, card: Card): Promise<void> {
    const presets = (this.ctx as any).get('agentPresets')
    const preset = await presets.resolve(card.agentId)
    const spec = await readSpec(dirname(String(preset.path)))
    const agentName = spec?.name ?? preset.name ?? preset.id
    let selection: any = (() => { try { return (this.ctx as any).get('agentDefaultModel')?.currentSelection?.() } catch { return undefined } })()
    if (spec?.model?.includes('/')) { const [provider, ...rest] = spec.model.split('/'); selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) } }

    const attempt = card.runIds.length + 1
    const runId = `${card.id}#${attempt}`
    const sessionId = `task-${task.id}-${batch.id}-${card.index + 1}${attempt > 1 ? `-t${attempt}` : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    this.nameCache.set(card.agentId, agentName)
    const upstream: { agentName: string; summary: string }[] = []
    for (const d of card.deps.map(x => this.store.s.cards.get(x)).filter(Boolean) as Card[]) upstream.push({ agentName: await this.displayName(d.agentId), summary: d.summary ?? '' })
    const text = cardMessage(task, card, batch.id, upstream)
    const messageId = randomUUID()
    const flight: Flight = { runId, cardId: card.id, taskId: task.id, sessionId, messageId, consumed: false, handle: undefined, lastText: '', timeoutSec: task.timeoutSec }
    this.flights.set(sessionId, flight)
    try {
      // Claim is durable before a process/session is created; later events make each boundary observable.
      await this.append({ t: 'run/claimed', taskId: task.id, cardId: card.id, runId, sessionId, attempt })
      flight.handle = await (this.ctx as any).agents.create({
        sessionId,
        ...(selection ? { agentOptions: selection } : {}),
        meta: { cwd: task.cwd, agentPreset: preset.id },
        setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
      })
      await this.append({ t: 'run/session_created', taskId: task.id, runId, sessionId })
      // The terminators live on this agent's scope only.
      try {
        const submit = async (kind: 'completed' | 'review', summary: string, paths: string[], metadata?: Record<string, unknown>) => {
          if (flight.terminal) throw new Error('这次运行已经提交了终态')
          const at = this.now()
          const captured = await captureArtifacts({ root: this.store.root, task, batchId: batch.id, cardId: card.id, runId, sessionId, at }, paths)
          for (const artifact of captured) await this.append({ t: 'artifact/registered', at, taskId: task.id, artifact })
          flight.terminal = { kind, summary, metadata }
        }
        flight.disposeTools = await registerWorkerTools(flight.handle.agent.ctx, {
          complete: async (summary, artifacts, metadata) => submit('completed', summary, artifacts, metadata),
          requestReview: async (summary, artifacts, metadata) => submit('review', summary, artifacts, metadata),
          block: async (reason, kind) => { flight.terminal = { kind: 'blocked', reason, blockKind: kind }; if (kind === 'needs_input') this.disarm(flight); await this.append({ t: 'run/blocked', taskId: task.id, runId, kind, reason }) },
        })
      } catch (error) { console.warn('[task-console] worker tools not registered:', error) }
      try { (this.ctx as any).get('sessionTitle')?.rename?.(flight.handle.agent.session, `task: ${task.title} · ${batch.id} · ${agentName}`) } catch { /* cosmetic */ }
      try {
        const registry = (this.ctx as any).get('workspaceRegistry')
        const ws = registry ? (await registry.resolveByPath(task.cwd).catch(() => undefined)) ?? (await registry.create(task.cwd).catch(() => undefined)) : undefined
        await ws?.attachSession?.(sessionId)
      } catch { /* cosmetic */ }
      flight.handle.agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      await this.append({ t: 'run/prompt_dispatched', taskId: task.id, runId, messageId })
      this.arm(flight)
    } catch (error) {
      this.flights.delete(sessionId)
      if (!this.store.s.runs.has(runId)) await this.append({ t: 'run/claimed', taskId: task.id, cardId: card.id, runId, sessionId, attempt })
      await this.append({ t: 'run/failed', taskId: task.id, runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The watchdog counts working time only: it pauses while a person is being waited on. */
  private arm(f: Flight): void {
    if (f.timer) clearTimeout(f.timer)
    f.timer = setTimeout(() => { void this.finish(f, 'run/timed_out', 'timed_out', `${f.timeoutSec} 秒没交卷`) }, f.timeoutSec * 1000)
    ;(f.timer as any).unref?.()
  }
  private disarm(f: Flight): void { if (f.timer) { clearTimeout(f.timer); f.timer = undefined } }

  private nameCache = new Map<string, string>()
  private async displayName(id: string): Promise<string> {
    const hit = this.nameCache.get(id); if (hit) return hit
    try { const p = await (this.ctx as any).get('agentPresets').resolve(id); const spec = await readSpec(dirname(String(p.path))); const name = spec?.name ?? p.name ?? id; this.nameCache.set(id, name); return name } catch { return id }
  }

  // ── session events ────────────────────────────────────────────────────

  private onSessionEvent(session: any, event: any): void {
    const f = this.flights.get(session?.id); if (!f) return
    const run = this.store.s.runs.get(f.runId)
    switch (event.type) {
      case 'user/message':
        if (event.data?.id === f.messageId) f.consumed = true
        else if (run?.status === 'blocked' && event.data?.source?.kind === 'user' && f.terminal?.kind === 'blocked') {
          // A person answered in the session: the block is over, the run continues.
          f.terminal = undefined
          this.arm(f)
          void this.append({ t: 'run/resumed', taskId: f.taskId, runId: f.runId })
        }
        break
      case 'tool/call':
        if (String(event.data?.name ?? '').endsWith('ask_user_question')) {
          let q = ''
          try { const a = JSON.parse(event.data.arguments ?? '{}'); q = a.questions?.[0]?.question ?? a.question ?? JSON.stringify(a).slice(0, 200) } catch { q = String(event.data.arguments ?? '').slice(0, 200) }
          f.pendingAsk = event.data.callId
          this.disarm(f)
          void this.append({ t: 'run/blocked', taskId: f.taskId, runId: f.runId, kind: 'needs_input', reason: q })
        }
        break
      case 'tool/result':
        if (f.pendingAsk && event.data?.message?.source?.callId === f.pendingAsk) {
          f.pendingAsk = undefined
          this.arm(f)
          void this.append({ t: 'run/resumed', taskId: f.taskId, runId: f.runId })
        }
        break
      case 'assistant/message': {
        const blocks = event.data?.message?.content
        if (Array.isArray(blocks)) { const t = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim(); if (t) f.lastText = t }
        break
      }
      case 'turn/end':
        if (!f.consumed) break
        void this.onTurnEnd(f, event.data?.reason)
        break
    }
  }

  private async onTurnEnd(f: Flight, reason: any): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    if (reason && reason.kind !== 'completed') { await this.finish(f, 'run/failed', 'failed', JSON.stringify(reason)); return }
    const t = f.terminal
    if (t?.kind === 'completed') { await this.finish(f, 'run/completed', 'completed', undefined, t.summary, false, t.metadata); return }
    if (t?.kind === 'review') { await this.finish(f, 'run/review_requested', 'review', undefined, t.summary, false, t.metadata); return }
    if (t?.kind === 'blocked') {
      if (t.blockKind === 'needs_input') return   // stay parked; the person's next message resumes it
      const card = this.store.s.cards.get(f.cardId)
      if (t.blockKind === 'transient' || t.blockKind === 'dependency') { await this.finish(f, 'run/failed', 'blocked', t.reason); return }
      if (card && card.blockRecurrences >= BLOCK_RECURRENCE_LIMIT) { await this.finish(f, 'run/failed', 'blocked', t.reason); return }
      await this.finish(f, 'run/failed', 'blocked', t.reason, undefined, true); return   // capability: no retry
    }
    const run = this.store.s.runs.get(f.runId)
    if (run?.status === 'blocked') return   // ask_user_question in flight
    if ((run?.nudges ?? 0) < 1) {
      await this.append({ t: 'run/nudged', taskId: f.taskId, runId: f.runId })
      f.handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: NUDGE }], source: { kind: 'user' } })
      return
    }
    await this.finish(f, 'run/failed', 'protocol_violation', '停了两次都没有调用 task_complete / task_block')
  }

  private async finish(f: Flight, t: 'run/completed' | 'run/review_requested' | 'run/failed' | 'run/timed_out' | 'run/cancelled', outcome: string, error?: string, summary?: string, giveUpNow = false, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    f.disposeTools?.()
    try { await f.handle?.dispose?.() } catch { /* already gone */ }
    if (t === 'run/completed' || t === 'run/review_requested') {
      await this.append({ t, taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...(metadata ? { metadata } : {}) })
    } else {
      await this.append({ t, taskId: f.taskId, runId: f.runId, outcome, error })
      if (giveUpNow) { const c = this.store.s.cards.get(f.cardId); if (c && c.status !== 'failed') await this.append({ t: 'card/gave_up', taskId: f.taskId, cardId: f.cardId, error: error ?? outcome }) }
    }
    await this.tick()
  }

  async cancelBatch(batchId: string): Promise<void> {
    const b = this.store.s.batches.get(batchId); if (!b) return
    for (const f of [...this.flights.values()]) { const r = this.store.s.runs.get(f.runId); if (r?.batchId === batchId) await this.finish(f, 'run/cancelled', 'cancelled', '人工取消') }
    for (const id of b.cardIds) { const c = this.store.s.cards.get(id); if (c && (c.status === 'todo' || c.status === 'ready' || c.status === 'review')) await this.append({ t: 'card/cancelled', taskId: b.taskId, cardId: id }) }
    if (!this.store.s.batches.get(batchId)?.settled) await this.append({ t: 'batch/settled', taskId: b.taskId, batchId, outcome: 'cancelled' })
  }

  /** Resolve the explicit human review gate for one card. */
  async reviewCard(cardId: string, decision: 'approve' | 'changes', note = '', targetCardId?: string): Promise<void> {
    const card = this.store.s.cards.get(cardId)
    if (!card || card.status !== 'review' || !card.currentRunId && !card.runIds.length) throw new Error('这张卡不在待验收状态')
    const runId = card.runIds[card.runIds.length - 1]
    if (decision === 'approve') await this.append({ t: 'card/review_approved', taskId: card.taskId, cardId, runId, ...(note.trim() ? { note: note.trim() } : {}) })
    else {
      if (!note.trim()) throw new Error('退回修改时必须写明原因')
      const target = this.store.s.cards.get(targetCardId ?? card.deps[0] ?? card.id)
      if (!target || target.batchId !== card.batchId || target.index > card.index) throw new Error('返工目标必须是同一运行中当前角色或它的上游')
      await this.append({ t: 'card/changes_requested', taskId: card.taskId, cardId, runId, note: note.trim(), targetCardId: target.id })
    }
    await this.tick()
  }

  /** Remember display names so upstream handoffs read "from 巡检员", not "from inspector". */
  rememberName(id: string, name: string): void { this.nameCache.set(id, name) }
}
