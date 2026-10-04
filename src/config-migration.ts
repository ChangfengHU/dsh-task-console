import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import type { AgentSpec } from './wire.ts'
import type { AgentAction } from './agent-actions.ts'
import type { TaskSpec } from './fold.ts'
import { validateActions } from './agent-actions.ts'
import { validateSpec } from './presets.ts'
import { parseCron, validTimeZone } from './cron.ts'
import { canonicalBase64, parseAssets, type ConfigAssets } from './config-assets.ts'
import { validateTaskActions } from './task-actions.ts'
import { taskAgentIds, validateDesign } from './task-design.ts'

export const CONFIG_SCHEMA = 'dsh-task-console/config-v1' as const
export const MAX_CONFIG_BYTES = 96 * 1024 * 1024
export const MAX_R2_BYTES = Math.ceil(MAX_CONFIG_BYTES * 4 / 3) + 2048
const SEALED_SCHEMA = 'dsh-task-console/encrypted-config-v1'

/** The fragment key never reaches R2. The complete URL is a private bearer capability. */
export function sealConfig(envelope: ConfigEnvelope): { data: Buffer; fragment: string } {
  const key = randomBytes(32), nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(SEALED_SCHEMA + '/gzip'))
  const ciphertext = Buffer.concat([cipher.update(gzipSync(encodeEnvelope(envelope))), cipher.final()])
  const data = Buffer.from(JSON.stringify({ schema: SEALED_SCHEMA, algorithm: 'aes-256-gcm', encoding: 'gzip', nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64') }))
  return { data, fragment: `#key=${key.toString('base64url')}` }
}

export function openConfig(raw: any, fragment = ''): ConfigEnvelope {
  if (raw?.schema !== SEALED_SCHEMA) {
    if (fragment) throw Error('链接中的解密信息与配置包不匹配')
    return parseEnvelope(raw) // Existing definition exports remain importable.
  }
  if (!/^#key=[A-Za-z0-9_-]{43}$/.test(fragment)) throw Error('加密配置包需要完整迁移链接（包含 #key=）；请重新复制导出地址')
  if (raw.algorithm !== 'aes-256-gcm' || raw.encoding !== undefined && raw.encoding !== 'gzip' || !/^[A-Za-z0-9_-]{16}$/.test(raw.nonce ?? '') || !/^[A-Za-z0-9_-]{22}$/.test(raw.tag ?? '') || typeof raw.ciphertext !== 'string' || raw.ciphertext.length > MAX_R2_BYTES || !canonicalBase64(raw.ciphertext)) throw Error('加密配置包格式无效')
  let plaintext: Buffer
  try {
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(fragment.slice(5), 'base64url'), Buffer.from(raw.nonce, 'base64url'))
    cipher.setAAD(Buffer.from(SEALED_SCHEMA + (raw.encoding === 'gzip' ? '/gzip' : ''))); cipher.setAuthTag(Buffer.from(raw.tag, 'base64url'))
    plaintext = Buffer.concat([cipher.update(Buffer.from(raw.ciphertext, 'base64')), cipher.final()])
    if (raw.encoding === 'gzip') plaintext = gunzipSync(plaintext,{maxOutputLength:MAX_CONFIG_BYTES})
  } catch { throw Error('配置包解密校验失败：链接密钥错误或内容已被篡改') }
  if (plaintext.length > MAX_CONFIG_BYTES) throw Error('解密后的配置包超过 96 MiB')
  let value: unknown
  try { value = JSON.parse(plaintext.toString('utf8')) } catch { throw Error('解密后的配置包不是有效 JSON') }
  return parseEnvelope(value)
}

export interface ConfigAgent { spec: AgentSpec; actions: AgentAction[] }
export interface ConfigTask {
  id: string; title: string; brief: string; trigger: TaskSpec['trigger']; participants: TaskSpec['participants']
  graphMode?: TaskSpec['graphMode']; workflowRecipe?: TaskSpec['workflowRecipe']; design?: TaskSpec['design']
  cwd: string; timeoutSec: number; onFail: TaskSpec['onFail']; maxTries: number; actions: AgentAction[]
  workflowKind?: 'chat' | 'manual' | 'external'
}
export interface ConfigPayload { agents: ConfigAgent[]; tasks: ConfigTask[]; assets?: ConfigAssets }
export interface ConfigRuntime {
  schema: 'dsh-task-console/fleet-runtime-v1'
  mcps: { serverName: string; transport: 'streamable-http' | 'stdio'; credentialRef: 'fleet-admin' | 'onboard-vault-resolve'; runtime: string }[]
  skills: { id: string; runtime: 'bootstrap-bundle' }[]
  bootstrap?: { issuer: 'https://fleet.vyibc.com/api/hub/dsh-config-bootstrap'; token: string; expiresAt: string }
}
export interface ConfigEnvelope {
  schema: typeof CONFIG_SCHEMA; exportedAt: string; source: { plugin: 'dsh-task-console'; version: string }
  digest: { algorithm: 'sha256'; value: string }; payload: ConfigPayload; runtime?: ConfigRuntime
}

/** Portable runtime contract. It intentionally names credentials, never values. */
export const FLEET_RUNTIME: ConfigRuntime = {
  schema: 'dsh-task-console/fleet-runtime-v1',
  mcps: [
    { serverName: 'vault', transport: 'streamable-http', credentialRef: 'fleet-admin', runtime: 'fleet-vault' },
    { serverName: 'vyibc-fleet', transport: 'streamable-http', credentialRef: 'fleet-admin', runtime: 'fleet-api' },
    { serverName: 'fleet-browser', transport: 'stdio', credentialRef: 'fleet-admin', runtime: 'browser-manager' },
    { serverName: 'fleet-proxy-read', transport: 'stdio', credentialRef: 'onboard-vault-resolve', runtime: 'proxy-reader' },
    { serverName: 'fleet-proxy', transport: 'stdio', credentialRef: 'onboard-vault-resolve', runtime: 'proxy-operator' },
    { serverName: 'vyibc-wecom', transport: 'stdio', credentialRef: 'fleet-admin', runtime: 'wecom-mcp' },
  ],
  skills: ['awesome-novel', 'fleet-node-onboard', 'fleet-proxy-switch', 'linux-browser-vnc', 'linux-clash-skill'].map(id => ({ id, runtime: 'bootstrap-bundle' })),
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
    onFail: task.onFail, maxTries: task.maxTries, actions: validateTaskActions(actions),
    ...(task.configMigration ? { workflowKind: task.configMigration.workflowKind } : task.origin ? { workflowKind: task.origin.source === 'task-chat' ? 'chat' as const : 'external' as const } : {}),
  }
}

export function createEnvelope(payload: ConfigPayload, version: string, now = new Date(), runtime?: ConfigRuntime): ConfigEnvelope {
  const normalized: ConfigPayload = {
    agents: [...payload.agents].sort((a, b) => a.spec.id.localeCompare(b.spec.id)),
    tasks: [...payload.tasks].sort((a, b) => a.id.localeCompare(b.id)),
    ...(payload.assets ? { assets: parseAssets(payload.assets) } : {}),
  }
  return { schema: CONFIG_SCHEMA, exportedAt: now.toISOString(), source: { plugin: 'dsh-task-console', version }, digest: { algorithm: 'sha256', value: payloadDigest(normalized) }, payload: normalized, ...(runtime ? { runtime } : {}) }
}

function text(value: unknown, name: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${name}无效`)
  return value
}

/** Migration must never silently remove unknown authored permissions or fields. */
export function portableAgentSpec(raw: any): AgentSpec {
  const spec = validateSpec(raw)
  const allowed = new Set(['id','name','description','persona','model','effort','permissionPreset','tools','mcp','mcpTools','mcpPolicy','skills','taskExpertise','imageGeneration'])
  const unsupported = Object.keys(raw ?? {}).filter(key => !allowed.has(key))
  const tools = Array.isArray(raw?.tools) ? raw.tools.filter((t: any) => !spec.tools.includes(t)) : []
  if (unsupported.length || tools.length) throw Error(`Agent ${spec.id} 包含当前插件不支持的配置：${[...unsupported, ...tools].join('、')}；请同步支持该能力的插件，不能静默丢失资产`)
  if (raw.effort !== undefined && raw.effort !== spec.effort || raw.permissionPreset !== undefined && raw.permissionPreset !== spec.permissionPreset) throw Error(`Agent ${spec.id} 的模型推理或权限配置不能无损迁移`)
  return spec
}

export function parseEnvelope(raw: unknown): ConfigEnvelope {
  const e = raw as any
  if (!e || e.schema !== CONFIG_SCHEMA || e.source?.plugin !== 'dsh-task-console' || e.digest?.algorithm !== 'sha256') throw Error('不是受支持的 dsh-task-console 配置包')
  if (!e.payload || !Array.isArray(e.payload.agents) || !Array.isArray(e.payload.tasks) || e.payload.agents.length > 500 || e.payload.tasks.length > 1000) throw Error('配置包清单无效或超过数量限制')
  const agentIds = new Set<string>(), taskIds = new Set<string>()
  const agents = e.payload.agents.map((row: any): ConfigAgent => {
    const spec = portableAgentSpec(row?.spec)
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
    if (row.workflowKind !== undefined && !['chat','manual','external'].includes(row.workflowKind)) throw Error('工作流类型无效')
    if (row.graphMode !== undefined && !['static-chain','dynamic-rounds'].includes(row.graphMode)) throw Error('任务图模式无效')
    const config = taskConfig({
      id, title: text(row.title, 'Task 标题', 300), brief: text(row.brief, 'Task 任务书', 50_000), trigger,
      participants: row.participants, graphMode: row.graphMode, workflowRecipe: row.workflowRecipe, design: row.design,
      cwd: text(row.cwd, 'Task 工作目录', 4096), timeoutSec: row.timeoutSec, onFail: row.onFail,
      maxTries: row.maxTries, enabled: false, createdAt: new Date(0).toISOString(),
    } as TaskSpec, row.actions ?? [])
    if (row.workflowKind !== undefined) config.workflowKind = row.workflowKind
    if (row.design) validateDesign(row.design)
    return config
  })
  const payload: ConfigPayload = { agents, tasks, ...(e.payload.assets ? { assets: parseAssets(e.payload.assets) } : {}) }
  for (const skill of payload.assets?.skills ?? []) if (skill.agentId && !agentIds.has(skill.agentId)) throw Error('Skill 引用了不存在的 Agent')
  for (const task of tasks) {
    const missing = taskAgentIds(task).filter(id => !agentIds.has(id))
    if (missing.length) throw Error(`Task ${task.id} 引用了配置包中不存在的 Agent:${missing.join('、')}`)
  }
  if (!/^[a-f0-9]{64}$/.test(e.digest.value) || payloadDigest(payload) !== e.digest.value) throw Error('配置包 SHA256 校验失败')
  if (!Number.isFinite(Date.parse(e.exportedAt))) throw Error('配置包导出时间无效')
  let runtime: ConfigRuntime | undefined
  if (e.runtime !== undefined) {
    if (e.runtime?.schema !== 'dsh-task-console/fleet-runtime-v1' || !Array.isArray(e.runtime.mcps) || !Array.isArray(e.runtime.skills)) throw Error('运行时依赖清单无效')
    const mcps = e.runtime.mcps.map((row: any) => ({ serverName: text(row?.serverName, 'MCP 名称', 120), transport: row?.transport === 'stdio' || row?.transport === 'streamable-http' ? row.transport : (() => { throw Error('MCP transport 无效') })(), credentialRef: row?.credentialRef === 'fleet-admin' || row?.credentialRef === 'onboard-vault-resolve' ? row.credentialRef : (() => { throw Error('MCP 凭据引用无效') })(), runtime: text(row?.runtime, 'MCP runtime', 160) }))
    const skills = e.runtime.skills.map((row: any) => ({ id: text(row?.id, 'Skill 名称', 120), runtime: row?.runtime === 'bootstrap-bundle' ? row.runtime : (() => { throw Error('Skill runtime 无效') })() }))
    let bootstrap: ConfigRuntime['bootstrap']
    if (e.runtime.bootstrap !== undefined) {
      if (e.runtime.bootstrap?.issuer !== 'https://fleet.vyibc.com/api/hub/dsh-config-bootstrap' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(e.runtime.bootstrap?.token ?? '') || !Number.isFinite(Date.parse(e.runtime.bootstrap?.expiresAt))) throw Error('运行时引导授权无效')
      bootstrap = { issuer: e.runtime.bootstrap.issuer, token: e.runtime.bootstrap.token, expiresAt: new Date(e.runtime.bootstrap.expiresAt).toISOString() }
    }
    runtime = { schema: 'dsh-task-console/fleet-runtime-v1', mcps, skills, ...(bootstrap ? { bootstrap } : {}) }
  }
  return { schema: CONFIG_SCHEMA, exportedAt: new Date(e.exportedAt).toISOString(), source: { plugin: 'dsh-task-console', version: text(e.source.version, '版本', 80) }, digest: e.digest, payload, ...(runtime ? { runtime } : {}) }
}

export function encodeEnvelope(envelope: ConfigEnvelope): Buffer {
  const data = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  if (data.byteLength > MAX_CONFIG_BYTES) throw Error('配置包超过 96 MiB，需拆分资产后重试')
  return data
}

export function assertPublicConfigUrl(value: string, publicDomain: string): URL {
  let url: URL, base: URL
  try { url = new URL(value); base = new URL(publicDomain) } catch { throw Error('R2 地址无效') }
  if (url.protocol !== 'https:' || url.origin !== base.origin || !url.pathname.endsWith('.json') || url.username || url.password) throw Error(`只允许导入 ${base.origin} 下的 HTTPS .json 配置包`)
  return url
}

export async function uploadConfig(envelope: ConfigEnvelope, config: { endpoint: string; domain: string; token: string }, fixedName?: string): Promise<{ publicUrl: string; bytes: number; sha256: string }> {
  if (!config.token) throw Error('宿主未配置配置导出所需的 R2 凭据')
  const { data, fragment } = sealConfig(envelope), name = fixedName ?? `dsh-config-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  if (!/^dsh-config-[A-Za-z0-9._-]+\.json$/.test(name)) throw Error('R2 配置文件名无效')
  const form = new FormData()
  form.set('file', new Blob([data], { type: 'application/json' }), name); form.set('domain', config.domain); form.set('name', name); form.set('path', 'dsh-task-console/config-exports')
  const response = await fetch(config.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: form, signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw Error(`R2 上传失败（HTTP ${response.status}）`)
  const body = await response.text()
  let publicUrl = ''
  try { const parsed = JSON.parse(body); publicUrl = String(parsed.url ?? parsed.image_url ?? parsed.data?.url ?? parsed.result?.url ?? '') } catch { publicUrl = body.trim() }
  if (!publicUrl.startsWith(`${config.domain.replace(/\/$/, '')}/`)) publicUrl = `${config.domain.replace(/\/$/, '')}/dsh-task-console/config-exports/${name}`
  const verifiedUrl = assertPublicConfigUrl(publicUrl, config.domain)
  verifiedUrl.hash = ''; verifiedUrl.searchParams.set('verify', createHash('sha256').update(data).digest('hex').slice(0, 16))
  const check = await fetch(verifiedUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000), cache: 'no-store' })
  const stored = check.ok ? Buffer.from(await check.arrayBuffer()) : Buffer.alloc(0)
  if (!check.ok || !stored.equals(data)) throw Error('R2 上传后内容校验失败')
  verifiedUrl.searchParams.delete('verify')
  return { publicUrl: verifiedUrl.toString() + fragment, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }
}

export async function downloadConfig(value: string, publicDomain: string): Promise<{ envelope: ConfigEnvelope; bytes: number; fileSha256: string }> {
  const url = assertPublicConfigUrl(value, publicDomain)
  const fragment = url.hash
  if (fragment && !/^#key=[A-Za-z0-9_-]{43}$/.test(fragment)) throw Error('迁移链接解密信息无效')
  url.hash = ''
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw Error(`配置包下载失败（HTTP ${response.status}）`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_R2_BYTES) throw Error('R2 配置包超过传输限制')
  const reader = response.body?.getReader()
  if (!reader) throw Error('配置包响应没有内容')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_R2_BYTES) throw Error('R2 配置包超过传输限制'); chunks.push(value) }
  } finally { await reader.cancel() }
  const data = Buffer.concat(chunks)
  let parsed: unknown
  try { parsed = JSON.parse(data.toString('utf8')) } catch { throw Error('配置包不是有效 JSON') }
  return { envelope: openConfig(parsed, fragment), bytes: data.byteLength, fileSha256: createHash('sha256').update(data).digest('hex') }
}

/** Issue a package-bound, time-limited command through the trusted Fleet service.
 * The command contains only an installation capability; Fleet credentials are
 * fetched by the installer into owner-only files and never pass through R2. */
export async function createBootstrapCommand(value: string, config: { domain: string; endpoint: string; token: string }): Promise<{ command: string; expiresInSeconds: number; bootstrapToken: string }> {
  const url = assertPublicConfigUrl(value, config.domain)
  if (url.hash) throw Error('加密资产链接请在已部署的新机器「配置资产迁移」页面导入；旧引导安装器不支持解密，不会向它发送迁移密钥')
  if (!config.token) throw Error('宿主未配置新机器引导授权')
  const response = await fetch(config.endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ configUrl: url.toString() }), redirect: 'error', signal: AbortSignal.timeout(30_000),
  })
  let body: any = {}
  try { body = await response.json() } catch { /* report the HTTP status below */ }
  if (!response.ok || !body?.ok || typeof body.command !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.bootstrapToken ?? '')) throw Error(body?.error || `新机器引导命令生成失败（HTTP ${response.status}）`)
  if (!/^bash <\(curl -fsSL https:\/\/skill\.vyibc\.com\/dsh-config-bootstrap\/release\/install-dsh-config-bootstrap\.sh\) --bootstrap-token \S+ --config-url /.test(body.command)) throw Error('新机器引导命令格式无效')
  return { command: body.command, expiresInSeconds: Number(body.expiresInSeconds) || 0, bootstrapToken: body.bootstrapToken }
}
