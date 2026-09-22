/** Read-only model transport evidence; never retries or diagnoses elapsed silence. */
export interface ModelConnection {
  status: 'unknown' | 'active' | 'reconnecting' | 'failed' | 'resumed' | 'ended'
  changedAt?: string
  lastEventAt?: string
  lastProgressAt?: string
  retry?: { attempt: number; limit: number }
  reason?: 'stream_disconnected' | 'provider_error' | 'turn_failed'
}

export function observeModelConnection(previous: ModelConnection, event: any): ModelConnection {
  const time = new Date(event.time)
  if (!Number.isFinite(time.getTime())) return previous
  const at = time.toISOString()
  const state = { ...previous, lastEventAt: at }
  const data = event.data ?? {}
  const chunk = data.chunk
  const block = chunk?.type === 'block-end' ? chunk.block : undefined
  if (block?.type === 'codex-action' && (block.actionType === 'error' || block.protocolEvent === 'error')) {
    const snapshot = block.snapshot ?? {}
    const disconnected = snapshot.error?.codexErrorInfo?.responseStreamDisconnected !== undefined
    // Only exact numeric retry metadata is extracted; error strings can contain credentials.
    const match = /^Reconnecting\.\.\. (\d+)\/(\d+)$/.exec(snapshot.error?.message ?? '')
    const attempt = match ? Number(match[1]) : 0
    const limit = match ? Number(match[2]) : 0
    return { ...state, status: snapshot.willRetry === true ? 'reconnecting' : snapshot.willRetry === false ? 'failed' : 'unknown', changedAt: at,
      reason: disconnected ? 'stream_disconnected' : 'provider_error',
      retry: Number.isSafeInteger(attempt) && Number.isSafeInteger(limit) && attempt > 0 && attempt <= limit ? { attempt, limit } : undefined }
  }
  if (event.type === 'turn/end') {
    const failed = ['failed', 'error', 'timed_out'].includes(data.reason?.kind)
    return { ...state, status: failed || previous.status === 'failed' ? 'failed' : 'ended', changedAt: at,
      reason: failed ? 'turn_failed' : previous.reason }
  }
  const content = data.message?.content
  const progress = event.type === 'tool/call'
    || (event.type === 'assistant/message' && Array.isArray(content) && content.some((c: any) => ['text', 'reasoning'].includes(c.type) && typeof c.text === 'string' && c.text.trim()))
    || (event.type === 'assistant/chunk' && (['text-delta', 'reasoning-delta'].includes(chunk?.type) && typeof chunk.text === 'string' && chunk.text.trim()
      || block?.type === 'codex-action' && block.category === 'action' && block.actionType !== 'context/injected'))
  if (progress) {
    // Terminal errors stay terminal within this turn; a new turn creates fresh evidence.
    const status = previous.status === 'failed' ? 'failed' : ['reconnecting', 'resumed'].includes(previous.status) ? 'resumed' : 'active'
    return { ...state, status, changedAt: status === previous.status ? previous.changedAt : at, lastProgressAt: at }
  }
  return state
}
