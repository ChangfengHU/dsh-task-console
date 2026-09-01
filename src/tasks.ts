/**
 * Store, validation, and the message a card receives. The model itself
 * lives in ./fold.ts (pure, shared with the browser).
 *
 * @module dsh-task-console/tasks
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fold, migrate, type Card, type Event, type Participant, type State, type TaskSpec, type Trigger } from './fold.ts'
import { HermesKernel, type ClaimResult } from './hermes-kernel.ts'

export { actorOf, batchStatus, cardRun, describe, fold, foldTurns, migrate, readyCards, BLOCK_RECURRENCE_LIMIT } from './fold.ts'
export type { Artifact, Batch, BlockKind, Card, CardStatus, Event, Participant, Run, RunOutcome, RunStatus, State, StepRow, TaskSpec, ToolRow, Trigger, TurnLedger, TurnRow } from './fold.ts'
export { cronHuman, cronMatches, nextFire, parseCron, type Cron } from './cron.ts'
import { parseCron } from './cron.ts'

// ── store ───────────────────────────────────────────────────────────────

export function storeDir(home = homedir()): string {
  return join(process.env.DSH_HOME ?? join(home, '.dsh'), 'task-console')
}

/** SQLite-backed append-only event log with the fold kept in memory. */
export class EventStore {
  private events: Event[] = []
  private state: State = fold([])
  private queue: Promise<void> = Promise.resolve()
  private readonly dir: string
  private _kernel?: HermesKernel

  constructor(dir = storeDir()) { this.dir = dir }

  get file(): string { return join(this.dir, 'task.db') }
  get legacyFile(): string { return join(this.dir, 'events.jsonl') }
  get root(): string { return this.dir }
  get kernel(): HermesKernel {
    if (!this._kernel) throw new Error('task store 尚未加载')
    return this._kernel
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    this._kernel = new HermesKernel(this.file)
    const count = Number((this.kernel.db.prepare('SELECT COUNT(*) AS n FROM dsh_events').get() as { n: number }).n)
    if (count === 0) await this.importLegacyJsonl()
    const rows = this.kernel.db.prepare('SELECT payload_json FROM dsh_events ORDER BY seq').all() as { payload_json: string }[]
    this.events = rows.flatMap(row => { try { return [JSON.parse(row.payload_json) as Event] } catch { return [] } })
    this.state = fold(this.events)
    this.backfillCoreProjection()
  }

  /** One-time, read-only import. The JSONL file remains untouched for rollback and audit. */
  private async importLegacyJsonl(): Promise<void> {
    let text = ''
    try { text = await readFile(this.legacyFile, 'utf8') } catch { return }
    const raw = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const events = migrate(raw)
    this.kernel.write(() => {
      const insert = this.kernel.db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)')
      for (const event of events) insert.run(event.t, 'taskId' in event ? event.taskId : null, event.at, JSON.stringify(event))
    })
  }

  all(): Event[] { return this.events }
  get s(): State { return this.state }
  get tasks(): Map<string, TaskSpec> { return this.state.tasks }

  /**
   * One-time migration of the pre-0.11 event projection into normalized core
   * rows. The historical DSH events remain untouched and continue to power
   * replay; all new scheduling decisions read `tasks` / `task_runs`.
   */
  private backfillCoreProjection(): void {
    const marker = this.kernel.db.prepare(`SELECT value FROM dsh_meta WHERE key = 'dsh_projection_v1'`).get()
    if (marker) return
    const st = this.state
    this.kernel.write(() => {
      const db = this.kernel.db
      const specStmt = db.prepare(`INSERT OR REPLACE INTO dsh_task_specs(id, spec_json, enabled, created_at) VALUES (?, ?, ?, ?)`)
      for (const spec of st.tasks.values()) specStmt.run(spec.id, JSON.stringify(spec), spec.enabled ? 1 : 0, toEpoch(spec.createdAt))

      const batchStmt = db.prepare(`INSERT OR REPLACE INTO dsh_batches(id, spec_id, fired_by, fired_at, settled_at, outcome) VALUES (?, ?, ?, ?, ?, ?)`)
      const cardStmt = db.prepare(`INSERT OR REPLACE INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`)
      const taskStmt = db.prepare(`INSERT OR IGNORE INTO tasks(
        id, title, body, assignee, status, priority, created_by, created_at, started_at,
        completed_at, workspace_kind, workspace_path, tenant, consecutive_failures,
        max_runtime_seconds, max_retries, block_kind, block_recurrences
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`)
      for (const batch of st.batches.values()) {
        const spec = st.tasks.get(batch.taskId)
        if (!spec) continue
        batchStmt.run(batch.id, spec.id, batch.by, toEpoch(batch.firedAt), batch.settled ? toEpoch(batch.settled.at) : null, batch.settled?.outcome ?? null)
        for (const cardId of batch.cardIds) {
          const card = st.cards.get(cardId); if (!card) continue
          cardStmt.run(card.id, spec.id, batch.id, card.index, card.brief ?? null)
          taskStmt.run(
            card.id, `${spec.title} · ${card.agentId}`, card.brief || spec.brief, card.agentId,
            coreStatus(card.status), card.index * -1, 'dsh-task-console', toEpoch(batch.firedAt),
            card.startedAt ? toEpoch(card.startedAt) : null, card.endedAt ? toEpoch(card.endedAt) : null,
            spec.cwd, batch.id, card.consecutiveFailures, spec.timeoutSec, spec.maxTries,
            card.status === 'blocked' ? (st.runs.get(card.currentRunId ?? '')?.blockKind ?? null) : null,
            card.blockRecurrences,
          )
        }
        for (const cardId of batch.cardIds) {
          const card = st.cards.get(cardId); if (!card) continue
          for (const parent of card.deps) db.prepare('INSERT OR IGNORE INTO task_links(parent_id, child_id) VALUES (?, ?)').run(parent, card.id)
        }
      }

      const runStmt = db.prepare(`INSERT INTO task_runs(
        task_id, profile, status, started_at, ended_at, outcome, summary, metadata, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const bindStmt = db.prepare(`INSERT OR REPLACE INTO dsh_run_bindings(external_run_id, core_run_id, session_id, message_id, nudges) VALUES (?, ?, ?, ?, ?)`)
      for (const run of st.runs.values()) {
        const card = st.cards.get(run.cardId); if (!card) continue
        const inserted = runStmt.run(card.id, card.agentId, coreRunStatus(run.status), toEpoch(run.startedAt), run.endedAt ? toEpoch(run.endedAt) : null, run.outcome ?? null, run.summary ?? null, run.metadata ? JSON.stringify(run.metadata) : null, run.error ?? null)
        const coreRunId = Number(inserted.lastInsertRowid)
        bindStmt.run(run.id, coreRunId, run.sessionId || null, null, run.nudges)
        if (card.currentRunId === run.id) db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(coreRunId, card.id)
      }
      db.prepare(`INSERT INTO dsh_meta(key, value) VALUES ('dsh_projection_v1', ?)`).run(new Date().toISOString())
    })
  }

  private applyExtension(e: Event): void {
    const db = this.kernel.db
    switch (e.t) {
      case 'task/created':
        db.prepare(`INSERT OR REPLACE INTO dsh_task_specs(id, spec_json, enabled, created_at) VALUES (?, ?, ?, ?)`).run(e.task.id, JSON.stringify(e.task), e.task.enabled ? 1 : 0, toEpoch(e.at)); break
      case 'task/enabled':
        db.prepare('UPDATE dsh_task_specs SET enabled = ? WHERE id = ?').run(e.enabled ? 1 : 0, e.taskId); break
      case 'task/deleted': {
        const cards = db.prepare('SELECT card_id FROM dsh_card_bindings WHERE spec_id = ?').all(e.taskId) as { card_id: string }[]
        for (const { card_id } of cards) {
          db.prepare('DELETE FROM task_links WHERE parent_id = ? OR child_id = ?').run(card_id, card_id)
          db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(card_id)
          db.prepare('DELETE FROM task_events WHERE task_id = ?').run(card_id)
          db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(card_id)
          db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(card_id)
          db.prepare('DELETE FROM tasks WHERE id = ?').run(card_id)
        }
        db.prepare('DELETE FROM dsh_run_bindings WHERE core_run_id NOT IN (SELECT id FROM task_runs)').run()
        db.prepare('DELETE FROM dsh_card_bindings WHERE spec_id = ?').run(e.taskId)
        db.prepare('DELETE FROM dsh_batches WHERE spec_id = ?').run(e.taskId)
        db.prepare('DELETE FROM dsh_task_specs WHERE id = ?').run(e.taskId)
        break
      }
      case 'batch/settled':
        db.prepare('UPDATE dsh_batches SET settled_at = ?, outcome = ? WHERE id = ?').run(toEpoch(e.at), e.outcome, e.batchId); break
      case 'run/session_created':
        db.prepare('UPDATE dsh_run_bindings SET session_id = ? WHERE external_run_id = ?').run(e.sessionId, e.runId); break
      case 'run/prompt_dispatched':
        db.prepare('UPDATE dsh_run_bindings SET message_id = ? WHERE external_run_id = ?').run(e.messageId, e.runId); break
      case 'run/nudged':
        db.prepare('UPDATE dsh_run_bindings SET nudges = nudges + 1 WHERE external_run_id = ?').run(e.runId); break
      case 'artifact/registered':
        db.prepare(`INSERT INTO task_attachments(task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.artifact.cardId, e.artifact.name, e.artifact.storagePath, e.artifact.mime, e.artifact.size, e.artifact.sessionId, toEpoch(e.at)); break
      default: break
    }
  }

  /** Serialized append: the UI projection is updated only after SQLite commits. */
  append(e: Event): Promise<void> {
    const next = this.queue.then(async () => {
      this.kernel.write(() => {
        this.applyExtension(e)
        this.kernel.db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)')
          .run(e.t, 'taskId' in e ? e.taskId : null, e.at, JSON.stringify(e))
      })
      this.events.push(e)
      this.state = fold(this.events)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Atomically mutate the normalized core and persist the matching DSH read event. */
  transition<T>(mutate: () => T, project: (result: T) => Event | undefined): Promise<T> {
    let projected: Event | undefined
    const next = this.queue.then(async () => {
      const result = this.kernel.compose(() => {
        const value = mutate()
        projected = project(value)
        if (projected) {
          this.applyExtension(projected)
          this.kernel.db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)')
            .run(projected.t, 'taskId' in projected ? projected.taskId : null, projected.at, JSON.stringify(projected))
        }
        return value
      })
      if (projected) { this.events.push(projected); this.state = fold(this.events) }
      return result
    })
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** Create executable Hermes rows for one DSH batch, then emit its UI event. */
  async createBatch(task: TaskSpec, event: Extract<Event, { t: 'batch/fired' }>): Promise<void> {
    this.kernel.write(() => {
      const db = this.kernel.db
      db.prepare(`INSERT INTO dsh_batches(id, spec_id, fired_by, fired_at) VALUES (?, ?, ?, ?)`).run(event.batch.id, task.id, event.batch.by, toEpoch(event.at))
      const insertedCards: string[] = []
      for (const [index, card] of event.batch.cards.entries()) {
        db.prepare(`INSERT INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`).run(card.id, task.id, event.batch.id, index, card.brief ?? null)
        const status = card.deps.length ? 'todo' : 'ready'
        db.prepare(`INSERT INTO tasks(id, title, body, assignee, status, priority, created_by, created_at,
          workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries)
          VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?)`).run(
          card.id, `${task.title} · ${card.agentId}`, [task.brief, card.brief].filter(Boolean).join('\n\n'), card.agentId,
          status, index * -1, toEpoch(event.at), task.cwd, event.batch.id, task.timeoutSec, task.maxTries,
        )
        for (const parent of card.deps) db.prepare('INSERT INTO task_links(parent_id, child_id) VALUES (?, ?)').run(parent, card.id)
        db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at) VALUES (?, 'created', ?, ?)`).run(card.id, JSON.stringify({ assignee: card.agentId, status, parents: card.deps, tenant: event.batch.id }), toEpoch(event.at))
        insertedCards.push(card.id)
      }
      if (insertedCards.length !== event.batch.cards.length) throw new Error('batch card insert incomplete')
      db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)').run(event.t, event.taskId, event.at, JSON.stringify(event))
    })
    this.events.push(event); this.state = fold(this.events)
  }

  async claimCard(cardId: string, externalRunId: string, sessionId: string, attempt: number, fromReview = false): Promise<ClaimResult | undefined> {
    return this.transition(
      () => this.kernel.claimTask(cardId, { fromReview }),
      claim => {
        if (!claim) return undefined
        this.kernel.db.prepare(`INSERT INTO dsh_run_bindings(external_run_id, core_run_id, session_id) VALUES (?, ?, ?)`).run(externalRunId, claim.run.id, sessionId)
        return { t: 'run/claimed', at: new Date(claim.run.started_at * 1000).toISOString(), taskId: this.state.cards.get(cardId)?.taskId ?? '', cardId, runId: externalRunId, sessionId, attempt, profileId: claim.run.profile ?? undefined }
      },
    )
  }

  coreRunId(externalRunId: string): number | undefined {
    return (this.kernel.db.prepare('SELECT core_run_id FROM dsh_run_bindings WHERE external_run_id = ?').get(externalRunId) as { core_run_id: number } | undefined)?.core_run_id
  }
}

const toEpoch = (value: string): number => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000)
}

const coreStatus = (status: Card['status']): string => status === 'failed' ? 'blocked' : status === 'cancelled' ? 'archived' : status
const coreRunStatus = (status: string): string => status === 'cancelled' ? 'released' : status

// ── the message a card receives ─────────────────────────────────────────

/** The one user message a card's session gets: brief, its part, the upstream handoffs, and the contract. */
export function cardMessage(task: TaskSpec, card: Card, batchId: string, upstream: { agentName: string; summary: string }[]): string {
  const lines = [`# 任务:${task.title} · ${batchId} · 第 ${card.index + 1}/${task.participants.length} 张卡`, '', '[TASK]', task.brief.trim()]
  if (card.brief?.trim()) lines.push('', '[YOUR PART]', card.brief.trim())
  for (const u of upstream) lines.push('', `[UPSTREAM HANDOFF from ${u.agentName}]`, u.summary.trim() || '(上游没有留下交接单)')
  if (card.reviewNote?.trim()) lines.push('', '[REVIEW CHANGES]', card.reviewNote.trim())
  lines.push('', '[CONTRACT]',
    '做完后必须调用 task_complete(summary, artifacts, metadata) 交卷;summary 写「产物 / 干了什么 / 下游注意」,它会原样交给下一张卡。',
    '生成了文件时,必须把文件路径放进 artifacts 数组;系统会保存不可变副本并让浏览器直接预览或下载。',
    '做完但需要验收时调用 task_request_review(summary, artifacts, metadata, reviewer?);验收通过前不会启动下游。指定 reviewer 会由评估 Agent 领取，不指定则进入人工闸门。',
    '作为评估者发现问题时调用 task_request_changes(reason);旧评审 Run 会关闭，原执行者得到新的返工 Run。',
    '拿不准且不可逆的事:能用 ask_user_question 就问;否则 task_block(reason, kind="needs_input")。',
    '缺工具或权限做不了:task_block(reason, kind="capability")。',
    '不要在没有调用 task_complete 或 task_block 的情况下结束。')
  return lines.join('\n')
}

/** The single nudge a run gets when it stops without a terminal tool (hermes' stop-guard). */
export const NUDGE = '你停下来了,但没有交卷。请现在调用 task_complete(summary, artifacts) 交卷,或 task_block(reason, kind) 说明为什么做不下去。'

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
