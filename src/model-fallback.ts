/** Only a failed model startup before ANY tool dispatch can be retried automatically. */
export function startupFallbackAllowed(reason: any, state: { used?: boolean; toolCalled?: boolean; terminal?: unknown; provider?: string }, fromProvider: string): boolean {
  return !state.used && !state.toolCalled && !state.terminal && state.provider === fromProvider
    && reason?.kind === 'error' && ['TRANSPORT', 'AUTH', 'RATE_LIMIT', 'PROTOCOL_VERSION'].includes(reason.error?.code)
}
export function fallbackSelection(value: string): { provider: string; model: string } | undefined {
  if (!value) return undefined
  const match = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._/-]+)$/.exec(value)
  if (!match) throw Error('Task fallback model must be provider/model')
  return { provider: match[1], model: match[2] }
}

/** Same native assembly/request seam as model selection, scoped to this worker only. */
export function installFallbackSelection(ctx: any, selection: { provider: string; model: string }): () => void {
  const a = ctx.on('system-prompt/assemble', async (_a: any, _b: any, next: any) => {
    const result = await next()
    return { ...result, variables: { ...result.variables, ...selection } }
  }, { prepend: true })
  const b = ctx.on('agent/request', async (_payload: any, next: any) => {
    const { reasoningEffort: _effort, maxTokens: _max, ...config } = await next()
    return { ...config, ...selection }
  }, { prepend: true })
  return () => { a(); b() }
}
