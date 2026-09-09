import { createHash, randomUUID } from 'node:crypto'
import { cronMatches, nextFire, parseCron } from './cron.ts'
import type { EventStore, TaskSpec } from './tasks.ts'

export interface ScheduleClaim { id: string; token: string; batchId: string }
interface FireRow { id: string; task_id: string; batch_id: string; scheduled_at: number; status: string; attempts: number; lease_until: number | null; available_at: number; reason: string | null; coalesced_from: number | null }

/** Scheduling metadata only. Canonical Tasks/Runs remain the execution state machine. */
export class ScheduleLedger {
  constructor(private store: EventStore) {
    store.kernel.db.exec(`
      CREATE TABLE IF NOT EXISTS dsh_schedule_state (
        task_id TEXT PRIMARY KEY, revision TEXT NOT NULL, enabled INTEGER NOT NULL, next_at INTEGER, time_zone TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dsh_schedule_fires (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, batch_id TEXT NOT NULL UNIQUE, scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        available_at INTEGER NOT NULL, reason TEXT, coalesced_from INTEGER,
        UNIQUE(task_id,scheduled_at)
      );
      CREATE INDEX IF NOT EXISTS idx_dsh_schedule_history ON dsh_schedule_fires(task_id,scheduled_at DESC);
    `)
  }

  sync(task: TaskSpec, now: number, reset = false) {
    if (task.trigger.kind !== 'cron') return
    const db = this.store.kernel.db, revision = JSON.stringify(task.trigger)
    const old = db.prepare('SELECT * FROM dsh_schedule_state WHERE task_id=?').get(task.id) as any
    if (!reset && old?.revision === revision && old.enabled === Number(task.enabled)) return
    const zone = task.trigger.timeZone ?? old?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const next = task.enabled ? nextFire(parseCron(task.trigger.expr)!, new Date(now), zone)?.getTime() ?? null : null
    db.prepare(`INSERT INTO dsh_schedule_state VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,next_at=excluded.next_at,time_zone=excluded.time_zone`).run(task.id, revision, Number(task.enabled), next, zone)
    if (!task.enabled) db.prepare("UPDATE dsh_schedule_fires SET status='skipped',reason='时间表已暂停',lease_token=NULL,lease_until=NULL WHERE task_id=? AND status='pending'").run(task.id)
  }

  /** Collapse missed ticks to the latest occurrence; never replay an hourly backlog. */
  claim(task: TaskSpec, now: number): ScheduleClaim | undefined {
    if (task.trigger.kind !== 'cron') return
    const cron = parseCron(task.trigger.expr)!
    return this.store.kernel.write(() => {
      this.sync(task, now)
      if (!task.enabled) return
      const db = this.store.kernel.db
      const state = db.prepare('SELECT * FROM dsh_schedule_state WHERE task_id=?').get(task.id) as any
      let row = db.prepare("SELECT * FROM dsh_schedule_fires WHERE task_id=? AND status='pending' ORDER BY scheduled_at LIMIT 1").get(task.id) as FireRow | undefined
      if (!row && state.next_at !== null && state.next_at <= now) {
        let due = Math.floor(now / 60_000) * 60_000
        while (due > state.next_at && !cronMatches(cron, new Date(due), state.time_zone)) due -= 60_000
        const id = createHash('sha256').update(`${task.id}:${due}`).digest('hex').slice(0, 24)
        db.prepare(`INSERT OR IGNORE INTO dsh_schedule_fires(id,task_id,batch_id,scheduled_at,status,available_at,coalesced_from) VALUES (?,?,?,?,'pending',?,?)`).run(id, task.id, `b-cron-${id}`, due, now, due > state.next_at ? state.next_at : null)
        db.prepare('UPDATE dsh_schedule_state SET next_at=? WHERE task_id=?').run(nextFire(cron, new Date(now), state.time_zone)?.getTime() ?? null, task.id)
        row = db.prepare('SELECT * FROM dsh_schedule_fires WHERE id=?').get(id) as FireRow
      }
      if (!row || row.status !== 'pending' || row.available_at > now || (row.lease_until ?? 0) > now) return
      if (db.prepare('SELECT id FROM dsh_batches WHERE spec_id=? AND settled_at IS NULL LIMIT 1').get(task.id)) {
        db.prepare("UPDATE dsh_schedule_fires SET status='skipped',reason='上一轮仍未结束，不重叠执行' WHERE id=?").run(row.id); return
      }
      if (row.attempts >= 3) { db.prepare("UPDATE dsh_schedule_fires SET status='failed',reason='派发恢复预算已用尽，需检查调度器' WHERE id=?").run(row.id); return }
      const token = randomUUID()
      db.prepare("UPDATE dsh_schedule_fires SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending'").run(token, now + 120_000, row.id)
      return { id: row.id, token, batchId: row.batch_id }
    })
  }

  failed(claim: ScheduleClaim, now: number, reason: string) {
    // Never replay a dispatched Batch because later preflight/notification failed.
    this.store.kernel.db.prepare("UPDATE dsh_schedule_fires SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,available_at=?,reason=? WHERE id=? AND lease_token=? AND status='pending'").run(now + 60_000, reason.slice(0, 500), claim.id, claim.token)
  }

  view(taskId: string, page = 1) {
    const db = this.store.kernel.db
    const total = (db.prepare('SELECT COUNT(*) AS n FROM dsh_schedule_fires WHERE task_id=?').get(taskId) as any).n
    const pages = Math.max(1, Math.ceil(total / 10)), current = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)))
    return { state: db.prepare('SELECT enabled,next_at,time_zone FROM dsh_schedule_state WHERE task_id=?').get(taskId) ?? null,
      total, pages, page: current, rows: db.prepare(`SELECT f.id,f.batch_id,f.scheduled_at,f.status,f.attempts,f.reason,f.coalesced_from,b.outcome FROM dsh_schedule_fires f LEFT JOIN dsh_batches b ON b.id=f.batch_id WHERE f.task_id=? ORDER BY f.scheduled_at DESC LIMIT 10 OFFSET ?`).all(taskId, (current - 1) * 10) }
  }

  state(taskId: string) {
    return this.store.kernel.db.prepare('SELECT enabled,next_at,time_zone FROM dsh_schedule_state WHERE task_id=?').get(taskId) as { enabled: number; next_at: number | null; time_zone: string } | undefined
  }
}
