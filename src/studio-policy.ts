import { validateStudioPolicy as validateEvidencePolicy } from './studio-evidence.mjs'

/** Task-frozen reference contract, no platform publication. */
export interface StudioPolicy {
  characterId: string
  width: number
  height: number
  fps: number
  durationMin: number
  durationMax: number
  maxRepairRounds: number
  referenceSha256: string
  referenceUrl: string
  requiredDimensions: string[]
  publish: false
}
export function validateStudioPolicy(value: unknown): StudioPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('studio 必须是明确的视频策略对象')
  const v = value as Record<string, unknown>
  const allowed = ['characterId','width','height','fps','durationMin','durationMax','maxRepairRounds','referenceSha256','referenceUrl','requiredDimensions','publish']
  if (Object.keys(v).some(key => !allowed.includes(key))) throw Error('studio 包含未知字段')
  if (v.publish !== undefined && v.publish !== false) throw Error('studio-video-v1 不授权发布；publish 只能为 false')
  let referenceUrl: URL
  try { referenceUrl = new URL(String(v.referenceUrl)) } catch { throw Error('studio referenceUrl 必须是有效 HTTPS URL') }
  if (referenceUrl.protocol !== 'https:' || referenceUrl.hostname !== 'cdn.vyibc.com' || referenceUrl.username || referenceUrl.password || referenceUrl.search || referenceUrl.hash || referenceUrl.port)
    throw Error('studio referenceUrl 仅允许 cdn.vyibc.com HTTPS 地址，无凭据、查询参数或片段')
  const result = validateEvidencePolicy({...v, referenceUrl:referenceUrl.href, publish:false})
  if (!result.ok) throw Error(`studio 策略无效: ${result.issues.join('; ')}`)
  if (result.policy.width !== 1080 || result.policy.height !== 1920 || result.policy.fps !== 30) throw Error('studio-video-v1 固定为 1080×1920、30fps')
  return result.policy as StudioPolicy
}
