// The native host requires an opaque parent token, not the mutable execution object.
// Scope the send grant to this one host-owned call; model arguments cannot mint it.
const activeNotifications = Symbol.for('dsh-task-console.active-notifications')

export function isTaskNotification(exec: any): boolean {
  return typeof exec?.parent === 'symbol' && exec.agent?.[activeNotifications]?.has(exec.parent) === true
}

export async function dispatchNotification(runtime: any, agent: any, toolName: string, args: unknown, exec: any) {
  if (exec?.name !== 'task_notify' || typeof exec.token !== 'symbol') throw new Error('notification-parent-required')
  const active: Set<symbol> = agent[activeNotifications] ??= new Set()
  active.add(exec.token)
  try {
    const result = await runtime.execute({ name: toolName, arguments: args, agent,
      callId: `${exec.callId}:wecom`, rootCallId: exec.rootCallId ?? exec.callId,
      signal: exec.signal, parent: exec.token })
    for (const context of result.additionalContexts ?? []) exec.deferContext(context)
    if (result.isError) throw new Error('notification-mcp-result-error')
    // The official MCP bridge's canonical value carries the full response. Rendered
    // content may be spilled/truncated and is not an authoritative delivery receipt.
    const value = result.value
    if (value?.structuredContent) return value.structuredContent
    return JSON.parse((value?.content ?? result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''))
  } finally {
    active.delete(exec.token)
    if (!active.size) delete agent[activeNotifications]
  }
}
