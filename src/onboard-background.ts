/** Same-process bridge; durable truth stays in the ledger, never in model text. */
type Observation = { phase: string; run_id?: unknown; async_operation?: unknown }
type Entry = { runId: string; read: () => Promise<Observation>; expires: number; ready?: boolean }
const key = Symbol.for('dsh.task-console.onboard-background.v1')
const host = globalThis as typeof globalThis & { [key]?: Map<string, Entry> }
const entries = host[key] ??= new Map<string, Entry>()

export function observeOnboardBackground(sessionId: string, runId: string, read: Entry['read']): () => void {
  const now = Date.now()
  for (const [id, value] of entries) if (value.expires < now) entries.delete(id)
  const entry = { runId, read, expires: now + 15 * 60_000 }
  entries.set(sessionId, entry)
  return () => { if (entries.get(sessionId) === entry) entries.delete(sessionId) }
}

export async function pendingOnboardOperation(input: { sessionId: string; profileId?: string }): Promise<string | undefined> {
  if (input.profileId !== 'fleet-installer') return
  const entry = entries.get(input.sessionId)
  if (!entry) return
  if (entry.expires < Date.now()) { entries.delete(input.sessionId); throw Error('装机后台等待已超时，必须核对原事务') }
  if (entry.ready) return
  const result = await entry.read()
  if (result.run_id !== entry.runId) throw Error('装机事务已变更，不能将其他事务作为本次结果')
  const operation = result.async_operation as { status?: string } | undefined
  if (result.phase === 'running' && !['running', 'queued', 'succeeded', 'noop', 'blocked', 'failed'].includes(operation?.status || ''))
    throw Error('无法核验装机后台操作状态')
  if (result.phase === 'running' && ['running', 'queued'].includes(operation?.status || ''))
    return '装机后台操作仍在执行；宿主等待原操作终态，不重复提交，不提前阻塞或交卷。'
  // Preserve the terminal edge even if it arrived before the model turn ended.
  // Only the runner consumes it; completion/block guards must not lose it.
  entry.ready = true
}

export const onboardOperationOutcome = '装机后台等待结束。调用 fleet_onboard_status 核对原事务，再调用 fleet_onboard_resume 收录真实回执并继续后续阶段；后台结束不代表安装或完整节点验收通过。'

export function takeOnboardContinuation(input: { sessionId: string; profileId?: string }): string | undefined {
  if (input.profileId !== 'fleet-installer') return
  const entry = entries.get(input.sessionId)
  if (!entry?.ready) return
  entries.delete(input.sessionId)
  return onboardOperationOutcome
}
