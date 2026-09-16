import { createHash, randomUUID } from 'node:crypto'
import type { AgentSpec } from './wire.ts'
import type { AgentAction } from './agent-actions.ts'
import type { TaskSpec } from './fold.ts'
import { validateActions } from './agent-actions.ts'
import { validateSpec } from './presets.ts'
import { parseCron, validTimeZone } from './cron.ts'

export const CONFIG_SCHEMA = 'dsh-task-console/config-v1' as const
export const MAX_CONFIG_BYTES = 5 * 1024 * 1024

export interface ConfigAgent { spec: AgentSpec; actions: AgentAction[] }
export interface ConfigTask {
  id: string; title: string; brief: string; trigger: TaskSpec['trigger']; participants: TaskSpec['participants']
  graphMode?: TaskSpec['graphMode']; workflowRecipe?: TaskSpec['workflowRecipe']; design?: TaskSpec['design']
  cwd: string; timeoutSec: number; onFail: TaskSpec['onFail']; maxTries: number; actions: AgentAction[]
}
export interface ConfigPayload { agents: ConfigAgent[]; tasks: ConfigTask[] }
export interface ConfigEnvelope {
  schema: typeof CONFIG_SCHEMA; exportedAt: string; source: { plugin: 'dsh-task-console'; version: string }
  digest: { algorithm: 'sha256'; value: string }; payload: ConfigPayload
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function payloadDigest(payload: ConfigPayload): string {
  return createHash('sha256').update(canonical(payload)).digest('hex')
}

export function taskConfig(task: TaskSpec, actions: AgentAction[]): ConfigTask {
  return {
    id: task.id, title: task.title, brief: task.brief, trigger: task.trigger,
    participants: task.participants, ...(task.graphMode ? { graphMode: task.graphMode } : {}),
    ...(task.workflowRecipe ? { workflowRecipe: task.workflowRecipe } : {}),
    ...(task.design ? { design: task.design } : {}), cwd: task.cwd, timeoutSec: task.timeoutSec,
    onFail: task.onFail, maxTries: task.maxTries, actions: validateActions(actions),
  }
}

export function createEnvelope(payload: ConfigPayload, version: string, now = new Date()): ConfigEnvelope {
  const normalized: ConfigPayload = {
    agents: [...payload.agents].sort((a, b) => a.spec.id.localeCompare(b.spec.id)),
    tasks: [...payload.tasks].sort((a, b) => a.id.localeCompare(b.id)),
  }
  return { schema: CONFIG_SCHEMA, exportedAt: now.toISOString(), source: { plugin: 'dsh-task-console', version }, digest: { algorithm: 'sha256', value: payloadDigest(normalized) }, payload: normalized }
}

function text(value: unknown, name: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${name}无效`)
  return value
}

export function parseEnvelope(raw: unknown): ConfigEnvelope {
  const e = raw as any
  if (!e || e.schema !== CONFIG_SCHEMA || e.source?.plugin !== 'dsh-task-console' || e.digest?.algorithm !== 'sha256') throw Error('不是受支持的 dsh-task-console 配置包')
  if (!e.payload || !Array.isArray(e.payload.agents) || !Array.isArray(e.payload.tasks) || e.payload.agents.length > 500 || e.payload.tasks.length > 1000) throw Error('配置包清单无效或超过数量限制')
  const agentIds = new Set<string>(), taskIds = new Set<string>()
  const agents = e.payload.agents.map((row: any): ConfigAgent => {
    const spec = validateSpec(row?.spec)
    if (agentIds.has(spec.id)) throw Error(`Agent id 重复:${spec.id}`)
    agentIds.add(spec.id)
    return { spec, actions: validateActions(row?.actions ?? []) }
  })
  const tasks = e.payload.tasks.map((row: any): ConfigTask => {
    const id = text(row?.id, 'Task id', 160)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) throw Error(`Task id 无效:${id}`)
    if (taskIds.has(id)) throw Error(`Task id 重复:${id}`)
    taskIds.add(id)
    const trigger = row?.trigger
    if (!trigger || trigger.kind !== 'once' && trigger.kind !== 'cron') throw Error(`Task ${id} 的触发方式无效`)
    if (trigger.kind === 'cron' && (!parseCron(String(trigger.expr ?? '')) || trigger.timeZone !== undefined && !validTimeZone(trigger.timeZone))) throw Error(`Task ${id} 的定时规则无效`)
    if (!Array.isArray(row.participants) || !row.participants.length || row.participants.length > 32) throw Error(`Task ${id} 的参与者无效`)
    if (row.participants.some((p: any) => !p || typeof p.agentId !== 'string' || !p.agentId.trim() || p.agentId.length > 160 || p.brief !== undefined && (typeof p.brief !== 'string' || p.brief.length > 10_000))) throw Error(`Task ${id} 的参与者无效`)
    if (!Number.isFinite(row.timeoutSec) || row.timeoutSec < 60 || row.timeoutSec > 21_600 || !Number.isInteger(row.maxTries) || row.maxTries < 1 || row.maxTries > 5 || !['stop', 'retry'].includes(row.onFail)) throw Error(`Task ${id} 的运行策略无效`)
    return taskConfig({
      id, title: text(row.title, 'Task 标题', 300), brief: text(row.brief, 'Task 任务书', 50_000), trigger,
      participants: row.participants, graphMode: row.graphMode, workflowRecipe: row.workflowRecipe, design: row.design,
      cwd: text(row.cwd, 'Task 工作目录', 4096), timeoutSec: row.timeoutSec, onFail: row.onFail,
      maxTries: row.maxTries, enabled: false, createdAt: new Date(0).toISOString(),
    } as TaskSpec, row.actions ?? [])
  })
  const payload = { agents, tasks }
  if (!/^[a-f0-9]{64}$/.test(e.digest.value) || payloadDigest(payload) !== e.digest.value) throw Error('配置包 SHA256 校验失败')
  if (!Number.isFinite(Date.parse(e.exportedAt))) throw Error('配置包导出时间无效')
  return { schema: CONFIG_SCHEMA, exportedAt: new Date(e.exportedAt).toISOString(), source: { plugin: 'dsh-task-console', version: text(e.source.version, '版本', 80) }, digest: e.digest, payload }
}

export function encodeEnvelope(envelope: ConfigEnvelope): Buffer {
  const data = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  if (data.byteLength > MAX_CONFIG_BYTES) throw Error('配置包超过 5 MiB，需减少 Agent 或 Task 后重试')
  return data
}

export function assertPublicConfigUrl(value: string, publicDomain: string): URL {
  let url: URL, base: URL
  try { url = new URL(value); base = new URL(publicDomain) } catch { throw Error('R2 地址无效') }
  if (url.protocol !== 'https:' || url.origin !== base.origin || !url.pathname.endsWith('.json') || url.username || url.password) throw Error(`只允许导入 ${base.origin} 下的 HTTPS .json 配置包`)
  return url
}

export async function uploadConfig(envelope: ConfigEnvelope, config: { endpoint: string; domain: string; token: string }): Promise<{ publicUrl: string; bytes: number; sha256: string }> {
  if (!config.token) throw Error('宿主未配置配置导出所需的 R2 凭据')
  const data = encodeEnvelope(envelope), name = `dsh-config-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  const form = new FormData()
  form.set('file', new Blob([data], { type: 'application/json' }), name); form.set('domain', config.domain); form.set('name', name); form.set('path', 'dsh-task-console/config-exports')
  const response = await fetch(config.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: form, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw Error(`R2 上传失败（HTTP ${response.status}）`)
  const body = await response.text()
  let publicUrl = ''
  try { const parsed = JSON.parse(body); publicUrl = String(parsed.url ?? parsed.image_url ?? parsed.data?.url ?? parsed.result?.url ?? '') } catch { publicUrl = body.trim() }
  if (!publicUrl.startsWith(`${config.domain.replace(/\/$/, '')}/`)) publicUrl = `${config.domain.replace(/\/$/, '')}/dsh-task-console/config-exports/${name}`
  assertPublicConfigUrl(publicUrl, config.domain)
  const check = await fetch(publicUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  const stored = check.ok ? Buffer.from(await check.arrayBuffer()) : Buffer.alloc(0)
  if (!check.ok || !stored.equals(data)) throw Error('R2 上传后内容校验失败')
  return { publicUrl, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }
}

export async function downloadConfig(value: string, publicDomain: string): Promise<{ envelope: ConfigEnvelope; bytes: number; fileSha256: string }> {
  const url = assertPublicConfigUrl(value, publicDomain)
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw Error(`配置包下载失败（HTTP ${response.status}）`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_CONFIG_BYTES) throw Error('配置包超过 5 MiB')
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength > MAX_CONFIG_BYTES) throw Error('配置包超过 5 MiB')
  let parsed: unknown
  try { parsed = JSON.parse(data.toString('utf8')) } catch { throw Error('配置包不是有效 JSON') }
  return { envelope: parseEnvelope(parsed), bytes: data.byteLength, fileSha256: createHash('sha256').update(data).digest('hex') }
}
