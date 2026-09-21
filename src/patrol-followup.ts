/** Read-only, allowlisted projection for Fleet. SQLite/Task history stays authoritative. */
import { patrolItemView } from './patrol-report.ts'

const parse = (value: string | null) => { try { return JSON.parse(value || 'null') } catch { return null } }
const iso = (seconds: number | null) => seconds ? new Date(seconds * 1000).toISOString() : null
const idOK = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(id)

export function patrolFollowup(db: any, now = Date.now()) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name))
  const required = ['dsh_task_specs','dsh_batches','dsh_patrol_inventory','dsh_patrol_observations','dsh_browser_issues','dsh_browser_operations','dsh_browser_operation_outcomes','dsh_task_notifications']
  if (required.some(name => !tables.has(name))) return { schemaVersion:1, capturedAt:new Date(now).toISOString(), tasks:[], items:[] }
  const tasks: any[] = [], items: any[] = []
  for (const saved of db.prepare('SELECT id,spec_json,enabled FROM dsh_task_specs').all()) {
    const spec = parse(saved.spec_json)
    if (!idOK(saved.id) || spec?.archivedAt || spec?.design?.evidenceContract !== 'browser-patrol-v2') continue
    const batch = db.prepare('SELECT id,fired_at,settled_at,outcome,turn_json FROM dsh_batches WHERE spec_id=? AND archived_at IS NULL ORDER BY fired_at DESC LIMIT 1').get(saved.id)
    if (!batch || !idOK(batch.id)) continue
    const definition = parse(batch.turn_json)?.workflow?.definition ?? spec
    const limit = definition.design?.failurePolicy?.maxAttempts
    const inventory = db.prepare('SELECT i.inventory_json FROM dsh_patrol_inventory i JOIN dsh_batches b ON b.id=i.batch_id WHERE b.spec_id=? ORDER BY b.fired_at DESC LIMIT 1').get(saved.id)
    const cards = db.prepare('SELECT t.status,t.role FROM tasks t JOIN dsh_card_bindings c ON c.card_id=t.id WHERE c.batch_id=?').all(batch.id)
    const blocked = cards.filter((c: any) => c.status === 'blocked')
    const state = batch.settled_at ? batch.outcome === 'done' ? 'completed' : 'unresolved' : blocked.length ? 'blocked' : 'running'
    const notice = db.prepare('SELECT id,batch_id,stage,state,updated_at FROM dsh_task_notifications WHERE task_id=? ORDER BY updated_at DESC LIMIT 1').get(saved.id)
    const notification = notice ? { id:notice.id, batchId:notice.batch_id, stage:notice.stage, state:notice.state, at:new Date(notice.updated_at).toISOString() } : null
    tasks.push({taskId:saved.id,batchId:batch.id,enabled:!!saved.enabled,state,startedAt:iso(batch.fired_at),endedAt:iso(batch.settled_at),notification,
      blockedRoles:blocked.map((c: any) => ['executor','reviewer','planner','proxy','notifier'].includes(c.role) ? c.role : 'unknown')})
    for (const node of parse(inventory?.inventory_json)?.nodes ?? []) for (const browser of node.browsers ?? []) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(node.ip) || node.ip.split('.').some((v: string) => +v > 255) || !Number.isInteger(browser.instance) || browser.instance < 1 || browser.instance > 128) continue
      const key = `${node.ip}:${browser.instance}`
      const proof = db.prepare('SELECT o.batch_id,o.checked_at,o.state,o.role FROM dsh_patrol_observations o JOIN dsh_batches b ON b.id=o.batch_id WHERE b.spec_id=? AND o.target_key=? ORDER BY o.checked_at DESC LIMIT 1').get(saved.id,key)
      const issue = db.prepare('SELECT id,status,attempts FROM dsh_browser_issues WHERE spec_id=? AND target_key=? ORDER BY id DESC LIMIT 1').get(saved.id,key)
      const refund = issue ? db.prepare("SELECT COUNT(*) n FROM dsh_browser_operations o JOIN dsh_browser_operation_outcomes r ON r.operation_id=o.operation_id WHERE o.issue_id=? AND r.mutation='not_started'").get(issue.id).n : 0
      const resumeAttempts=issue?db.prepare("SELECT COUNT(*) n FROM dsh_browser_operations o LEFT JOIN dsh_browser_operation_outcomes r ON r.operation_id=o.operation_id WHERE o.issue_id=? AND o.action='login-resume' AND COALESCE(r.mutation,'unknown')!='not_started'").get(issue.id).n:0
      const resumeLimit=definition.design?.browserPatrol?.resumeAfterCopyLimit??0
      const attempts = issue ? Math.max(0,issue.attempts-refund-(resumeLimit?resumeAttempts:0)) : 0
      const delivery = issue ? db.prepare('SELECT o.action,o.created_at,r.mutation,r.reason FROM dsh_browser_operations o LEFT JOIN dsh_browser_operation_outcomes r ON r.operation_id=o.operation_id WHERE o.issue_id=? ORDER BY o.created_at DESC LIMIT 1').get(issue.id) : null
      const signedOut = proof?.state === 'signed_out'
      const exhausted = issue?.status === 'open' && Number.isInteger(limit) && attempts >= limit
      const snapshot = proof && db.prepare("SELECT payload FROM task_events WHERE graph_id=? AND kind='patrol_snapshot' ORDER BY id DESC LIMIT 1").get(proof.batch_id)
      const recorded = parse(snapshot?.payload)?.items?.find((r: any) => r.ip === node.ip && r.instance === browser.instance && r.checkedAt === proof.checked_at)
      const row = { state:proof?.state ?? 'unknown',accepted:recorded?.accepted === true && issue?.status !== 'open',
        reason:recorded?.reason ?? (signedOut?'signed-out':proof?.state === 'verified'?'observation-window-pending-or-failed':proof?'verification-unknown':'missing-independent-verification'),
        attempts,repairLimit:limit,repairExhausted:exhausted,loginDelivery:delivery,canResume:recorded?.canResume===true&&resumeLimit===1&&resumeAttempts<1 }
      const view = patrolItemView(row)
      if (row.accepted) { view.verdict='最近独立检查通过'; view.reason='最近记录已有独立验收证据，不代表当前仍然有效' }
      items.push({ip:node.ip,instance:browser.instance,taskId:saved.id,batchId:batch.id,taskState:state,
        checkedAt:proof?.checked_at ?? null,observationBatchId:proof?.batch_id ?? null,observedState:row.state,
        treatment:row.accepted?'checked':signedOut&&attempts?'unresolved':signedOut?'pending':proof?.state==='verified'?'awaiting_verification':'unknown',
        attempts,repairLimit:limit,repairExhausted:exhausted,resumeAttempts,resumeLimit,
        lastAction:delivery ? {action:delivery.action,at:delivery.created_at,mutation:delivery.mutation ?? 'unknown'} : null,
        verdict:view.verdict,reason:view.reason,next:view.next,notification})
    }
  }
  return {schemaVersion:1,capturedAt:new Date(now).toISOString(),tasks,items}
}
