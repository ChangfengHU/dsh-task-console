import type { CompletionCheck } from './runner.ts'
import type { EventStore } from './tasks.ts'
import { collectBrowserEvidence } from './browser-patrol-evidence.ts'
import { patrolReportSummary } from './patrol-report.ts'
import { ProxyWorkflow } from './proxy-workflow.ts'

export interface PatrolRoundItem { ip: string; instance: number; action: 'verify' | 'provision' | 'resume' | 'recover'; reason: string }

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
      if (row.reason === 'cdp-unavailable' && row.gemini === 'unknown' && !db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='patrol_service_unavailable' AND json_extract(payload,'$.operationId')=?").get(input.card.id,row.operationId))
        this.store.kernel.recordEvent(input.card.id,'patrol_service_unavailable',{key,operationId:row.operationId,checkedAt:row.checkedAt,expiresAt:row.expiresAt,reason:row.reason})
    }
    for (const failure of proof.verificationFailures) {
      if (Date.parse(failure.at) < Date.parse(input.batch.firedAt)) continue
      if (!db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='patrol_verification_unavailable' AND json_extract(payload,'$.operationId')=?").get(input.card.id, failure.operationId))
        this.store.kernel.recordEvent(input.card.id, 'patrol_verification_unavailable', failure)
    }
  }

  plan(input: CompletionCheck, candidate: unknown) {
    if (input.task.design?.evidenceContract !== 'browser-patrol-v2') return
    const db = this.db()
    if (input.task.graphMode !== 'dynamic-rounds' || input.card.role !== 'planner') throw new Error('巡查v2必须使用动态规划/执行/评估')
    const inventory = this.inventory(input.batch.id)
    if (!inventory) throw new Error('先用真实 browser_fleet_inventory 建立本次目标清单')
    if (this.status(input).ready) throw new Error('本次已完成独立验收，不能因 inventory 缓存未知或回执过期再冻结返工。调用 task_notify(restored) 与 task_finalize 收口；新的真实异常须先取得原生证据，下一次巡查使用同 Task 的新执行记录。')
    if (!Array.isArray(candidate) || !candidate.length || candidate.length > 128) throw new Error('巡查每轮需要 items:[{ip,instance,action:verify|provision|resume|recover,reason}]，不能只提交自然语言')
    const keys = new Set<string>(), items: PatrolRoundItem[] = []
    for (const row of candidate) {
      const key = `${row?.ip}:${row?.instance}`, node = inventory.nodes.find((n: any) => n.ip === row?.ip)
      const browser = node?.browsers.find((b: any) => b.instance === row?.instance)
      if (keys.has(key) || !browser || !node.readAuthorized || input.task.design.browserPatrol?.excludedNodeIds?.includes(node.nodeId) || !['verify', 'provision', 'resume', 'recover'].includes(row.action) || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 1000) throw new Error('轮次目标/动作不在本次真实可读清单，或缺少决策理由')
      if (row.action !== 'verify' && (!browser.loginAuthorized || !input.task.design.browserPatrol!.actions.includes(row.action))) throw new Error('本计划没有该目标的登录修复授权')
      if (row.action !== 'verify') {
        const latest = db.prepare('SELECT state,checked_at,expires_at FROM dsh_patrol_observations WHERE batch_id=? AND target_key=? ORDER BY checked_at DESC LIMIT 1').get(input.batch.id, key) as any
        const unavailable = db.prepare("SELECT json_extract(payload,'$.at') at FROM task_events WHERE graph_id=? AND kind='patrol_verification_unavailable' AND json_extract(payload,'$.key')=? ORDER BY at DESC LIMIT 1").get(input.batch.id,key) as any
        if (row.action === 'recover') {
          const service = db.prepare("SELECT payload FROM task_events WHERE graph_id=? AND kind='patrol_service_unavailable' AND json_extract(payload,'$.key')=? ORDER BY id DESC LIMIT 1").get(input.batch.id,key) as any
          const evidence = service && JSON.parse(service.payload)
          if (latest?.state !== 'unknown' || evidence?.checkedAt !== latest.checked_at || !(Date.parse(evidence.expiresAt) > Date.now())) throw Error('恢复需当前真实 CDP 连接失败证据；普通未知或健康实例不能重启')
        }
        if (row.action === 'provision' && (latest?.state !== 'signed_out' || Date.parse(latest.checked_at) > Date.now() || !(Date.parse(latest.expires_at) > Date.now()) || unavailable && Date.parse(unavailable.at) >= Date.parse(latest.checked_at))) throw new Error('复制前需要本次新鲜真实未登录证据；未知、过期或后续验证失败先复验')
        if (row.action === 'resume' && (latest?.state === 'verified' || !db.prepare('SELECT 1 FROM dsh_browser_operations o JOIN dsh_browser_issues i ON i.id=o.issue_id WHERE i.spec_id=? AND i.target_key=? AND i.status=\'open\'').get(input.task.id,key))) throw new Error('正常续接仅用于已有授权复制尚未通过的目标，不改动健康登录')
      }
      keys.add(key); items.push({ ip: row.ip, instance: row.instance, action: row.action, reason: row.reason.trim() })
    }
    if (input.card.round! > 1 && items.every(row => row.action === 'verify') && input.task.design.browserPatrol!.actions.includes('provision')) {
      const repairable = this.status(input).items.filter(row => !row.accepted && row.readAuthorized && inventory.nodes.some((n: any) => n.ip === row.ip && n.reachable) && row.state === 'signed_out' && row.loginAuthorized && row.attempts < input.task.design!.failurePolicy.maxAttempts)
      if (repairable.length) throw new Error('仍有已知未登录且有剩余修复预算的目标，不能把仅刷新回执冻结为整轮返工。规划者先 browser_login_verify + browser_status 刷新这些目标，再根据新鲜证据安排授权修复；来源或权限受阻须明确报告，不得盲目复制或绕过授权。')
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
    const failures = (db.prepare("SELECT payload FROM task_events WHERE graph_id=? AND kind='patrol_verification_unavailable'").all(input.batch.id) as any[])
      .map(r => JSON.parse(r.payload)).filter(r => Date.parse(r.at) >= Date.parse(input.batch.firedAt) && Date.parse(r.at) <= now)
    const excluded = inventory.nodes.filter((n: any) => input.task.design?.browserPatrol?.excludedNodeIds?.includes(n.nodeId)).map((n: any) => ({ nodeId:n.nodeId, ip:n.ip, reachable:n.reachable, reason:'reviewed-scope-exclusion' }))
    const nodes = inventory.nodes.filter((n: any) => !excluded.some((e: any) => e.nodeId === n.nodeId))
    for (const node of nodes) for (const browser of node.browsers) {
      const key = `${node.ip}:${browser.instance}`
      const history = (db.prepare('SELECT * FROM dsh_patrol_observations WHERE batch_id=? AND target_key=? ORDER BY checked_at,card_id').all(input.batch.id, key) as any[])
        .filter(s => Date.parse(s.checked_at) >= Date.parse(input.batch.firedAt) && Date.parse(s.checked_at) <= now)
      const proof = history.at(-1)
      const samples = history.filter(s => s.role === 'reviewer')
      const issue = db.prepare("SELECT * FROM dsh_browser_issues WHERE spec_id=? AND target_key=? AND (status='open' OR resolved_at>=?) ORDER BY (status='open') DESC,id DESC LIMIT 1").get(input.task.id, key, input.batch.firedAt) as any
      const changedThisBatch = (db.prepare('SELECT COUNT(*) n FROM dsh_browser_operations o JOIN dsh_browser_issues i ON i.id=o.issue_id WHERE o.batch_id=? AND i.target_key=?').get(input.batch.id,key) as any).n
      const needsStability = !!issue || changedThisBatch > 0
      // Closing an issue must not discard this Batch's repair/observation requirement.
      const lastChange = db.prepare('SELECT o.created_at FROM dsh_browser_operations o JOIN dsh_browser_issues i ON i.id=o.issue_id WHERE i.spec_id=? AND i.target_key=? AND (o.batch_id=? OR i.id=?) ORDER BY o.created_at DESC LIMIT 1').get(input.task.id,key,input.batch.id,issue?.id ?? -1) as any
      // Any later negative/unknown result or identity change invalidates older review,
      // including executor receipts; a later executor success alone cannot restore it.
      const adverse = history.findLast(s => s.state !== 'verified' || s.fingerprint !== proof?.fingerprint)
      const failure = failures.filter(r => r.key === key).sort((a,b) => a.at.localeCompare(b.at)).at(-1)
      const relevant = [...new Map(samples.filter(s => s.state === 'verified' && s.fingerprint && Date.parse(s.expires_at) > Date.parse(s.checked_at) &&
        (!lastChange || Date.parse(s.checked_at) > Date.parse(lastChange.created_at)) &&
        (!failure || Date.parse(s.checked_at) > Date.parse(failure.at)) &&
        (!adverse || Date.parse(s.checked_at) > Date.parse(adverse.checked_at))).map(s => [s.checked_at, s])).values()]
      const last = relevant.at(-1), first = relevant[0]
      const cfg = input.task.design!.browserPatrol!
      const stable = !needsStability || (relevant.length >= cfg.minSamples && Date.parse(last?.checked_at) - Date.parse(first?.checked_at) >= cfg.observationMinutes * 60_000)
      // Acceptance is this Batch's point-in-time evidence, not a promise that every
      // short-lived receipt stays fresh while downstream agents finish their work.
      const accepted = node.readAuthorized === true && node.reachable === true && !!last && stable
      const reference = last ?? proof
      const freshness = !reference || !Number.isFinite(Date.parse(reference.expires_at)) ? 'unknown' : Date.parse(reference.expires_at) > now && now - Date.parse(reference.checked_at) <= 15 * 60_000 ? 'fresh' : 'expired'
      // A due sample stays due after a delayed wake/status poll; moving it relative
      // to "now" would make every resumed reviewer postpone forever.
      const nextCheckAt = needsStability && first && !stable ? new Date(Date.parse(first.checked_at) + cfg.observationMinutes * 60_000 * Math.min(relevant.length, cfg.minSamples - 1) / (cfg.minSamples - 1)).toISOString() : null
      items.push({ ip: node.ip, instance: browser.instance, state: proof?.state ?? 'unknown', fingerprint: proof?.fingerprint ?? null,
        checkedAt: proof?.checked_at ?? null, operationId: proof?.operation_id ?? null, accepted: !!accepted,
        freshness, independentCheckedAt: last?.checked_at ?? null, independentExpiresAt: last?.expires_at ?? null,
        independentOperationId: last?.operation_id ?? null, evidenceSeq: last?.evidence_seq ?? proof?.evidence_seq ?? null,
        expiresAt: reference?.expires_at ?? null, lastChangeAt: lastChange?.created_at ?? null,
        verificationFailure: failure && !last ? failure : null,
        readAuthorized: node.readAuthorized, loginAuthorized: browser.loginAuthorized, attempts: issue?.attempts ?? changedThisBatch,
        independentlyObserved: samples.length,
        observation: needsStability ? { samples: relevant.length, requiredSamples: cfg.minSamples, minutes: cfg.observationMinutes, passed: stable, nextCheckAt, checkDue: !stable && (!nextCheckAt || Date.parse(nextCheckAt) <= now) } : null,
        reason: !node.readAuthorized ? 'read-not-authorized' : !node.reachable ? 'unreachable' : failure && (!proof || Date.parse(failure.at) >= Date.parse(proof.checked_at)) ? 'verification-operation-incomplete' : proof?.state === 'signed_out' ? 'signed-out' : proof && proof.state !== 'verified' ? 'verification-unknown' : !last ? samples.length ? 'independent-recheck-required' : 'missing-independent-verification' : !stable ? 'observation-window-pending-or-failed' : 'independent-verification-passed' })
    }
    const uncovered = nodes.filter((n: any) => n.reachable !== true && !n.browsers.length).map((n: any) => ({ nodeId: n.nodeId, reason: 'unreachable-no-browser-observation' }))
    const plan = db.prepare('SELECT target_key,action,reason FROM dsh_patrol_round_items WHERE batch_id=? AND round=?').all(input.batch.id, input.card.round ?? 0)
    const pendingStability = items.filter(i => !i.accepted && i.readAuthorized && inventory.nodes.find((n: any) => n.ip === i.ip)?.reachable && i.state === 'verified' && !i.verificationFailure && i.observation && !i.observation.passed)
    const canHandoffForRework = (input.card.round ?? 0) < input.task.design!.failurePolicy.maxAttempts && items.some(i => !i.accepted && i.readAuthorized && inventory.nodes.some((n: any) => n.ip === i.ip && n.reachable) && i.loginAuthorized && i.attempts < input.task.design!.failurePolicy.maxAttempts && (i.checkedAt && i.state !== 'verified' || i.verificationFailure))
    const canCloseUnresolved = items.every(i => i.accepted || !i.readAuthorized || !inventory.nodes.find((n: any) => n.ip === i.ip)?.reachable || i.independentlyObserved > 0 && (
      (input.card.round ?? 0) > input.task.design!.failurePolicy.maxAttempts || i.attempts >= input.task.design!.failurePolicy.maxAttempts || i.state === 'unknown' && i.independentlyObserved >= 2
    )) && pendingStability.length === 0 && (items.length > 0 || uncovered.length > 0)
    const proxy=input.task.design?.proxy?new ProxyWorkflow(this.store).status(input):undefined
    const networkReady=!proxy||proxy.items.length>0&&proxy.items.every(row=>row.independent)
    const report=patrolReportSummary(items,uncovered)
    return { assessmentMode: 'point-in-time-v1', assessedAt: new Date(now).toISOString(),
      ready: items.length > 0 && items.every(i => i.accepted) && uncovered.length === 0&&networkReady, canCloseUnresolved, plan,
      pendingStability: pendingStability.map(i => `${i.ip}:${i.instance}`), canHandoffForRework,
      items, uncovered, excluded, ...report,...(proxy?{proxy,summary:report.summary+` 代理独立验收 ${proxy.items.filter(row=>row.independent).length}/${proxy.items.length}。`}:{}) }
  }

  complete(input: CompletionCheck) {
    const report = this.snapshot(input)
    const unresolved = input.metadata?.patrolDisposition === 'unresolved'
    if (input.card.role === 'reviewer' && report.pendingStability?.length && !report.canHandoffForRework)
      throw new Error(`不能提前交接：${report.pendingStability.join(', ')} 仍缺完整稳定性采样，且没有可提前交接的下一轮修复。继续独立复验，按 observation.nextCheckAt 使用 task_wait；最后一轮及修复次数耗尽不能免除已登录目标的观察窗口。真实掉线或挑战应如实记录，不空等成功。`)
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
    const facts = (value: any) => { const { assessedAt, ...rest } = value; return JSON.stringify(rest) }
    if (!last || facts(JSON.parse(last.payload)) !== facts(JSON.parse(encoded))) this.store.kernel.recordEvent(input.card.id, 'patrol_snapshot', report)
    return report
  }
}
