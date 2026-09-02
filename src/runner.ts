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
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { applyAgentPermission } from './agent-session.ts'
import { captureArtifacts } from './artifacts.ts'
import { readSpec } from './presets.ts'
import { EventStore, NUDGE, cardMessage, cronMatches, parseCron, type Batch, type BlockKind, type Card, type TaskSpec } from './tasks.ts'
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
  coreRunId: number
  claimLock: string
  profileId: string
  /** Set by a terminator tool; the turn's end then finalizes the run. */
  terminal?: { kind: 'completed' | 'review' | 'changes' | 'blocked'; summary?: string; reason?: string; blockKind?: BlockKind; metadata?: Record<string, unknown>; reviewer?: string }
  pendingAsk?: string
  timer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
  timeoutSec: number
}

export interface RunnerOptions {
  maxInProgress?: number
  now?: () => number
  onBatchSettled?: (batch: Batch) => void | Promise<void>
  onSessionCreated?: (sessionId: string) => void | Promise<void>
}

export class TaskRunner {
  private readonly ctx: Context
  readonly store: EventStore
  private flights = new Map<string, Flight>()
  private ticker?: ReturnType<typeof setInterval>
  private firedMinute = new Map<string, string>()
  private disposeListener?: () => void
  private ticking = false
  private dispatchSuspended = 0
  readonly maxInProgress: number
  private readonly clock: () => number
  private readonly onBatchSettled?: (batch: Batch) => void | Promise<void>
  private readonly onSessionCreated?: (sessionId: string) => void | Promise<void>

  constructor(ctx: Context, store: EventStore, opts: RunnerOptions = {}) {
    this.ctx = ctx; this.store = store
    this.maxInProgress = opts.maxInProgress ?? 3
    this.clock = opts.now ?? (() => Date.now())
    this.onBatchSettled = opts.onBatchSettled
    this.onSessionCreated = opts.onSessionCreated
  }

  async start(): Promise<void> {
    await this.store.load()
    // Runs still live in the projection belonged to a previous host process.
    // Close the normalized core run first; the UI event is only its projection.
    for (const r of this.store.s.runs.values()) {
      if (r.status !== 'running' && r.status !== 'blocked') continue
      const coreRunId = this.store.coreRunId(r.id)
      if (coreRunId === undefined) continue
      await this.store.transition(
        () => this.store.kernel.failRun(r.cardId, { expectedRunId: coreRunId, outcome: 'crashed', error: '宿主重启,会话不在了' }),
        result => result.ok ? { t: 'run/crashed', at: this.now(), taskId: r.taskId, runId: r.id, error: '宿主重启,会话不在了' } : undefined,
      )
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
    for (const f of this.flights.values()) { this.disarm(f); this.stopHeartbeat(f); f.disposeTools?.() }
  }

  private now(): string { return new Date(this.clock()).toISOString() }
  private append(e: any): Promise<void> { return this.store.append({ at: this.now(), ...e }) }

  private async settleBatch(batch: Batch, outcome: 'done' | 'failed' | 'cancelled'): Promise<void> {
    if (this.store.s.batches.get(batch.id)?.settled) return
    await this.append({ t: 'batch/settled', taskId: batch.taskId, batchId: batch.id, outcome })
    try { await this.onBatchSettled?.(this.store.s.batches.get(batch.id) ?? batch) }
    catch (error) { console.warn(`[task-console] session archive failed for batch ${batch.id}:`, error) }
  }

  // ── the tick ──────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking || this.dispatchSuspended > 0) return
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
    await this.store.openReadyGates()
    const s = this.store.s
    this.store.kernel.promoteReadyTasks()
    const core = this.store.kernel.listTasks()
    for (const task of core.filter(row => row.status === 'ready')) {
      const card = s.cards.get(task.id)
      if (card?.status === 'todo') await this.append({ t: 'card/ready', taskId: card.taskId, cardId: card.id })
    }
    let inProgress = core.filter(row => row.status === 'running').length
    const automatedReview = (cardId: string) => {
      const event = this.store.kernel.listEvents(cardId).filter(row => row.kind === 'review_requested').at(-1)
      if (!event?.payload) return false
      try { return !!JSON.parse(event.payload).reviewer } catch { return false }
    }
    const ready = core.filter(row => row.status === 'ready' || (row.status === 'review' && automatedReview(row.id)))
      .map(row => s.cards.get(row.id)).filter(Boolean) as Card[]
    ready.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.index - b.index)
    for (const c of ready) {
      if (inProgress >= this.maxInProgress) break
      const task = this.store.tasks.get(c.taskId); if (!task) continue
      const batch = this.store.s.batches.get(c.batchId); if (!batch || batch.settled) continue
      if (c.consecutiveFailures > 0 && (task.onFail !== 'retry' || c.consecutiveFailures >= task.maxTries)) {
        const failure = c.error ?? `连续失败 ${c.consecutiveFailures} 次`
        await this.store.transition(
          () => this.store.kernel.giveUpTask(c.id, failure),
          ok => ok ? { t: 'card/gave_up', at: this.now(), taskId: c.taskId, cardId: c.id, error: failure } : undefined,
        )
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
        for (const c of cards) if (c.status === 'todo' || c.status === 'ready') {
          await this.store.transition(
            () => this.store.kernel.cancelTask(c.id, '上游失败，任务不可达'),
            ok => ok ? { t: 'card/cancelled', at: this.now(), taskId: b.taskId, cardId: c.id } : undefined,
          )
        }
        const stillLive = cards.some(c => c.status === 'running' || c.status === 'blocked')
        if (!stillLive) await this.settleBatch(b, dead.some(c => c.status === 'failed') ? 'failed' : 'cancelled')
        continue
      }
      if (cards.every(c => c.status === 'done')) await this.settleBatch(b, 'done')
    }
  }

  // ── firing ────────────────────────────────────────────────────────────

  /** Create a batch (one card per participant, chained) and dispatch. */
  async fire(taskId: string, by: Batch['by']): Promise<Batch> {
    const task = this.store.tasks.get(taskId)
    if (!task) throw new Error('没有这个任务')
    const batchId = `b-${this.clock().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const cards = task.graphMode === 'dynamic-rounds'
      ? [{ id: `${batchId}#p1`, agentId: task.participants[0].agentId, ...(task.participants[0].brief ? { brief: task.participants[0].brief } : {}), deps: [], kind: 'agent' as const, role: 'planner' as const, round: 1 }]
      : task.participants.map((p, i) => ({ id: `${batchId}#${i}`, agentId: p.agentId, ...(p.brief ? { brief: p.brief } : {}), deps: i ? [`${batchId}#${i - 1}`] : [] }))
    await this.store.createBatch(task, { t: 'batch/fired', at: this.now(), taskId, batch: { id: batchId, by, cards } })
    const problem = await this.preflight(task)
    if (problem) {
      const first = cards[0]
      const runId = `${first.id}#1`
      const failure = `预检不过:${problem}`
      const claim = await this.store.claimCard(first.id, runId, '', 1)
      if (claim) {
        await this.store.transition(
          () => this.store.kernel.failRun(first.id, { expectedRunId: claim.run.id, outcome: 'failed', error: failure }),
          result => result.ok ? { t: 'run/failed', at: this.now(), taskId, runId, outcome: 'failed', error: failure } : undefined,
        )
        await this.store.transition(
          () => this.store.kernel.giveUpTask(first.id, failure),
          ok => ok ? { t: 'card/gave_up', at: this.now(), taskId, cardId: first.id, error: failure } : undefined,
        )
      }
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
    const coreTask = this.store.kernel.getTask(card.id)
    if (!coreTask || !['ready', 'review'].includes(coreTask.status)) return
    const fromReview = coreTask.status === 'review'
    const profileId = coreTask.assignee ?? card.agentId
    const preset = await presets.resolve(profileId)
    const spec = await readSpec(dirname(String(preset.path)))
    const agentName = spec?.name ?? preset.name ?? preset.id
    let selection: any = (() => { try { return (this.ctx as any).get('agentDefaultModel')?.currentSelection?.() } catch { return undefined } })()
    if (spec?.model?.includes('/')) { const [provider, ...rest] = spec.model.split('/'); selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) } }

    const attempt = this.store.kernel.listRuns(card.id).length + 1
    const runId = `${card.id}#${attempt}`
    const sessionId = `task-${task.id}-${batch.id}-${card.index + 1}${attempt > 1 ? `-t${attempt}` : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    this.nameCache.set(profileId, agentName)
    const upstream: { agentName: string; summary: string }[] = []
    for (const d of card.deps.map(x => this.store.s.cards.get(x)).filter(Boolean) as Card[]) upstream.push({ agentName: await this.displayName(d.agentId), summary: d.summary ?? '' })
    const text = `${this.store.kernel.buildWorkerContext(card.id)}\n${cardMessage(task, card, batch.id, upstream)}`
    const messageId = randomUUID()
    const claim = await this.store.claimCard(card.id, runId, sessionId, attempt, fromReview)
    if (!claim) return
    const flight: Flight = {
      runId, cardId: card.id, taskId: task.id, sessionId, messageId, consumed: false,
      handle: undefined, lastText: '', timeoutSec: task.timeoutSec,
      coreRunId: claim.run.id, claimLock: claim.lock, profileId,
    }
    this.flights.set(sessionId, flight)
    this.startHeartbeat(flight)
    try {
      // The normalized CAS claim is durable before a DSH session is created.
      flight.handle = await (this.ctx as any).agents.create({
        sessionId,
        ...(selection ? { agentOptions: selection } : {}),
        meta: { cwd: task.cwd, agentPreset: preset.id },
        setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
      })
      applyAgentPermission(this.ctx, spec, flight.handle.agent.session)
      await this.onSessionCreated?.(sessionId)
      this.store.kernel.recordEvent(card.id, 'session_created', { session_id: sessionId }, flight.coreRunId)
      await this.append({ t: 'run/session_created', taskId: task.id, runId, sessionId })
      // The terminators live on this agent's scope only.
      try {
        const submit = async (kind: 'completed' | 'review', summary: string, paths: string[], metadata?: Record<string, unknown>, reviewer?: string) => {
          if (flight.terminal) throw new Error('这次运行已经提交了终态')
          const at = this.now()
          const captured = await captureArtifacts({ root: this.store.root, task, batchId: batch.id, cardId: card.id, runId, sessionId, at }, paths)
          for (const artifact of captured) await this.append({ t: 'artifact/registered', at, taskId: task.id, artifact })
          flight.terminal = { kind, summary, metadata, reviewer }
        }
        flight.disposeTools = await registerWorkerTools(flight.handle.agent.ctx, {
          complete: async (summary, artifacts, metadata) => submit('completed', summary, artifacts, metadata),
          requestReview: async (summary, artifacts, metadata, reviewer) => submit('review', summary, artifacts, metadata, reviewer),
          requestChanges: async (reason) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            flight.terminal = { kind: 'changes', reason }
          },
          block: async (reason, kind) => { flight.terminal = { kind: 'blocked', reason, blockKind: kind } },
          planRound: async (summary) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            await this.store.expandRound(task, batch, card, summary)
            flight.terminal = { kind: 'completed', summary, metadata: { decision: card.round === 1 ? 'planned' : 'rework', round: card.round } }
          },
          finalize: async (summary, artifactPath) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            let finalArtifactId: string | undefined
            if (artifactPath) {
              let originalPath: string
              try { originalPath = await realpath(resolve(task.cwd, artifactPath)) } catch { throw new Error(`最终产物不存在:${artifactPath}`) }
              const candidates = [...this.store.s.artifacts.values()].filter(row => row.batchId === batch.id && row.originalPath === originalPath)
              const selected = candidates.sort((a, b) => {
                const ac = this.store.s.cards.get(a.cardId); const bc = this.store.s.cards.get(b.cardId)
                const executor = Number(ac?.role === 'executor') - Number(bc?.role === 'executor')
                return executor || (ac?.round ?? 0) - (bc?.round ?? 0) || a.createdAt.localeCompare(b.createdAt)
              }).at(-1)
              if (!selected) throw new Error(`最终产物尚未通过 task_complete 登记:${artifactPath}`)
              finalArtifactId = selected.id
            }
            flight.terminal = { kind: 'completed', summary, metadata: { decision: 'approved', round: card.round, ...(finalArtifactId ? { finalArtifactId } : {}) } }
          },
        }, { planner: task.graphMode === 'dynamic-rounds' && card.role === 'planner' })
      } catch (error) { console.warn('[task-console] worker tools not registered:', error) }
      try { (this.ctx as any).get('sessionTitle')?.rename?.(flight.handle.agent.session, `task: ${task.title} · ${batch.id} · ${agentName}`) } catch { /* cosmetic */ }
      try {
        const registry = (this.ctx as any).get('workspaceRegistry')
        const ws = registry ? (await registry.resolveByPath(task.cwd).catch(() => undefined)) ?? (await registry.create(task.cwd).catch(() => undefined)) : undefined
        await ws?.attachSession?.(sessionId)
      } catch { /* cosmetic */ }
      flight.handle.agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      this.store.kernel.recordEvent(card.id, 'prompt_dispatched', { message_id: messageId }, flight.coreRunId)
      await this.append({ t: 'run/prompt_dispatched', taskId: task.id, runId, messageId })
      this.arm(flight)
    } catch (error) {
      try { await flight.handle?.dispose?.() } catch { /* original startup error wins */ }
      this.flights.delete(sessionId)
      this.stopHeartbeat(flight)
      this.store.kernel.failRun(card.id, { expectedRunId: flight.coreRunId, outcome: 'failed', error: error instanceof Error ? error.message : String(error) })
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

  private startHeartbeat(f: Flight): void {
    this.stopHeartbeat(f)
    f.heartbeatTimer = setInterval(() => {
      if (!this.store.kernel.heartbeat(f.cardId, f.coreRunId, f.claimLock, undefined, `session=${f.sessionId}`)) {
        console.warn(`[task-console] heartbeat refused: ${f.cardId} core run ${f.coreRunId}`)
      }
    }, 60_000)
    ;(f.heartbeatTimer as any).unref?.()
  }

  private stopHeartbeat(f: Flight): void {
    if (f.heartbeatTimer) { clearInterval(f.heartbeatTimer); f.heartbeatTimer = undefined }
  }

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
    if (t?.kind === 'review') { await this.finish(f, 'run/review_requested', 'review', undefined, t.summary, false, t.metadata, t.reviewer); return }
    if (t?.kind === 'changes') { await this.finishChanges(f, t.reason ?? 'changes requested'); return }
    if (t?.kind === 'blocked') { await this.finishBlocked(f, t.reason ?? 'blocked', t.blockKind ?? 'needs_input'); return }
    const run = this.store.s.runs.get(f.runId)
    if (run?.status === 'blocked') return   // ask_user_question in flight
    if ((run?.nudges ?? 0) < 1) {
      await this.append({ t: 'run/nudged', taskId: f.taskId, runId: f.runId })
      f.handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: NUDGE }], source: { kind: 'user' } })
      return
    }
    await this.finish(f, 'run/failed', 'protocol_violation', '停了两次都没有调用 task_complete / task_block')
  }

  private async finish(f: Flight, t: 'run/completed' | 'run/review_requested' | 'run/failed' | 'run/timed_out' | 'run/cancelled', outcome: string, error?: string, summary?: string, giveUpNow = false, metadata?: Record<string, unknown>, reviewer?: string): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    this.stopHeartbeat(f)
    f.disposeTools?.()
    try { await f.handle?.dispose?.() } catch { /* already gone */ }
    let changed = false
    if (t === 'run/completed') {
      changed = await this.store.transition(
        () => this.store.kernel.completeTask(f.cardId, { expectedRunId: f.coreRunId, summary: summary ?? f.lastText, metadata }),
        ok => ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...(metadata ? { metadata } : {}) } : undefined,
      )
    } else if (t === 'run/review_requested') {
      changed = await this.store.transition(
        () => this.store.kernel.requestReview(f.cardId, { expectedRunId: f.coreRunId, summary: summary ?? f.lastText, metadata, reviewer }),
        ok => ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...(metadata ? { metadata } : {}), ...(reviewer ? { reviewer } : {}) } : undefined,
      )
    } else {
      const mapped = outcome === 'timed_out' ? 'timed_out' : outcome === 'cancelled' ? 'cancelled' : outcome === 'protocol_violation' ? 'protocol_violation' : 'failed'
      const result = await this.store.transition(
        () => {
          const failed = this.store.kernel.failRun(f.cardId, { expectedRunId: f.coreRunId, outcome: mapped, error })
          if (failed.ok && mapped === 'cancelled' && !this.store.kernel.cancelTask(f.cardId, error ?? '人工取消')) throw new Error(`无法归档已取消任务 ${f.cardId}`)
          return failed
        },
        value => value.ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, outcome: outcome as any, error } : undefined,
      )
      changed = result.ok
    }
    if (!changed) {
      console.warn(`[task-console] stale terminal transition refused: ${f.cardId} core run ${f.coreRunId}`)
      await this.tick(); return
    }
    if (t === 'run/completed' && metadata?.decision === 'approved' && typeof metadata.finalArtifactId === 'string') {
      const artifact = this.store.s.artifacts.get(metadata.finalArtifactId)
      const card = this.store.s.cards.get(f.cardId)
      if (artifact && card?.role === 'planner' && artifact.batchId === card.batchId) {
        await this.append({ t: 'artifact/finalized', taskId: f.taskId, batchId: artifact.batchId, artifactId: artifact.id, artifactCardId: artifact.cardId, cardId: f.cardId, runId: f.runId, sha256: artifact.sha256 })
      }
    }
    if (giveUpNow) {
      const c = this.store.s.cards.get(f.cardId)
      if (c && c.status !== 'failed') await this.store.transition(
        () => this.store.kernel.giveUpTask(f.cardId, error ?? outcome),
        ok => ok ? { t: 'card/gave_up', at: this.now(), taskId: f.taskId, cardId: f.cardId, error: error ?? outcome } : undefined,
      )
    }
    await this.tick()
  }

  private async finishBlocked(f: Flight, reason: string, kind: BlockKind): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    this.stopHeartbeat(f)
    f.disposeTools?.()
    try { await f.handle?.dispose?.() } catch { /* already gone */ }
    const ok = await this.store.transition(
      () => this.store.kernel.blockTask(f.cardId, { expectedRunId: f.coreRunId, reason, kind }),
      changed => changed ? { t: 'run/blocked', at: this.now(), taskId: f.taskId, runId: f.runId, kind, reason, terminal: true } : undefined,
    )
    if (!ok) console.warn(`[task-console] stale block refused: ${f.cardId} core run ${f.coreRunId}`)
    await this.tick()
  }

  private async finishChanges(f: Flight, reason: string): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    this.stopHeartbeat(f)
    f.disposeTools?.()
    try { await f.handle?.dispose?.() } catch { /* already gone */ }
    const result = await this.store.transition(
      () => this.store.kernel.requestChanges(f.cardId, { expectedRunId: f.coreRunId, reason }),
      value => value.ok ? { t: 'card/changes_requested', at: this.now(), taskId: f.taskId, cardId: f.cardId, runId: f.runId, note: reason, targetCardId: f.cardId, reviewer: f.profileId } : undefined,
    )
    if (!result.ok) console.warn(`[task-console] request_changes refused: ${result.error}`)
    await this.tick()
  }

  async cancelBatch(batchId: string): Promise<void> {
    const b = this.store.s.batches.get(batchId); if (!b) return
    this.dispatchSuspended++
    try {
      for (const f of [...this.flights.values()]) { const r = this.store.s.runs.get(f.runId); if (r?.batchId === batchId) await this.finish(f, 'run/cancelled', 'cancelled', '人工取消') }
      for (const id of b.cardIds) {
        const c = this.store.s.cards.get(id)
        if (c && (c.status === 'todo' || c.status === 'ready' || c.status === 'review')) await this.store.transition(
          () => this.store.kernel.cancelTask(id, '人工取消批次'),
          ok => ok ? { t: 'card/cancelled', at: this.now(), taskId: b.taskId, cardId: id } : undefined,
        )
      }
      if (!this.store.s.batches.get(batchId)?.settled) await this.settleBatch(b, 'cancelled')
    } finally {
      this.dispatchSuspended--
    }
    await this.tick()
  }

  /** Resolve the explicit human review gate for one card. */
  async reviewCard(cardId: string, decision: 'approve' | 'changes', note = '', targetCardId?: string): Promise<void> {
    const card = this.store.s.cards.get(cardId)
    if (!card || card.status !== 'review' || !card.currentRunId && !card.runIds.length) throw new Error('这张卡不在待验收状态')
    const runId = card.runIds[card.runIds.length - 1]
    if (decision === 'approve') {
      const ok = await this.store.transition(
        () => this.store.kernel.completeTask(cardId, { summary: note.trim() || 'Human review approved.', metadata: { approval: 'human' } }),
        changed => changed ? { t: 'card/review_approved', at: this.now(), taskId: card.taskId, cardId, runId, ...(note.trim() ? { note: note.trim() } : {}) } : undefined,
      )
      if (!ok) throw new Error('核心任务状态已经变化，无法批准')
    } else {
      if (!note.trim()) throw new Error('退回修改时必须写明原因')
      const target = this.store.s.cards.get(targetCardId ?? card.deps[0] ?? card.id)
      if (!target || target.batchId !== card.batchId || target.index > card.index) throw new Error('返工目标必须是同一运行中当前角色或它的上游')
      const affected = [...this.store.s.cards.values()].filter(row => row.batchId === card.batchId && row.index >= target.index && row.index <= card.index).sort((a, b) => a.index - b.index)
      await this.store.transition(
        () => {
          for (const row of affected) {
            const ok = this.store.kernel.reopenForChanges(row.id, {
              reason: note.trim(), assignee: row.agentId, forceTodo: row.id !== target.id, sourceTaskId: card.id,
            })
            if (!ok) throw new Error(`无法重开核心任务 ${row.id}`)
          }
          return true
        },
        () => ({ t: 'card/changes_requested', at: this.now(), taskId: card.taskId, cardId, runId, note: note.trim(), targetCardId: target.id }),
      )
    }
    await this.tick()
  }

  /** Hermes unblock semantics: a blocked run stays closed and a new run is claimed. */
  async unblockCard(cardId: string): Promise<void> {
    const card = this.store.s.cards.get(cardId)
    if (!card || card.status !== 'blocked') throw new Error('这张卡不在阻塞状态')
    const ok = await this.store.transition(
      () => this.store.kernel.unblockTask(cardId),
      changed => changed && this.store.kernel.getTask(cardId)?.status === 'ready' ? { t: 'card/ready', at: this.now(), taskId: card.taskId, cardId } : undefined,
    )
    if (!ok) throw new Error('核心任务状态已经变化，无法解除阻塞')
    await this.tick()
  }

  /** Remember display names so upstream handoffs read "from 巡检员", not "from inspector". */
  rememberName(id: string, name: string): void { this.nameCache.set(id, name) }
}
