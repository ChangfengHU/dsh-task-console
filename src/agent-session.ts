import type { AgentSpec } from './wire.ts'

/** Pin an authored Agent's DSH execution boundary before its first turn starts. */
export function applyAgentPermission(ctx: any, spec: AgentSpec | null, session: any): void {
  if (!spec) return
  const permissions = ctx.get?.('permissionPresets') ?? ctx.permissionPresets
  if (!permissions?.set) throw new Error('这个部署没有会话权限服务，无法安全启动 Agent')
  permissions.set(session, spec.permissionPreset)
}
