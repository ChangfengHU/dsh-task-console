export interface ActionRequest {
  agentId: string
  name: string
  actionId?: string
  /** Present only for an Action chosen from the current role. */
  targetSessionId?: string
  originSessionId: string
  span?: { start: number; end: number; draftRev: number }
  cwd?: string
}
export const ACTION_OPEN = 'dtc:action-open'
export const ACTION_CHANGED = 'dtc:actions-changed'

/** Native prompt path preserves transcript, tools and role; no separate Task execution. */
export async function sendCurrentAction(ctx: any, sessionId: string, text: string): Promise<void> {
  if (ctx.sessions.list.getSnapshot().current !== sessionId) throw new Error('已切换会话，请回到原会话后再发送')
  const scope = ctx.sessions.scope(sessionId)
  const face = ctx.sessions.sessionOf(scope)
  if (!face || face.sessionId !== sessionId) throw new Error('原会话尚未就绪，请稍后再试')
  const result = await face.prompt([{ type: 'text', text }], 'queue')
  if (!result?.ok) throw new Error(result?.error?.message ?? '会话未接受消息；请先检查会话记录')
}
