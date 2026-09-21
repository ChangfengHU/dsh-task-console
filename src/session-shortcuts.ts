/** Session metadata only. No transcript, workspace or Task lifecycle mutations. */
import type Database from 'better-sqlite3'

export type ShortcutKind = 'pinned' | 'favorite'
export interface SessionShortcut { sessionId: string; pinned: boolean; favorite: boolean; pinnedAt: number; favoriteAt: number }
export interface ShortcutChange { sessionId: string; kind: ShortcutKind; value: boolean; expected: boolean }

export function shortcutChange(raw: unknown): ShortcutChange {
  const q = raw as ShortcutChange
  if (!q || typeof q.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(q.sessionId) || !['pinned', 'favorite'].includes(q.kind) || typeof q.value !== 'boolean' || typeof q.expected !== 'boolean' || Object.keys(q).some(k => !['sessionId', 'kind', 'value', 'expected'].includes(k))) throw Error('无效的会话标记')
  return q
}

export class SessionShortcuts {
  constructor(private db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS dsh_session_shortcuts(session_id TEXT PRIMARY KEY,pinned_at INTEGER NOT NULL DEFAULT 0,favorite_at INTEGER NOT NULL DEFAULT 0)')
  }
  list(hidden: ReadonlySet<string> = new Set()): SessionShortcut[] {
    return (this.db.prepare('SELECT * FROM dsh_session_shortcuts ORDER BY session_id').all() as any[]).filter(r => !hidden.has(r.session_id)).map(r => ({ sessionId: r.session_id, pinned: r.pinned_at > 0, favorite: r.favorite_at > 0, pinnedAt: r.pinned_at, favoriteAt: r.favorite_at }))
  }
  set(raw: unknown, eligible: ReadonlySet<string>, now = Date.now()): void {
    const q = shortcutChange(raw)
    if (!eligible.has(q.sessionId)) throw Error('会话不存在、已归档或属于任务内部会话，不能设置快捷入口')
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM dsh_session_shortcuts WHERE session_id=?').get(q.sessionId) as any
      const field = q.kind === 'pinned' ? 'pinned_at' : 'favorite_at'
      const current = (row?.[field] ?? 0) > 0
      if (current === q.value) return // Retransmission is idempotent, not a toggle.
      if (current !== q.expected) throw Error('会话标记已变化，请刷新后重试')
      this.db.prepare('INSERT OR IGNORE INTO dsh_session_shortcuts(session_id) VALUES (?)').run(q.sessionId)
      this.db.prepare(`UPDATE dsh_session_shortcuts SET ${field}=? WHERE session_id=?`).run(q.value ? Math.max(1, now) : 0, q.sessionId)
      this.db.prepare('DELETE FROM dsh_session_shortcuts WHERE session_id=? AND pinned_at=0 AND favorite_at=0').run(q.sessionId)
    })()
  }
}
