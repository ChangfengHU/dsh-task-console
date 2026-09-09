import { open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CompletionCheck, BlockDecision } from './runner.ts'

const windowMs = 20 * 60_000
const rejection = (reason: string): never => { throw new Error(`工作流登录验收未通过：${reason}。由浏览器管理员完成 browser_login_acceptance 后提交真实 operationId；不要用再次复制代替验收。`) }

type JobDeps = { jobs?: () => Promise<any[]>; now?: () => number }
async function browserJobs(deps: JobDeps) {
  return (deps.jobs || (async () => {
    const root = process.env.FLEET_BROWSER_STATE_DIR || join(homedir(), '.local/state/fleet-browser-manager')
    let names: string[]
    try { names = await readdir(root) } catch (e: any) { if (e.code === 'ENOENT') return []; throw e }
    const rows = []
    for (const name of names) if (/^[a-f0-9]{32}\.json$/.test(name)) rows.push(await readBrowserAcceptance(name.slice(0, 32)))
    return rows
  }))()
}

export async function pendingBrowserOperation(input: CompletionCheck, deps: JobDeps = {}): Promise<string | undefined> {
  if (input.profileId !== 'browser-manager') return
  const now = (deps.now || Date.now)()
  const active = (await browserJobs(deps)).find(j => j.args?.sessionId === input.sessionId && j.phase === 'running' && now - Date.parse(j.updatedAt) < 360000)
  return active ? `操作 ${active.id} 仍为 running，等待真实终态；不要重复复制或提前交卷。` : undefined
}

export async function validateWorkflowBlock(input: CompletionCheck, deps: JobDeps = {}): Promise<BlockDecision | void> {
  if (input.profileId !== 'browser-manager') return
  const jobs = await browserJobs(deps)
  const now = (deps.now || Date.now)()
  const active = jobs.find(j => j.args?.sessionId === input.sessionId && j.phase === 'running' && now - Date.parse(j.updatedAt) < 360000)
  if (active) throw new Error(`操作 ${active.id} 仍为 running，尚未失败。继续调用 browser_status 到 complete/blocked/interrupted；不能因等待一分钟或公开状态 pending 而 task_block。`)
  // The job can finish between the model's last poll and its block call. Use
  // that receipt's actual reason instead of persisting a stale "still running".
  const latest = jobs.filter(j => j.args?.sessionId === input.sessionId && now - Date.parse(j.updatedAt) < 360000)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  if (latest?.phase === 'blocked' && /^[a-f0-9]{32}$/.test(latest.id) && /^[a-z0-9-]{1,100}$/.test(latest.error || '')) {
    if (latest.error === 'interactive-verification-required') return { kind: 'needs_input',
      reason: `Google 要求交互式登录验证，需用户在目标浏览器完成。操作 ${latest.id} 已真实结束为 blocked；不能再次复制或绕过验证。完成验证后在同 Task 新尝试执行稳定性验收。` }
    return { kind: 'capability', reason: `浏览器操作 ${latest.id} 已真实结束为 blocked，回执原因：${latest.error}。原始证据保存在该操作与会话中；不能把它描述成仍在运行或已通过验收。` }
  }
}

export async function readBrowserAcceptance(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) return rejection('验收回执 ID 无效')
  const root = process.env.FLEET_BROWSER_STATE_DIR || join(homedir(), '.local/state/fleet-browser-manager')
  let file
  try {
    file = await open(join(root, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) return rejection('验收回执不可信')
    return JSON.parse(await file.readFile('utf8'))
  } catch { return rejection('验收回执不存在或不可读') }
  finally { await file?.close() }
}

// Business acceptance belongs to this versioned recipe, not the generic Task
// kernel. Legacy and unrelated Tasks keep their existing completion contract.
export async function validateWorkflowCompletion(input: CompletionCheck, deps: {
  receipt?: (id: string) => Promise<any>; fleet?: () => Promise<any>; now?: () => number
} = {}) {
  const { task, batch, profileId, sessionId, metadata } = input
  if (task.workflowRecipe?.id !== 'fleet-base-v2' || task.workflowRecipe.login !== 'provision-gemini' || profileId !== 'browser-manager') return
  const now = (deps.now || Date.now)(), targets = [...new Set(batch.turn?.targets?.filter(t => t.kind === 'fleet-node').map(t => t.id) || [])]
  const ids = Array.isArray(metadata?.browserAcceptanceOperationIds) ? metadata.browserAcceptanceOperationIds : [metadata?.browserAcceptanceOperationId]
  if (!targets.length || ids.length !== targets.length || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) || new Set(ids).size !== ids.length) return rejection('缺少各目标的真实稳定性回执')
  const remaining = new Set(targets), accepted = new Map<string, any[]>()
  for (const id of ids) {
    const job = await (deps.receipt || readBrowserAcceptance)(id)
    const expected = createHash('sha256').update(JSON.stringify([sessionId, job?.args?.requestId])).digest('hex').slice(0, 32)
    const result = job?.result, rows = result?.instances
    if (job?.id !== id || id !== expected || job.action !== 'login-acceptance' || job.phase !== 'complete' || job.args?.sessionId !== sessionId || !remaining.delete(job.args?.ip) || job.args.platform !== 'gemini') return rejection('回执不属于本次会话、目标或操作')
    if (!Array.isArray(job.args.instances) || JSON.stringify([...job.args.instances].sort()) !== '[1,2]' || result?.stable !== true || result.criterion !== 'gemini-background-stability-v1' || result.probeVersion !== 3 || result.requiredMs !== windowMs || !Array.isArray(rows) || rows.length !== 2 || new Set(rows.map(r => r.instance)).size !== 2) return rejection('未覆盖双浏览器稳定性标准')
    const started = Date.parse(result.startedAt), completed = Date.parse(result.completedAt)
    if (!Number.isFinite(started) || !Number.isFinite(completed) || started < Date.parse(batch.firedAt) || completed > now + 5000 || now - completed > 180_000) return rejection('验收时间不属于当前执行或已过期')
    for (const row of rows) {
      const first = Date.parse(row.firstCheckedAt), last = Date.parse(row.checkedAt)
      if (![1, 2].includes(row.instance) || !/^[a-f0-9]{8}$/.test(row.fingerprint || '') || !Number.isFinite(first) || !Number.isFinite(last) || first < started || last > completed || last - first < windowMs || row.observedMs !== last - first || !Number.isInteger(row.samples) || row.samples < 8 || !(Date.parse(row.expiresAt) > now)) return rejection('样本数、持续窗口或最新验证不足')
    }
    accepted.set(job.args.ip, rows)
  }
  const fleet = await (deps.fleet || (async () => {
    const response = await fetch('https://fleet.vyibc.com/api/fleet', { signal: AbortSignal.timeout(30000) })
    if (!response.ok) return rejection('Fleet 当前结果读取失败')
    return response.json()
  }))()
  for (const [ip, rows] of accepted) {
    const node = fleet.nodes?.find((n: any) => n.id === 'host-' + ip.replaceAll('.', '-'))
    for (const row of rows) {
      const b = node?.browsers?.find((b: any) => b.browserNo === row.instance), check = b?.loginVerification
      if (b?.identities?.gemini !== 'in' || b.accounts?.gemini?.fingerprint !== row.fingerprint || b.accounts?.gemini?.source !== 'gemini-account-control' || check?.probeVersion !== 3 || check.status !== 'verified' || !(Date.parse(check.expiresAt) > now) || !(Date.parse(check.checkedAt) >= Date.parse(row.checkedAt))) return rejection('Fleet 当前登录与验收回执不一致')
    }
  }
}
