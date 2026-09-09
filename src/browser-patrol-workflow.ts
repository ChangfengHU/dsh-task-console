import type { CompletionCheck } from './runner.ts'
import type { EventStore } from './tasks.ts'
import { collectBrowserEvidence } from './browser-patrol-evidence.ts'

export interface PatrolRoundItem { ip: string; instance: number; action: 'verify' | 'provision' | 'resume'; reason: string }

/** Business evidence/authorization adapter. It never operates a browser. */
export class BrowserPatrolWorkflow {
  constructor(private store: EventStore) {}
  private db() {
    const db = this.store.kernel.db
    db.exec(`
      CREATE TABLE IF NOT EXISTS dsh_patrol_inventory(batch_id TEXT PRIMARY KEY, inventory_json TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dsh_patrol_observations(batch_id TEXT NOT NULL, target_key TEXT NOT NULL, card_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
        checked_at TEXT NOT NULL, expires_at TEXT, state TEXT NOT NULL, fingerprint TEXT, operation_id TEXT, evidence_seq INTEGER,
        PRIMARY KEY(batch_id,target_key,card_id,checked_at));
      CREATE TABLE IF NOT EXISTS dsh_patrol_round_items(batch_id TEXT NOT NULL, round INTEGER NOT NULL, target_key TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(batch_id,round,target_key));
      CREATE TABLE IF NOT EXISTS dsh_browser_issues(id INTEGER PRIMARY KEY AUTOINCREMENT, spec_id TEXT NOT NULL, target_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, opened_at TEXT NOT NULL, resolved_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_browser_open_issue ON dsh_browser_issues(spec_id,target_key) WHERE status='open';
      CREATE TABLE IF NOT EXISTS dsh_browser_operations(operation_id TEXT PRIMARY KEY, issue_id INTEGER NOT NULL, batch_id TEXT NOT NULL, card_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
    `)
    return db
  }

  capture(input: CompletionCheck, events: any[]) {
    if (input.task.design?.evidenceContract !== 'browser-patrol-v2') return
    const db = this.db(), proof = collectBrowserEvidence(input, events)
    if (proof.inventory && input.card.role === 'planner' && input.card.round === 1) {
      db.prepare('INSERT OR IGNORE INTO dsh_patrol_inventory VALUES (?,?,?)').run(input.batch.id, JSON.stringify(proof.inventory), input.sessionId)
    }
    const insert = db.prepare('INSERT OR IGNORE INTO dsh_patrol_observations VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    for (const { key, row } of proof.verificationHistory) {
      if (!Number.isFinite(Date.parse(row.checkedAt)) || Date.parse(row.checkedAt) < Date.parse(input.batch.firedAt)) continue
      insert.run(input.batch.id, key, input.card.id, input.sessionId, input.card.role ?? '', row.checkedAt, row.expiresAt ?? null, row.gemini, row.account?.fingerprint ?? null, row.operationId ?? null, row.evidenceSeq ?? null)
    }
  }

  plan(input: CompletionCheck, candidate: unknown) {
    if (input.task.design?.evidenceContract !== 'browser-patrol-v2') return
    const db = this.db()
    if (input.task.graphMode !== 'dynamic-rounds' || input.card.role !== 'planner') throw new Error('巡查v2必须使用动态规划/执行/评估')
    const inventory = this.inventory(input.batch.id)
    if (!inventory) throw new Error('先用真实 browser_fleet_inventory 建立本次目标清单')
    if (!Array.isArray(candidate) || !candidate.length || candidate.length > 128) throw new Error('巡查每轮需要 items:[{ip,instance,action:verify|provision|resume,reason}]，不能只提交自然语言')
    const keys = new Set<string>(), items: PatrolRoundItem[] = []
    for (const row of candidate) {
      const key = `${row?.ip}:${row?.instance}`, node = inventory.nodes.find((n: any) => n.ip === row?.ip)
      const browser = node?.browsers.find((b: any) => b.instance === row?.instance)
      if (keys.has(key) || !browser || !node.readAuthorized || !['verify', 'provision', 'resume'].includes(row.action) || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 1000) throw new Error('轮次目标/动作不在本次真实可读清单，或缺少决策理由')
      if (row.action !== 'verify' && (!browser.loginAuthorized || !input.task.design.browserPatrol!.actions.includes(row.action))) throw new Error('本计划没有该目标的登录修复授权')
      if (row.action !== 'verify') {
        const latest = db.prepare('SELECT state FROM dsh_patrol_observations WHERE batch_id=? AND target_key=? ORDER BY checked_at DESC LIMIT 1').get(input.batch.id, key) as any
        if (row.action === 'provision' && latest?.state !== 'signed_out') throw new Error('复制前需要本次真实未登录证据；未知先验证')
        if (row.action === 'resume' && (latest?.state === 'verified' || !db.prepare('SELECT 1 FROM dsh_browser_operations o JOIN dsh_browser_issues i ON i.id=o.issue_id WHERE i.spec_id=? AND i.target_key=? AND i.status=\'open\'').get(input.task.id,key))) throw new Error('正常续接仅用于已有授权复制尚未通过的目标，不改动健康登录')
      }
      keys.add(key); items.push({ ip: row.ip, instance: row.instance, action: row.action, reason: row.reason.trim() })
    }
    // Runner invokes commit inside the SAME transaction as the real Gate and links.
    return { items, commit: () => {
      if (db.prepare('SELECT 1 FROM dsh_patrol_round_items WHERE batch_id=? AND round=?').get(input.batch.id, input.card.round!)) throw new Error('本轮计划已冻结，不能原地改写')
      for (const row of items) db.prepare('INSERT INTO dsh_patrol_round_items VALUES (?,?,?,?,?)').run(input.batch.id, input.card.round!, `${row.ip}:${row.instance}`, row.action, row.reason)
      this.store.kernel.recordEvent(input.card.id, 'patrol_round_planned', { round: input.card.round, items })
    } }
  }

  private inventory(batchId: string) {
    const row = this.db().prepare('SELECT inventory_json FROM dsh_patrol_inventory WHERE batch_id=?').get(batchId) as any
    return row ? JSON.parse(row.inventory_json) : null
  }

  status(input: CompletionCheck, now = Date.now()) {
    const db = this.db(), inventory = this.inventory(input.batch.id)
    if (!inventory) return { ready: false, canCloseUnresolved: false, reason: '等待规划者建立真实清单', items: [], uncovered: [] }
    const items: any[] = []
    for (const node of inventory.nodes) for (const browser of node.browsers) {
      const key = `${node.ip}:${browser.instance}`
      const proof = db.prepare('SELECT * FROM dsh_patrol_observations WHERE batch_id=? AND target_key=? ORDER BY checked_at DESC LIMIT 1').get(input.batch.id, key) as any
      const samples = db.prepare("SELECT * FROM dsh_patrol_observations WHERE batch_id=? AND target_key=? AND role='reviewer' ORDER BY checked_at").all(input.batch.id, key) as any[]
      const issue = db.prepare("SELECT * FROM dsh_browser_issues WHERE spec_id=? AND target_key=? AND status='open'").get(input.task.id, key) as any
      const changedThisBatch = (db.prepare('SELECT COUNT(*) n FROM dsh_browser_operations o JOIN dsh_browser_issues i ON i.id=o.issue_id WHERE o.batch_id=? AND i.target_key=?').get(input.batch.id,key) as any).n
      const lastChange = issue ? db.prepare('SELECT created_at FROM dsh_browser_operations WHERE issue_id=? ORDER BY created_at DESC LIMIT 1').get(issue.id) as any : null
      const afterChange = samples.filter(s => !lastChange || Date.parse(s.checked_at) > Date.parse(lastChange.created_at))
      // A transient unknown sample resets the observation window, not browser state.
      const lastAccount = afterChange.at(-1)?.fingerprint
      const invalid = afterChange.findLastIndex(s => s.state !== 'verified' || s.fingerprint !== lastAccount)
      const relevant = afterChange.slice(invalid + 1)
      const last = relevant.at(-1), first = relevant[0]
      const cfg = input.task.design!.browserPatrol!
      const fresh = last && Date.parse(last.checked_at) <= now && Date.parse(last.expires_at) > now && now - Date.parse(last.checked_at) <= 15 * 60_000 && last.state === 'verified'
      const stable = !issue || (relevant.length >= cfg.minSamples && Date.parse(last?.checked_at) - Date.parse(first?.checked_at) >= cfg.observationMinutes * 60_000 && relevant.every(s => s.state === 'verified' && s.fingerprint === last.fingerprint))
      const accepted = node.readAuthorized === true && node.reachable === true && fresh && stable
      const nextCheckAt = issue && first && !stable && relevant.every(s => s.state === 'verified') ? new Date(Math.max(now + 60_000, Date.parse(first.checked_at) + cfg.observationMinutes * 60_000 * Math.min(relevant.length, cfg.minSamples - 1) / (cfg.minSamples - 1))).toISOString() : null
      items.push({ ip: node.ip, instance: browser.instance, state: proof?.state ?? 'unknown', fingerprint: proof?.fingerprint ?? null,
        checkedAt: proof?.checked_at ?? null, operationId: proof?.operation_id ?? null, accepted: !!accepted,
        readAuthorized: node.readAuthorized, loginAuthorized: browser.loginAuthorized, attempts: issue?.attempts ?? changedThisBatch,
        independentlyObserved: samples.length,
        observation: issue ? { samples: relevant.length, requiredSamples: cfg.minSamples, minutes: cfg.observationMinutes, passed: stable, nextCheckAt } : null,
        reason: !node.readAuthorized ? 'read-not-authorized' : !node.reachable ? 'unreachable' : !last ? 'missing-independent-verification' : !fresh ? 'not-currently-verified' : !stable ? 'observation-window-pending-or-failed' : 'independent-verification-passed' })
    }
    const uncovered = inventory.nodes.filter((n: any) => n.reachable !== true && !n.browsers.length).map((n: any) => ({ nodeId: n.nodeId, reason: 'unreachable-no-browser-observation' }))
    const plan = db.prepare('SELECT target_key,action,reason FROM dsh_patrol_round_items WHERE batch_id=? AND round=?').all(input.batch.id, input.card.round ?? 0)
    const canCloseUnresolved = items.every(i => i.accepted || !i.readAuthorized || !inventory.nodes.find((n: any) => n.ip === i.ip)?.reachable || i.independentlyObserved > 0 && ((input.card.round ?? 0) > input.task.design!.failurePolicy.maxAttempts || i.attempts >= input.task.design!.failurePolicy.maxAttempts || i.state === 'unknown' && i.independentlyObserved >= 2)) && (items.length > 0 || uncovered.length > 0)
    return { ready: items.length > 0 && items.every(i => i.accepted) && uncovered.length === 0, canCloseUnresolved, plan,
      items, uncovered, summary: `${items.length} 个已观测浏览器：${items.filter(i => i.accepted).length} 验收通过，${items.filter(i => !i.accepted).length} 未通过；${uncovered.length} 个节点无法确认浏览器覆盖。` }
  }

  complete(input: CompletionCheck) {
    const report = this.snapshot(input)
    const unresolved = input.metadata?.patrolDisposition === 'unresolved'
    // Resolve only independently accepted targets, even if another node is unreachable.
    if (input.card.role === 'reviewer' || input.card.role === 'planner') for (const row of report.items.filter(i => i.accepted))
      this.db().prepare("UPDATE dsh_browser_issues SET status='resolved',resolved_at=? WHERE spec_id=? AND target_key=? AND status='open'").run(new Date().toISOString(), input.task.id, `${row.ip}:${row.instance}`)
    if (input.card.role === 'planner') {
      if (unresolved ? report.ready || !report.canCloseUnresolved : !report.ready) throw new Error(`不能收口：${report.summary || report.reason}。检查 task_patrol_status 后决定等待、返工或请求输入；只有 canCloseUnresolved=true 时才能以 unresolved 结束本次巡查，结果为未通过。`)
    }
    return { summary: `${input.card.role === 'planner' ? unresolved ? '本次巡查未通过（不是修复完成）' : '最终验收' : '本轮角色交接（不等于整个任务完成）'}：${report.summary || report.reason}\n${JSON.stringify(report.items)}`, metadata: { ...(unresolved ? { workflowOutcome: 'unresolved' } : {}), browserPatrol: { contract: 'browser-patrol-v2', ...report } } }
  }

  snapshot(input: CompletionCheck) {
    const report = this.status(input), encoded = JSON.stringify(report)
    const last = this.db().prepare("SELECT payload FROM task_events WHERE task_id=? AND kind='patrol_snapshot' ORDER BY id DESC LIMIT 1").get(input.card.id) as any
    if (last?.payload !== encoded) this.store.kernel.recordEvent(input.card.id, 'patrol_snapshot', report)
    return report
  }
}
