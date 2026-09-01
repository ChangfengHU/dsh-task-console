/**
 * Store, validation, and the message a card receives. The model itself
 * lives in ./fold.ts (pure, shared with the browser).
 *
 * @module dsh-task-console/tasks
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fold, migrate, type Batch, type Card, type Event, type Participant, type State, type TaskSpec, type Trigger } from './fold.ts'
import { HermesKernel, type ClaimResult } from './hermes-kernel.ts'
import type { GraphEventRow, GraphLinkRow, GraphRunRow, GraphSnapshot, GraphTaskRow } from './graph-data.ts'

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
          workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries, node_kind, round, role)
          VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`).run(
          card.id, `${task.title} · ${card.agentId}`, [task.brief, card.brief].filter(Boolean).join('\n\n'), card.agentId,
          status, index * -1, toEpoch(event.at), task.cwd, event.batch.id, task.timeoutSec, task.maxTries,
          card.kind ?? 'agent', card.round ?? null, card.role ?? null,
        )
        const at = toEpoch(event.at)
        db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'created', ?, ?, ?)`).run(card.id, JSON.stringify({ title: `${task.title} · ${card.role ?? card.agentId}`, body: [task.brief, card.brief].filter(Boolean).join('\n\n'), assignee: card.agentId, status, parents: card.deps, tenant: event.batch.id, node_kind: card.kind ?? 'agent', round: card.round ?? null, role: card.role ?? null, created_at: at }), at, event.batch.id)
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

  /** Materialize one real rework round. Nothing is inferred by the browser. */
  async expandRound(task: TaskSpec, batch: Batch, planner: Card, summary: string): Promise<void> {
    if (task.graphMode !== 'dynamic-rounds' || planner.role !== 'planner' || !planner.round) throw new Error('只有动态回合的规划者能创建下一轮')
    const round = planner.round
    const seeds: Extract<Event, { t: 'card/created' }>[] = []
    const next = this.queue.then(async () => {
      this.kernel.compose(() => {
        const db = this.kernel.db
        const active = this.kernel.getTask(planner.id)
        if (!active || active.status !== 'running') throw new Error('规划者已不在运行中')
        if ((db.prepare('SELECT COUNT(*) AS n FROM task_links WHERE parent_id = ?').get(planner.id) as { n: number }).n) throw new Error('这个规划者已经创建过下一轮')
        const atIso = new Date().toISOString(); const at = toEpoch(atIso)
        const rows = [
          { id: `${batch.id}#g${round}`, agentId: '__gate__', kind: 'gate' as const, role: 'gate' as const, round, deps: [planner.id], brief: `Round ${round} 放行闸门` },
          { id: `${batch.id}#e${round}`, agentId: task.participants[1].agentId, kind: 'agent' as const, role: 'executor' as const, round, deps: [`${batch.id}#g${round}`], brief: task.participants[1].brief ?? `执行规划者给出的第 ${round} 轮方案。` },
          { id: `${batch.id}#r${round}`, agentId: task.participants[2].agentId, kind: 'agent' as const, role: 'reviewer' as const, round, deps: [`${batch.id}#e${round}`], brief: task.participants[2].brief ?? `评估第 ${round} 轮结果，明确给出通过或返工依据。` },
          { id: `${batch.id}#p${round + 1}`, agentId: task.participants[0].agentId, kind: 'agent' as const, role: 'planner' as const, round: round + 1, deps: [`${batch.id}#r${round}`], brief: task.participants[0].brief ?? `读取第 ${round} 轮评估，决定结束或创建第 ${round + 1} 轮。` },
        ]
        const position = Number((db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM dsh_card_bindings WHERE batch_id = ?').get(batch.id) as { n: number }).n) + 1
        for (const [offset, row] of rows.entries()) {
          const status = 'todo'
          const assignee = row.kind === 'gate' ? null : row.agentId
          const title = `${task.title} · ${row.role} ${row.round}`
          db.prepare(`INSERT INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`).run(row.id, task.id, batch.id, position + offset, row.brief)
          db.prepare(`INSERT INTO tasks(id, title, body, assignee, status, priority, created_by, created_at, workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries, node_kind, round, role)
            VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`).run(row.id, title, [task.brief, row.brief, summary].filter(Boolean).join('\n\n'), assignee, status, -(position + offset), at, task.cwd, batch.id, task.timeoutSec, task.maxTries, row.kind, row.round, row.role)
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'created', ?, ?, ?)`).run(row.id, JSON.stringify({ title, body: [task.brief, row.brief].join('\n\n'), assignee, status, parents: row.deps, tenant: batch.id, node_kind: row.kind, round: row.round, role: row.role, created_at: at }), at, batch.id)
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
      () => this.kernel.claimTask(cardId, { fromReview }),
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

/** The one user message a card's session gets: brief, its part, the upstream handoffs, and the contract. */
export function cardMessage(task: TaskSpec, card: Card, batchId: string, upstream: { agentName: string; summary: string }[]): string {
  const lines = [`# 任务:${task.title} · ${batchId} · 第 ${card.index + 1}/${task.participants.length} 张卡`, '', '[TASK]', task.brief.trim()]
  if (card.brief?.trim()) lines.push('', '[YOUR PART]', card.brief.trim())
  for (const u of upstream) lines.push('', `[UPSTREAM HANDOFF from ${u.agentName}]`, u.summary.trim() || '(上游没有留下交接单)')
  if (card.reviewNote?.trim()) lines.push('', '[REVIEW CHANGES]', card.reviewNote.trim())
  if (task.graphMode === 'dynamic-rounds' && card.role === 'planner') {
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
