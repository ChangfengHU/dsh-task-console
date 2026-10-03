export type ImageBackend = 'codex' | 'gemini'
export interface ImagePolicy {
  defaultBackend: ImageBackend
  allowedBackends: ImageBackend[]
  allowOverride: boolean
  fallback: 'none' | 'unavailable-only'
  maxRequestsPerSession: number
}
export const DEFAULT_IMAGE_POLICY: ImagePolicy = {
  defaultBackend: 'codex', allowedBackends: ['codex'], allowOverride: false,
  fallback: 'none', maxRequestsPerSession: 12,
}
export function imagePolicy(value: unknown): ImagePolicy {
  if (value === undefined) return { ...DEFAULT_IMAGE_POLICY, allowedBackends: ['codex'] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('生图配置必须是对象')
  const p = value as any
  if (Object.keys(p).some(k => !['defaultBackend','allowedBackends','allowOverride','fallback','maxRequestsPerSession'].includes(k))) throw Error('生图配置含未知字段；凭据只能配置在宿主')
  if (!['codex','gemini'].includes(p.defaultBackend)) throw Error('生图默认后端无效')
  if (!Array.isArray(p.allowedBackends) || !p.allowedBackends.length || p.allowedBackends.some((b: unknown) => b !== 'codex' && b !== 'gemini')) throw Error('生图允许后端无效')
  const allowedBackends = [...new Set(p.allowedBackends)] as ImageBackend[]
  if (!allowedBackends.includes(p.defaultBackend)) throw Error('默认生图后端必须在允许列表内')
  if (typeof p.allowOverride !== 'boolean' || !['none','unavailable-only'].includes(p.fallback)) throw Error('生图切换策略无效')
  if (!Number.isSafeInteger(p.maxRequestsPerSession) || p.maxRequestsPerSession < 1 || p.maxRequestsPerSession > 100) throw Error('生图会话预算必须为 1–100')
  return { defaultBackend:p.defaultBackend, allowedBackends, allowOverride:p.allowOverride, fallback:p.fallback, maxRequestsPerSession:p.maxRequestsPerSession }
}
