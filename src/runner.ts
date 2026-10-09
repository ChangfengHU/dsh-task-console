import {effectiveExecutionBinding,assertEffectiveBinding,executionMigrationSha} from './batch-execution-migration.ts'
import {StudioProgressReconcile,PROGRESS_POLL_LIMITS} from './studio-progress-reconcile.js'
import {StudioOperations} from './studio-operations.js'
import {StudioProgress,registerStudioProgress,studioProgressPending,studioProgressResume} from './studio-progress.js'
import {StudioInterventions} from './studio-interventions.js'
import {captureExecutionBinding,verifyExecutionBinding,withBoundPreset,executionRuntimeIdentity,ExecutionBindingError,type BatchExecutionBinding,type BoundFallback} from './batch-execution-binding.ts'
import {persistExecutionBindingSnapshot} from './execution-binding-snapshot.ts'
import {workflowDefinition} from './workflow-plan.ts'
import {planStudioBatchWorkspace,ensureStudioBatchWorkspace} from './studio-workspace.js'
import {StudioPreparation,preparationBarrier,preparationOriginExited} from './studio-preparation.js'
import { recoverStudioFailure, type StudioRecoveryInput } from './studio-recovery.ts'
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
import { randomUUID,createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { applyAgentPermission } from './agent-session.ts'
import { captureArtifacts } from './artifacts.ts'
import { readSpec } from './presets.ts'
import { EventStore, NUDGE, cardMessage, cronMatches, parseCron, taskForBatch, taskForTurn, type Batch, type BlockKind, type Card, type TaskSpec, type TaskTurn } from './tasks.ts'
import { registerWorkerTools } from './worker-tools.ts'
import { taskAgentIds } from './task-design.ts'
import { ScheduleLedger, type ScheduleClaim } from './scheduler.ts'
import { publicToolName } from './filtered-mcp-client.ts'
import { dispatchNotification } from './notification-dispatch.ts'
import { readBrowserAcceptance } from './workflow-acceptance.ts'
import { startupFallbackAllowed, installFallbackSelection } from './model-fallback.ts'
import { installTaskModelSelection, taskAgentOptions } from './task-model-selection.ts'
import { FleetRepairRequired, fullFleetRecipe, fleetRoles } from './fleet-workflow-evidence.ts'

interface Flight {
  progress?:StudioProgress
  progressStopping?:boolean
  progressDisposed?:boolean
  progressTerminalBoundary?:boolean
  executionBinding?: BatchExecutionBinding
  boundFallback?: BoundFallback|null
  sessionCreationAttempted?: boolean
  modelProvider?: string
  fallbackUsed?: boolean
  toolCalled?: boolean
  disposeFallback?: () => void
  disposeModelSelection?: () => void
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
  terminal?: { kind: 'completed' | 'review' | 'changes' | 'blocked' | 'deferred'; summary?: string; reason?: string; blockKind?: BlockKind; metadata?: Record<string, unknown>; reviewer?: string }
  pendingAsk?: string
  timer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
  idleTimer?: ReturnType<typeof setTimeout>
  waitedForOperation?: boolean
  timeoutSec: number
  deadline?: number
}

export interface RunnerOptions {
  /** Host-owned identity reader; tests may provide an isolated runtime fixture. */
  executionRuntimeIdentity?:()=>Promise<string>
  /** Test seam. Production defaults to the host-private immutable snapshot writer. */
  persistExecutionBindingSnapshot?:(binding:BatchExecutionBinding)=>Promise<unknown>
  maxInProgress?: number
  now?: () => number
  onBatchSettled?: (batch: Batch) => void | Promise<void>
  onSessionCreated?: (sessionId: string) => void | Promise<void>
  pollProgressOperation?: (operation:any)=>Promise<{name:string;args:any;result:any}>
  reconcilePreparationOperations?: (request:any)=>Promise<void>
  registerWorkflowTools?: (agentCtx:any,input:CompletionCheck,isActive:()=>boolean)=>Promise<()=>void>
  registerStudioTools?: (agentCtx: any, input: CompletionCheck, isActive: () => boolean, submitReview: () => Promise<void>) => Promise<() => void>
  beforeStart?: (input: CompletionCheck) => BlockDecision | void | Promise<BlockDecision | void>
  beforeComplete?: (input: CompletionCheck) => CompletionDecision | void | Promise<CompletionDecision | void>
  beforeBlock?: (input: CompletionCheck) => BlockDecision | void | Promise<BlockDecision | void>
  afterBlock?: (input: CompletionCheck) => Promise<void>
  pendingOperation?: (input: CompletionCheck) => Promise<string | undefined>
  /** Consume a verified terminal edge, including operations completed before turn/end. */
  operationContinuation?: (input: CompletionCheck) => string | undefined | Promise<string | undefined>
  operationOutcome?: (input: CompletionCheck) => Promise<string | undefined>
  scheduledTurn?: (task: TaskSpec, occurrenceId: string) => Promise<TaskTurn | undefined>
  beforePlanRound?: (input: CompletionCheck, items: unknown, proxyItems?: unknown) => Promise<{ items: unknown; commit: () => void } | undefined>
  patrolStatus?: (input: CompletionCheck) => Promise<unknown>
  notify?: (input: CompletionCheck, stage: string, deliver: (args: any) => Promise<any>) => Promise<unknown>
}

export interface BlockDecision { reason: string; kind: BlockKind }
export interface CompletionDecision { summary: string; metadata: Record<string, unknown>; artifacts?:{path:string;sha256:string}[] }
export interface CompletionCheck { task: TaskSpec; batch: Batch; card: Card; sessionId: string; profileId: string; isActive?:()=>boolean; metadata?: Record<string, unknown>; artifactPaths?:string[]; finalArtifactPath?:string }

export interface FireOptions {
  /** Stable IDs let an external signal resume safely after a host restart. */
  batchId?: string
  /** Signal-specific objective and dynamically selected Agent team. */
  turn?: TaskTurn
  scheduleClaim?: ScheduleClaim
  /** Acknowledge after the batch is durable; preflight and claiming run off-request. */
  dispatch?: 'await' | 'background'
}

export class TaskRunner {
  private readonly executionIdentity:()=>Promise<string>
  private readonly persistExecutionSnapshot:(binding:BatchExecutionBinding)=>Promise<unknown>
  modelFallback?: { fromProvider: string; provider: string; model: string }
  private readonly ctx: Context
  readonly store: EventStore
  private flights = new Map<string, Flight>()
  private preparationRetiring = new Map<string, Flight>()
  private ticker?: ReturnType<typeof setInterval>
  schedule!: ScheduleLedger
  private disposeListener?: () => void
  private ticking = false
  private backgroundTick?: ReturnType<typeof setImmediate>
  private backgroundBatches = new Set<string>()
  private firing = new Map<string,{taskId:string;promise:Promise<Batch>}>()
  private dispatchSuspended = 0
  readonly maxInProgress: number
  private readonly clock: () => number
  private readonly onBatchSettled?: (batch: Batch) => void | Promise<void>
  private readonly onSessionCreated?: (sessionId: string) => void | Promise<void>
  private stopped=false
  private readonly pollProgressOperation?:RunnerOptions['pollProgressOperation']
  private readonly reconcilePreparationOperations?:RunnerOptions['reconcilePreparationOperations']
  private readonly registerWorkflowTools?:RunnerOptions['registerWorkflowTools']
  private readonly registerStudioTools?: RunnerOptions['registerStudioTools']
  private readonly beforeStart?: RunnerOptions['beforeStart']
  private readonly beforeComplete?: RunnerOptions['beforeComplete']
  private readonly beforeBlock?: RunnerOptions['beforeBlock']
  private readonly afterBlock?: RunnerOptions['afterBlock']
  private readonly pendingOperation?: RunnerOptions['pendingOperation']
  private readonly operationContinuation?: RunnerOptions['operationContinuation']
  private readonly operationOutcome?: RunnerOptions['operationOutcome']
  private readonly scheduledTurn?: RunnerOptions['scheduledTurn']
  private readonly beforePlanRound?: RunnerOptions['beforePlanRound']
  private readonly patrolStatus?: RunnerOptions['patrolStatus']
  private readonly notify?: RunnerOptions['notify']

  constructor(ctx: Context, store: EventStore, opts: RunnerOptions = {}) {
    this.executionIdentity=opts.executionRuntimeIdentity??executionRuntimeIdentity
    this.persistExecutionSnapshot=opts.persistExecutionBindingSnapshot??(opts.executionRuntimeIdentity?async()=>undefined:persistExecutionBindingSnapshot)
    this.ctx = ctx; this.store = store
    this.maxInProgress = opts.maxInProgress ?? 3
    this.clock = opts.now ?? (() => Date.now())
    this.onBatchSettled = opts.onBatchSettled
    this.onSessionCreated = opts.onSessionCreated
    this.pollProgressOperation = opts.pollProgressOperation
    this.reconcilePreparationOperations = opts.reconcilePreparationOperations
    this.registerWorkflowTools = opts.registerWorkflowTools
    this.registerStudioTools = opts.registerStudioTools
    this.beforeStart = opts.beforeStart
    this.beforeComplete = opts.beforeComplete
    this.beforeBlock = opts.beforeBlock
    this.afterBlock = opts.afterBlock
    this.pendingOperation = opts.pendingOperation
    this.operationContinuation = opts.operationContinuation
    this.operationOutcome = opts.operationOutcome
    this.scheduledTurn = opts.scheduledTurn
    this.beforePlanRound = opts.beforePlanRound
    this.patrolStatus = opts.patrolStatus
    this.notify = opts.notify
  }

  async start(): Promise<void> {
    this.stopped=false
    await this.store.load()
    this.schedule = new ScheduleLedger(this.store)
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
    this.ticker = setInterval(() => { this.queueDispatch() }, 60_000)
    ;(this.ticker as any).unref?.()
    ;(this.ctx as any).effect?.(() => () => this.stop(), 'task-console: runner')
    await this.tick()
  }

  stop(): void {
    this.stopped=true
    if (this.ticker) clearInterval(this.ticker)
    if (this.backgroundTick) clearImmediate(this.backgroundTick)
    this.backgroundTick = undefined
    this.backgroundBatches.clear()
    this.disposeListener?.()
    for (const f of this.flights.values()) { this.disarm(f); this.stopHeartbeat(f); f.disposeFallback?.(); f.disposeModelSelection?.(); if(!f.progressStopping||f.progressDisposed)f.disposeTools?.() }
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
    if (this.stopped || this.ticking || this.dispatchSuspended > 0) return
    this.ticking = true
    try {
      await this.reconcilePreparations()
      if(this.stopped)return
      await this.reconcileProgressOperations()
      if(this.stopped)return
      await this.expireBlockedPatrols()
      if(this.stopped)return
      await this.wakeDueCards()
      if(this.stopped)return
      await this.fireDueCron()
      if(this.stopped)return
      await this.dispatch()
    } finally { this.ticking = false }
  }

  private async reconcileProgressOperations():Promise<void>{
    if(!this.pollProgressOperation)return
    const ledger=new StudioProgressReconcile(this.store),ops=new StudioOperations(this.store)
    for(const row of ledger.due(this.clock())){
      const card=this.store.s.cards.get(row.card_id),batch=card&&this.store.s.batches.get(card.batchId),template=card&&this.store.tasks.get(card.taskId)
      if(!card||!batch||!template){ledger.db.prepare("UPDATE dsh_studio_progress_reconcile SET state='invalidated' WHERE card_id=? AND run_id=? AND state='waiting'").run(row.card_id,row.run_id);continue}
      const input={task:taskForBatch(template,batch),batch,card}
      const stopped=()=>!this.stopped&&![...this.flights.values(),...this.preparationRetiring.values()].some(f=>f.cardId===card.id)
      if(!stopped())continue
      const token=await this.store.transition(()=>ledger.reserve(input,row,this.clock()),()=>undefined)
      if(!token)continue
      try{
        const operations=ledger.operations(input)
        // Ambiguous ownership/no ID or an unsupported provider cannot be guessed.
        const supported=(op:any)=>typeof op.job_id==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(op.job_id)&&((op.kind==='imageCalls'&&/vyibc-image_generate_image$/.test(op.tool))||(op.kind==='voiceSegments'&&/vyibc-voice_(synthesize|retry_segments)$/.test(op.tool)))
        if(operations.some((op:any)=>!supported(op)))continue
        for(const operation of operations.slice(0,PROGRESS_POLL_LIMITS.jobsPerTick)){
          if(!stopped()||!ledger.current(input,token,this.clock()))break
          try{
            const p=await this.pollProgressOperation(operation)
            await ops.invoke(input,p.name,p.args,async()=>p.result,undefined,undefined,{operation,canApply:()=>stopped()&&ledger.current(input,token,this.clock())})
          }catch{/* Bounded failed read keeps the reservation and original job. */}
        }
        await this.store.transition(()=>stopped()&&ledger.resume(input,token,this.clock()),ok=>ok?{t:'card/ready',at:this.now(),taskId:card.taskId,cardId:card.id}:undefined)
      }catch{/* Unavailable/corrupt reconciliation evidence stays blocked within its attempt cap. */}
      finally{ledger.release(input,token)}
    }
  }

  private async disposePreparationHandle(f:Flight):Promise<void> {
    if(f.progressDisposed)return
    const task=this.store.tasks.get(f.taskId),studio=task?.design?.evidenceContract==='studio-video-v1'
    this.preparationRetiring.set(f.sessionId,f)
    if(studio&&f.sessionCreationAttempted&&typeof f.handle?.dispose!=='function')throw Error('studio-preparation-stop-unavailable')
    await f.handle?.dispose?.()
    if(studio)new StudioPreparation(this.store).recordStoppedSession(f.sessionId,f.sessionCreationAttempted?'disposed':'not-created')
    this.preparationRetiring.delete(f.sessionId)
  }

  private async reconcilePreparations():Promise<void>{
    const prep=new StudioPreparation(this.store)
    for(const request of prep.rows().filter((r:any)=>r.state==='draining')){
      const batch=this.store.s.batches.get(request.batchId)
      if(!batch||batch.settled||batch.archivedAt)continue
      for(const sid of request.sessionsToStop){
        if(request.stoppedSessions.includes(sid))continue
        const f=this.flights.get(sid)??this.preparationRetiring.get(sid)
        if(f?.handle){
          // The barrier already prevents commits. Do not infer stopped from
          // absence in flights or swallow disposal failures as confirmation.
          try{await this.disposePreparationHandle(f);this.disarm(f);this.stopHeartbeat(f);f.disposeFallback?.();f.disposeModelSelection?.();f.disposeTools?.();this.flights.delete(sid)}catch{continue}
        }else if(!f&&request.hostProcess&&preparationOriginExited(request.hostProcess))prep.markStopped(request.id,sid,'origin-process-exited')
      }
      try{await this.reconcilePreparationOperations?.(request)}catch{continue}
      const fresh=prep.rows(request.batchId).find((r:any)=>r.id===request.id)
      if(fresh.sessionsToStop.some((sid:string)=>!fresh.stoppedSessions.includes(sid))||prep.pending(fresh).length)continue
      await prep.release(request.id)
    }
  }

  /** The durable ready rows, not this callback, are the recoverable work queue. */
  private queueDispatch(batchId?: string): void {
    if (batchId) this.backgroundBatches.add(batchId)
    if (this.backgroundTick) return
    this.backgroundTick = setImmediate(() => {
      this.backgroundTick = undefined
      const requested = [...this.backgroundBatches]
      this.backgroundBatches.clear()
      void this.tick().catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[task-console] background dispatch failed:', message)
        // An infrastructure error is not a successful run or a reason to replay
        // paid work. Keep durable rows intact and expose the failed dispatch.
        const batches = requested.length ? requested.map(id => this.store.s.batches.get(id)).filter(Boolean) as Batch[]
          : [...this.store.s.batches.values()].filter(b => !b.settled && !b.archivedAt)
        for (const batch of batches) {
          const cardId = batch.cardIds.find(id => !['done','failed','cancelled'].includes(this.store.s.cards.get(id)?.status ?? '')) ?? batch.cardIds[0]
          if (!cardId) continue
          try { this.store.kernel.recordEvent(cardId, 'dispatch_failed', { code: 'task_dispatch_failed', message, batch_id: batch.id, retry: 'next_scheduler_tick' }) }
          catch { console.warn('[task-console] dispatch failure could not be persisted for', batch.id) }
        }
      })
    })
  }

  /** A parked hourly patrol cannot suppress every future occurrence forever. */
  private async expireBlockedPatrols(): Promise<void> {
    for (const batch of this.store.s.batches.values()) {
      const template = this.store.tasks.get(batch.taskId)
      if (!template || template.archivedAt || batch.by !== 'cron' || batch.settled || batch.archivedAt) continue
      const task = taskForBatch(template, batch)
      if (task.design?.evidenceContract !== 'browser-patrol-v2') continue
      const cards = batch.cardIds.map(id => this.store.s.cards.get(id)!).filter(Boolean)
      if (cards.some(c => ['running','scheduled'].includes(c.status) || this.store.kernel.getTask(c.id)?.block_kind === 'needs_input')) continue
      const expired = cards.filter(c => c.status === 'blocked' && c.startedAt && this.clock() >= Date.parse(c.startedAt) + task.timeoutSec * 1000)
      if (!expired.length) continue
      const db = this.store.kernel.db
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_proxy_calls'").get() &&
        db.prepare("SELECT 1 FROM dsh_proxy_calls WHERE batch_id=? AND state IN ('running','unknown') LIMIT 1").get(batch.id)) continue
      let pending = false
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_browser_operations'").get()) {
        const operations = db.prepare('SELECT operation_id FROM dsh_browser_operations WHERE batch_id=?').all(batch.id) as { operation_id:string }[]
        for (const row of operations) {
          try {
            const receipt = await readBrowserAcceptance(row.operation_id)
            if (!['complete','blocked'].includes(receipt.phase)) pending = true
          } catch { pending = true }
        }
      }
      for (const card of cards) {
        const run = this.store.s.runs.get(card.runIds.at(-1) ?? '')
        if (!run) continue
        try {
          if (await this.pendingOperation?.({ task, batch, card, sessionId: run.sessionId, profileId: run.profileId ?? card.agentId })) pending = true
        } catch { pending = true } // Missing/ambiguous receipts never release the overlap fence.
      }
      if (pending) continue
      for (const card of expired) await this.store.transition(
        () => this.store.kernel.giveUpTask(card.id, '定时巡查阻塞超过本卡总时间预算；本次未通过，保留历史与修复预算，下次整点重新检查'),
        ok => ok ? { t:'card/gave_up', at:this.now(), taskId:task.id, cardId:card.id, error:'定时巡查阻塞超时，非业务成功' } : undefined,
      )
      await this.settleBatches()
    }
  }

  private async wakeDueCards(): Promise<void> {
    const rows = this.store.kernel.db.prepare("SELECT w.card_id FROM dsh_task_wakeups w JOIN tasks t ON t.id=w.card_id WHERE w.state='pending' AND w.wake_at<=? AND t.status='scheduled'").all(this.clock()) as { card_id: string }[]
    for (const row of rows) {
      const card = this.store.s.cards.get(row.card_id)
      if (!card || this.store.tasks.get(card.taskId)?.archivedAt || this.store.s.batches.get(card.batchId)?.archivedAt) continue
      await this.store.transition(() => {
        const ok = this.store.kernel.unblockTask(card.id)
        if (ok) this.store.kernel.db.prepare("UPDATE dsh_task_wakeups SET state='resumed' WHERE card_id=?").run(card.id)
        return ok
      }, ok => ok ? { t: 'card/ready', at: this.now(), taskId: card.taskId, cardId: card.id } : undefined)
    }
  }

  private async fireDueCron(): Promise<void> {
    for (const task of this.store.tasks.values()) {
      const claim = this.schedule.claim(task, this.clock())
      if (!claim) continue
      try { await this.fire(task.id, 'cron', { batchId: claim.batchId, scheduleClaim: claim }) }
      catch (error) { this.schedule.failed(claim, this.clock(), error instanceof Error ? error.message : '定时派发失败') }
    }
  }

  /** Promote, claim, spawn — bounded by the in-progress cap. */
  private async dispatch(): Promise<void> {
    if(this.stopped)return
    await this.store.openReadyGates()
    if(this.stopped)return
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
    ready.sort((a, b) => a.batchId.localeCompare(b.batchId) || Number(a.role === 'notifier') - Number(b.role === 'notifier') || a.index - b.index)
    for (const c of ready) {
      if(this.stopped)return
      if (inProgress >= this.maxInProgress) break
      if(preparationBarrier(this.store.kernel.db,c.id))continue
      const template = this.store.tasks.get(c.taskId); if (!template || template.archivedAt) continue
      const batch = this.store.s.batches.get(c.batchId); if (!batch || batch.settled || batch.archivedAt) continue
      const task = taskForBatch(template, batch)
      if(task.design?.progressPolicy==='studio-bounded-v1'&&!(c.consecutiveFailures>0&&(task.onFail!=='retry'||c.consecutiveFailures>=task.maxTries))){
        const prior=this.store.kernel.db.prepare("SELECT payload FROM task_events WHERE task_id=? AND kind='studio_progress_stopped' ORDER BY id DESC LIMIT 1").get(c.id) as any
        if(prior){
          let blocked:string|undefined
          try{const stopped=JSON.parse(prior.payload);blocked=stopped.stopConfirmed!==true?'studio-progress-session-stop-unconfirmed':studioProgressPending(this.store.kernel.db,{task,batch,card:c})}catch{blocked='studio-progress-operation-state-unavailable'}
          if(blocked){
            await this.store.transition(()=>{const ok=this.store.kernel.blockTask(c.id,{reason:blocked!,kind:'capability'});if(ok)new StudioProgressReconcile(this.store).bind(c.id);return ok},ok=>ok?{t:'run/blocked',at:this.now(),taskId:task.id,runId:c.runIds.at(-1)!,kind:'capability',reason:blocked!,terminal:true}:undefined)
            continue
          }
        }
      }
      if (c.consecutiveFailures > 0 && (c.role === 'notifier' || task.onFail !== 'retry' || c.consecutiveFailures >= task.maxTries)) {
        const failure = c.error ?? `连续失败 ${c.consecutiveFailures} 次`
        await this.store.transition(
          () => this.store.kernel.giveUpTask(c.id, failure),
          ok => ok ? { t: 'card/gave_up', at: this.now(), taskId: c.taskId, cardId: c.id, error: failure } : undefined,
        )
        await this.settleBatches(); continue
      }
      // The first preflight is part of dispatch, so acknowledgement does not
      // wait for it, and restart cannot bypass it on a durable unclaimed batch.
      if (c.index === 0 && c.runIds.length === 0) {
        try { await this.checkBatchWorkspace(task,batch,true) }
        catch(error){await this.failInitialPreflight(task,c,error instanceof Error?error.message:'studio-workspace-invalid');continue}
        const problem = await this.preflight(task)
        if (problem) { await this.failInitialPreflight(task, c, problem); continue }
      }
      await this.startRun(task, batch, c)
      inProgress++
    }
    await this.settleBatches()
  }

  /** Close batches whose cards are all terminal; cancel cards a failure made unreachable. */
  private async settleBatches(): Promise<void> {
    for (const b of this.store.s.batches.values()) {
      if (b.settled || b.archivedAt || this.store.tasks.get(b.taskId)?.archivedAt) continue
      if(new StudioPreparation(this.store).rows(b.id).some((r:any)=>r.state==='draining'))continue
      const cards = b.cardIds.map(id => this.store.s.cards.get(id)).filter(c=>c&&!c.supersededBy) as Card[]
      if (!cards.length) continue
      const dead = cards.filter(c => c.status === 'failed' || c.status === 'cancelled')
      if (dead.length) {
        if (dead.every(c => c.role === 'notifier')) {
          if (cards.every(c => ['done','failed','cancelled'].includes(c.status))) await this.settleBatch(b,'failed')
          continue
        }
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
      if (cards.every(c => c.status === 'done')) {
        const unresolved = cards.some(c => c.runIds.some(id => this.store.s.runs.get(id)?.metadata?.workflowOutcome === 'unresolved'))
        await this.settleBatch(b, unresolved ? 'failed' : 'done')
      }
    }
  }

  // ── firing ────────────────────────────────────────────────────────────

  /** Create a batch (one card per participant, chained) and dispatch. */
  async fire(taskId: string, by: Batch['by'], options: FireOptions = {}): Promise<Batch> {
    const template = this.store.tasks.get(taskId)
    if (!template) throw new Error('没有这个任务')
    if (template.archivedAt) throw new Error('任务已归档，请先恢复')
    const batchId = options.batchId ?? `b-${this.clock().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(batchId)) throw new Error('batchId 不合法')
    const existing = this.store.s.batches.get(batchId)
    if (existing) {
      if (existing.taskId !== taskId) throw new Error('batchId 已被其他任务使用')
      if (options.dispatch === 'background' && !existing.settled && !existing.archivedAt) this.queueDispatch(batchId)
      return existing
    }
    const active=this.firing.get(batchId)
    if(active){if(active.taskId!==taskId)throw Error('batchId 已被其他任务使用');return active.promise}
    const promise=this.fireNew(template,by,{...options,batchId})
    this.firing.set(batchId,{taskId,promise})
    try{return await promise}finally{if(this.firing.get(batchId)?.promise===promise)this.firing.delete(batchId)}
  }

  private async fireNew(template:TaskSpec,by:Batch['by'],options:FireOptions&{batchId:string}):Promise<Batch>{
    const taskId=template.id,batchId=options.batchId
    if (template.trigger.kind === 'cron' && !options.turn && this.scheduledTurn) options = { ...options, turn: await this.scheduledTurn(template, batchId) }
    if(options.turn?.executionBinding)throw new ExecutionBindingError('host-created-only')
    if(options.turn?.studioWorkspace)throw Error('studio-workspace-host-created-only')
    let task = taskForTurn(template, options.turn)
    if (!options.turn && (template.origin?.signalId || [...this.store.s.batches.values()].some(b => b.taskId === taskId && b.turn?.origin?.signalId))) {
      throw new Error('外部 Signal 任务请从来源系统重新提交，由 Task Agent 重新核对目标与角色；不能重跑旧模板。')
    }
    if (task.graphMode === 'dynamic-rounds' && task.participants.length !== 3) throw new Error('动态回合必须有规划者、执行者、评估者')
    if(template.design?.workspaceMode&&task.design?.workspaceMode!==template.design.workspaceMode)throw Error('studio-workspace-mode-changed')
    if(task.design?.workspaceMode!==undefined){
      if(task.design.workspaceMode!=='studio-batch-v1'||task.design.evidenceContract!=='studio-video-v1')throw Error('unsupported-studio-workspace-mode')
      if(options.turn?.cwd!==undefined&&options.turn.cwd!==template.cwd)throw Error('studio-workspace-override-forbidden')
      const studioWorkspace=await planStudioBatchWorkspace(this.store.root,taskId,batchId)
      const turn=options.turn??{objective:task.brief,participants:task.participants,workflow:{id:createHash('sha256').update(JSON.stringify(workflowDefinition(task))).digest('hex'),definition:workflowDefinition(task)}}
      options={...options,turn:{...turn,cwd:studioWorkspace.path,studioWorkspace}}
      task=taskForTurn(template,options.turn)
    }
    if(task.design?.executionBinding==='agent-runtime-v1'){
      const definition=workflowDefinition(task)
      const turn=options.turn??{objective:task.brief,participants:task.participants,cwd:task.cwd,workflow:{id:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),definition}}
      const binding=await captureExecutionBinding(this.ctx,task,batchId,this.modelFallback,this.executionIdentity)
      await this.persistExecutionSnapshot(binding)
      options={...options,turn:{...turn,executionBinding:binding}}
    }
    const cards = task.graphMode === 'dynamic-rounds'
      ? [{ id: `${batchId}#p1`, agentId: task.participants[0].agentId, ...(task.participants[0].brief ? { brief: task.participants[0].brief } : {}), deps: [], kind: 'agent' as const, role: 'planner' as const, round: 1 }]
      : task.participants.map((p, i) => ({ id: `${batchId}#${i}`, agentId: p.agentId, ...(p.brief ? { brief: p.brief } : {}), deps: i ? [`${batchId}#${i - 1}`] : [] }))
    await this.store.createBatch(template, { t: 'batch/fired', at: this.now(), taskId, batch: { id: batchId, by, cards, ...(options.turn ? { turn: options.turn } : {}) } }, options.scheduleClaim)
    if (options.dispatch === 'background') this.queueDispatch(batchId)
    else await this.tick()
    return this.store.s.batches.get(batchId)!
  }

  private async checkBatchWorkspace(task:TaskSpec,batch:Batch,initial=false){
    const value=batch.turn?.studioWorkspace
    if(task.design?.workspaceMode===undefined&&!value)return // Immutable legacy batches retain their original cwd.
    if(task.design?.workspaceMode!=='studio-batch-v1'||!value)throw Error('studio-workspace-batch-binding-missing')
    const first=batch.cardIds[0],ready=this.store.kernel.listEvents(first).some(e=>e.kind==='studio_workspace_ready')
    const used=batch.cardIds.some(id=>this.store.kernel.listRuns(id).length>0)
    await ensureStudioBatchWorkspace(this.store.root,value,task.id,batch.id,task.cwd,initial&&!ready&&!used)
    if(!ready){
      if(!initial||used)throw Error('studio-workspace-allocation-evidence-missing')
      this.store.kernel.recordEvent(first,'studio_workspace_ready',value)
    }
  }

  private async failInitialPreflight(task: TaskSpec, first: Card, problem: string): Promise<void> {
    const runId = `${first.id}#1`
    const failure = `预检不过:${problem}`
    const claim = await this.store.claimCard(first.id, runId, '', 1,false,()=>!this.stopped)
    if (claim) {
      await this.store.transition(
        () => this.store.kernel.failRun(first.id, { expectedRunId: claim.run.id, outcome: 'failed', error: failure }),
        result => result.ok ? { t: 'run/failed', at: this.now(), taskId: task.id, runId, outcome: 'failed', error: failure } : undefined,
      )
      await this.store.transition(
        () => this.store.kernel.giveUpTask(first.id, failure),
        ok => ok ? { t: 'card/gave_up', at: this.now(), taskId: task.id, cardId: first.id, error: failure } : undefined,
      )
    }
    await this.settleBatches()
  }

  private async preflight(task: TaskSpec): Promise<string | null> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return '这个部署没有 preset 服务'
    for (const id of taskAgentIds(task)) {
      try { const r = await presets.resolve(id); if (r.broken) return `preset ${id} 坏了:${r.broken}` } catch { return `preset ${id} 不在名册上` }
    }
    try { const { stat } = await import('node:fs/promises'); if (!(await stat(task.cwd)).isDirectory()) return `工作目录不存在:${task.cwd}` } catch { return `工作目录不存在:${task.cwd}` }
    return null
  }

  // ── one run ───────────────────────────────────────────────────────────

  public executionMigrationQuiescent(){return this.flights.size===0&&this.preparationRetiring.size===0}

  private async startRun(task: TaskSpec, batch: Batch, card: Card): Promise<void> {
    if(this.stopped)return
    const presets = (this.ctx as any).get('agentPresets')
    const coreTask = this.store.kernel.getTask(card.id)
    if (!coreTask || !['ready', 'review'].includes(coreTask.status)||preparationBarrier(this.store.kernel.db,card.id)) return
    const fromReview = coreTask.status === 'review'
    const profileId = coreTask.assignee ?? card.agentId
    const originalBinding=batch.turn?.executionBinding
    let binding=originalBinding,migrationError:unknown
    try{if(originalBinding)binding=effectiveExecutionBinding(this.store.kernel.db,originalBinding)}catch(error){migrationError=error}
    let preset:any,spec:Awaited<ReturnType<typeof readSpec>>,bindingStartupError=false
    try{preset=await presets.resolve(profileId);spec=await readSpec(dirname(String(preset.path)))}catch(e){if(!binding)throw e;bindingStartupError=true;preset={id:profileId,name:profileId};spec=null}
    const agentName = spec?.name ?? preset.name ?? preset.id
    let selection: any = (() => { try { return (this.ctx as any).get('agentDefaultModel')?.currentSelection?.() } catch { return undefined } })()
    if (spec?.model?.includes('/')) { const [provider, ...rest] = spec.model.split('/'); selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) } }
    if(binding)selection=Array.isArray(binding.agents)?binding.agents.find(a=>a?.id===profileId)?.selection:undefined

    const attempt = this.store.kernel.listRuns(card.id).length + 1
    const runId = `${card.id}#${attempt}`
    const sessionId = `task-${task.id}-${batch.id}-${card.index + 1}${attempt > 1 ? `-t${attempt}` : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    this.nameCache.set(profileId, agentName)
    const upstream: { agentName: string; summary: string }[] = []
    const prior = new Map<string, Card>()
    const collect = (id: string) => {
      const d = this.store.s.cards.get(id)
      if (!d || prior.has(id) || !batch.cardIds.includes(id)) return
      prior.set(id, d)
      // A reusable workflow's final role needs original ancestor receipts, not only a rewritten immediate handoff.
      if (d.kind === 'gate' || task.origin?.source === 'task-chat' && task.graphMode !== 'dynamic-rounds') d.deps.forEach(collect)
    }
    card.deps.forEach(collect)
    for (const d of [...prior.values()].sort((a, b) => a.index - b.index)) upstream.push({ agentName: await this.displayName(d.agentId), summary: d.summary ?? '' })
    const previousWait = this.store.kernel.db.prepare('SELECT reason,wake_at FROM dsh_task_wakeups WHERE card_id=?').get(card.id) as any
    const resumeFacts = [card.runIds.length ? await this.operationOutcome?.({task,batch,card,sessionId,profileId}) : undefined,task.design?.progressPolicy==='studio-bounded-v1'?studioProgressResume(this.store.kernel,card.id,task.cwd):undefined].filter(Boolean).join('\n')
    const background = ['browser-manager','fleet-installer'].includes(profileId) && this.pendingOperation
      ? '\n[BACKGROUND OPERATIONS]\n后台操作返回 running 后，可用普通回复说明等待并结束当前模型回合；宿主会保留同一 Run、Session 和租约，等待真实终态后自动唤醒你读取原回执。不要调用 task_complete、task_block 或 task_wait 表示等待，不要在 Codex exec/setTimeout/sleep/wait 中长时间睡眠，也不要重复发起操作。宿主等待不是业务验收通过。\n' : ''
    const text = `[DSH SESSION]\nCurrent sessionId: ${sessionId}\nUse this exact identity for scoped tools; never invent a standalone Agent session.\n${this.store.kernel.buildWorkerContext(card.id)}\n${cardMessage(task, card, batch.id, upstream)}${background}${resumeFacts ? '\n[RESUME FACTS]\n'+resumeFacts : ''}${previousWait ? `\n[RESUMED DURABLE WAIT]\nDue: ${new Date(previousWait.wake_at).toISOString()}\n${previousWait.reason}\nContinue verification; do not repeat completed side effects.` : ''}`
    const messageId = randomUUID()
    const claim = await this.store.claimCard(card.id, runId, sessionId, attempt, fromReview,()=>!this.stopped)
    if (!claim) return
    const flight: Flight = {
      ...(binding?{executionBinding:binding,boundFallback:binding.fallback}:{}),
      modelProvider: selection?.provider,
      runId, cardId: card.id, taskId: task.id, sessionId, messageId, consumed: false,
      handle: undefined, lastText: '', timeoutSec: card.role === 'notifier' ? 300 : task.timeoutSec,
      coreRunId: claim.run.id, claimLock: claim.lock, profileId,
      ...(previousWait ? { deadline: Date.parse(card.startedAt ?? this.now()) + task.timeoutSec * 1000 } : {}),
    }
    if (task.workflowRecipe?.id === fullFleetRecipe) flight.deadline = Math.min(
      flight.deadline ?? this.clock() + task.timeoutSec * 1000,
      Date.parse(batch.firedAt) + task.timeoutSec * fleetRoles.length * 1000,
    )
    if(task.design?.progressPolicy==='studio-bounded-v1')flight.progress=new StudioProgress(this.store.kernel,card.id,claim.run.id)
    this.flights.set(sessionId, flight)
    this.startHeartbeat(flight)
    const assertStartupActive=()=>{const current=this.store.kernel.getTask(card.id);if(this.stopped||this.flights.get(sessionId)!==flight||current?.current_run_id!==flight.coreRunId||preparationBarrier(this.store.kernel.db,card.id))throw Error('studio-preparation-startup-superseded')}
    try {
      assertStartupActive()
      try{await this.checkBatchWorkspace(task,batch)}catch(error){await this.finishBlocked(flight,error instanceof Error?error.message:'studio-workspace-invalid','capability');return}
      if(binding){
        if(migrationError)throw migrationError
        assertEffectiveBinding(this.store.kernel.db,originalBinding!,binding)
        if(bindingStartupError)throw new ExecutionBindingError('preset-unavailable')
        await (assertEffectiveBinding(this.store.kernel.db,originalBinding!,binding),verifyExecutionBinding(this.ctx,binding,task.id,batch.id,profileId,this.executionIdentity))
      }
      // Host preflight runs after a durable claim, before any model or paid work.
      const blocked = await this.beforeStart?.({ task, batch, card, sessionId, profileId, isActive:()=>!this.stopped&&this.flights.get(sessionId)===flight&&this.store.kernel.getTask(card.id)?.current_run_id===flight.coreRunId&&!preparationBarrier(this.store.kernel.db,card.id) })
      if (blocked) { await this.finishBlocked(flight, blocked.reason, blocked.kind); return }
      assertStartupActive()
      try{await this.checkBatchWorkspace(task,batch)}catch(error){await this.finishBlocked(flight,error instanceof Error?error.message:'studio-workspace-invalid','capability');return}
      // The normalized CAS claim is durable before a DSH session is created.
      flight.sessionCreationAttempted=true
      const createSession=async()=>{
        let setupFailure:ExecutionBindingError|undefined
        flight.handle = await (this.ctx as any).agents.create({
          sessionId,
          ...(selection ? { agentOptions: taskAgentOptions(selection) } : {}),
          meta: { cwd: task.cwd, agentPreset: preset.id,...(binding?{executionBindingSha256:binding.sha256}: {}) },
          setup: async (agentCtx: Context) => {
            if(selection)flight.disposeModelSelection=installTaskModelSelection(agentCtx,selection)
            if(!binding){await presets.mount(agentCtx,preset.id);return}
            // Return the created handle before rejecting setup so finishBlocked
            // can dispose it. No prompt is dispatched until verification passes.
            try{
              await (assertEffectiveBinding(this.store.kernel.db,originalBinding!,binding),verifyExecutionBinding(this.ctx,binding,task.id,batch.id,profileId,this.executionIdentity))
              await presets.mount(agentCtx,preset.id)
              await (assertEffectiveBinding(this.store.kernel.db,originalBinding!,binding),verifyExecutionBinding(this.ctx,binding,task.id,batch.id,profileId,this.executionIdentity))
            }catch(error){setupFailure=error instanceof ExecutionBindingError?error:new ExecutionBindingError('mount-unavailable')}
          },
        })
        if(setupFailure)throw setupFailure
      }
      if(binding)await withBoundPreset(this.ctx,binding,task.id,batch.id,profileId,createSession,this.executionIdentity)
      else await createSession()
      assertStartupActive()
      applyAgentPermission(this.ctx, spec, flight.handle.agent.session)
      await this.onSessionCreated?.(sessionId)
      assertStartupActive()
      this.store.kernel.recordEvent(card.id, 'session_created', { session_id: sessionId }, flight.coreRunId)
      await this.append({ t: 'run/session_created', taskId: task.id, runId, sessionId })
      // The terminators live on this agent's scope only.
      let submitStudioReview: (() => Promise<void>) | undefined
      try {
        const toolClaim = this.store.kernel.getTask(card.id)?.claim_lock
        const assertToolActive = () => {
          const current=this.store.kernel.getTask(card.id),currentBatch=this.store.s.batches.get(batch.id)
          if(this.stopped||this.flights.get(sessionId)!==flight||flight.terminal||flight.progressStopping||flight.progress?.state.reason||current?.status!=='running'||current.current_run_id!==flight.coreRunId||current.claim_lock!==toolClaim||!current.claim_expires||current.claim_expires<=Math.floor(this.clock()/1000)||!currentBatch||currentBatch.settled||currentBatch.archivedAt)throw Error('task-run-no-longer-active')
        }
        const submit = async (kind: 'completed' | 'review', summary: string, paths: string[], metadata?: Record<string, unknown>, reviewer?: string) => {
          if (flight.terminal) throw new Error('这次运行已经提交了终态')
          if (kind === 'review' && task.design?.extension) throw Error('workflow-extension-human-review-bypass-forbidden: use task_complete with host evidence or task_block')
          if (kind === 'review' && task.workflowRecipe?.id === 'fleet-base-v3') throw new Error('完整 Fleet 接入必须通过宿主证据验收后 task_complete；不能用人工批准替代缺失的业务证据。无法完成时 task_block 并保留原因。')
          const pending = await this.pendingOperation?.({ task, batch, card, sessionId, profileId })
          if (pending) throw new Error(`后台操作仍在运行，继续读取终态回执，不能提前提交验收：${pending}`)
          let observed: CompletionDecision | void
          if (kind === 'completed' || task.design?.evidenceContract === 'browser-patrol-v1') {
            try { observed = await this.beforeComplete?.({ task, batch, card, sessionId, profileId, metadata,artifactPaths:paths }) }
            catch (error) {
              if (!(error instanceof FleetRepairRequired) || task.workflowRecipe?.id !== fullFleetRecipe || profileId !== 'fleet-runner-operator') throw error
              const round = await this.store.expandFleetRepair(task,batch,card,flight.coreRunId,error.owner,error.message,this.clock())
              flight.terminal = {kind:'completed',summary:`本轮验收未通过；已交接第 ${round} 轮定向返工给 ${error.owner}。\n${error.message}`,metadata:{decision:'rework',round,repairOwner:error.owner,acceptanceFailure:error.message}}
              return
            }
            if (observed) { summary = observed.summary; metadata = observed.metadata }
          }
          assertToolActive()
          const at = this.now()
          const captured = await captureArtifacts({ root: this.store.root, task, batchId: batch.id, cardId: card.id, runId, sessionId, at }, paths)
          if(observed?.artifacts&&(captured.length!==observed.artifacts.length||observed.artifacts.some(expected=>!captured.some(actual=>actual.originalPath===expected.path&&actual.sha256===expected.sha256))))throw Error('workflow-artifact-capture-mismatch')
          assertToolActive()
          for (const artifact of captured) await this.append({ t: 'artifact/registered', at, taskId: task.id, artifact })
          flight.terminal = { kind, summary, metadata, reviewer }
        }
        submitStudioReview=async()=>{
          if(card.role!=='reviewer'||task.design?.evidenceContract!=='studio-video-v1')throw new Error('studio-reviewer-required')
          await submit('completed','Independent studio review submitted.',[])
        }
        flight.disposeTools = await registerWorkerTools(flight.handle.agent.ctx, {
          ...(task.design?.notifications && (['planner','notifier'].includes(card.role ?? '') || profileId === task.design.notifications.agentId) && this.notify ? { notify: (stage: string, exec: any) => this.notify!({ task, batch, card, sessionId, profileId }, stage, async args => {
            const runtime = flight.handle.agent.ctx.tools
            const names = Object.entries(spec?.mcpTools ?? {}).flatMap(([server, selected]) => selected.filter(raw => raw.replace(/-/g, '_') === 'vyibc_wecom_send_message').flatMap(raw => [publicToolName(server, raw), publicToolName(`${server}-${profileId}`, raw)]))
            const tool = runtime.schemas(flight.handle.agent).find((s: any) => names.includes(s.name))
            if (!tool) throw new Error('当前通知角色未配置企业微信发送 MCP')
            return dispatchNotification(runtime, flight.handle.agent, tool.name, args, exec)
          }) } : {}),
          ...((task.design?.evidenceContract === 'browser-patrol-v2' || profileId === task.design?.notifications?.agentId) && this.patrolStatus ? { patrolStatus: () => this.patrolStatus!({ task, batch, card, sessionId, profileId }) } : {}),
          wait: async (until, reason) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            if (task.design?.evidenceContract === 'browser-patrol-v2' && card.role !== 'reviewer')
              throw new Error('巡查v2的分时独立复验由下游评估者负责，当前角色不能 task_wait 等待评估者采样。执行者完成本轮动作并取得后台终态后调用 task_complete 交接；规划者根据证据创建下一轮或收口。ready=false 不代表执行者不能交接。')
            const wakeAt = Date.parse(until), deadline = Date.parse(card.startedAt ?? this.now()) + task.timeoutSec * 1000
            if (!/(Z|[+-]\d\d:\d\d)$/.test(until) || !Number.isFinite(wakeAt) || wakeAt < this.clock() + 60_000 || wakeAt > deadline || !reason.trim() || reason.length > 4000) throw new Error('等待需要带时区、至少一分钟且不超过本卡总时间预算的时间及简短理由')
            if (await this.pendingOperation?.({ task, batch, card, sessionId, profileId })) throw new Error('后台操作仍在运行，先继续查询原操作回执')
            if (task.design?.evidenceContract === 'browser-patrol-v2') await this.patrolStatus?.({ task, batch, card, sessionId, profileId })
            const ok = await this.store.transition(() => { assertToolActive(); return this.store.kernel.deferTask(card.id, flight.coreRunId, wakeAt, reason.trim()) }, changed => changed ? { t: 'run/deferred', at: this.now(), taskId: task.id, runId: flight.runId, wakeAt: new Date(wakeAt).toISOString(), reason: reason.trim() } : undefined)
            if (!ok) throw new Error('等待被拒绝，当前 Run 已变化')
            flight.terminal = { kind: 'deferred' }
          },
          complete: async (summary, artifacts, metadata) => submit('completed', summary, artifacts, metadata),
          requestReview: async (summary, artifacts, metadata, reviewer) => {
            if (task.graphMode === 'dynamic-rounds') throw new Error('动态 DAG 使用独立评估卡，调用 task_complete 交给下游')
            await submit('review', summary, artifacts, metadata, reviewer)
          },
          requestChanges: async (reason) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            const claim = this.store.kernel.listEvents(flight.cardId).findLast(e => e.run_id === flight.coreRunId && e.kind === 'claimed')
            if (task.graphMode === 'dynamic-rounds' || JSON.parse(claim?.payload || '{}').source_status !== 'review') throw new Error('不是同卡评审；通过 task_complete 将返工结论交给规划者')
            flight.terminal = { kind: 'changes', reason }
          },
          block: async (reason, kind) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            if (kind === 'dependency' && card.role === 'planner' && task.design?.notifications?.agentId) {
              const notice = this.store.kernel.db.prepare(`SELECT t.id FROM tasks t JOIN task_links l ON l.child_id=t.id
                WHERE l.parent_id=? AND t.role='notifier' AND t.status='todo' LIMIT 1`).get(card.id)
              if (notice) throw new Error('通知员依赖当前规划者先交接，不能反向等待 sent。已排队后根据真实证据 task_plan_round 或 task_finalize；宿主仍等待通知员结束才结算整次执行。')
            }
            if (card.role === 'notifier') {
              this.store.kernel.recordEvent(card.id,'notification_blocked',{reason,kind},flight.coreRunId)
              flight.terminal = {kind:'completed',summary:`通知未完成：${reason}`,metadata:{workflowOutcome:'unresolved',notificationBlocked:true}}
              return
            }
            const observed = await this.beforeBlock?.({ task, batch, card, sessionId, profileId, metadata:{requestedBlock:{reason,kind}} })
            assertToolActive()
            flight.terminal = { kind: 'blocked', reason: observed?.reason ?? reason, blockKind: observed?.kind ?? kind }
          },
          planRound: async (summary, items, proxyItems) => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            const plan = await this.beforePlanRound?.({ task, batch, card, sessionId, profileId }, items, proxyItems)
            if (plan) summary += `\n[FROZEN ROUND ITEMS]\n${JSON.stringify(plan.items)}`
            assertToolActive()
            await this.store.expandRound(task, batch, card, summary, () => { assertToolActive(); plan?.commit?.() })
            assertToolActive()
            flight.terminal = { kind: 'completed', summary, metadata: { decision: card.round === 1 ? 'planned' : 'rework', round: card.round } }
          },
          finalize: async (summary, artifactPath, disposition = 'passed') => {
            if (flight.terminal) throw new Error('这次运行已经提交了终态')
            if (disposition === 'unresolved' && task.design?.evidenceContract !== 'browser-patrol-v2') throw new Error('仅巡查v2允许明确的未解决收口')
            const verified = await this.beforeComplete?.({ task, batch, card, sessionId, profileId, metadata: { patrolDisposition: disposition },...(artifactPath?{finalArtifactPath:artifactPath}:{}) })
            assertToolActive()
            if (disposition === 'unresolved' && verified?.metadata.workflowOutcome !== 'unresolved') throw new Error('未通过宿主未解决收口检查')
            if (verified) summary = verified.summary
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
            assertToolActive()
            flight.terminal = { kind: 'completed', summary, metadata: { ...verified?.metadata, decision: verified?.metadata.workflowOutcome==='assisted_machine_assessed_candidate'?'assisted':'approved', round: card.round, ...(finalArtifactId ? { finalArtifactId } : {}) } }
          },
        }, { planner: task.graphMode === 'dynamic-rounds' && card.role === 'planner', dynamicRounds: task.graphMode === 'dynamic-rounds', nativeEvidence: ['browser-patrol-v2','studio-video-v1'].includes(task.design?.evidenceContract ?? '') })
      } catch (error) {
        if (task.design?.evidenceContract === 'studio-video-v1'||task.design?.extension) throw error
        console.warn('[task-console] worker tools not registered:', error)
      }
      if(task.design?.extension){
        if(!this.registerWorkflowTools&&task.design.extension.hostApi===2)throw Error('workflow-runtime-tools-unavailable')
        if(this.registerWorkflowTools){
          const old=flight.disposeTools,dispose=await this.registerWorkflowTools(flight.handle.agent.ctx,{task,batch,card,sessionId,profileId},()=>!this.stopped&&this.flights.get(sessionId)===flight&&!flight.terminal&&!flight.progressStopping&&!flight.progress?.state.reason)
          flight.disposeTools=()=>{dispose();old?.()}
        }
      }
      if (task.design?.evidenceContract === 'studio-video-v1') {
        if (!this.registerStudioTools) throw Error('studio-runtime-tools-unavailable')
        const disposeWorker = flight.disposeTools
        const disposeStudio = await this.registerStudioTools(flight.handle.agent.ctx, {task,batch,card,sessionId,profileId}, () => !this.stopped && this.flights.get(sessionId) === flight && !flight.terminal&&!flight.progressStopping&&!flight.progress?.state.reason, submitStudioReview!)
        flight.disposeTools = () => { disposeStudio(); disposeWorker?.() }
      }
      if(flight.progress){
        const old=flight.disposeTools,dispose=registerStudioProgress(flight.handle.agent.ctx,flight.progress,sessionId,()=>!this.stopped&&this.flights.get(sessionId)===flight&&!flight.progressStopping&&!flight.terminal,()=>{
          const accepted=this.ownsAcceptedProgressTerminal(flight)
          if(accepted)flight.progressTerminalBoundary=true
          return accepted
        })
        flight.disposeTools=()=>{dispose();old?.()}
      }
      try { (this.ctx as any).get('sessionTitle')?.rename?.(flight.handle.agent.session, `task: ${task.title} · ${batch.id} · ${agentName}`) } catch { /* cosmetic */ }
      try {
        const registry = (this.ctx as any).get('workspaceRegistry')
        const ws = registry ? (await registry.resolveByPath(task.cwd).catch(() => undefined)) ?? (await registry.create(task.cwd).catch(() => undefined)) : undefined
        await ws?.attachSession?.(sessionId)
      } catch { /* cosmetic */ }
      assertStartupActive()
      if(binding){
        const observed=await (assertEffectiveBinding(this.store.kernel.db,originalBinding!,binding),verifyExecutionBinding(this.ctx,binding,task.id,batch.id,profileId,this.executionIdentity))
        this.store.kernel.recordEvent(card.id,'execution_binding_verified',{originalBindingSha256:originalBinding!.sha256,migrationOverlaySha256:executionMigrationSha(this.store.kernel.db,batch.id),bindingSha256:binding.sha256,runtimeSha256:binding.runtimeSha256,agentId:profileId,selection:observed.selection,permission:observed.permission,specSha256:observed.specSha256,compositionSha256:observed.compositionSha256,capabilitySha256:observed.capabilitySha256,skillsSha256:observed.skillsSha256},flight.coreRunId)
      }
      try{await this.checkBatchWorkspace(task,batch)}catch(error){await this.finishBlocked(flight,error instanceof Error?error.message:'studio-workspace-invalid','capability');return}
      flight.handle.agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      this.store.kernel.recordEvent(card.id, 'prompt_dispatched', { message_id: messageId }, flight.coreRunId)
      await this.append({ t: 'run/prompt_dispatched', taskId: task.id, runId, messageId })
      this.arm(flight)
    } catch (error) {
      // A disposed host cannot close or reclassify a run being recovered elsewhere.
      if(this.stopped)return
      if(error instanceof ExecutionBindingError){
        this.store.kernel.recordEvent(card.id,'execution_binding_rejected',{bindingSha256:binding?.sha256??null,code:error.message},flight.coreRunId)
        await this.finishBlocked(flight,error.message,'capability');return
      }
      flight.disposeModelSelection?.()
      try { await this.disposePreparationHandle(flight) } catch { /* no stop receipt on failure */ }
      this.flights.delete(sessionId)
      this.stopHeartbeat(flight)
      this.store.kernel.failRun(card.id, { expectedRunId: flight.coreRunId, outcome: 'failed', error: error instanceof Error ? error.message : String(error) })
      await this.append({ t: 'run/failed', taskId: task.id, runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The watchdog counts working time only: it pauses while a person is being waited on. */
  private arm(f: Flight): void {
    if (f.timer) clearTimeout(f.timer)
    f.timer = setTimeout(() => { void this.finish(f, 'run/timed_out', 'timed_out', `${f.timeoutSec} 秒没交卷`) }, f.deadline ? Math.max(0, f.deadline - this.clock()) : f.timeoutSec * 1000)
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
    if (f.idleTimer) { clearTimeout(f.idleTimer); f.idleTimer = undefined }
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
        if (f.idleTimer) { clearTimeout(f.idleTimer); f.idleTimer = undefined }
        if (event.data?.id === f.messageId) f.consumed = true
        else if (run?.status === 'blocked' && event.data?.source?.kind === 'user' && f.terminal?.kind === 'blocked') {
          // A person answered in the session: the block is over, the run continues.
          f.terminal = undefined
          this.arm(f)
          void this.append({ t: 'run/resumed', taskId: f.taskId, runId: f.runId })
        }
        break
      case 'tool/call':
        f.toolCalled = true
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

  private ownsAcceptedProgressTerminal(f:Flight):boolean {
    if(this.stopped||this.flights.get(f.sessionId)!==f||!f.terminal||f.progressStopping||f.progress?.state.reason||preparationBarrier(this.store.kernel.db,f.cardId))return false
    const card=this.store.s.cards.get(f.cardId),batch=card&&this.store.s.batches.get(card.batchId),current=this.store.kernel.getTask(f.cardId)
    if(!batch||batch.settled||batch.archivedAt||!current)return false
    if(f.terminal.kind==='deferred'){
      // deferTask already closes the kernel run. The exact durable wakeup, not
      // a missing current run, proves that this session accepted the wait.
      const wake=this.store.kernel.db.prepare("SELECT run_id FROM dsh_task_wakeups WHERE card_id=? AND state='pending'").get(f.cardId) as any
      return current.status==='scheduled'&&current.current_run_id===null&&wake?.run_id===f.coreRunId
    }
    return current.status==='running'&&current.current_run_id===f.coreRunId
  }

  private async onTurnEnd(f: Flight, reason: any): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    if (f.idleTimer) { clearTimeout(f.idleTimer); f.idleTimer = undefined }
    if(f.progressStopping)return
    if(f.progress?.state.reason){await this.finishProgress(f);return}
    // Native pre-step rejection after an accepted terminator is a normal close,
    // even if the driver labels its rejected boundary as interrupted. Never
    // convert an unrelated failure or superseded kernel run into completion.
    if(f.progressTerminalBoundary&&this.ownsAcceptedProgressTerminal(f))reason={kind:'completed'}
    if (reason && reason.kind !== 'completed') {
      const fallback = f.executionBinding?f.boundFallback:this.modelFallback
      if (fallback && startupFallbackAllowed(reason, { used: f.fallbackUsed, toolCalled: f.toolCalled, terminal: f.terminal, provider: f.modelProvider }, fallback.fromProvider)) {
        f.fallbackUsed = true // Reserve once before async resolution or duplicate events.
        try {
          if(f.executionBinding){assertEffectiveBinding(this.store.kernel.db,this.store.s.batches.get(this.store.s.cards.get(f.cardId)!.batchId)!.turn!.executionBinding!,f.executionBinding)}
          if(f.executionBinding)await verifyExecutionBinding(this.ctx,f.executionBinding,f.taskId,this.store.s.cards.get(f.cardId)!.batchId,f.profileId,this.executionIdentity)
          const resolved = await (this.ctx as any).get('llm').resolveCallConfig({ provider: fallback.provider, model: fallback.model })
          if(f.executionBinding&&(resolved.provider!==fallback.provider||resolved.model!==fallback.model))throw new ExecutionBindingError('fallback-resolution-drift')
          if (!this.flights.has(f.sessionId)) return
          if(f.executionBinding){assertEffectiveBinding(this.store.kernel.db,this.store.s.batches.get(this.store.s.cards.get(f.cardId)!.batchId)!.turn!.executionBinding!,f.executionBinding);await verifyExecutionBinding(this.ctx,f.executionBinding,f.taskId,this.store.s.cards.get(f.cardId)!.batchId,f.profileId,this.executionIdentity)}
          f.disposeFallback = installFallbackSelection(f.handle.agent.ctx, { provider: resolved.provider, model: resolved.model })
          const fact = { from: f.modelProvider, to: `${resolved.provider}/${resolved.model}`, code: reason.error.code, stage: 'before-tools' }
          this.store.kernel.recordEvent(f.cardId, 'model_fallback', fact, f.coreRunId)
          f.modelProvider = resolved.provider
          f.handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: `[HOST MODEL FALLBACK]\n主模型启动失败（${fact.code}），尚未调用任何工具。已切换至 ${fact.to}。在同一任务、会话与原权限范围继续原始请求；不是新任务，不得改变验收条件。` }], source: { kind: 'user' } })
          return
        } catch (error) {
          if(error instanceof ExecutionBindingError){
            this.store.kernel.recordEvent(f.cardId,'execution_binding_rejected',{bindingSha256:f.executionBinding?.sha256??null,code:error.message},f.coreRunId)
            await this.finishBlocked(f,error.message,'capability');return
          }
          this.store.kernel.recordEvent(f.cardId, 'model_fallback_unavailable', { provider: fallback.provider, model: fallback.model }, f.coreRunId)
        }
      }
      await this.finish(f, 'run/failed', 'failed', JSON.stringify(reason)); return
    }
    const t = f.terminal
    if (t?.kind === 'deferred') {
      this.flights.delete(f.sessionId); this.disarm(f); this.stopHeartbeat(f); f.disposeFallback?.(); f.disposeModelSelection?.(); f.disposeTools?.()
      try { await f.handle?.dispose?.() } catch { /* already closed */ }
      await this.tick(); return
    }
    if (t?.kind === 'completed') { await this.finish(f, 'run/completed', 'completed', undefined, t.summary, false, t.metadata); return }
    if (t?.kind === 'review') { await this.finish(f, 'run/review_requested', 'review', undefined, t.summary, false, t.metadata, t.reviewer); return }
    if (t?.kind === 'changes') { await this.finishChanges(f, t.reason ?? 'changes requested'); return }
    if (t?.kind === 'blocked') { await this.finishBlocked(f, t.reason ?? 'blocked', t.blockKind ?? 'needs_input'); return }
    const run = this.store.s.runs.get(f.runId)
    if (run?.status === 'blocked') return   // ask_user_question in flight
    const card = this.store.s.cards.get(f.cardId), batch = card && this.store.s.batches.get(card.batchId)
    const base = this.store.tasks.get(f.taskId)
    let outcomeNotice: string | undefined
    if (card && batch && base && this.pendingOperation) {
      try {
        const pending = await this.pendingOperation({ task: taskForBatch(base, batch), batch, card, sessionId: f.sessionId, profileId: f.profileId })
        if (!this.flights.has(f.sessionId)) return
        if (pending) {
          f.waitedForOperation = true
          // An async operation outlives a model turn. Retain its live Run/CAS
          // binding; poll receipts without LLM calls, without extending timeout.
          f.idleTimer = setTimeout(() => { void this.onTurnEnd(f, reason) }, 30_000)
          ;(f.idleTimer as any).unref?.()
          return
        }
        const input = { task: taskForBatch(base, batch), batch, card, sessionId: f.sessionId, profileId: f.profileId }
        outcomeNotice = await this.operationContinuation?.(input)
        if (!outcomeNotice && f.waitedForOperation) outcomeNotice = await this.operationOutcome?.(input)
        f.waitedForOperation = false
      } catch { await this.finish(f, 'run/failed', 'failed', '无法核验后台操作状态，未宣称完成'); return }
    }
    if (!this.flights.has(f.sessionId)) return
    if (outcomeNotice) {
      // A receipt-driven continuation is normal progress, not a protocol repair.
      // Keep the same Run/claim and original watchdog; do not spend nudges.
      this.store.kernel.recordEvent(f.cardId, 'operation_resumed', { reason: 'background-terminal-receipt' }, f.coreRunId)
      f.handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: outcomeNotice }], source: { kind: 'user' } })
      return
    }
    const nativeEvidence = !!base && !!batch && ['browser-patrol-v2','studio-video-v1'].includes(taskForBatch(base,batch).design?.evidenceContract??'') && card?.role !== 'planner'
    const studioPlanner = !!base && !!batch && taskForBatch(base,batch).design?.evidenceContract === 'studio-video-v1' && card?.role === 'planner'
    const maxNudges = nativeEvidence || studioPlanner ? 2 : 1
    if ((run?.nudges ?? 0) < maxNudges) {
      await this.append({ t: 'run/nudged', taskId: f.taskId, runId: f.runId })
      const correction = studioPlanner ? '上次只有普通文本，没有执行规划交接工具。请依据真实证据，实际调用 task_plan_round 安排继续制作或返修；全部验收通过才实际调用 task_finalize；无法继续则调用 task_block。参数使用工具定义的 JSON 对象，不要在普通文字中写函数调用，也不要重复已完成的外部操作。' : nativeEvidence ? `${(run?.nudges ?? 0) > 0 ? '最后一次协议纠正。' : ''}上次只有普通文本，没有执行交卷工具。现在请实际调用 task_complete，仅传 JSON 对象 {"summary":"简短如实交接"}，省略 metadata 和 artifacts；或实际调用 task_block 说明阻塞。宿主自动读取证据，不接受你口述成功。不要复查或重发业务操作，不要再次只输出“我将调用”的文字。` : NUDGE
      f.handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: correction }], source: { kind: 'user' } })
      return
    }
    await this.finish(f, 'run/failed', 'protocol_violation', `经过 ${maxNudges} 次协议纠正仍未调用 task_complete / task_block`)
  }

  /** Stop first with guards still installed; only a confirmed stop may retry. */
  private async finishProgress(f:Flight):Promise<void>{
    if(f.progressStopping||!f.progress||!this.flights.has(f.sessionId))return
    f.progressStopping=true
    this.disarm(f);this.stopHeartbeat(f)
    const card=this.store.s.cards.get(f.cardId)!,batch=this.store.s.batches.get(card.batchId)!,task=taskForBatch(this.store.tasks.get(f.taskId)!,batch)
    const facts=JSON.parse(f.progress.summary(task.cwd))
    const record=(stopConfirmed:boolean,blocked?:string)=>this.store.kernel.recordEvent(f.cardId,'studio_progress_stopped',{schemaVersion:1,policy:'studio-bounded-v1',sessionId:f.sessionId,stopConfirmed,...facts,...(blocked?{blocked,...(stopConfirmed?{reconciliationVersion:1}:{})}: {})},f.coreRunId)
    record(false)
    try{await this.disposePreparationHandle(f);f.progressDisposed=true}
    catch{
      // Keep the tools/pre-step fence installed. No new run may be claimed until
      // host stop is independently confirmed; absence from flights is no proof.
      record(false,'session-stop-unconfirmed')
      const reason='studio-progress-session-stop-unconfirmed: '+JSON.stringify(facts)
      await this.store.transition(()=>this.store.kernel.blockTask(f.cardId,{expectedRunId:f.coreRunId,reason,kind:'capability'}),ok=>ok?{t:'run/blocked',at:this.now(),taskId:f.taskId,runId:f.runId,kind:'capability',reason,terminal:true}:undefined)
      return
    }
    let pending:string|undefined
    try{pending=studioProgressPending(this.store.kernel.db,{task,batch,card})}catch{pending='studio-progress-operation-state-unavailable; reconcile original operations before unblocking'}
    record(true,pending)
    await this.finish(f,'run/failed','failed','STUDIO_PROGRESS_GUARD: '+JSON.stringify(facts))
  }

  private async finish(f: Flight, t: 'run/completed' | 'run/review_requested' | 'run/failed' | 'run/timed_out' | 'run/cancelled', outcome: string, error?: string, summary?: string, giveUpNow = false, metadata?: Record<string, unknown>, reviewer?: string): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    this.stopHeartbeat(f)
    f.disposeFallback?.()
    f.disposeModelSelection?.()
    f.disposeTools?.()
    try { await this.disposePreparationHandle(f) } catch { /* no preparation stop receipt on failure */ }
    if(preparationBarrier(this.store.kernel.db,f.cardId)){t='run/cancelled';outcome='cancelled';error='Preparation revision superseded this run';giveUpNow=false;metadata=undefined}
    let changed = false
    if (t === 'run/completed') {
      changed = await this.store.transition(
        () => {
          if(preparationBarrier(this.store.kernel.db,f.cardId))return false
          // Re-read at the final transactional boundary: assistance may have been
          // recorded after asynchronous artifact validation or session disposal.
          const card=this.store.s.cards.get(f.cardId),batch=card&&this.store.s.batches.get(card.batchId),template=this.store.tasks.get(f.taskId)
          if(card?.role==='planner'&&batch&&template&&taskForBatch(template,batch).design?.evidenceContract==='studio-video-v1'&&metadata&&['machine_assessed_candidate','assisted_machine_assessed_candidate'].includes(String(metadata.workflowOutcome))){
            const autonomy=new StudioInterventions(this.store).assessment({taskId:f.taskId,batchId:batch.id})
            metadata={...metadata,autonomy,...(autonomy.status==='assisted'?{decision:'assisted',workflowOutcome:'assisted_machine_assessed_candidate'}:{})}
            if(autonomy.status==='assisted')summary='机器质检候选片（有人工协助）；不计为自主成功，也非用户审美认可。'
          }
          return this.store.kernel.completeTask(f.cardId, { expectedRunId: f.coreRunId, summary: summary ?? f.lastText, metadata })
        },
        ok => ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...(metadata ? { metadata } : {}) } : undefined,
      )
    } else if (t === 'run/review_requested') {
      changed = await this.store.transition(
        () => preparationBarrier(this.store.kernel.db,f.cardId) ? false : this.store.kernel.requestReview(f.cardId, { expectedRunId: f.coreRunId, summary: summary ?? f.lastText, metadata, reviewer }),
        ok => ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...(metadata ? { metadata } : {}), ...(reviewer ? { reviewer } : {}) } : undefined,
      )
    } else {
      const mapped = outcome === 'timed_out' ? 'timed_out' : outcome === 'cancelled' ? 'cancelled' : outcome === 'protocol_violation' ? 'protocol_violation' : 'failed'
      const result = await this.store.transition(
        () => {
          const failed = this.store.kernel.failRun(f.cardId, { expectedRunId: f.coreRunId, outcome: mapped, error })
          if(failed.ok&&mapped==='failed'&&f.progressDisposed)new StudioProgressReconcile(this.store).arm(f.cardId,f.coreRunId)
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
    if (t === 'run/completed' && ['approved','assisted'].includes(String(metadata?.decision)) && typeof metadata?.finalArtifactId === 'string') {
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
    f.disposeFallback?.()
    f.disposeModelSelection?.()
    f.disposeTools?.()
    try { await this.disposePreparationHandle(f) } catch { /* no preparation stop receipt on failure */ }
    const ok = await this.store.transition(
      () => this.store.kernel.blockTask(f.cardId, { expectedRunId: f.coreRunId, reason, kind }),
      changed => changed ? { t: 'run/blocked', at: this.now(), taskId: f.taskId, runId: f.runId, kind, reason, terminal: true } : undefined,
    )
    if (!ok) console.warn(`[task-console] stale block refused: ${f.cardId} core run ${f.coreRunId}`)
    if (ok && this.afterBlock) {
      const card=this.store.s.cards.get(f.cardId)!,batch=this.store.s.batches.get(card.batchId)!,base=this.store.tasks.get(f.taskId)!
      try { await this.afterBlock({task:taskForBatch(base,batch),batch,card,sessionId:f.sessionId,profileId:f.profileId}) }
      catch { console.warn('[task-console] blocked notification could not be queued; original block retained') }
    }
    await this.tick()
  }

  private async finishChanges(f: Flight, reason: string): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    this.stopHeartbeat(f)
    f.disposeFallback?.()
    f.disposeModelSelection?.()
    f.disposeTools?.()
    try { await this.disposePreparationHandle(f) } catch { /* no preparation stop receipt on failure */ }
    const result = await this.store.transition(
      () => this.store.kernel.requestChanges(f.cardId, { expectedRunId: f.coreRunId, reason }),
      value => value.ok ? { t: 'card/changes_requested', at: this.now(), taskId: f.taskId, cardId: f.cardId, runId: f.runId, note: reason, targetCardId: f.cardId, reviewer: f.profileId } : undefined,
    )
    if (!result.ok) console.warn(`[task-console] request_changes refused: ${result.error}`)
    await this.tick()
  }

  async cancelBatch(batchId: string): Promise<void> {
    const b = this.store.s.batches.get(batchId); if (!b) return
    if (b.archivedAt) throw new Error('执行记录已归档，历史状态保持不变')
    this.dispatchSuspended++
    try {
      for (const f of [...this.flights.values()]) { const r = this.store.s.runs.get(f.runId); if (r?.batchId === batchId) await this.finish(f, 'run/cancelled', 'cancelled', '人工取消') }
      for (const id of b.cardIds) {
        // A previous failed terminal transition can leave a claimed run without a Flight.
        const core = this.store.kernel.getTask(id)
        if (core?.current_run_id) {
          const run = [...this.store.s.runs.values()].find(r => r.cardId === id && r.status === 'running')
          if (run) await this.store.transition(
            () => this.store.kernel.failRun(id, { expectedRunId: core.current_run_id!, outcome: 'cancelled', error: '人工取消批次：清理遗留运行' }),
            result => result.ok ? { t: 'run/cancelled', at: this.now(), taskId: b.taskId, runId: run.id, outcome: 'cancelled', error: '人工取消批次：清理遗留运行' } : undefined,
          )
        }
        const c = this.store.s.cards.get(id)
        const remaining = this.store.kernel.getTask(id)
        if (c && remaining && remaining.current_run_id === null && !['done', 'archived'].includes(remaining.status)) await this.store.transition(
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
    if (card && this.store.s.batches.get(card.batchId)?.archivedAt) throw new Error('执行记录已归档，历史状态保持不变')
    if (!card || card.status !== 'review' || !card.currentRunId && !card.runIds.length) throw new Error('这张卡不在待验收状态')
    const runId = card.runIds[card.runIds.length - 1]
    if (decision === 'approve') {
      const batch=this.store.s.batches.get(card.batchId),base=this.store.tasks.get(card.taskId)
      if(!batch||!base)throw Error('review-task-definition-missing')
      if(taskForBatch(base,batch).design?.extension)throw Error('workflow-extension-human-review-bypass-forbidden: request changes and submit host evidence')
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

  async recoverStudioCard(input: StudioRecoveryInput) {
    const result = await recoverStudioFailure(this.store, input)
    if (!result.replay) void this.tick().catch(error => console.warn('[task-console] studio recovery dispatch failed', String(error)))
    return { ok: true, ...result }
  }

  /** Fail closed before an operator retry creates a new Session/Run. */
  async assertRecoveryExecutionIdentity(cardId:string):Promise<void>{
    const card=this.store.s.cards.get(cardId),batch=card&&this.store.s.batches.get(card.batchId),template=card&&this.store.tasks.get(card.taskId)
    if(!card||!batch||!template||batch.settled||batch.archivedAt||template.archivedAt)throw Error('task-recovery-context-changed')
    const task=taskForBatch(template,batch),binding=batch.turn?.executionBinding
    if(task.design?.executionBinding==='agent-runtime-v1'&&!binding)throw Error('task-recovery-execution-binding-missing')
    if(!binding)return
    try{await verifyExecutionBinding(this.ctx,effectiveExecutionBinding(this.store.kernel.db,binding),task.id,batch.id,card.agentId,this.executionIdentity)}
    catch(error){
      if(error instanceof ExecutionBindingError&&['batch-execution-binding-agent-drift','batch-execution-binding-runtime-drift'].includes(error.message))throw Error(`task-recovery-binding-migration-required:${error.message}`)
      throw error
    }
  }

  /** Hermes unblock semantics: a blocked run stays closed and a new run is claimed. */
  async unblockCard(cardId: string): Promise<void> {
    const card = this.store.s.cards.get(cardId)
    if (card && this.store.s.batches.get(card.batchId)?.archivedAt) throw new Error('执行记录已归档；请新建执行重新检查，不改写历史阻塞')
    if (!card || card.status !== 'blocked') throw new Error('这张卡不在阻塞状态')
    const existingBatch = this.store.s.batches.get(card.batchId), existingTemplate = this.store.tasks.get(card.taskId)
    const existingTask = existingBatch && existingTemplate ? taskForBatch(existingTemplate, existingBatch) : undefined
    if (existingBatch && existingTask?.workflowRecipe?.id === fullFleetRecipe
      && this.clock() >= Date.parse(existingBatch.firedAt) + existingTask.timeoutSec * fleetRoles.length * 1000)
      throw new Error('本次 Fleet 执行已超过总时限；请在同一 Task 新建执行，保留旧记录，不能解除阻塞后立即创建超时 Run')
    if (card.wakeAt && Date.parse(card.wakeAt) > this.clock()) throw new Error('定时等待尚未到期，不能提前当作复验完成')
    await this.assertRecoveryExecutionIdentity(cardId)
    const ok = await this.store.transition(
      () => {
        const changed=this.store.kernel.unblockTask(cardId)
        const batch=this.store.s.batches.get(card.batchId),template=this.store.tasks.get(card.taskId)
        if(changed&&batch&&template&&taskForBatch(template,batch).design?.evidenceContract==='studio-video-v1'){
          const sourceRunId=card.runIds.at(-1);if(!sourceRunId)throw Error('studio-unblock-source-run-required')
          new StudioInterventions(this.store).record({id:`unblock:${sourceRunId}`,taskId:card.taskId,batchId:card.batchId,cardId,sourceRunId,kind:'operator_unblock',reason:'Operator explicitly unblocked the card'})
        }
        return changed
      },
      changed => changed && this.store.kernel.getTask(cardId)?.status === 'ready' ? { t: 'card/ready', at: this.now(), taskId: card.taskId, cardId } : undefined,
    )
    if (!ok) throw new Error('核心任务状态已经变化，无法解除阻塞')
    const batch = this.store.s.batches.get(card.batchId)
    const template = this.store.tasks.get(card.taskId)
    if (batch && template && taskForBatch(template, batch).design?.evidenceContract === 'studio-video-v1') {
      // The durable unblock is the HTTP acknowledgement boundary. Media preflight
      // may take minutes; the ordinary tick guard + kernel CAS still own claiming.
      void this.tick().catch(error => {
        console.warn('[task-console] studio background unblock dispatch failed', error instanceof Error ? error.message : String(error))
        try { this.store.kernel.recordEvent(card.id, 'studio_unblock_dispatch_failed', { message: error instanceof Error ? error.message : String(error) }) }
        catch { console.warn('[task-console] studio unblock dispatch failure could not be persisted') }
      })
      return
    }
    await this.tick()
  }

  /** Remember display names so upstream handoffs read "from 巡检员", not "from inspector". */
  rememberName(id: string, name: string): void { this.nameCache.set(id, name) }
}
