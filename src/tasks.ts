/**
 * Store, validation, and the message a card receives. The model itself
 * lives in ./fold.ts (pure, shared with the browser).
 *
 * @module dsh-task-console/tasks
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fold, migrate, type Batch, type Card, type Event, type Participant, type State, type TaskSpec, type TaskTurn, type Trigger } from './fold.ts'
import { HermesKernel, type ClaimResult } from './hermes-kernel.ts'
import type { GraphEventRow, GraphLinkRow, GraphRunRow, GraphSnapshot, GraphTaskRow } from './graph-data.ts'

export { actorOf, batchStatus, cardRun, describe, fold, foldTurns, migrate, readyCards, BLOCK_RECURRENCE_LIMIT } from './fold.ts'
export type { Artifact, Batch, BlockKind, Card, CardStatus, Event, Participant, Run, RunOutcome, RunStatus, State, StepRow, TaskOrigin, TaskSpec, TaskTarget, TaskTurn, ToolRow, Trigger, TurnLedger, TurnRow } from './fold.ts'
export { cronHuman, cronMatches, nextFire, parseCron, type Cron } from './cron.ts'
import { parseCron, validTimeZone } from './cron.ts'

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
    this.backfillArtifactProjection()
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

      const batchStmt = db.prepare(`INSERT OR REPLACE INTO dsh_batches(id, spec_id, fired_by, fired_at, settled_at, outcome, turn_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      const cardStmt = db.prepare(`INSERT OR REPLACE INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`)
      const taskStmt = db.prepare(`INSERT OR IGNORE INTO tasks(
        id, title, body, assignee, status, priority, created_by, created_at, started_at,
        completed_at, workspace_kind, workspace_path, tenant, consecutive_failures,
        max_runtime_seconds, max_retries, block_kind, block_recurrences
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`)
      for (const batch of st.batches.values()) {
        const spec = st.tasks.get(batch.taskId)
        if (!spec) continue
        batchStmt.run(batch.id, spec.id, batch.by, toEpoch(batch.firedAt), batch.settled ? toEpoch(batch.settled.at) : null, batch.settled?.outcome ?? null, batch.turn ? JSON.stringify(batch.turn) : null)
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

  /** Older plugin builds stored artifacts only in dsh_events/task_attachments. Add replay evidence once. */
  private backfillArtifactProjection(): void {
    const marker = this.kernel.db.prepare(`SELECT value FROM dsh_meta WHERE key = 'dsh_artifact_projection_v1'`).get()
    if (marker) return
    this.kernel.write(() => {
      const db = this.kernel.db
      const insert = db.prepare(`INSERT INTO task_events(task_id, run_id, kind, payload, created_at, graph_id)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)`)
      for (const event of this.events) {
        if (event.t === 'artifact/registered') {
          const a = event.artifact
          insert.run(a.cardId, this.coreRunId(a.runId) ?? null, 'artifact_registered', JSON.stringify({ artifact_id: a.id, name: a.name, sha256: a.sha256, size: a.size }), toEpoch(event.at), a.batchId, a.cardId)
        } else if (event.t === 'artifact/finalized') {
          insert.run(event.cardId, this.coreRunId(event.runId) ?? null, 'artifact_finalized', JSON.stringify({ artifact_id: event.artifactId, artifact_card_id: event.artifactCardId, sha256: event.sha256 }), toEpoch(event.at), event.batchId, event.cardId)
        } else if (event.t === 'artifact/published') {
          const a = this.state.artifacts.get(event.artifactId)
          if (a) insert.run(a.cardId, this.coreRunId(a.runId) ?? null, 'artifact_published', JSON.stringify({ artifact_id: a.id, public_url: event.publicUrl }), toEpoch(event.at), a.batchId, a.cardId)
        }
      }
      db.prepare(`INSERT INTO dsh_meta(key, value) VALUES ('dsh_artifact_projection_v1', ?)`).run(new Date().toISOString())
    })
  }

  private applyExtension(e: Event): void {
    const db = this.kernel.db
    switch (e.t) {
      case 'task/created':
        db.prepare(`INSERT OR REPLACE INTO dsh_task_specs(id, spec_json, enabled, created_at) VALUES (?, ?, ?, ?)`).run(e.task.id, JSON.stringify(e.task), e.task.enabled ? 1 : 0, toEpoch(e.at)); break
      case 'task/enabled':
        if (e.enabled && this.tasks.get(e.taskId)?.archivedAt) throw new Error('任务已归档，请先恢复')
        db.prepare('UPDATE dsh_task_specs SET enabled = ? WHERE id = ?').run(e.enabled ? 1 : 0, e.taskId); break
      case 'task/archived': {
        const task = this.tasks.get(e.taskId)
        if (!task) throw new Error('没有这个任务')
        const spec = { ...task, enabled: false, archivedAt: e.archived ? e.at : undefined }
        db.prepare('UPDATE dsh_task_specs SET spec_json = ?, enabled = 0 WHERE id = ?').run(JSON.stringify(spec), e.taskId)
        break
      }
      case 'task/deleted': {
        // Optional feature ledgers belong to this exact Task; never touch native sessions.
        const exists = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
        for (const table of ['dsh_patrol_inventory','dsh_patrol_observations','dsh_patrol_round_items']) if (exists(table)) db.prepare(`DELETE FROM ${table} WHERE batch_id IN (SELECT id FROM dsh_batches WHERE spec_id=?)`).run(e.taskId)
        if (exists('dsh_browser_operations')) db.prepare('DELETE FROM dsh_browser_operations WHERE issue_id IN (SELECT id FROM dsh_browser_issues WHERE spec_id=?)').run(e.taskId)
        if (exists('dsh_browser_issues')) db.prepare('DELETE FROM dsh_browser_issues WHERE spec_id=?').run(e.taskId)
        for (const table of ['dsh_schedule_state','dsh_schedule_fires','dsh_schedule_bindings','dsh_task_notifications']) if (exists(table)) db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(e.taskId)
        const cards = db.prepare('SELECT card_id FROM dsh_card_bindings WHERE spec_id = ?').all(e.taskId) as { card_id: string }[]
        for (const { card_id } of cards) {
          db.prepare('DELETE FROM dsh_task_wakeups WHERE card_id=?').run(card_id)
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
      case 'batch/archived':
        db.prepare('UPDATE dsh_batches SET archived_at = ? WHERE id = ? AND spec_id = ?').run(e.archived ? toEpoch(e.at) : null, e.batchId, e.taskId); break
      case 'run/session_created':
        db.prepare('UPDATE dsh_run_bindings SET session_id = ? WHERE external_run_id = ?').run(e.sessionId, e.runId); break
      case 'run/prompt_dispatched':
        db.prepare('UPDATE dsh_run_bindings SET message_id = ? WHERE external_run_id = ?').run(e.messageId, e.runId); break
      case 'run/nudged':
        db.prepare('UPDATE dsh_run_bindings SET nudges = nudges + 1 WHERE external_run_id = ?').run(e.runId); break
      case 'artifact/registered': {
        db.prepare(`INSERT INTO task_attachments(task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.artifact.cardId, e.artifact.name, e.artifact.storagePath, e.artifact.mime, e.artifact.size, e.artifact.sessionId, toEpoch(e.at))
        db.prepare(`INSERT INTO task_events(task_id, run_id, kind, payload, created_at, graph_id) VALUES (?, ?, 'artifact_registered', ?, ?, ?)`)
          .run(e.artifact.cardId, this.coreRunId(e.artifact.runId) ?? null, JSON.stringify({ artifact_id: e.artifact.id, name: e.artifact.name, sha256: e.artifact.sha256, size: e.artifact.size }), toEpoch(e.at), e.artifact.batchId)
        break
      }
      case 'artifact/finalized':
        db.prepare(`INSERT INTO task_events(task_id, run_id, kind, payload, created_at, graph_id) VALUES (?, ?, 'artifact_finalized', ?, ?, ?)`)
          .run(e.cardId, this.coreRunId(e.runId) ?? null, JSON.stringify({ artifact_id: e.artifactId, artifact_card_id: e.artifactCardId, sha256: e.sha256 }), toEpoch(e.at), e.batchId); break
      case 'artifact/published': {
        const a = this.state.artifacts.get(e.artifactId)
        if (a) db.prepare(`INSERT INTO task_events(task_id, run_id, kind, payload, created_at, graph_id) VALUES (?, ?, 'artifact_published', ?, ?, ?)`)
          .run(a.cardId, this.coreRunId(a.runId) ?? null, JSON.stringify({ artifact_id: a.id, public_url: e.publicUrl }), toEpoch(e.at), a.batchId)
        break
      }
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

  /** CAS the paused definition, review and schedule binding together; never rewrite a Batch. */
  reviseReviewedTask(previous: TaskSpec, task: TaskSpec, planId: string, commitReview: () => void): Promise<void> {
    const next = this.queue.then(() => {
      const current = this.tasks.get(previous.id)
      if (!current || JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('待更新工作流已变化，需重新审查')
      if (current.enabled || current.archivedAt || current.trigger.kind !== 'cron' || task.trigger.kind !== 'cron' || task.enabled || task.id !== current.id)
        throw new Error('只能审查更新已暂停、未归档的定时 Task')
      const db = this.kernel.db
      const event: Event = { t: 'task/revised', at: new Date().toISOString(), taskId: task.id, task, previous, planId }
      this.kernel.write(() => {
        const row = db.prepare('SELECT spec_json,enabled FROM dsh_task_specs WHERE id=?').get(task.id) as { spec_json: string; enabled: number } | undefined
        if (!row || JSON.stringify({ ...JSON.parse(row.spec_json), enabled: Boolean(row.enabled) }) !== JSON.stringify(previous))
          throw new Error('数据库中的工作流已变化，需重新审查')
        if (db.prepare('SELECT 1 FROM dsh_batches WHERE spec_id=? AND settled_at IS NULL AND archived_at IS NULL LIMIT 1').get(task.id))
          throw new Error('仍有未结束的执行，不能更新任务定义')
        if (db.prepare("SELECT 1 FROM dsh_batches WHERE spec_id=? AND json_extract(turn_json,'$.workflow.definition') IS NULL LIMIT 1").get(task.id))
          throw new Error('旧执行缺少冻结定义；不能用新设计替换历史展示')
        if (db.prepare('UPDATE dsh_task_specs SET spec_json=?,enabled=0 WHERE id=? AND enabled=0').run(JSON.stringify(task), task.id).changes !== 1)
          throw new Error('任务暂停状态已变化，需重新审查')
        commitReview()
        db.prepare('INSERT INTO dsh_events(event_type,task_id,occurred_at,payload_json) VALUES (?,?,?,?)').run(event.t,task.id,event.at,JSON.stringify(event))
      })
      this.events.push(event); this.state = fold(this.events)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Archive exact definitions atomically, retaining their execution and evidence rows. */
  setTasksArchived(ids: string[], archived: boolean): Promise<number> {
    const next = this.queue.then(() => {
      const events: Event[] = []
      this.kernel.write(() => {
        for (const id of ids) {
          if (!this.tasks.has(id)) throw new Error(`没有这个任务：${id}`)
          if (this.kernel.db.prepare(`SELECT 1 FROM tasks t JOIN dsh_card_bindings b ON b.card_id=t.id
            WHERE b.spec_id=? AND t.current_run_id IS NOT NULL LIMIT 1`).get(id)) throw new Error('任务仍在执行，不能归档或恢复')
        }
        for (const id of new Set(ids)) {
          if (Boolean(this.tasks.get(id)!.archivedAt) === archived) continue
          const event: Event = { t: 'task/archived', at: new Date().toISOString(), taskId: id, archived }
          this.applyExtension(event)
          this.kernel.db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)')
            .run(event.t, id, event.at, JSON.stringify(event))
          events.push(event)
        }
      })
      this.events.push(...events); this.state = fold(this.events)
      return events.length
    })
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** Archive a parked/ended execution without settling it or rewriting its evidence. */
  setBatchArchived(taskId: string, batchId: string, archived: boolean): Promise<boolean> {
    return this.transition(() => {
      const batch = this.s.batches.get(batchId)
      if (!batch || batch.taskId !== taskId) throw new Error('执行记录不存在或不属于这个任务')
      const rows = this.kernel.db.prepare('SELECT status,current_run_id FROM tasks WHERE tenant=?').all(batchId) as { status: string; current_run_id: number | null }[]
      if (rows.some(r => r.current_run_id !== null || r.status === 'running')) throw new Error('执行记录仍在执行，不能归档或恢复')
      if (rows.some(r => !['done','blocked','failed','cancelled','archived'].includes(r.status))) throw new Error('仍有待执行或定时等待的角色，不能归档或恢复')
      return Boolean(batch.archivedAt) !== archived
    }, changed => changed ? { t:'batch/archived', at:new Date().toISOString(), taskId, batchId, archived } : undefined)
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
  async createBatch(task: TaskSpec, event: Extract<Event, { t: 'batch/fired' }>, scheduleClaim?: { id: string; token: string }): Promise<void> {
    if (this.tasks.get(task.id)?.archivedAt) throw new Error('任务已归档，请先恢复')
    const execution = taskForTurn(task, event.batch.turn)
    this.kernel.write(() => {
      const db = this.kernel.db
      if (task.trigger.kind === 'cron' && db.prepare('SELECT id FROM dsh_batches WHERE spec_id=? AND settled_at IS NULL AND archived_at IS NULL LIMIT 1').get(task.id)) throw new Error('上一轮仍未结束，不重复启动')
      if (scheduleClaim && db.prepare("UPDATE dsh_schedule_fires SET status='dispatched',lease_token=NULL,lease_until=NULL WHERE id=? AND status='pending' AND lease_token=?").run(scheduleClaim.id, scheduleClaim.token).changes !== 1) throw new Error('定时派发租约已失效')
      db.prepare(`INSERT INTO dsh_batches(id, spec_id, fired_by, fired_at, turn_json) VALUES (?, ?, ?, ?, ?)`).run(event.batch.id, task.id, event.batch.by, toEpoch(event.at), event.batch.turn ? JSON.stringify(event.batch.turn) : null)
      const insertedCards: string[] = []
      for (const [index, card] of event.batch.cards.entries()) {
        db.prepare(`INSERT INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`).run(card.id, task.id, event.batch.id, index, card.brief ?? null)
        const status = card.deps.length ? 'todo' : 'ready'
        db.prepare(`INSERT INTO tasks(id, title, body, assignee, status, priority, created_by, created_at,
          workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries, node_kind, round, role)
          VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`).run(
          card.id, `${execution.title} · ${card.agentId}`, [execution.brief, card.brief].filter(Boolean).join('\n\n'), card.agentId,
          status, index * -1, toEpoch(event.at), execution.cwd, event.batch.id, execution.timeoutSec, execution.maxTries,
          card.kind ?? 'agent', card.round ?? null, card.role ?? null,
        )
        const at = toEpoch(event.at)
        db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'created', ?, ?, ?)`).run(card.id, JSON.stringify({ title: `${execution.title} · ${card.role ?? card.agentId}`, body: [execution.brief, card.brief].filter(Boolean).join('\n\n'), assignee: card.agentId, status, parents: card.deps, tenant: event.batch.id, node_kind: card.kind ?? 'agent', round: card.round ?? null, role: card.role ?? null, created_at: at }), at, event.batch.id)
        for (const parent of card.deps) {
          db.prepare(`INSERT INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, 'dependency', ?)`).run(parent, card.id, at)
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'linked', ?, ?, ?)`).run(card.id, JSON.stringify({ parent_id: parent, kind: 'dependency' }), at, event.batch.id)
        }
        insertedCards.push(card.id)
      }
      if (insertedCards.length !== event.batch.cards.length) throw new Error('batch card insert incomplete')
      db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)').run(event.t, event.taskId, event.at, JSON.stringify(event))
    })
    this.events.push(event); this.state = fold(this.events)
  }

  /** A durable side branch: notification failure never becomes a repair dependency. */
  async createNotification(task: TaskSpec, batch: Batch, planner: Card, stage: string, report: unknown): Promise<string> {
    const agentId = task.design?.notifications?.agentId
    if (!agentId || planner.role !== 'planner' || !planner.round) throw new Error('没有已审查的通知员配置')
    const id = `${batch.id}#n${planner.round}-${stage}`
    await this.transition(() => {
      const db = this.kernel.db
      if (this.kernel.getTask(planner.id)?.status !== 'running' || this.state.batches.get(batch.id)?.settled) throw new Error('规划者已不在运行中')
      if (this.kernel.getTask(id)) return undefined
      const at = new Date().toISOString(), epoch = toEpoch(at)
      const position = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM dsh_card_bindings WHERE batch_id=?').get(batch.id) as {n:number}).n
      const brief = `只负责 ${stage} 阶段企微通知；先 task_patrol_status 读取冻结交接，再 task_notify(stage="${stage}")，按真实回执 task_complete。`
      const card = { id, agentId, kind: 'agent' as const, role: 'notifier' as const, round: planner.round, deps: [planner.id], brief }
      db.prepare('INSERT INTO dsh_card_bindings(card_id,spec_id,batch_id,position,brief) VALUES (?,?,?,?,?)').run(id,task.id,batch.id,position,brief)
      db.prepare(`INSERT INTO tasks(id,title,body,assignee,status,priority,created_by,created_at,workspace_kind,workspace_path,tenant,max_runtime_seconds,max_retries,node_kind,round,role)
        VALUES (?,?,?,?,'todo',?,'dsh-task-console',?,'dir',?,?,300,1,'agent',?,'notifier')`).run(id,`企微通知 · ${stage}`,brief,agentId,-position,epoch,task.cwd,batch.id,planner.round)
      db.prepare("INSERT INTO task_links(parent_id,child_id,kind,created_at) VALUES (?,?,'dependency',?)").run(planner.id,id,epoch)
      this.kernel.recordEvent(id,'created',{title:`企微通知 · ${stage}`,body:brief,assignee:agentId,status:'todo',parents:[planner.id],tenant:batch.id,node_kind:'agent',round:planner.round,role:'notifier',created_at:epoch})
      this.kernel.recordEvent(id,'linked',{parent_id:planner.id,kind:'dependency'})
      this.kernel.recordEvent(id,'notification_requested',{source_card_id:planner.id,stage,report})
      return { t: 'card/created' as const, at, taskId:task.id, batchId:batch.id, card }
    }, event => event)
    return id
  }

  /** Materialize one real rework round. Nothing is inferred by the browser. */
  async expandRound(task: TaskSpec, batch: Batch, planner: Card, summary: string, commit?: () => void): Promise<void> {
    if (task.graphMode !== 'dynamic-rounds' || planner.role !== 'planner' || !planner.round) throw new Error('只有动态回合的规划者能创建下一轮')
    const execution = taskForBatch(task, batch)
    const round = planner.round
    if (execution.design && round > execution.design.failurePolicy.maxAttempts) throw new Error('已达审查计划的累计回合上限，不能继续创建返工')
    const seeds: Extract<Event, { t: 'card/created' }>[] = []
    const next = this.queue.then(async () => {
      this.kernel.compose(() => {
        const db = this.kernel.db
        const active = this.kernel.getTask(planner.id)
        if (!active || active.status !== 'running') throw new Error('规划者已不在运行中')
        if ((db.prepare("SELECT COUNT(*) AS n FROM task_links l JOIN tasks t ON t.id=l.child_id WHERE parent_id = ? AND COALESCE(t.role,'') != 'notifier'").get(planner.id) as { n: number }).n) throw new Error('这个规划者已经创建过下一轮')
        commit?.()
        const atIso = new Date().toISOString(); const at = toEpoch(atIso)
        const rows = [
          ...(execution.design?.proxy ? [{ id: `${batch.id}#x${round}`, agentId: execution.design.proxy.agentId, kind:'agent' as const, role:'proxy' as const, round, deps:[planner.id], brief:'根据本轮冻结的 proxyItems 逐台检查或幂等修复批准线路；必须调用 proxy_status 取得全部操作终态，再 task_complete 交接通过/未通过清单。确定失败不重复修复，继续其他节点；下游宿主逐机器阻止未通过目标登录写入。不确定只查原操作，不换编号重复；仍无法确认 task_block。' }] : []),
          { id: `${batch.id}#g${round}`, agentId: '__gate__', kind: 'gate' as const, role: 'gate' as const, round, deps: [execution.design?.proxy ? `${batch.id}#x${round}` : planner.id], brief: `Round ${round} ${execution.design?.proxy ? '代理阶段交接；逐机器校验后' : ''}放行闸门` },
          { id: `${batch.id}#e${round}`, agentId: execution.participants[1].agentId, kind: 'agent' as const, role: 'executor' as const, round, deps: [`${batch.id}#g${round}`], brief: execution.participants[1].brief ?? `执行规划者给出的第 ${round} 轮方案。` },
          { id: `${batch.id}#r${round}`, agentId: execution.participants[2].agentId, kind: 'agent' as const, role: 'reviewer' as const, round, deps: [`${batch.id}#e${round}`], brief: execution.participants[2].brief ?? `评估第 ${round} 轮结果，明确给出通过或返工依据。` },
          { id: `${batch.id}#p${round + 1}`, agentId: execution.participants[0].agentId, kind: 'agent' as const, role: 'planner' as const, round: round + 1, deps: [`${batch.id}#r${round}`], brief: execution.participants[0].brief ?? `读取第 ${round} 轮评估，决定结束或创建第 ${round + 1} 轮。` },
        ]
        const position = Number((db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM dsh_card_bindings WHERE batch_id = ?').get(batch.id) as { n: number }).n) + 1
        for (const [offset, row] of rows.entries()) {
          const status = 'todo'
          const assignee = row.kind === 'gate' ? null : row.agentId
          const title = `${execution.title} · ${row.role} ${row.round}`
          db.prepare(`INSERT INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`).run(row.id, task.id, batch.id, position + offset, row.brief)
          db.prepare(`INSERT INTO tasks(id, title, body, assignee, status, priority, created_by, created_at, workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries, node_kind, round, role)
            VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`).run(row.id, title, [execution.brief, row.brief, summary].filter(Boolean).join('\n\n'), assignee, status, -(position + offset), at, execution.cwd, batch.id, execution.timeoutSec, execution.maxTries, row.kind, row.round, row.role)
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'created', ?, ?, ?)`).run(row.id, JSON.stringify({ title, body: [execution.brief, row.brief].join('\n\n'), assignee, status, parents: row.deps, tenant: batch.id, node_kind: row.kind, round: row.round, role: row.role, created_at: at }), at, batch.id)
          seeds.push({ t: 'card/created', at: atIso, taskId: task.id, batchId: batch.id, card: row })
        }
        for (const row of rows) for (const parent of row.deps) {
          db.prepare(`INSERT INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, 'dependency', ?)`).run(parent, row.id, at)
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'linked', ?, ?, ?)`).run(row.id, JSON.stringify({ parent_id: parent, kind: 'dependency' }), at, batch.id)
        }
        const insertEvent = db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)')
        for (const e of seeds) insertEvent.run(e.t, e.taskId, e.at, JSON.stringify(e))
      })
      this.events.push(...seeds); this.state = fold(this.events)
    })
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  async openReadyGates(): Promise<string[]> {
    const projected: Event[] = []
    const next = this.queue.then(async () => {
      const ids = this.kernel.compose(() => {
        const opened = this.kernel.openReadyGates()
        const insert = this.kernel.db.prepare('INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)')
        for (const cardId of opened) {
          const card = this.state.cards.get(cardId); if (!card) continue
          const e: Event = { t: 'gate/opened', at: new Date().toISOString(), taskId: card.taskId, cardId }
          insert.run(e.t, e.taskId, e.at, JSON.stringify(e)); projected.push(e)
        }
        return opened
      })
      if (projected.length) { this.events.push(...projected); this.state = fold(this.events) }
      return ids
    })
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  graphSnapshot(taskId: string, batchId: string): GraphSnapshot {
    const db = this.kernel.db
    const batch = db.prepare(`SELECT id, fired_at, settled_at, outcome FROM dsh_batches WHERE id = ? AND spec_id = ?`).get(batchId, taskId) as { id: string; fired_at: number; settled_at: number | null; outcome: string | null } | undefined
    if (!batch) throw new Error('没有这个任务运行')
    const tasks = db.prepare(`SELECT id,title,body,assignee,status,created_at,started_at,completed_at,result,node_kind,round,role,current_run_id FROM tasks WHERE tenant = ? ORDER BY created_at,id`).all(batchId) as GraphTaskRow[]
    const links = db.prepare(`SELECT l.parent_id,l.child_id,l.kind,l.created_at FROM task_links l JOIN tasks c ON c.id=l.child_id WHERE c.tenant=? ORDER BY COALESCE(l.created_at,0),l.rowid`).all(batchId) as GraphLinkRow[]
    const rawRuns = db.prepare(`SELECT r.id,b.external_run_id,r.task_id,r.profile,r.status,r.started_at,r.ended_at,r.outcome,r.summary,r.error,b.session_id,b.message_id,r.claim_expires,r.last_heartbeat_at FROM task_runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN dsh_run_bindings b ON b.core_run_id=r.id WHERE t.tenant=? ORDER BY r.started_at,r.id`).all(batchId) as Omit<GraphRunRow, 'phase' | 'evidence'>[]
    const eventRows = db.prepare(`SELECT id,graph_id,task_id,run_id,kind,payload,created_at FROM task_events WHERE graph_id=? ORDER BY id`).all(batchId) as { id: number; graph_id: string; task_id: string; run_id: number | null; kind: string; payload: string | null; created_at: number }[]
    const events: GraphEventRow[] = eventRows.map(row => ({ ...row, payload: (() => { try { return row.payload ? JSON.parse(row.payload) : {} } catch { return {} } })() }))
    const phaseByKind: Partial<Record<string, GraphRunRow['phase']>> = { claimed: 'claimed', run_bound: 'bound', session_created: 'session_created', prompt_dispatched: 'prompt_dispatched', heartbeat: 'heartbeat', completed: 'completed' }
    const runs = rawRuns.map(run => {
      const evidence = events.filter(event => event.run_id === run.id).map(event => phaseByKind[event.kind]).filter(Boolean) as GraphRunRow['evidence']
      return { ...run, phase: evidence.at(-1) ?? 'claimed', evidence: [...new Set(evidence)] }
    })
    return { graphId: batchId, taskId, batch: { id: batch.id, firedAt: batch.fired_at, settledAt: batch.settled_at, outcome: batch.outcome }, live: { tasks, links, runs }, events }
  }

  async claimCard(cardId: string, externalRunId: string, sessionId: string, attempt: number, fromReview = false): Promise<ClaimResult | undefined> {
    return this.transition(
      () => this.tasks.get(this.state.cards.get(cardId)?.taskId ?? '')?.archivedAt || this.s.batches.get(this.s.cards.get(cardId)?.batchId ?? '')?.archivedAt ? undefined : this.kernel.claimTask(cardId, { fromReview }),
      claim => {
        if (!claim) return undefined
        this.kernel.db.prepare(`INSERT INTO dsh_run_bindings(external_run_id, core_run_id, session_id) VALUES (?, ?, ?)`).run(externalRunId, claim.run.id, sessionId)
        this.kernel.recordEvent(cardId, 'run_bound', { external_run_id: externalRunId, session_id: sessionId }, claim.run.id)
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

/** Resolve the immutable Task template plus one signal-specific execution turn. */
export function taskForTurn(task: TaskSpec, turn?: TaskTurn): TaskSpec {
  if (!turn) return task
  return {
    ...task,
    ...(turn.workflow ? turn.workflow.definition : {}),
    brief: turn.objective,
    participants: turn.participants,
    ...(turn.cwd ? { cwd: turn.cwd } : {}),
    ...(turn.origin ? { origin: turn.origin } : {}),
    ...(turn.targets ? { targets: turn.targets } : {}),
  }
}

export function taskForBatch(task: TaskSpec, batch: Batch): TaskSpec {
  return taskForTurn(task, batch.turn)
}

/** The one user message a card's session gets: brief, its part, the upstream handoffs, and the contract. */
export function cardMessage(task: TaskSpec, card: Card, batchId: string, upstream: { agentName: string; summary: string }[]): string {
  if (card.role === 'notifier') return [
    `# 企微通知协作 · Task ${task.id} · 执行 ${batchId}`, card.brief,
    '你是独立通知员，不执行浏览器检查、登录或修复，也不恢复企业微信服务。',
    '调用 task_patrol_status 读取本卡冻结的 stage/report；这是上游在当时提交的事实，不把之后发生的结果冒充该阶段事实。',
    '调用 task_notify(stage) 经你的企微 MCP 发送。收件群和事实正文由已审查契约限定，禁止直接 send_message 绕过发件箱。',
    'sent 表示服务确认发送，不代表已读；failed 仅在明确未发送时可重试最多3次，unknown 禁止重发。',
    '得到终态回执后调用 task_complete 如实交接；通知失败不能要求重复浏览器操作。没有文件产物，不要创建文件。',
  ].join('\n\n')
  const lines = [`# 任务:${task.title} · ${batchId} · 第 ${card.index + 1}/${task.participants.length} 张卡`, '',
    task.origin?.reviewPlanId ? '[ORIGINAL REQUEST — CREATION STAGE ALREADY REVIEWED]' : '[TASK]', task.brief.trim()]
  if (task.origin) lines.push('', '[ORIGIN]', [
    `task=${task.id}`,
    `source=${task.origin.source}`,
    `signal=${task.origin.signalId}`,
    ...(task.origin.incidentId ? [`incident=${task.origin.incidentId}`] : []),
    `decision=${task.origin.decision}`,
  ].join('\n'))
  if (task.targets?.length) lines.push('', '[TARGETS — RESOURCE METADATA ONLY]', task.targets.map(target => `${target.kind}:${target.id}${target.label ? ` (${target.label})` : ''}`).join('\n'))
  if (task.origin?.reviewPlanId) lines.push('', '[HOST REVIEW RELEASE]',
    `本 Run 已由独立审查放行，审批计划 ${task.origin.reviewPlanId}。原始消息中“先生成计划、等待审查、不执行”描述的创建阶段已完成；现在执行下方已审查的业务范围。其他禁止事项、宿主权限及验收要求仍有效，不因批准而扩大。`)
  if (card.brief?.trim()) lines.push('', '[YOUR PART]', card.brief.trim())
  if (task.workflowRecipe?.id === 'fleet-base-v2') lines.push('', '[FRESH EXECUTION / RECOVERY]',
    '本次使用当前工具重新检查目标。其他执行或历史会话的 blocked/人工验证原因不代表当前仍故障；健康组件及有效登录只复用，不为重跑而重装或再次复制。',
    'Google 交互验证若当前仍真实存在，按回执 task_block，不能绕过。未安排 task_wait 或真实恢复触发时，不得承诺“完成验证后自动恢复”。本次新会话必须取得自己的完整验收回执。')
  if (task.workflowRecipe?.id === 'fleet-base-v2' && card.agentId === 'browser-manager') lines.push('', '[BASE NODE BROWSER API]',
    '独立浏览器 API 的准备使用默认 browser_prepare（省略 component）。component=login-observation 仅修复已安装旧图片服务的检测循环；imageInstalled=false 的基础节点不能选它。legacy-login-observer-required 表示选错专项组件，不代表缺少图片服务或必须安装旧观察器。未知版本或真实权限错误仍应停止；不能通过省略 component 绕过一个原本明确授权的专项范围。')
  if (task.design) lines.push('', '[REVIEWED DECISION CONTRACT]', JSON.stringify(task.design, null, 2),
    '以上为已审查的业务决策契约：依据真实工具证据选分支，不能将 unknown 当失败或未登录；它不是自动执行的脚本。逐目标记录匹配分支、证据、动作和结果；隔离的失败不得遗漏或伪装成整体成功。重试上限不授予重复副作用或扩大权限。最终报告覆盖全部目标和验收条件；有未达标项必须明确列出。')
  for (const u of upstream) lines.push('', `[UPSTREAM HANDOFF from ${u.agentName}]`, u.summary.trim() || '(上游没有留下交接单)')
  if (card.reviewNote?.trim()) lines.push('', '[REVIEW CHANGES]', card.reviewNote.trim())
  if (task.design?.evidenceContract === 'browser-patrol-v2') lines.push('', '[PATROL ROLE HANDOFF]',
    '每个浏览器操作都要用其真实 id 显式调用 browser_status({ip,operationId:id}) 取得宿主认可的终态回执，包括幂等发起时已返回 complete 的操作；只看启动响应或自己汇总不进入独立证据。重复查询同一回执不是新采样，分时采样必须发起新的只读验证。',
    'task_patrol_status.ready 表示整个 Task 的独立验收，不是当前角色的交接条件。执行者自己的检查不计入评估者独立采样。',
    '本轮有效独立检查的 accepted 与实时 freshness 分开：accepted=true 且 freshness=expired 表示检查时通过、实时证据待刷新，不是登录失败，不得仅因此返工/复制/重建。后续未知、掉线、账号变化或新的修复操作会使旧检查不能继续充当验收；以宿主当前逐项目结论为准。未覆盖节点单独报告，不将其算作其他浏览器未登录。',
    card.role === 'proxy'
      ? '你只处理 task_patrol_status.proxy.plan 冻结的机器与动作；不操作浏览器。健康节点只验收复用，repair 受线路及累计预算约束；逐一拿到 proxy_status 的终态才 task_complete。确定失败如实交接，让其他已通过目标继续；宿主仍会禁止未通过目标登录写入。运行中或不确定不能冒充失败或成功交卷。'
      : card.role === 'executor'
      ? '你只完成本轮冻结 items 的动作，取得后台操作终态后立即 task_complete({summary:"真实结果及下游待验项"}) 交给评估者。不得 task_wait 等待下游采样，也不得为填满独立采样重复 provision。'
      : card.role === 'reviewer'
        ? '只有你负责分时独立复验并可 task_wait。新鲜探针才算新采样；缓存/重复回执不算。优先检查本轮修复目标，等待 observation.nextCheckAt，修复后仍须完整观察窗口；健康目标取得本轮独立检查后不因其回执在交接中到期而重做检查或20分钟观察。任一目标明确需要返工且 task_patrol_status.canHandoffForRework=true 时，立即 task_complete 交接失败结论；同一 Batch 的有效独立样本跨轮保留，只有实际修复/后续不良证据会使对应目标重新计时，不降低最终20分钟验收。最后一轮或没有可继续修复项时，pendingStability 中的已登录目标必须在当前评估卡完成观察，使用 task_wait，不得提前交接或以预算耗尽免除采样。明确仍未登录/挑战的目标如实记录，不空等凑稳定样本。得到通过或返工结论后 task_complete 交给规划者。'
        : '先通过 task_notify 留下通知回执；根据真实证据 task_plan_round 或 task_finalize。不要 task_wait 等待尚未执行的下游；通知失败只处理通知，不能重跑已完成浏览器动作。')
  if (task.design?.proxy) lines.push('', '[PROXY BEFORE LOGIN]',
    `批准线路 ${task.design.proxy.lineId}；代理处理由独立角色 ${task.design.proxy.agentId} 执行。每轮 task_plan_round 同时提供 proxyItems:[{ip,action:verify|repair,reason}]，覆盖 items 中的机器；只读与修复分开，不固化本轮 IP 到工作流模板。`,
    'proxyItems 的 IP 集合必须恰好等于本轮浏览器 items 的去重 IP：每台一次，不多不少。若只修复一个目标，就只冻结它所在机器的代理动作，不把其余健康 inventory 节点加进去；既有独立验收证据保留。参数/范围拒绝不是修复次数耗尽，纠正清单后重提同一轮，不因此 task_block。',
    'proxy_verify/repair 使用16至96字符 requestId，同会话同请求重复时保持原编号；proxy_status 使用返回 operationId。结果unknown只查原操作，不换编号重复修复。',
    '使用代码批量调用 MCP 时先解析返回包装：value = reply.structuredContent ?? (reply.content ? JSON.parse(reply.content.find(x => x.type === "text").text) : typeof reply === "string" ? JSON.parse(reply) : reply)。检查 isError/ok 和非空 value.operationId，再显式传给 proxy_status({operationId:value.operationId,after:0})。缺字段或明确参数错误立即停止该循环并纠正，不把工具错误当成节点故障，不重复发起已存在操作。',
    '网络通过后仍需重新判断登录；unknown 先验证，不作为复制依据。登录复制/续接必须有15分钟内真实代理成功回执，过期用只读 proxy_verify 刷新，不因此 repair。',
    '独立评估者逐台执行只读 proxy_verify + proxy_status，再做原登录稳定性验收；规划者以 task_patrol_status.proxy 和浏览器证据共同收口。独立历史验收不因后续等待过期；新的异常或修复使其失效，新写入仍需新鲜检查。原20分钟及采样数、通知范围不变。')
  if (task.design?.browserPatrol?.actions.includes('recover')) lines.push('', '[SCOPED BROWSER RECOVERY]',
    '仅本轮真实 cdp-unavailable 且新鲜的验证回执允许规划 recover；普通 unknown/页面加载/账号挑战不允许重启。执行者调用 browser_recover(ip,instance,sessionId,requestId)，等待终态后 login_verify。工具只重启明确授权的故障实例，保留资料和其他进程；它不能删除重建或复制。恢复后未登录需要下一轮冻结 provision，不把 recover 当作登录授权。独立评估者对恢复目标执行原稳定窗口，不能只有一次成功。')
  if (task.design?.browserPatrol?.excludedNodeIds?.length) lines.push('', '[REVIEWED SCOPE EXCLUSIONS]',
    `排除节点 ${task.design.browserPatrol.excludedNodeIds.join(', ')}：不安排动作，不阻止本轮验收，但保留排除及真实观测记录。其余目标必须正常处理，不能自行增加排除。`)
  if (task.graphMode === 'dynamic-rounds' && card.role === 'planner') {
    if (task.design?.evidenceContract === 'browser-patrol-v2') lines.push('', '[REFRESH BEFORE FREEZING]',
      '已有明确返工项但其回执过期时，先用你自己的 browser_login_verify + browser_status 取得该目标的新鲜终态，再决定本轮 provision/recover/verify。只读刷新不需要新建 Gate 或消耗完整返工轮次。不得从过期证据授权写入，也不要仅为刷新少数旧回执把全量只读检查冻结成另一整轮；健康独立证据保留，实际副作用预算和最终验收要求不变。')
    lines.push('', '[DYNAMIC DAG CONTRACT]',
      card.round === 1
        ? '你是初始规划者。完成方案后必须调用 task_plan_round(summary)；系统随后才会创建真实 Gate、执行者、评估者和下一位规划者记录。'
        : '你是回合决策者。结合上游评估：需要返工就调用 task_plan_round(summary) 创建新一轮真实记录；已经通过就调用 task_finalize(summary, artifact)。有文件交付时 artifact 必须指向最终文件，没有文件时省略。',
      '不要调用 task_complete；本会话只提供 task_plan_round、task_finalize 和 task_block。')
    return lines.join('\n')
  }
  if (task.graphMode === 'dynamic-rounds' && card.role === 'executor') lines.push('', '[ROLE]', `你是第 ${card.round} 轮执行者。严格执行本 Task body 中的规划，完成后调用 task_complete。`)
  if (task.graphMode === 'dynamic-rounds' && card.role === 'reviewer') lines.push('', '[ROLE]', `你是第 ${card.round} 轮评估者。给出明确通过/返工结论和依据，完成后调用 task_complete；下一位规划者负责据此结束或创建新一轮。`)
  lines.push('', '[CONTRACT]',
    '做完后必须调用 task_complete(summary, artifacts, metadata) 交卷;summary 写「产物 / 干了什么 / 下游注意」,它会原样交给下一张卡。',
    '生成了文件时,必须把文件路径放进 artifacts 数组;系统会保存不可变副本并让浏览器直接预览或下载。',
    ...(task.graphMode === 'dynamic-rounds' ? ['本模式不提供同卡评审工具。评估通过或返工都调用 task_complete 给出结论；规划者决定下一轮 Gate、执行者和评估者。'] : [
      '做完但需要验收时调用 task_request_review(summary, artifacts, metadata, reviewer?);验收通过前不会启动下游。指定 reviewer 会由评估 Agent 领取，不指定则进入人工闸门。',
      '作为同卡评估者发现问题时调用 task_request_changes(reason);旧评审 Run 会关闭，原执行者得到新的返工 Run。',
    ]),
    '拿不准且不可逆的事:能用 ask_user_question 就问;否则 task_block(reason, kind="needs_input")。',
    '缺工具或权限做不了:task_block(reason, kind="capability")。',
    '不要在没有调用 task_complete 或 task_block 的情况下结束。')
  if (task.origin?.reviewPlanId) lines.push('', '[CURRENT EXECUTION PHASE — APPLIES TO THIS RUN AND RETRIES]',
    `计划 ${task.origin.reviewPlanId} 已批准。本次是业务执行，不是创建或审查计划。按 YOUR PART 和 REVIEWED DECISION CONTRACT 完成真实工具操作与逐项验收。`,
    '原始输入保留用于审计，其中要求 Creator 等待批准的阶段指令已经履行，不要求执行者再次提交计划。task_request_review 只能提交实际已执行的业务结果，不得以新计划替代执行。',
    '异步工具返回 running/waiting 时继续按 nextAction 等待真实终态；有独立目标未检查时继续检查。有未达标项不能宣布全部验收通过；动态模式 task_complete 是如实交接本角色结果，允许交接待验/返工事项。')
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
  if (s.trigger && !['once', 'cron'].includes(s.trigger.kind)) throw new Error('未知时间表类型')
  if ((s.trigger as Trigger)?.kind === 'cron') {
    const expr = String((s.trigger as { expr?: string }).expr ?? '').trim()
    if (!parseCron(expr)) throw new Error('cron 表达式不合法(要 5 段)')
    const timeZone = (s.trigger as { timeZone?: string }).timeZone
    if (timeZone !== undefined && (typeof timeZone !== 'string' || !validTimeZone(timeZone))) throw new Error('时间表时区不合法')
    trigger = { kind: 'cron', expr, ...(timeZone ? { timeZone } : {}) }
  }
  const timeoutSec = Math.min(Math.max(Number(s.timeoutSec) || 1800, 60), 6 * 3600)
  const onFail = s.onFail === 'retry' ? 'retry' : 'stop'
  const graphMode = s.graphMode === 'dynamic-rounds' ? 'dynamic-rounds' : 'static-chain'
  if (graphMode === 'dynamic-rounds' && participants.length !== 3) throw new Error('动态回合必须依次选择 3 位参与者:规划者、执行者、评估者')
  return {
    id: String(s.id ?? '') || `T-${Date.now().toString(36)}`,
    title, brief, trigger, participants,
    graphMode,
    cwd: String(s.cwd ?? '').trim() || homedir(),
    timeoutSec, onFail,
    maxTries: onFail === 'retry' ? Math.min(Math.max(Number(s.maxTries) || 2, 1), 5) : 1,
    enabled: true,
    createdAt: new Date().toISOString(),
  }
}
