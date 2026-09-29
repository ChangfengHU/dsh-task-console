/** Wait for configured MCP discovery, never for an absent grant or a changed preset. */
export interface ReadinessAudit { status: string; missingDependencies?: string[]; [key: string]: unknown }
export interface ReadinessSource { serverName: string; live: boolean; tools: string[] }
export interface ReadinessEvent { phase: 'waiting' | 'ready' | 'rejected' | 'timeout'; servers: string[]; attempts: number; elapsedMs: number }

export function pendingMcpSources(audit: ReadinessAudit, sources: ReadinessSource[]): string[] {
  if (audit.status !== 'dependency-missing' || !audit.missingDependencies?.length) return []
  const pending = new Set<string>()
  for (const dependency of audit.missingDependencies) {
    const match = /^mcp:([^:]+):(.+)$/.exec(dependency)
    if (!match) return []
    const source = sources.find(row => row.serverName === match[1])
    // The official client atomically registers a complete generation after tools/list.
    // A nonempty inventory missing a selected tool is a real contract mismatch.
    if (!source?.live || source.tools.length || match[2] === 'disabled' || match[2] === 'missing') return []
    pending.add(source.serverName)
  }
  return [...pending].sort()
}

export async function awaitAgentCapabilities(options: {
  inspect: () => Promise<{ audit: ReadinessAudit; sources: ReadinessSource[] }>;
  isActive?: () => boolean; onEvent?: (event: ReadinessEvent) => void;
  timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
}) {
  const timeout = options.timeoutMs ?? 60_000, interval = options.intervalMs ?? 1_000
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) throw Error('invalid-mcp-readiness-budget')
  const now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const start = now(), maxAttempts = Math.ceil(timeout / interval) + 1
  let waiting = false, servers: string[] = []
  for (let attempts = 1; ; attempts++) {
    if (options.isActive?.() === false) throw Error('agent-capability-wait-cancelled')
    const { audit, sources } = await options.inspect()
    if (options.isActive?.() === false) throw Error('agent-capability-wait-cancelled')
    const elapsedMs = Math.max(0, now() - start), pending = pendingMcpSources(audit, sources)
    const event = (phase: ReadinessEvent['phase']) => options.onEvent?.({ phase, servers, attempts, elapsedMs })
    if (!pending.length) {
      if (waiting) event(audit.status === 'in-sync' ? 'ready' : 'rejected')
      return { audit, timedOut: false, attempts, elapsedMs }
    }
    servers = pending
    if (!waiting) { waiting = true; event('waiting') }
    if (elapsedMs >= timeout || attempts >= maxAttempts) {
      event('timeout')
      return { audit, timedOut: true, attempts, elapsedMs }
    }
    await sleep(Math.min(interval, timeout - elapsedMs))
  }
}
