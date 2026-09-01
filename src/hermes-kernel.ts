/**
 * Hermes 0.20.4 compatible task kernel for the DSH plugin.
 *
 * This is a semantic port of the small, durable part of Hermes Kanban:
 * normalized SQLite rows, BEGIN IMMEDIATE writes, CAS claims, one run per
 * attempt, dependency gating, same-card review/rework, and bounded handoff
 * context. DSH-specific task templates and UI projections live above this
 * module; they must not become a second task state machine.
 *
 * Hermes Agent is MIT licensed, Copyright (c) 2025 Nous Research.
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const HERMES_COMPAT_VERSION = '0.20.4'
export const DEFAULT_CLAIM_TTL_SECONDS = 900
export const BLOCK_RECURRENCE_LIMIT = 3

export type KernelTaskStatus = 'triage' | 'todo' | 'scheduled' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'
export type KernelBlockKind = 'dependency' | 'needs_input' | 'capability' | 'transient'

export interface KernelTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: KernelTaskStatus
  priority: number
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  workspace_kind: string
  workspace_path: string | null
  branch_name: string | null
  project_id: string | null
  claim_lock: string | null
  claim_expires: number | null
  tenant: string | null
  result: string | null
  idempotency_key: string | null
  consecutive_failures: number
  worker_pid: number | null
  last_failure_error: string | null
  max_runtime_seconds: number | null
  last_heartbeat_at: number | null
  current_run_id: number | null
  skills: string | null
  model_override: string | null
  provider_override: string | null
  reasoning_effort: string | null
  max_retries: number | null
  block_kind: KernelBlockKind | null
  block_recurrences: number
  node_kind: 'agent' | 'gate'
  round: number | null
  role: string | null
}

export interface KernelRun {
  id: number
  task_id: string
  profile: string | null
  step_key: string | null
  status: string
  claim_lock: string | null
  claim_expires: number | null
  worker_pid: number | null
  max_runtime_seconds: number | null
  last_heartbeat_at: number | null
  started_at: number
  ended_at: number | null
  outcome: string | null
  summary: string | null
  metadata: string | null
  error: string | null
}

export interface KernelEvent {
  id: number
  task_id: string
  run_id: number | null
  kind: string
  payload: string | null
  created_at: number
  graph_id: string | null
}

export interface CreateKernelTask {
  id: string
  title: string
  body?: string
  assignee?: string
  status?: KernelTaskStatus
  priority?: number
  createdBy?: string
  workspaceKind?: string
  workspacePath?: string
  tenant?: string
  maxRuntimeSeconds?: number
  maxRetries?: number
  modelOverride?: string
  providerOverride?: string
  reasoningEffort?: string
  parents?: string[]
  nodeKind?: 'agent' | 'gate'
  round?: number
  role?: string
}

export interface ClaimResult {
  task: KernelTask
  run: KernelRun
  lock: string
}

export interface KernelOptions {
  /** Unix seconds. Kept injectable so transition tests do not sleep. */
  now?: () => number
  claimer?: () => string
  isPidAlive?: (pid: number) => boolean
}

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,
  status TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  workspace_kind TEXT NOT NULL DEFAULT 'scratch',
  workspace_path TEXT,
  branch_name TEXT,
  project_id TEXT,
  claim_lock TEXT,
  claim_expires INTEGER,
  tenant TEXT,
  result TEXT,
  idempotency_key TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  worker_pid INTEGER,
  last_failure_error TEXT,
  max_runtime_seconds INTEGER,
  last_heartbeat_at INTEGER,
  current_run_id INTEGER,
  workflow_template_id TEXT,
  current_step_key TEXT,
  skills TEXT,
  model_override TEXT,
  provider_override TEXT,
  reasoning_effort TEXT,
  max_retries INTEGER,
  goal_mode INTEGER NOT NULL DEFAULT 0,
  goal_max_turns INTEGER,
  session_id TEXT,
  block_kind TEXT,
  block_recurrences INTEGER NOT NULL DEFAULT 0,
  node_kind TEXT NOT NULL DEFAULT 'agent',
  round INTEGER,
  role TEXT
);

CREATE TABLE IF NOT EXISTS task_links (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dependency',
  created_at INTEGER,
  PRIMARY KEY (parent_id, child_id)
);

CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  graph_id TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  profile TEXT,
  step_key TEXT,
  status TEXT NOT NULL,
  claim_lock TEXT,
  claim_expires INTEGER,
  worker_pid INTEGER,
  max_runtime_seconds INTEGER,
  last_heartbeat_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  summary TEXT,
  metadata TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_notify_subs (
  task_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  user_id_alt TEXT,
  chat_type TEXT,
  notifier_profile TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'notify',
  delivery_metadata TEXT,
  created_at INTEGER NOT NULL,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, platform, chat_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_links_child ON task_links(child_id);
CREATE INDEX IF NOT EXISTS idx_links_parent ON task_links(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON task_attachments(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notify_task ON kanban_notify_subs(task_id);

-- DSH owns these extensions. The Hermes-compatible tables above remain usable
-- without the DSH task-template and UI layers.
CREATE TABLE IF NOT EXISTS dsh_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dsh_task_specs (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dsh_batches (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  fired_by TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  settled_at INTEGER,
  outcome TEXT
);
CREATE TABLE IF NOT EXISTS dsh_card_bindings (
  card_id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  brief TEXT
);
CREATE TABLE IF NOT EXISTS dsh_run_bindings (
  external_run_id TEXT PRIMARY KEY,
  core_run_id INTEGER NOT NULL UNIQUE,
  session_id TEXT,
  message_id TEXT,
  nudges INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dsh_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  task_id TEXT,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dsh_events_task_seq ON dsh_events(task_id, seq);
`

const VALID_STATUSES = new Set<KernelTaskStatus>(['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'])
const json = (value: unknown) => value === undefined ? null : JSON.stringify(value)
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

/** One SQLite file is one Hermes-compatible board. */
export class HermesKernel {
  readonly db: Database.Database
  private composeDepth = 0
  readonly path: string
  private readonly clock: () => number
  private readonly claimer: () => string
  private readonly isPidAlive: (pid: number) => boolean

  constructor(path: string, options: KernelOptions = {}) {
    this.path = path
    this.clock = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.claimer = options.claimer ?? (() => `${hostname()}:${process.pid}:${randomUUID()}`)
    this.isPidAlive = options.isPidAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { timeout: 5_000 })
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('wal_autocheckpoint = 100')
    this.db.pragma('journal_size_limit = 8388608')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('secure_delete = ON')
    this.db.pragma('busy_timeout = 5000')
    this.prepareLegacyEventTable()
    this.db.exec(CORE_SCHEMA_SQL)
    this.ensureGraphColumns()
    this.db.prepare(`INSERT INTO dsh_meta(key, value) VALUES ('hermes_compat_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(HERMES_COMPAT_VERSION)
  }

  private ensureGraphColumns(): void {
    const ensure = (table: string, column: string, ddl: string) => {
      const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
    ensure('tasks', 'node_kind', `node_kind TEXT NOT NULL DEFAULT 'agent'`)
    ensure('tasks', 'round', 'round INTEGER')
    ensure('tasks', 'role', 'role TEXT')
    ensure('task_links', 'kind', `kind TEXT NOT NULL DEFAULT 'dependency'`)
    ensure('task_links', 'created_at', 'created_at INTEGER')
    ensure('task_events', 'graph_id', 'graph_id TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_graph_id ON task_events(graph_id, id)')
  }

  close(): void { this.db.close() }

  /** Move the former one-table store aside before creating Hermes task_events. */
  private prepareLegacyEventTable(): void {
    const table = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events'`).get()
    if (!table) return
    const columns = (this.db.prepare('PRAGMA table_info(task_events)').all() as { name: string }[]).map(row => row.name)
    if (!columns.includes('payload_json') || columns.includes('kind')) return
    const hasDestination = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dsh_events'`).get()
    this.write(() => {
      if (!hasDestination) this.db.exec('ALTER TABLE task_events RENAME TO dsh_events')
      else {
        this.db.exec(`INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json)
          SELECT event_type, task_id, occurred_at, payload_json FROM task_events ORDER BY seq`)
        this.db.exec('DROP TABLE task_events')
      }
    })
  }

  write<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      if (this.composeDepth > 0) return fn()
      throw new Error('HermesKernel.write cannot nest; use compose() for an explicit extension transaction')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* SQLite may have auto-rolled back */ }
      throw error
    }
  }

  /** Explicitly let DSH extension rows join one core transaction; ordinary nested writes stay forbidden. */
  compose<T>(fn: () => T): T {
    if (this.db.inTransaction) throw new Error('HermesKernel.compose must start the outer transaction')
    return this.write(() => {
      this.composeDepth++
      try { return fn() } finally { this.composeDepth-- }
    })
  }

  private now(): number { return Math.floor(this.clock()) }

  private appendEvent(taskId: string, kind: string, payload?: unknown, runId?: number | null): void {
    const graphId = this.taskRow(taskId)?.tenant ?? null
    this.db.prepare('INSERT INTO task_events(task_id, run_id, kind, payload, created_at, graph_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, runId ?? null, kind, json(payload), this.now(), graphId)
  }

  private taskRow(id: string): KernelTask | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as KernelTask | undefined
  }

  getTask(id: string): KernelTask | undefined { return this.taskRow(id) }
  listTasks(): KernelTask[] { return this.db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at, id').all() as KernelTask[] }
  listRuns(taskId: string): KernelRun[] { return this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at, id').all(taskId) as KernelRun[] }
  listEvents(taskId: string): KernelEvent[] { return this.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(taskId) as KernelEvent[] }
  parentIds(taskId: string): string[] { return (this.db.prepare('SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id').all(taskId) as { parent_id: string }[]).map(row => row.parent_id) }
  childIds(taskId: string): string[] { return (this.db.prepare('SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id').all(taskId) as { child_id: string }[]).map(row => row.child_id) }

  createTask(input: CreateKernelTask): KernelTask {
    if (!input.id.trim() || !input.title.trim()) throw new Error('task id and title are required')
    const requested = input.status ?? 'ready'
    if (!VALID_STATUSES.has(requested)) throw new Error(`invalid task status: ${requested}`)
    const parents = [...new Set(input.parents ?? [])]
    if (parents.includes(input.id)) throw new Error('task cannot depend on itself')
    return this.write(() => {
      for (const parent of parents) if (!this.taskRow(parent)) throw new Error(`unknown parent task: ${parent}`)
      const parentsDone = parents.every(parent => ['done', 'archived'].includes(this.taskRow(parent)!.status))
      const status = requested === 'ready' && !parentsDone ? 'todo' : requested
      const now = this.now()
      this.db.prepare(`INSERT INTO tasks(
        id, title, body, assignee, status, priority, created_by, created_at,
        workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries,
        model_override, provider_override, reasoning_effort, node_kind, round, role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id, input.title.trim(), input.body?.trim() || null, input.assignee?.trim() || null,
        status, input.priority ?? 0, input.createdBy?.trim() || null, now,
        input.workspaceKind ?? 'dir', input.workspacePath?.trim() || null, input.tenant?.trim() || null,
        input.maxRuntimeSeconds ?? null, input.maxRetries ?? null,
        input.modelOverride?.trim() || null, input.providerOverride?.trim() || null, input.reasoningEffort?.trim() || null,
        input.nodeKind ?? 'agent', input.round ?? null, input.role?.trim() || null,
      )
      for (const parent of parents) this.db.prepare('INSERT INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, ?, ?)').run(parent, input.id, 'dependency', now)
      this.appendEvent(input.id, 'created', { title: input.title.trim(), assignee: input.assignee ?? null, status, parents, tenant: input.tenant ?? null, node_kind: input.nodeKind ?? 'agent', round: input.round ?? null, role: input.role ?? null, created_at: now })
      return this.taskRow(input.id)!
    })
  }

  linkTasks(parentId: string, childId: string): void {
    if (parentId === childId) throw new Error('task cannot depend on itself')
    this.write(() => {
      if (!this.taskRow(parentId) || !this.taskRow(childId)) throw new Error('both tasks must exist')
      const cycle = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT child_id FROM task_links WHERE parent_id = ?
        UNION SELECT l.child_id FROM task_links l JOIN descendants d ON l.parent_id = d.id
      ) SELECT 1 FROM descendants WHERE id = ? LIMIT 1`).get(childId, parentId)
      if (cycle) throw new Error('dependency would create a cycle')
      this.db.prepare('INSERT OR IGNORE INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, ?, ?)').run(parentId, childId, 'dependency', this.now())
      this.db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = ? AND status = 'ready'
        AND EXISTS (SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id
          WHERE l.child_id = tasks.id AND p.status NOT IN ('done', 'archived'))`).run(childId)
      this.appendEvent(childId, 'linked', { parent_id: parentId })
    })
  }

  /** Gates are durable task rows but never own an agent run. */
  openReadyGates(): string[] {
    return this.write(() => {
      const rows = this.db.prepare(`SELECT id FROM tasks WHERE node_kind = 'gate' AND status = 'todo' ORDER BY created_at, id`).all() as { id: string }[]
      const opened: string[] = []
      for (const row of rows) {
        if (!this.parentsSatisfied(row.id)) continue
        const now = this.now()
        const cur = this.db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, result = 'gate_opened' WHERE id = ? AND status = 'todo'`).run(now, row.id)
        if (!cur.changes) continue
        this.appendEvent(row.id, 'gate_opened', { status: 'done' })
        this.promoteChildren(row.id)
        opened.push(row.id)
      }
      return opened
    })
  }

  private parentsSatisfied(taskId: string): boolean {
    return !this.db.prepare(`SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id
      WHERE l.child_id = ? AND p.status NOT IN ('done', 'archived') LIMIT 1`).get(taskId)
  }

  private promoteChildren(parentId: string): number {
    const children = this.childIds(parentId)
    let promoted = 0
    for (const childId of children) {
      const cur = this.db.prepare(`UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'
        AND assignee IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id
          WHERE l.child_id = tasks.id AND p.status NOT IN ('done', 'archived')
        )`).run(childId)
      if (cur.changes) { this.appendEvent(childId, 'promoted'); promoted++ }
    }
    return promoted
  }

  promoteReadyTasks(): number {
    return this.write(() => {
      const rows = this.db.prepare(`SELECT id FROM tasks WHERE status = 'todo' AND assignee IS NOT NULL`).all() as { id: string }[]
      let promoted = 0
      for (const row of rows) {
        if (!this.parentsSatisfied(row.id)) continue
        const cur = this.db.prepare(`UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'`).run(row.id)
        if (cur.changes) { this.appendEvent(row.id, 'promoted'); promoted++ }
      }
      return promoted
    })
  }

  claimTask(taskId: string, options: { ttlSeconds?: number; claimer?: string; fromReview?: boolean } = {}): ClaimResult | undefined {
    return this.write(() => {
      const source: KernelTaskStatus = options.fromReview ? 'review' : 'ready'
      if (!this.parentsSatisfied(taskId)) {
        const cur = this.db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = ? AND status = ? AND claim_lock IS NULL`).run(taskId, source)
        if (cur.changes) this.appendEvent(taskId, 'claim_rejected', { reason: 'parents_not_done', source_status: source })
        return undefined
      }
      const now = this.now(); const lock = options.claimer ?? this.claimer()
      const expires = now + Math.max(1, options.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS)
      const cur = this.db.prepare(`UPDATE tasks SET status = 'running', claim_lock = ?, claim_expires = ?,
        started_at = COALESCE(started_at, ?), last_heartbeat_at = ?
        WHERE id = ? AND status = ? AND claim_lock IS NULL`).run(lock, expires, now, now, taskId, source)
      if (cur.changes !== 1) return undefined
      const task = this.taskRow(taskId)!
      const inserted = this.db.prepare(`INSERT INTO task_runs(
        task_id, profile, step_key, status, claim_lock, claim_expires,
        max_runtime_seconds, last_heartbeat_at, started_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(
        taskId, task.assignee, null, lock, expires, task.max_runtime_seconds, now, now,
      )
      const runId = Number(inserted.lastInsertRowid)
      this.db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(runId, taskId)
      this.appendEvent(taskId, 'claimed', { lock, expires, run_id: runId, ...(source === 'review' ? { source_status: 'review' } : {}) }, runId)
      return { task: this.taskRow(taskId)!, run: this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as KernelRun, lock }
    })
  }

  setWorkerPid(taskId: string, runId: number, lock: string, pid: number): boolean {
    return this.write(() => {
      const cur = this.db.prepare(`UPDATE tasks SET worker_pid = ? WHERE id = ? AND status = 'running'
        AND current_run_id = ? AND claim_lock = ?`).run(pid, taskId, runId, lock)
      if (!cur.changes) return false
      this.db.prepare('UPDATE task_runs SET worker_pid = ? WHERE id = ? AND claim_lock = ? AND ended_at IS NULL').run(pid, runId, lock)
      this.appendEvent(taskId, 'spawned', { pid }, runId)
      return true
    })
  }

  heartbeat(taskId: string, runId: number, lock: string, ttlSeconds = DEFAULT_CLAIM_TTL_SECONDS, note?: string): boolean {
    return this.write(() => {
      const now = this.now(); const expires = now + Math.max(1, ttlSeconds)
      const cur = this.db.prepare(`UPDATE tasks SET claim_expires = ?, last_heartbeat_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ? AND claim_lock = ?`).run(expires, now, taskId, runId, lock)
      if (!cur.changes) return false
      this.db.prepare(`UPDATE task_runs SET claim_expires = ?, last_heartbeat_at = ?
        WHERE id = ? AND claim_lock = ? AND ended_at IS NULL`).run(expires, now, runId, lock)
      this.appendEvent(taskId, 'heartbeat', note ? { note } : undefined, runId)
      return true
    })
  }

  private endRun(taskId: string, runId: number, status: string, outcome: string, summary?: string, metadata?: Record<string, unknown>, error?: string): void {
    const now = this.now()
    this.db.prepare(`UPDATE task_runs SET status = ?, outcome = ?, summary = COALESCE(?, summary),
      metadata = COALESCE(?, metadata), error = COALESCE(?, error), ended_at = ?,
      claim_lock = NULL, claim_expires = NULL, worker_pid = NULL
      WHERE id = ? AND task_id = ? AND ended_at IS NULL`).run(status, outcome, summary ?? null, json(metadata), error ?? null, now, runId, taskId)
    this.db.prepare('UPDATE tasks SET current_run_id = NULL WHERE id = ? AND current_run_id = ?').run(taskId, runId)
  }

  completeTask(taskId: string, options: { expectedRunId?: number; result?: string; summary?: string; metadata?: Record<string, unknown> } = {}): boolean {
    const completed = this.write(() => {
      if (!this.parentsSatisfied(taskId)) return false
      const task = this.taskRow(taskId)
      if (!task || !['running', 'ready', 'blocked', 'review'].includes(task.status)) return false
      if (options.expectedRunId !== undefined && task.current_run_id !== options.expectedRunId) return false
      const now = this.now()
      const cur = this.db.prepare(`UPDATE tasks SET status = 'done', result = ?, completed_at = ?,
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL, block_kind = NULL,
        block_recurrences = 0, consecutive_failures = 0
        WHERE id = ? AND status IN ('running', 'ready', 'blocked', 'review')
        ${options.expectedRunId === undefined ? '' : 'AND current_run_id = ?'}`)
        .run(options.result ?? null, now, taskId, ...(options.expectedRunId === undefined ? [] : [options.expectedRunId]))
      if (!cur.changes) return false
      let runId = task.current_run_id
      if (runId !== null) this.endRun(taskId, runId, 'done', 'completed', options.summary ?? options.result, options.metadata)
      else if (options.summary || options.result || options.metadata || task.status === 'review') {
        const inserted = this.db.prepare(`INSERT INTO task_runs(task_id, profile, status, started_at, ended_at, outcome, summary, metadata)
          VALUES (?, ?, 'done', ?, ?, 'completed', ?, ?)`).run(taskId, task.assignee, now, now, options.summary ?? options.result ?? 'Review approved without additional evidence.', json(options.metadata))
        runId = Number(inserted.lastInsertRowid)
      }
      const first = (options.summary ?? options.result ?? '').trim().split(/\r?\n/)[0]?.slice(0, 400)
      this.appendEvent(taskId, 'completed', { result_len: options.result?.length ?? 0, summary: first || undefined }, runId)
      this.promoteChildren(taskId)
      return true
    })
    return completed
  }

  requestReview(taskId: string, options: { expectedRunId?: number; reviewer?: string; summary: string; metadata?: Record<string, unknown> }): boolean {
    if (!options.summary.trim()) throw new Error('summary is required')
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || !['running', 'ready'].includes(task.status)) return false
      if (options.expectedRunId !== undefined && task.current_run_id !== options.expectedRunId) return false
      const implementer = task.assignee
      const cur = this.db.prepare(`UPDATE tasks SET status = 'review', assignee = COALESCE(?, assignee),
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL
        WHERE id = ? AND status IN ('running', 'ready')
        ${options.expectedRunId === undefined ? '' : 'AND current_run_id = ?'}`)
        .run(options.reviewer?.trim() || null, taskId, ...(options.expectedRunId === undefined ? [] : [options.expectedRunId]))
      if (!cur.changes) return false
      let runId = task.current_run_id
      if (runId !== null) this.endRun(taskId, runId, 'review', 'review_requested', options.summary, options.metadata)
      else {
        const now = this.now()
        const inserted = this.db.prepare(`INSERT INTO task_runs(task_id, profile, status, started_at, ended_at, outcome, summary, metadata)
          VALUES (?, ?, 'review', ?, ?, 'review_requested', ?, ?)`).run(taskId, implementer, now, now, options.summary, json(options.metadata))
        runId = Number(inserted.lastInsertRowid)
      }
      this.appendEvent(taskId, 'review_requested', {
        summary: options.summary.trim().split(/\r?\n/)[0].slice(0, 400), implementer, reviewer: options.reviewer?.trim() || null,
      }, runId)
      return true
    })
  }

  requestChanges(taskId: string, options: { expectedRunId: number; reason: string }): { ok: boolean; implementer?: string; error?: string } {
    const reason = options.reason.trim()
    if (!reason) return { ok: false, error: 'reason is required' }
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || task.status !== 'running' || task.current_run_id !== options.expectedRunId) return { ok: false, error: 'task is not in the expected active review run' }
      const claimed = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id DESC LIMIT 1`).get(taskId, options.expectedRunId) as { payload?: string } | undefined
      if (parseJson<Record<string, unknown>>(claimed?.payload, {}).source_status !== 'review') return { ok: false, error: 'active run was not claimed from review' }
      const requested = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND kind = 'review_requested' ORDER BY id DESC LIMIT 1`).get(taskId) as { payload?: string } | undefined
      const implementer = parseJson<Record<string, unknown>>(requested?.payload, {}).implementer
      if (typeof implementer !== 'string' || !implementer.trim()) return { ok: false, error: 'review handoff has no implementer provenance' }
      const reviewer = task.assignee
      const status = this.parentsSatisfied(taskId) ? 'ready' : 'todo'
      const cur = this.db.prepare(`UPDATE tasks SET status = ?, assignee = ?, claim_lock = NULL,
        claim_expires = NULL, worker_pid = NULL WHERE id = ? AND status = 'running' AND current_run_id = ?`)
        .run(status, implementer, taskId, options.expectedRunId)
      if (!cur.changes) return { ok: false, error: 'task changed during review handoff' }
      this.endRun(taskId, options.expectedRunId, status, 'changes_requested', reason)
      this.appendEvent(taskId, 'changes_requested', { reason, implementer, reviewer, status }, options.expectedRunId)
      return { ok: true, implementer }
    })
  }

  blockTask(taskId: string, options: { expectedRunId?: number; reason: string; kind?: KernelBlockKind }): boolean {
    if (!options.reason.trim()) throw new Error('reason is required')
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || !['running', 'ready'].includes(task.status)) return false
      if (options.expectedRunId !== undefined && task.current_run_id !== options.expectedRunId) return false
      const kind = options.kind ?? null
      const priorSame = task.block_kind === kind && kind !== null
      const recurrences = priorSame ? task.block_recurrences + 1 : (kind ? 1 : task.block_recurrences)
      const status: KernelTaskStatus = kind === 'dependency' ? (this.parentsSatisfied(taskId) ? 'ready' : 'todo') : recurrences >= BLOCK_RECURRENCE_LIMIT ? 'triage' : 'blocked'
      this.db.prepare(`UPDATE tasks SET status = ?, block_kind = ?, block_recurrences = ?,
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ?`).run(status, kind, recurrences, taskId)
      const runId = task.current_run_id
      if (runId !== null) this.endRun(taskId, runId, status, 'blocked', options.reason)
      this.appendEvent(taskId, 'blocked', { reason: options.reason, kind, recurrences, status }, runId)
      return true
    })
  }

  unblockTask(taskId: string): boolean {
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || !['blocked', 'scheduled', 'triage'].includes(task.status)) return false
      const status = this.parentsSatisfied(taskId) && task.assignee ? 'ready' : 'todo'
      const cur = this.db.prepare(`UPDATE tasks SET status = ? WHERE id = ? AND status IN ('blocked', 'scheduled', 'triage')`).run(status, taskId)
      if (cur.changes) this.appendEvent(taskId, 'unblocked', { status })
      return cur.changes === 1
    })
  }

  cancelTask(taskId: string, reason = 'cancelled'): boolean {
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || ['done', 'archived'].includes(task.status) || task.current_run_id !== null) return false
      const cur = this.db.prepare(`UPDATE tasks SET status = 'archived', claim_lock = NULL,
        claim_expires = NULL, worker_pid = NULL WHERE id = ? AND current_run_id IS NULL
        AND status NOT IN ('done', 'archived')`).run(taskId)
      if (cur.changes) this.appendEvent(taskId, 'cancelled', { reason })
      return cur.changes === 1
    })
  }

  giveUpTask(taskId: string, error: string): boolean {
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || task.current_run_id !== null || ['done', 'archived', 'triage'].includes(task.status)) return false
      const cur = this.db.prepare(`UPDATE tasks SET status = 'triage', last_failure_error = ?,
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ?
        AND current_run_id IS NULL AND status NOT IN ('done', 'archived', 'triage')`).run(error, taskId)
      if (cur.changes) this.appendEvent(taskId, 'gave_up', { error })
      return cur.changes === 1
    })
  }

  reclaimTask(taskId: string, reason = 'manual reclaim'): boolean {
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || task.status !== 'running' || task.current_run_id === null) return false
      const runId = task.current_run_id
      const claimed = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id DESC LIMIT 1`).get(taskId, runId) as { payload?: string } | undefined
      const source = parseJson<Record<string, unknown>>(claimed?.payload, {}).source_status === 'review' ? 'review' : 'ready'
      this.db.prepare(`UPDATE tasks SET status = ?, claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ? AND status = 'running' AND current_run_id = ?`).run(source, taskId, runId)
      this.endRun(taskId, runId, 'reclaimed', 'reclaimed', undefined, undefined, reason)
      this.appendEvent(taskId, 'reclaimed', { manual: true, reason, retry_status: source }, runId)
      return true
    })
  }

  releaseStaleClaims(): number {
    const now = this.now()
    const stale = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running' AND claim_expires IS NOT NULL AND claim_expires < ?`).all(now) as KernelTask[]
    let reclaimed = 0
    for (const task of stale) {
      if (task.worker_pid && this.isPidAlive(task.worker_pid) && task.last_heartbeat_at && now - task.last_heartbeat_at < 3600) {
        this.write(() => {
          const expires = now + DEFAULT_CLAIM_TTL_SECONDS
          const cur = this.db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ? AND status = 'running' AND claim_lock IS ? AND claim_expires < ?`).run(expires, task.id, task.claim_lock, now)
          if (cur.changes && task.current_run_id !== null) {
            this.db.prepare('UPDATE task_runs SET claim_expires = ? WHERE id = ?').run(expires, task.current_run_id)
            this.appendEvent(task.id, 'claim_extended', { reason: 'pid_alive', worker_pid: task.worker_pid, claim_expires_now: expires }, task.current_run_id)
          }
        })
        continue
      }
      if (this.reclaimTask(task.id, `stale_lock=${task.claim_lock ?? ''}`)) reclaimed++
    }
    return reclaimed
  }

  /** Append non-state telemetry (session creation, prompt dispatch, nudge). */
  recordEvent(taskId: string, kind: string, payload?: unknown, runId?: number | null): void {
    if (!this.taskRow(taskId)) throw new Error('task not found')
    this.write(() => this.appendEvent(taskId, kind, payload, runId))
  }

  /** Close an interrupted run and restore the phase it was claimed from. */
  failRun(taskId: string, options: { expectedRunId: number; outcome: 'failed' | 'crashed' | 'timed_out' | 'cancelled' | 'protocol_violation'; error?: string }): { ok: boolean; retryStatus?: 'ready' | 'review' | 'todo' } {
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || task.current_run_id !== options.expectedRunId || !['running', 'blocked'].includes(task.status)) return { ok: false }
      const claimed = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id DESC LIMIT 1`).get(taskId, options.expectedRunId) as { payload?: string } | undefined
      const fromReview = parseJson<Record<string, unknown>>(claimed?.payload, {}).source_status === 'review'
      const retryStatus: 'ready' | 'review' | 'todo' = this.parentsSatisfied(taskId) ? (fromReview ? 'review' : 'ready') : 'todo'
      const failures = task.consecutive_failures + (options.outcome === 'cancelled' ? 0 : 1)
      this.db.prepare(`UPDATE tasks SET status = ?, claim_lock = NULL, claim_expires = NULL,
        worker_pid = NULL, current_run_id = NULL, consecutive_failures = ?, last_failure_error = ?
        WHERE id = ? AND current_run_id = ?`).run(retryStatus, failures, options.error ?? options.outcome, taskId, options.expectedRunId)
      const runStatus = options.outcome === 'protocol_violation' ? 'failed' : options.outcome
      this.endRun(taskId, options.expectedRunId, runStatus, options.outcome, undefined, undefined, options.error)
      this.appendEvent(taskId, options.outcome, { error: options.error, retry_status: retryStatus }, options.expectedRunId)
      return { ok: true, retryStatus }
    })
  }

  /** Human/UI review extension: reopen one card without fabricating a worker run. */
  reopenForChanges(taskId: string, options: { reason: string; assignee?: string; forceTodo?: boolean; sourceTaskId?: string }): boolean {
    if (!options.reason.trim()) throw new Error('reason is required')
    return this.write(() => {
      const task = this.taskRow(taskId)
      if (!task || !['done', 'review', 'ready', 'todo'].includes(task.status)) return false
      const status = options.forceTodo || !this.parentsSatisfied(taskId) ? 'todo' : 'ready'
      const cur = this.db.prepare(`UPDATE tasks SET status = ?, assignee = COALESCE(?, assignee),
        completed_at = NULL, result = NULL, claim_lock = NULL, claim_expires = NULL,
        worker_pid = NULL, current_run_id = NULL WHERE id = ?`).run(status, options.assignee?.trim() || null, taskId)
      if (!cur.changes) return false
      this.appendEvent(taskId, 'changes_requested', {
        reason: options.reason.trim(), status, human: true, source_task_id: options.sourceTaskId ?? taskId,
      })
      return true
    })
  }

  /** Remove a DSH-owned card and its local history. User-facing delete calls only. */
  deleteTask(taskId: string): boolean {
    return this.write(() => {
      if (!this.taskRow(taskId)) return false
      this.db.prepare('DELETE FROM task_links WHERE parent_id = ? OR child_id = ?').run(taskId, taskId)
      this.db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
      return true
    })
  }

  addComment(taskId: string, author: string, body: string): number {
    if (!this.taskRow(taskId)) throw new Error('task not found')
    return this.write(() => {
      const inserted = this.db.prepare('INSERT INTO task_comments(task_id, author, body, created_at) VALUES (?, ?, ?, ?)').run(taskId, author.trim() || 'user', body.trim(), this.now())
      this.appendEvent(taskId, 'commented', { author: author.trim() || 'user', len: body.trim().length })
      return Number(inserted.lastInsertRowid)
    })
  }

  buildWorkerContext(taskId: string): string {
    const task = this.taskRow(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const cap = (value: unknown, limit = 8_000) => {
      const text = String(value ?? '').trim()
      return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`
    }
    const lines = [`# Kanban task ${task.id}: ${task.title}`, '', `Assignee: ${task.assignee ?? '(unassigned)'}`, `Status:   ${task.status}`, `Workspace: ${task.workspace_kind} @ ${task.workspace_path ?? '(unresolved)'}`, '']
    if (task.body?.trim()) lines.push('## Body', cap(task.body), '')

    const prior = this.listRuns(taskId).filter(run => run.ended_at !== null).slice(-8)
    if (prior.length) {
      lines.push('## Prior attempts on this task')
      prior.forEach((run, index) => {
        lines.push(`### Attempt ${index + 1} — ${run.outcome ?? run.status} (${run.profile ?? '(unknown)'})`)
        if (run.summary) lines.push(cap(run.summary, 4_000))
        if (run.error) lines.push(`_error_: ${cap(run.error, 4_000)}`)
        if (run.metadata) lines.push(`_metadata_: \`${cap(run.metadata, 4_000)}\``)
        lines.push('')
      })
    }

    let wroteParents = false
    for (const parentId of this.parentIds(taskId)) {
      const parent = this.taskRow(parentId)
      if (!parent || parent.status !== 'done') continue
      const runs = this.listRuns(parentId).filter(run => run.outcome === 'completed').sort((a, b) => b.started_at - a.started_at || b.id - a.id)
      const run = runs[0]
      if (!wroteParents) { lines.push('## Parent task results'); wroteParents = true }
      lines.push(`### ${parentId}`, cap(run?.summary || parent.result || '(no result recorded)', 4_000))
      if (run?.metadata) lines.push(`_metadata_: \`${cap(run.metadata, 4_000)}\``)
      lines.push('')
    }

    if (task.assignee) {
      const recent = this.db.prepare(`SELECT t.id, t.title, r.summary FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.profile = ? AND r.task_id <> ? AND r.outcome = 'completed' ORDER BY r.ended_at DESC LIMIT 5`).all(task.assignee, taskId) as { id: string; title: string; summary: string | null }[]
      if (recent.length) {
        lines.push(`## Recent work by @${task.assignee}`)
        for (const row of recent) lines.push(`- ${row.id} — ${row.title}: ${cap(row.summary || '(no summary)', 200)}`)
        lines.push('')
      }
    }

    const comments = this.db.prepare('SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 20').all(taskId) as { author: string; body: string; created_at: number }[]
    if (comments.length) {
      lines.push('## Comment thread')
      for (const comment of comments.reverse()) lines.push(`comment from worker \`${comment.author.replaceAll('`', '')}\`:`, cap(comment.body, 2_000), '')
    }
    return lines.join('\n').trimEnd() + '\n'
  }
}
