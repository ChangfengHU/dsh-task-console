import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CompletionCheck } from './runner.ts'

const windowMs = 20 * 60_000
const rejection = (reason: string): never => { throw new Error(`工作流登录验收未通过：${reason}。由浏览器管理员完成 browser_login_acceptance 后提交真实 operationId；不要用再次复制代替验收。`) }

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
