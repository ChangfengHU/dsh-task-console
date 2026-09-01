/**
 * Store, validation, and the message a card receives. The model itself
 * lives in ./fold.ts (pure, shared with the browser).
 *
 * @module dsh-task-console/tasks
 */

import initSqlJs from 'sql.js'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fold, migrate, type Card, type Event, type Participant, type State, type TaskSpec, type Trigger } from './fold.ts'

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
  private db?: any

  constructor(dir = storeDir()) { this.dir = dir }

  get file(): string { return join(this.dir, 'task.db') }
  get legacyFile(): string { return join(this.dir, 'events.jsonl') }
  get root(): string { return this.dir }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const SQL = await initSqlJs()
    let data: Uint8Array | undefined
    try { data = new Uint8Array(await readFile(this.file)) } catch { /* first run */ }
    this.db = data ? new SQL.Database(data) : new SQL.Database()
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        task_id TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_task_seq ON task_events(task_id, seq);
    `)

    const count = Number(this.db.exec('SELECT COUNT(*) AS n FROM task_events')[0]?.values[0]?.[0] ?? 0)
    if (count === 0) await this.importLegacyJsonl()
    else if (!data) await this.persist()
    const rows = this.db.exec('SELECT payload_json FROM task_events ORDER BY seq')[0]?.values ?? []
    this.events = rows.flatMap((row: unknown[]) => { try { return [JSON.parse(String(row[0])) as Event] } catch { return [] } })
    this.state = fold(this.events)
  }

  /** One-time, read-only import. The JSONL file remains untouched for rollback and audit. */
  private async importLegacyJsonl(): Promise<void> {
    let text = ''
    try { text = await readFile(this.legacyFile, 'utf8') } catch { await this.persist(); return }
    const raw = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const events = migrate(raw)
    this.db!.run('BEGIN')
    try {
      for (const event of events) this.db!.run('INSERT INTO task_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)', [event.t, 'taskId' in event ? event.taskId : null, event.at, JSON.stringify(event)])
      this.db!.run('COMMIT')
    } catch (error) { this.db!.run('ROLLBACK'); throw error }
    await this.persist()
  }

  /** sql.js is SQLite compiled to WASM; exporting through a sibling file keeps replacement atomic. */
  private async persist(): Promise<void> {
    const temp = `${this.file}.next`
    await writeFile(temp, Buffer.from(this.db!.export()), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }

  all(): Event[] { return this.events }
  get s(): State { return this.state }
  get tasks(): Map<string, TaskSpec> { return this.state.tasks }

  /** Serialized append: the fold is updated only after SQLite commits the row. */
  append(e: Event): Promise<void> {
    const next = this.queue.then(async () => {
      if (!this.db) throw new Error('task store 尚未加载')
      this.db.run('INSERT INTO task_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)', [e.t, 'taskId' in e ? e.taskId : null, e.at, JSON.stringify(e)])
      try { await this.persist() } catch (error) { this.db.run('DELETE FROM task_events WHERE seq = last_insert_rowid()'); throw error }
      this.events.push(e)
      this.state = fold(this.events)
    })
    this.queue = next.catch(() => undefined)
    return next
  }
}

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
    '做完但需要人工验收时调用 task_request_review(summary, artifacts, metadata);验收通过前不会启动下游或判定整批完成。',
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
