/**
 * Narrow, host-owned Fleet onboarding tools.
 *
 * The model supplies only intent (an IP). Credentials,
 * inventory, executable paths and commands stay behind this module's adapter
 * boundary. A deployment without a production adapter still registers the
 * four tools, but every executable operation fails closed.
 *
 * @module dsh-task-console/fleet-onboard-tools
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, chmod, lstat, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'task-console-fleet-onboard-tools'
export const inject = ['tools']

const MAX_PROCESS_BYTES = 1024 * 1024
const LEDGER_TIMEOUT_MS = 120_000
const DEFAULT_ADAPTER_TIMEOUT_MS = 12 * 60_000
const MAX_ADAPTER_TIMEOUT_MS = 14 * 60_000
const CLOUD_TIMEOUT_MS = 30_000
const TOOL_NAMES = ['fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report'] as const
const SAFE_SOURCE = new Set(['intake', 'vault', 'managed-account'])
const SECRET_KEYS = new Set([
  'accesskey', 'apikey', 'authheader', 'authorization', 'authorizationheader', 'bearer', 'bootstrapkey',
  'clientsecret', 'configurl', 'cookie', 'cookies', 'credential', 'credentialfile', 'credentialhandle',
  'credentialref', 'credentialvalue', 'key', 'password', 'passwd', 'privatekey', 'proxyurl', 'secret',
  'setcookie', 'sourceurl', 'sshagentsocket', 'sshprivatekey', 'subscriptionurl', 'token',
])
const SECRET_TEXT = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /\bauthorization\s*[:=]\s*bearer\s+\S+/i,
  /https?:\/\/[^\s/:]+:[^@\s]+@/i,
  /[?&](?:token|key|secret|password|signature)=/i,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
]

export type FleetProfile = 'base' | 'image-worker'
export type FleetOperation = 'start' | 'status' | 'resume' | 'report'

export interface FleetToolResult {
  schema: 1
  ok: boolean
  operation: FleetOperation
  ip: string
  phase: string
  execution_available: boolean
  needs_input: boolean
  run_created: boolean
  probe_executed: boolean
  reason?: string
  missing?: string[]
  [key: string]: unknown
}

/** Secret material is deliberately opaque outside the host adapter. */
export interface CredentialLease {
  available: boolean
  source?: 'intake' | 'vault' | 'managed-account'
  missing?: string[]
  /** Bytes written only to a short-lived 0600 file; never returned or logged. */
  material?: Uint8Array
  /** Or an already-created owner-only file from the fixed Vault provider. */
  file?: string
  dispose?: () => Promise<void>
}

export interface CredentialProvider {
  resolve(ip: string, exec: ToolExecutionLike): Promise<CredentialLease>
}

export interface ToolExecutionLike {
  signal?: AbortSignal
  agent?: { id?: unknown; session?: { id?: unknown; header?: { id?: unknown }; deriveMessages?: () => unknown[] } }
}

export interface FleetLedgerRun {
  id: string
  nodeId: string
  ip: string
  sessionId: string
  mode: 'new' | 'adopt' | 'verify-only' | 'repair'
  status: 'running' | 'blocked' | 'failed' | 'complete'
  currentStage: number
  revision: number
  leaseEpoch: number
  leaseOwner: string | null
  writeChallenge: string
  contractVersion: string
  executorVersion: string
  targetFingerprint: string
  browserCount: number
  report?: unknown
}

export interface FleetLedgerStatus {
  ok: boolean
  run?: FleetLedgerRun
  stages?: Array<Record<string, unknown>>
  events?: Array<Record<string, unknown>>
  error?: string
}

export interface FleetOnboardLedger {
  start(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; created?: boolean; run?: FleetLedgerRun; error?: string }>
  status(input: { ip?: string; runId?: string }, signal?: AbortSignal): Promise<FleetLedgerStatus>
  report(input: { ip?: string; runId?: string }, signal?: AbortSignal): Promise<FleetLedgerStatus>
  resume(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; run?: FleetLedgerRun; error?: string }>
  record(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; run?: FleetLedgerRun; error?: string }>
  finish(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; run?: FleetLedgerRun; error?: string }>
}

export interface FleetOnboardCloudResult {
  status: 'queued' | 'running' | 'blocked' | 'failed' | 'succeeded'
  action: 'reused' | 'changed' | null
  resultCode: string | null
}

export interface FleetOnboardCloudTransport {
  execute(input: { schema: 1; operationId: string; stage: 5 | 6 | 7 | 8 | 10; ip: string }, signal?: AbortSignal): Promise<FleetOnboardCloudResult>
}

function trustedCloudWorkflowUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/api/fleet-onboard-cloud/v1/operations') {
    throw new Error('fleet-onboard-cloud-url-unsafe')
  }
  return url
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PROCESS_BYTES) throw new Error('cloud-response-too-large')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_PROCESS_BYTES) throw new Error('cloud-response-too-large')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('cloud-response-invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cloud-response-invalid')
  assertNoSecrets(value, 'cloud-response')
  return value as Record<string, unknown>
}

/** Fixed host transport; callers can choose only the already-validated stage identity. */
export class HttpFleetOnboardCloudTransport implements FleetOnboardCloudTransport {
  readonly #url: URL
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(config: { url: string; token: string; fetch?: typeof fetch }) {
    this.#url = trustedCloudWorkflowUrl(config.url)
    if (!config.token || config.token.length < 16 || /[\0\r\n]/.test(config.token)) {
      throw new Error('fleet-onboard-cloud-token-invalid')
    }
    this.#token = config.token
    this.#fetch = config.fetch ?? fetch
  }

  async #request(url: URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS)
    try {
      return await this.#fetch(url, {
        ...init, signal: controller.signal, redirect: 'error',
        headers: { accept: 'application/json', authorization: `Bearer ${this.#token}`, ...(init.headers || {}) },
      })
    } catch {
      throw new Error('fleet-onboard-cloud-transport-failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async execute(input: { schema: 1; operationId: string; stage: 5 | 6 | 7 | 8 | 10; ip: string }, signal?: AbortSignal): Promise<FleetOnboardCloudResult> {
    if (input.schema !== 1 || !/^onboard-[0-9a-f]{32}$/.test(input.operationId)
      || ![5, 6, 7, 8, 10].includes(input.stage) || !validIpv4(input.ip)) {
      throw new Error('fleet-onboard-cloud-request-invalid')
    }
    const request = { schema: 1, operation_id: input.operationId, stage: input.stage, ip: input.ip }
    const submitted = await this.#request(this.#url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }, signal)
    if (![200, 202].includes(submitted.status)) throw new Error('fleet-onboard-cloud-submit-failed')
    const accepted = await boundedJson(submitted)
    if (accepted.ok !== true || accepted.operation_id !== input.operationId
      || !['queued', 'running', 'blocked', 'failed', 'succeeded'].includes(String(accepted.status))
      || typeof accepted.idempotent !== 'boolean') throw new Error('fleet-onboard-cloud-submit-invalid')

    const statusUrl = new URL(`${this.#url.href}/${input.operationId}`)
    const response = await this.#request(statusUrl, {}, signal)
    if (response.status !== 200) throw new Error('fleet-onboard-cloud-status-failed')
    const status = await boundedJson(response)
    if (status.ok !== true || !Array.isArray(status.operations)) throw new Error('fleet-onboard-cloud-status-invalid')
    const matches = status.operations.filter(row => row && typeof row === 'object' && Number((row as any).stage) === input.stage)
    if (matches.length !== 1) throw new Error('fleet-onboard-cloud-stage-ambiguous')
    const operation = matches[0] as Record<string, unknown>
    const operationStatus = String(operation.status)
    const action = operation.action === null || operation.action === undefined ? null : String(operation.action)
    const resultCode = operation.result_code === null || operation.result_code === undefined ? null : String(operation.result_code)
    if (operation.operation_id !== input.operationId || operation.ip !== input.ip || Number(operation.schema_version) !== 1
      || operation.node_id !== `host-${input.ip.replaceAll('.', '-')}`
      || !['queued', 'running', 'blocked', 'failed', 'succeeded'].includes(operationStatus)
      || (action !== null && action !== 'reused' && action !== 'changed')
      || (resultCode !== null && !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(resultCode))) {
      throw new Error('fleet-onboard-cloud-status-invalid')
    }
    if (operationStatus === 'succeeded' && (resultCode !== 'readback-verified' || !action)) {
      throw new Error('fleet-onboard-cloud-status-invalid')
    }
    if ((operationStatus === 'blocked' || operationStatus === 'failed') && (!resultCode || action !== null)) {
      throw new Error('fleet-onboard-cloud-status-invalid')
    }
    if ((operationStatus === 'queued' || operationStatus === 'running') && action !== null) {
      throw new Error('fleet-onboard-cloud-status-invalid')
    }
    return { status: operationStatus as FleetOnboardCloudResult['status'], action: action as FleetOnboardCloudResult['action'], resultCode }
  }
}

type AgentLedgerTool = 'onboard_start' | 'onboard_status' | 'onboard_report'
type ExecutorLedgerTool = 'onboard_resume' | 'onboard_record' | 'onboard_finish'

function trustedMcpUrl(value: string): URL {
  const url = new URL(value)
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw new Error('fleet-onboard-mcp-url-unsafe')
  return url
}

/** A bearer credential scoped in-process to one fixed MCP capability URL. */
export class ScopedFleetMcpClient<Tool extends string> {
  readonly #url: URL
  readonly #token: string
  readonly #allowed: ReadonlySet<string>
  readonly #workerId: string
  #sequence = 0

  constructor(endpoint: string, token: string, workerId: string, allowed: readonly Tool[]) {
    this.#url = trustedMcpUrl(endpoint)
    if (!token || token.length < 16 || /[\0\r\n]/.test(token)) throw new Error('fleet-onboard-mcp-token-invalid')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$/.test(workerId)) throw new Error('fleet-onboard-worker-id-invalid')
    this.#token = token
    this.#workerId = workerId
    this.#allowed = new Set(allowed)
  }

  async call(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.#allowed.has(tool)) throw new Error('fleet-onboard-mcp-scope-denied')
    assertNoSecrets(args, 'ledger-request')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS)
    let response: Response
    let text: string
    try {
      response = await fetch(this.#url, {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: {
          accept: 'application/json', 'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`, 'x-vyibc-actor': this.#workerId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: ++this.#sequence, method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      })
      if (!response.ok) throw new Error('ledger-http')
      const length = Number(response.headers.get('content-length'))
      if (Number.isFinite(length) && length > MAX_PROCESS_BYTES) throw new Error('ledger-size')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('ledger-body')
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PROCESS_BYTES) { await reader.cancel(); throw new Error('ledger-size') }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      bytes.fill(0)
    } catch {
      throw new Error('fleet-onboard-ledger-transport-failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    let envelope: any
    try { envelope = JSON.parse(text) } catch { throw new Error('fleet-onboard-ledger-response-invalid') }
    if (!envelope || typeof envelope !== 'object' || envelope.error || !envelope.result
      || envelope.result.isError === true || !Array.isArray(envelope.result.content)) {
      throw new Error('fleet-onboard-ledger-call-failed')
    }
    const block = envelope.result.content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')
    if (!block) throw new Error('fleet-onboard-ledger-result-missing')
    let payload: unknown
    try { payload = JSON.parse(block.text) } catch { throw new Error('fleet-onboard-ledger-payload-invalid') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('fleet-onboard-ledger-payload-invalid')
    assertNoSecrets(payload, 'ledger-response')
    return payload as Record<string, unknown>
  }
}

/** Two-token ledger: observation/start reads and lease-fenced execution writes never share credentials. */
export class HttpFleetOnboardLedger implements FleetOnboardLedger {
  readonly #agent: ScopedFleetMcpClient<AgentLedgerTool>
  readonly #executor: ScopedFleetMcpClient<ExecutorLedgerTool>

  constructor(config: { agentUrl: string; agentToken: string; executorUrl: string; executorToken: string; workerId: string }) {
    if (config.agentToken === config.executorToken || trustedMcpUrl(config.agentUrl).href === trustedMcpUrl(config.executorUrl).href) {
      throw new Error('fleet-onboard-mcp-scopes-must-be-distinct')
    }
    this.#agent = new ScopedFleetMcpClient(config.agentUrl, config.agentToken, config.workerId,
      ['onboard_start', 'onboard_status', 'onboard_report'])
    this.#executor = new ScopedFleetMcpClient(config.executorUrl, config.executorToken, config.workerId,
      ['onboard_resume', 'onboard_record', 'onboard_finish'])
  }

  start(input: Record<string, unknown>, signal?: AbortSignal) {
    return this.#agent.call('onboard_start', input, signal) as Promise<{ ok: boolean; created?: boolean; run?: FleetLedgerRun; error?: string }>
  }
  status(input: { ip?: string; runId?: string }, signal?: AbortSignal) {
    return this.#agent.call('onboard_status', input, signal) as unknown as Promise<FleetLedgerStatus>
  }
  report(input: { ip?: string; runId?: string }, signal?: AbortSignal) {
    return this.#agent.call('onboard_report', input, signal) as unknown as Promise<FleetLedgerStatus>
  }
  resume(input: Record<string, unknown>, signal?: AbortSignal) {
    return this.#executor.call('onboard_resume', input, signal) as Promise<{ ok: boolean; run?: FleetLedgerRun; error?: string }>
  }
  record(input: Record<string, unknown>, signal?: AbortSignal) {
    return this.#executor.call('onboard_record', input, signal) as Promise<{ ok: boolean; run?: FleetLedgerRun; error?: string }>
  }
  finish(input: Record<string, unknown>, signal?: AbortSignal) {
    return this.#executor.call('onboard_finish', input, signal) as Promise<{ ok: boolean; run?: FleetLedgerRun; error?: string }>
  }
}

export interface FleetOnboardHostAdapter {
  readonly executionAvailable: boolean
  start(ip: string, profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult>
  status(ip: string, exec: ToolExecutionLike): Promise<FleetToolResult>
  resume(ip: string, profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult>
  report(ip: string, exec: ToolExecutionLike): Promise<FleetToolResult>
}

export interface FixedCommand {
  /** Absolute host-owned executable. Model input can never override it. */
  executable: string
  /** Immutable host-owned arguments, passed without a shell. */
  args?: readonly string[]
}

export interface SubprocessFleetAdapterConfig {
  credentials: CredentialProvider
  /** Central run/stage/event ledger with host-owned auth and CAS leases. */
  ledger?: FleetOnboardLedger
  /** Durable control-plane executor for machine/cloud-owned stages 5/6/7/8/10. */
  cloud?: FleetOnboardCloudTransport
  probe: FixedCommand
  runtime: FixedCommand
  /** A single executable because onboard-runtime invokes it directly. */
  executor?: FixedCommand
  contractFile: string
  hmacKeyFile: string
  /** Host-only bearer values that must never equal the shared evidence key. */
  hmacForbiddenValues: readonly string[]
  stateDir?: string
  tempRoot?: string
  timeoutMs?: number
  /** Explicit, host-owned non-secret environment for adapters and tests. */
  environment?: Readonly<Record<string, string>>
  workerId: string
  executorVersion: string
}

interface PreparedConfig extends Omit<SubprocessFleetAdapterConfig, 'probe' | 'runtime' | 'executor' | 'hmacForbiddenValues'> {
  probe: Required<FixedCommand>
  runtime: Required<FixedCommand>
  executor?: Required<FixedCommand>
  contract: Record<string, unknown>
  contractSha256: string
  hmacKey: Buffer
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function assertNoSecrets(value: unknown, path = 'value'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecrets(child, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(normalizeKey(key))) throw new Error(`unsafe-field:${path}.${key}`)
      assertNoSecrets(child, `${path}.${key}`)
    }
    return
  }
  if (typeof value === 'string' && SECRET_TEXT.some(pattern => pattern.test(value))) {
    throw new Error(`unsafe-value:${path}`)
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function validIpv4(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.trim().split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part)
}

function requireIp(value: unknown): string {
  if (!validIpv4(value)) throw new Error('ip 必须是完整 IPv4 地址')
  return value.trim()
}

function textOfMessage(message: unknown): string {
  if (!message || typeof message !== 'object' || (message as any).role !== 'user') return ''
  const content = (message as any).content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

const SSH_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/i
const STANDALONE_SECRET = /^[\x21-\x7e]{1,256}$/

function messageIpv4s(text: string): string[] {
  const values: string[] = []
  for (const match of text.matchAll(/(?:^|[^\d.])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^\d.])/g)) {
    if (validIpv4(match[1])) values.push(match[1])
  }
  return [...new Set(values)]
}

function labeledCredential(text: string): { username?: string; password?: string } {
  return {
    username: /(?:^|\s)(?:username|user|账号|用户)(?:\s*(?:[:=：]|is|是)\s*|\s+)([a-z_][a-z0-9_-]{0,31})/i.exec(text)?.[1],
    password: /(?:^|\s)(?:password|passwd|密码)(?:\s*(?:[:=：]|is|是)\s*|\s+)(\S{1,256})/i.exec(text)?.[1],
  }
}

function conventionalCredential(text: string, ip: string): { username?: string; password?: string } {
  const tokens = text.trim().split(/\s+/)
  const ipIndex = tokens.findLastIndex(token => token.replace(/[，,。；;]+$/g, '') === ip)
  if (ipIndex < 2) return {}
  const username = tokens[ipIndex - 2]
  const password = tokens[ipIndex - 1]
  return {
    ...(SSH_USERNAME.test(username) ? { username } : {}),
    ...(STANDALONE_SECRET.test(password) ? { password } : {}),
  }
}

/**
 * Read credentials from the latest target-IP context in real user messages.
 * Explicit labels, `username password IP`, and subsequent one/two-token
 * replies are supported. A later different IP invalidates the context. It is
 * intentionally not a model tool argument. Returned bytes must immediately
 * cross a credential broker boundary or be zeroed.
 */
export function credentialFromSession(ip: string, exec: ToolExecutionLike): CredentialLease {
  const messages = exec.agent?.session?.deriveMessages?.()
  if (!Array.isArray(messages)) return { available: false, missing: ['ssh_username', 'ssh_credential'] }
  const rows = messages.map(textOfMessage)
  let anchor = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (messageIpv4s(rows[index]).includes(ip)) { anchor = index; break }
  }
  if (anchor < 0) return { available: false, missing: ['ssh_username', 'ssh_credential'] }
  const anchorIps = messageIpv4s(rows[anchor])
  if (anchorIps.some(value => value !== ip)
    || rows.slice(anchor + 1).some(text => messageIpv4s(text).some(value => value !== ip))) {
    return { available: false, missing: ['ssh_username', 'ssh_credential'] }
  }
  let username: string | undefined
  let password: string | undefined
  for (let index = anchor; index < rows.length; index += 1) {
    const text = rows[index]
    if (!text) continue
    const labeled = labeledCredential(text)
    if (labeled.username) username = labeled.username
    if (labeled.password) password = labeled.password
    if (index === anchor) {
      const conventional = conventionalCredential(text, ip)
      username ??= conventional.username
      password ??= conventional.password
      continue
    }
    const tokens = text.trim().split(/\s+/)
    if (tokens.length === 2 && SSH_USERNAME.test(tokens[0]) && STANDALONE_SECRET.test(tokens[1])) {
      username ??= tokens[0]
      password ??= tokens[1]
    } else if (tokens.length === 1 && STANDALONE_SECRET.test(tokens[0])) {
      if (!username && SSH_USERNAME.test(tokens[0])) username = tokens[0]
      else if (!password) password = tokens[0]
    }
  }
  if (username && password) {
    return {
      available: true,
      source: 'intake',
      material: Buffer.from(JSON.stringify({ schema: 1, ip, username, password }), 'utf8'),
    }
  }
  return {
    available: false,
    missing: [!username ? 'ssh_username' : '', !password ? 'ssh_credential' : ''].filter(Boolean),
  }
}

export const sessionCredentialProvider: CredentialProvider = {
  async resolve(ip, exec) { return credentialFromSession(ip, exec) },
}

interface VaultCredentialProviderConfig {
  command: Required<FixedCommand>
  environment?: Readonly<Record<string, string>>
  tempRoot?: string
  timeoutMs?: number
}

async function validateCredentialLeaseFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('credential-file-unsafe')
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o077) !== 0 || metadata.size < 2 || metadata.size > 128 * 1024) {
    throw new Error('credential-file-unsafe')
  }
}

async function runCredentialProvider(config: VaultCredentialProviderConfig, ip: string, output: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const env = safeEnvironment(config.environment)
  env.FLEET_ONBOARD_CREDENTIAL_FILE = output
  const child = spawn(config.command.executable, [...config.command.args], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
  })
  let stdout = Buffer.alloc(0)
  let outputBytes = 0
  child.stdout.on('data', chunk => {
    stdout = Buffer.concat([stdout, Buffer.from(chunk)])
    outputBytes += Buffer.byteLength(chunk)
    if (outputBytes > MAX_PROCESS_BYTES) child.kill('SIGKILL')
  })
  child.stderr.on('data', chunk => {
    outputBytes += Buffer.byteLength(chunk)
    if (outputBytes > MAX_PROCESS_BYTES) child.kill('SIGKILL')
  })
  const abort = () => child.kill('SIGTERM')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs ?? 60_000)
  child.stdin.on('error', () => undefined)
  child.stdin.end(`${canonical({ schema: 1, operation: 'resolve', ip })}\n`)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  })
  if (signal?.aborted) throw new Error('fleet-onboard-operation-aborted')
  if (outputBytes > MAX_PROCESS_BYTES) throw new Error('credential-provider-output-too-large')
  const lines = stdout.toString('utf8').split(/\r?\n/).filter(line => line.trim())
  stdout.fill(0)
  if (lines.length !== 1) throw new Error('credential-provider-result-invalid')
  let value: unknown
  try { value = JSON.parse(lines[0]) } catch { throw new Error('credential-provider-result-invalid') }
  assertNoSecrets(value, 'credential-provider-result')
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as any).schema !== 1) {
    throw new Error('credential-provider-result-invalid')
  }
  if (code === 2 && (value as any).available === false) {
    if (['managed-credential-missing', 'vault-key-unavailable', 'ip-must-be-public'].includes(String((value as any).reason_code))) return undefined
    throw new Error('credential-provider-unavailable')
  }
  if (code !== 0 || (value as any).available !== true || (value as any).source !== 'vault') {
    throw new Error('credential-provider-failed')
  }
  return value as Record<string, unknown>
}

/** Latest user intake wins; otherwise a single fixed, host-owned Vault provider is consulted. */
export class VaultFirstCredentialProvider implements CredentialProvider {
  private constructor(private readonly config: VaultCredentialProviderConfig) {}

  static async create(config: { command: FixedCommand; environment?: Readonly<Record<string, string>>; tempRoot?: string; timeoutMs?: number }) {
    if (config.tempRoot && !isAbsolute(config.tempRoot)) throw new Error('temp-root-must-be-absolute')
    return new VaultFirstCredentialProvider({ ...config, command: await prepareCommand(config.command, 'credential-provider') })
  }

  async resolve(ip: string, exec: ToolExecutionLike): Promise<CredentialLease> {
    const intake = credentialFromSession(ip, exec)
    if (intake.available) return intake
    const root = await mkdtemp(join(this.config.tempRoot ?? tmpdir(), 'dsh-fleet-vault-'))
    await chmod(root, 0o700)
    const file = join(root, 'credential.json')
    try {
      const metadata = await runCredentialProvider(this.config, ip, file, exec.signal)
      if (!metadata) {
        await rm(root, { recursive: true, force: true })
        return { available: false, missing: intake.missing ?? ['ssh_username', 'ssh_credential'] }
      }
      await validateCredentialLeaseFile(file)
      let disposed = false
      return {
        available: true, source: 'vault', file,
        async dispose() {
          if (disposed) return
          disposed = true
          await rm(root, { recursive: true, force: true })
        },
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
}

async function prepareCommand(command: FixedCommand, label: string): Promise<Required<FixedCommand>> {
  if (!isAbsolute(command.executable) || command.executable.includes('\0')) throw new Error(`${label}-executable-must-be-absolute`)
  const executable = await realpath(command.executable)
  const metadata = await stat(executable)
  if (!metadata.isFile() || ![0, process.getuid?.()].includes(metadata.uid) || (metadata.mode & 0o022) !== 0) {
    throw new Error(`${label}-executable-unsafe`)
  }
  await access(executable, fsConstants.X_OK)
  const args = [...(command.args ?? [])]
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error(`${label}-argument-invalid`)
  return { executable, args }
}

async function dshOnboardGroupId(): Promise<number | undefined> {
  try {
    const rows = (await readFile('/etc/group', 'utf8')).split(/\r?\n/)
    const matches = rows.filter(row => row.startsWith('dsh-onboard:'))
    if (matches.length !== 1) return undefined
    const gid = Number(matches[0].split(':')[2])
    return Number.isSafeInteger(gid) && gid >= 0 ? gid : undefined
  } catch { return undefined }
}

async function readHmacKey(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('hmac-key-file-must-be-absolute')
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    const mode = metadata.mode & 0o777
    const ownFile = metadata.uid === process.getuid?.() && mode === 0o600
    const serviceGid = metadata.uid === 0 && mode === 0o640 ? await dshOnboardGroupId() : undefined
    const serviceFile = serviceGid !== undefined && metadata.gid === serviceGid && (process.getgroups?.() ?? []).includes(serviceGid)
    if (!metadata.isFile() || (!ownFile && !serviceFile)) throw new Error('hmac-key-file-unsafe')
    if (metadata.size < 64 || metadata.size > 66) throw new Error('hmac-key-file-size-invalid')
    const value = Buffer.from(await handle.readFile())
    let keyText = value.toString('utf8')
    if (keyText.endsWith('\r\n')) keyText = keyText.slice(0, -2)
    else if (keyText.endsWith('\n')) keyText = keyText.slice(0, -1)
    value.fill(0)
    if (!/^[0-9a-f]{64}$/.test(keyText)) throw new Error('hmac-key-file-format-invalid')
    return Buffer.from(keyText, 'ascii')
  } finally { await handle.close() }
}

function secretsEqual(left: Buffer, right: string): boolean {
  const candidate = Buffer.from(right, 'utf8')
  const equal = candidate.byteLength === left.byteLength && timingSafeEqual(candidate, left)
  candidate.fill(0)
  return equal
}

async function prepareConfig(config: SubprocessFleetAdapterConfig): Promise<PreparedConfig> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$/.test(config.workerId)) throw new Error('fleet-onboard-worker-id-invalid')
  if (!/^[A-Za-z0-9._/+:-]{1,80}$/.test(config.executorVersion)) throw new Error('fleet-onboard-executor-version-invalid')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > MAX_ADAPTER_TIMEOUT_MS)) {
    throw new Error('fleet-onboard-adapter-timeout-invalid')
  }
  if (!isAbsolute(config.contractFile)) throw new Error('contract-file-must-be-absolute')
  const contractPath = await realpath(config.contractFile)
  const contractMetadata = await stat(contractPath)
  if (!contractMetadata.isFile() || (contractMetadata.uid !== 0 && contractMetadata.uid !== process.getuid?.())
    || (contractMetadata.mode & 0o022) !== 0) throw new Error('contract-file-unsafe')
  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  const hmacKey = await readHmacKey(config.hmacKeyFile)
  try {
    if (config.hmacForbiddenValues.some(value => typeof value !== 'string' || value.length < 16 || /[\0\r\n]/.test(value))
      || new Set(config.hmacForbiddenValues).size !== config.hmacForbiddenValues.length) {
      throw new Error('fleet-onboard-scoped-tokens-must-be-distinct')
    }
    if (config.hmacForbiddenValues.some(value => secretsEqual(hmacKey, value))) {
      throw new Error('hmac-key-must-differ-from-scoped-tokens')
    }
    const executor = config.executor ? await prepareCommand(config.executor, 'executor') : undefined
    if (executor?.args.length) throw new Error('executor-fixed-arguments-not-supported')
    if (config.stateDir && !isAbsolute(config.stateDir)) throw new Error('state-dir-must-be-absolute')
    if (config.tempRoot && !isAbsolute(config.tempRoot)) throw new Error('temp-root-must-be-absolute')
    const { hmacForbiddenValues: _hmacForbiddenValues, ...safeConfig } = config
    return {
      ...safeConfig,
      probe: await prepareCommand(config.probe, 'probe'),
      runtime: await prepareCommand(config.runtime, 'runtime'),
      executor,
      contract,
      contractSha256: createHash('sha256').update(canonical(contract)).digest('hex'),
      hmacKey,
    }
  } catch (error) {
    hmacKey.fill(0)
    throw error
  }
}

function safeEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const inherited = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']
  const env: NodeJS.ProcessEnv = {}
  for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('adapter-environment-invalid')
    env[key] = value
  }
  return env
}

async function runJsonProcess(command: Required<FixedCommand>, extraArgs: string[], input: unknown, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = DEFAULT_ADAPTER_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const child = spawn(command.executable, [...command.args, ...extraArgs], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  let stdout = Buffer.alloc(0)
  let stderrBytes = 0
  let overflow = false
  child.stdout.on('data', chunk => {
    if (overflow) return
    stdout = Buffer.concat([stdout, Buffer.from(chunk)])
    if (stdout.byteLength > MAX_PROCESS_BYTES) { overflow = true; child.kill('SIGKILL') }
  })
  child.stderr.on('data', chunk => {
    stderrBytes += Buffer.byteLength(chunk)
    if (stderrBytes > MAX_PROCESS_BYTES) child.kill('SIGKILL')
  })
  const abort = () => child.kill('SIGTERM')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.stdin.on('error', () => undefined)
  child.stdin.end(`${canonical(input)}\n`)
  const { code, aborted } = await new Promise<{ code: number | null; aborted: boolean }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, aborted: Boolean(signal?.aborted) }))
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  })
  if (aborted) throw new Error('fleet-onboard-operation-aborted')
  if (overflow) throw new Error('fleet-onboard-adapter-output-too-large')
  if (code !== 0) throw new Error(`fleet-onboard-adapter-exit-${code ?? 'signal'}`)
  const lines = stdout.toString('utf8').split(/\r?\n/).filter(line => line.trim())
  stdout.fill(0)
  if (lines.length !== 1) throw new Error('fleet-onboard-adapter-must-return-one-json-line')
  let parsed: unknown
  try { parsed = JSON.parse(lines[0]) } catch { throw new Error('fleet-onboard-adapter-invalid-json') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('fleet-onboard-adapter-result-must-be-object')
  assertNoSecrets(parsed, 'adapter-result')
  return parsed as Record<string, unknown>
}

async function withCredentialFile<T>(lease: CredentialLease, config: PreparedConfig, task: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  let root = ''
  const material = lease.material ? Buffer.from(lease.material) : undefined
  try {
    const env = safeEnvironment(config.environment)
    env.FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE = config.hmacKeyFile
    env.FLEET_ONBOARD_CONTRACT_FILE = config.contractFile
    if (config.stateDir) env.FLEET_ONBOARD_STATE_DIR = config.stateDir
    if (lease.file) {
      await validateCredentialLeaseFile(lease.file)
      env.FLEET_ONBOARD_CREDENTIAL_FILE = lease.file
    } else if (material?.length) {
      root = await mkdtemp(join(config.tempRoot ?? tmpdir(), 'dsh-fleet-intake-'))
      await chmod(root, 0o700)
      const credentialFile = join(root, 'credential.json')
      await writeFile(credentialFile, material, { flag: 'wx', mode: 0o600 })
      env.FLEET_ONBOARD_CREDENTIAL_FILE = credentialFile
    }
    return await task(env)
  } finally {
    material?.fill(0)
    if (lease.material instanceof Uint8Array) lease.material.fill(0)
    if (root) await rm(root, { recursive: true, force: true })
    await lease.dispose?.().catch(() => undefined)
  }
}

function verifiedProbeInventory(raw: Record<string, unknown>, ip: string, profile: FleetProfile, config: PreparedConfig): Record<string, unknown> {
  assertNoSecrets(raw, 'probe-result')
  if (raw.schema !== 1 || raw.ok !== true || raw.operation !== 'probe' || raw.ip !== ip
    || !raw.inventory || typeof raw.inventory !== 'object' || Array.isArray(raw.inventory)) {
    throw new Error('probe-result-envelope-invalid')
  }
  const inventory = raw.inventory as Record<string, unknown>
  assertNoSecrets(inventory, 'probe-inventory')
  if (inventory.schema !== 1 || inventory.ip !== ip) throw new Error('probe-inventory-identity-mismatch')
  const provenance = inventory.provenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('probe-provenance-required')
  const proof = provenance as Record<string, unknown>
  if (proof.origin !== 'dsh-fleet-probe-v1' || proof.executor_id !== 'fleet.inventory-probe.v1') {
    throw new Error('probe-provenance-untrusted')
  }
  if (typeof proof.target_fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(proof.target_fingerprint)) {
    throw new Error('probe-target-fingerprint-required')
  }
  if (typeof proof.observed_at !== 'string' || !proof.observed_at.trim()) throw new Error('probe-observed-at-required')
  const observedAt = Date.parse(proof.observed_at)
  const age = Date.now() - observedAt
  if (!Number.isFinite(observedAt) || age < -60_000 || age > 10 * 60_000) throw new Error('probe-observation-stale')
  if (proof.contract_sha256 !== config.contractSha256) throw new Error('probe-contract-digest-mismatch')
  const desired = inventory.desired as Record<string, unknown> | undefined
  if (!desired || desired.line !== 'line-100' || desired.profile !== profile || ![1, 2].includes(Number(desired.browser_count))) {
    throw new Error('probe-desired-state-invalid')
  }
  const credentials = inventory.credentials as Record<string, unknown> | undefined
  if (!credentials || credentials.available !== true || !SAFE_SOURCE.has(String(credentials.source))) {
    throw new Error('probe-credential-proof-invalid')
  }
  if (typeof proof.attestation !== 'string' || !/^hmac-sha256:[0-9a-f]{64}$/.test(proof.attestation)) {
    throw new Error('probe-attestation-required')
  }
  const unsigned = JSON.parse(canonical(inventory)) as Record<string, unknown>
  delete (unsigned.provenance as Record<string, unknown>).attestation
  const expected = Buffer.from(`hmac-sha256:${createHmac('sha256', config.hmacKey).update(canonical(unsigned)).digest('hex')}`)
  const actual = Buffer.from(proof.attestation)
  const valid = actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
  expected.fill(0); actual.fill(0)
  if (!valid) throw new Error('probe-attestation-mismatch')
  return inventory
}

function intakeResult(operation: 'start' | 'resume', ip: string, missing: string[], executionAvailable: boolean): FleetToolResult {
  return {
    schema: 1, ok: false, operation, ip, phase: 'intake', execution_available: executionAvailable,
    needs_input: true, run_created: false, probe_executed: false,
    reason: 'first-login-credential-required',
    missing: missing.length ? [...new Set(missing)] : ['ssh_username', 'ssh_credential'],
  }
}

function blockedResult(operation: FleetOperation, ip: string, reason: string): FleetToolResult {
  return {
    schema: 1, ok: false, operation, ip, phase: 'blocked', execution_available: false,
    needs_input: false, run_created: false, probe_executed: false, reason,
  }
}

function executionSessionId(exec: ToolExecutionLike): string | undefined {
  const value = exec.agent?.session?.id ?? exec.agent?.session?.header?.id
  return value === undefined || value === null || value === '' ? undefined : String(value)
}

interface StageSpec {
  stage: number
  id: string
  executor_id: string
  execution_mode?: 'probe-gate' | 'reconcile'
  required_checks?: string[]
  required_units?: string[]
  required_unit_template?: { format?: string; count_from?: string }
  allowed_facts?: Record<string, unknown>
}

function contractStages(config: PreparedConfig): StageSpec[] {
  const stages = (config.contract as any).stages
  if (!Array.isArray(stages) || stages.length !== 10) throw new Error('component-contract-stages-invalid')
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]
    if (!stage || stage.stage !== index + 1 || typeof stage.id !== 'string' || typeof stage.executor_id !== 'string') {
      throw new Error('component-contract-stage-invalid')
    }
    if (stage.execution_mode !== undefined && !['probe-gate', 'reconcile'].includes(stage.execution_mode)) {
      throw new Error('component-contract-execution-mode-invalid')
    }
  }
  return stages as StageSpec[]
}

function safeReason(value: unknown, fallback: string): string {
  const reason = String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96)
  return /^[a-z0-9][a-z0-9._-]{0,95}$/.test(reason) ? reason : fallback
}

function checkedRun(value: unknown, config: PreparedConfig, ip: string, sessionId: string): FleetLedgerRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ledger-run-invalid')
  const run = value as FleetLedgerRun
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(String(run.id))
    || run.nodeId !== `host-${ip.replaceAll('.', '-')}` || run.ip !== ip || run.sessionId !== sessionId
    || !['new', 'adopt', 'verify-only', 'repair'].includes(run.mode)
    || !['running', 'blocked', 'failed', 'complete'].includes(run.status)
    || !Number.isSafeInteger(run.currentStage) || run.currentStage < 0 || run.currentStage > 10
    || !Number.isSafeInteger(run.revision) || run.revision < 1
    || !Number.isSafeInteger(run.leaseEpoch) || run.leaseEpoch < 1
    || typeof run.writeChallenge !== 'string' || !run.writeChallenge
    || run.contractVersion !== config.contractSha256 || run.executorVersion !== config.executorVersion
    || !/^sha256:[0-9a-f]{64}$/.test(String(run.targetFingerprint))
    || ![1, 2].includes(Number(run.browserCount))) throw new Error('ledger-run-invalid')
  return run
}

function assertRunBinding(run: FleetLedgerRun, inventory: Record<string, unknown>, config: PreparedConfig): void {
  const provenance = inventory.provenance as Record<string, unknown>
  const desired = inventory.desired as Record<string, unknown>
  if (run.targetFingerprint !== provenance.target_fingerprint || run.browserCount !== desired.browser_count
    || run.contractVersion !== config.contractSha256 || run.executorVersion !== config.executorVersion) {
    throw new Error('ledger-run-binding-mismatch')
  }
}

function assertLeaseOwner(run: FleetLedgerRun, config: PreparedConfig): void {
  if (run.leaseOwner !== config.workerId) throw new Error('ledger-lease-owner-mismatch')
}

function assertRunAdvance(before: FleetLedgerRun, after: FleetLedgerRun, leaseAdvance: 0 | 1): void {
  if (after.id !== before.id || after.revision !== before.revision + 1
    || after.leaseEpoch !== before.leaseEpoch + leaseAdvance || after.writeChallenge === before.writeChallenge) {
    throw new Error('ledger-cas-advance-invalid')
  }
}

function nextAttempt(stages: Array<Record<string, unknown>>, stage: number): number {
  const rows = stages.filter(row => Number(row.stage) === stage).sort((a, b) => Number(b.attempt) - Number(a.attempt))
  if (!rows.length) return 1
  return rows[0].status === 'running' ? Number(rows[0].attempt) : Number(rows[0].attempt) + 1
}

function latestAttempt(stages: Array<Record<string, unknown>>, stage: number): Record<string, unknown> | undefined {
  return stages.filter(row => Number(row.stage) === stage).sort((a, b) => Number(b.attempt) - Number(a.attempt))[0]
}

function stageAssessment(assessment: Record<string, unknown>, stage: number): Record<string, unknown> {
  const components = Array.isArray(assessment.components) ? assessment.components : []
  const item = components.find(value => value && typeof value === 'object' && Number(value.stage) === stage)
  if (!item) throw new Error('runtime-assessment-stage-missing')
  return item as Record<string, unknown>
}

function startMode(inventory: Record<string, unknown>, assessment: Record<string, unknown>, prior: FleetLedgerStatus): FleetLedgerRun['mode'] {
  if (prior.ok && prior.run && ['running', 'blocked'].includes(prior.run.status)) return prior.run.mode
  const fleet = inventory.fleet as Record<string, unknown> | undefined
  const stages = Array.isArray(assessment.components) ? assessment.components : []
  const complete = fleet?.registered === true && fleet.reachable === true
    && fleet.node_id === `host-${String(inventory.ip).replaceAll('.', '-')}`
    && stages.length === 10 && stages.every(item => item && typeof item === 'object' && (item as Record<string, unknown>).health === 'healthy')
  if (complete) return 'verify-only'
  const components = inventory.components as Record<string, unknown> | undefined
  const durable = ['standard-account', 'vault-login', 'mihomo', 'clash-control-plane', 'browser-vnc', 'cloudflare-publication', 'fleet-registration']
  const existing = fleet?.registered === true || durable.some(name => {
    const component = components?.[name]
    if (!component || typeof component !== 'object' || Array.isArray(component)) return false
    const row = component as Record<string, unknown>
    const units = row.units && typeof row.units === 'object' && !Array.isArray(row.units)
      ? Object.values(row.units as Record<string, unknown>) : []
    return row.present === true || units.some(unit => unit && typeof unit === 'object' && (unit as Record<string, unknown>).exists === true)
  })
  if (!existing) return 'new'
  return prior.ok && prior.run ? 'repair' : 'adopt'
}

function stageObservation(inventory: Record<string, unknown>, stage: StageSpec): Record<string, unknown> {
  const components = inventory.components as Record<string, unknown>
  let source = components?.[stage.id]
  if (!source && stage.stage === 10) {
    const fleet = inventory.fleet as Record<string, unknown>
    if (fleet?.registered === true) {
      source = { present: true, healthy: fleet.reachable === true, checks: { registered: true, readback: true, reachable: fleet.reachable === true } }
    }
  }
  return source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : {}
}

function receiptProof(inventory: Record<string, unknown>, stage: StageSpec): { checks: Record<string, boolean>; units: Record<string, unknown>; facts: Record<string, unknown> } {
  const source = stageObservation(inventory, stage)
  const sourceChecks = source.checks && typeof source.checks === 'object' ? source.checks as Record<string, unknown> : {}
  const sourceUnits = source.units && typeof source.units === 'object' ? source.units as Record<string, unknown> : {}
  const sourceFacts = source.facts && typeof source.facts === 'object' ? source.facts as Record<string, unknown> : {}
  const checks = Object.fromEntries((stage.required_checks ?? []).filter(key => typeof sourceChecks[key] === 'boolean').map(key => [key, sourceChecks[key]])) as Record<string, boolean>
  const requiredUnits = [...(stage.required_units ?? [])]
  if (stage.required_unit_template?.format) {
    const count = Number((inventory.desired as any)?.browser_count)
    for (let index = 1; index <= count; index += 1) requiredUnits.push(stage.required_unit_template.format.replace('{index}', String(index)))
  }
  const units = Object.fromEntries(requiredUnits.filter(key => sourceUnits[key] && typeof sourceUnits[key] === 'object').map(key => [key, sourceUnits[key]]))
  const facts = Object.fromEntries(Object.keys(stage.allowed_facts ?? {}).filter(key => sourceFacts[key] !== undefined).map(key => [key, sourceFacts[key]]))
  return { checks, units, facts }
}

function signedReceipt(config: PreparedConfig, run: FleetLedgerRun, inventory: Record<string, unknown>, stage: StageSpec, input: {
  attempt: number; status: 'running' | 'passed' | 'blocked' | 'failed'; action: 'checked' | 'reused' | 'installed' | 'repaired' | 'blocked';
  reasonCode: string; failureClass?: 'repairable' | 'needs-user' | 'fatal'
}): Record<string, unknown> {
  const provenance = inventory.provenance as Record<string, unknown>
  const evidence: Record<string, unknown> = {
    origin: 'dsh-fleet-probe-v1', observedAt: provenance.observed_at,
    targetFingerprint: provenance.target_fingerprint, contractVersion: run.contractVersion,
    executorVersion: run.executorVersion, runId: run.id, nodeId: run.nodeId, ip: run.ip,
    sessionId: run.sessionId, workerId: config.workerId, revision: run.revision,
    leaseEpoch: run.leaseEpoch, writeChallenge: run.writeChallenge, stage: stage.stage,
    attempt: input.attempt, status: input.status, component: stage.id, action: input.action,
    reasonCode: safeReason(input.reasonCode, 'host-runtime-failed'), ...receiptProof(inventory, stage),
  }
  if (input.failureClass) evidence.failureClass = input.failureClass
  evidence.attestation = `hmac-sha256:${createHmac('sha256', config.hmacKey).update(canonical(evidence)).digest('hex')}`
  return evidence
}

function failureClass(disposition: unknown): 'repairable' | 'needs-user' | 'fatal' {
  if (disposition === 'fatal') return 'fatal'
  if (disposition === 'needs-user') return 'needs-user'
  return 'repairable'
}

function isCloudStage(stage: number): stage is 5 | 6 | 7 | 8 | 10 {
  return [5, 6, 7, 8, 10].includes(stage)
}

function isHostStage(stage: number): stage is 2 | 4 | 9 {
  return stage === 2 || stage === 4 || stage === 9
}

function projectLedger(operation: 'status' | 'report', ip: string, value: FleetLedgerStatus, executionAvailable: boolean): FleetToolResult {
  if (!value.ok || !value.run) return { ...blockedResult(operation, ip, 'onboarding-run-not-found'), execution_available: executionAvailable }
  const run = value.run
  const stages = (value.stages ?? []).map(row => ({
    stage: Number(row.stage), attempt: Number(row.attempt), status: row.status, component: row.component,
    action: row.action, failure_class: row.failureClass ?? null, note: row.note ?? '',
    started_at: row.startedAt ?? null, finished_at: row.finishedAt ?? null,
  }))
  const events = (value.events ?? []).map(row => ({
    id: Number(row.id), at: row.at ?? null, kind: row.kind, stage: row.stage ?? null, status: row.status ?? null,
  }))
  const result: FleetToolResult = {
    schema: 1, ok: true, operation, ip, phase: run.status, execution_available: executionAvailable,
    needs_input: false, run_created: false, probe_executed: false, run_id: run.id,
    revision: run.revision, current_stage: run.currentStage, stages, events,
  }
  if (operation === 'report') {
    result.report_available = Boolean(run.report)
    if (run.report) result.report = run.report
  }
  assertNoSecrets(result, 'tool-result')
  return result
}

/** Production-capable only when a trusted credential broker, probe and central ledger are supplied. */
export class SubprocessFleetOnboardAdapter implements FleetOnboardHostAdapter {
  private constructor(private readonly config: PreparedConfig) {}

  static async create(config: SubprocessFleetAdapterConfig): Promise<SubprocessFleetOnboardAdapter> {
    const prepared = await prepareConfig(config)
    contractStages(prepared)
    if (prepared.executor) {
      try {
        const capabilities = await runJsonProcess(
          prepared.executor, ['capabilities'], {}, safeEnvironment(prepared.environment), undefined,
          Math.min(prepared.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS, 10_000),
        )
        const stages = Array.isArray(capabilities.stages) ? capabilities.stages : []
        const expectedStages = contractStages(prepared).filter(stage => isHostStage(stage.stage))
        const configured = expectedStages.every(expected => {
          const stage = stages.find(capability => capability?.stage === expected.stage)
          const expectedMode = expected.stage === 9 ? 'probe-gate' : 'reconcile'
          return stage?.component === expected.id && stage.executor_id === expected.executor_id
            && stage.execution_mode === expectedMode && stage.execution === 'configured'
        })
        if (capabilities.schema !== 1 || capabilities.ok !== true || capabilities.probe !== 'configured'
          || !configured) prepared.executor = undefined
      } catch { prepared.executor = undefined }
    }
    return new SubprocessFleetOnboardAdapter(prepared)
  }

  get executionAvailable(): boolean { return Boolean(this.config.executor && this.config.ledger && this.config.cloud) }

  private async inventory(ip: string, profile: FleetProfile, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const raw = await runJsonProcess(this.config.probe, [], { schema: 1, operation: 'probe', ip }, env, signal, this.config.timeoutMs)
    return verifiedProbeInventory(raw, ip, profile, this.config)
  }

  private async assess(inventory: Record<string, unknown>, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const state = await mkdtemp(join(this.config.tempRoot ?? tmpdir(), 'dsh-fleet-assess-'))
    await chmod(state, 0o700)
    try {
      const result = await runJsonProcess(this.config.runtime, ['assess', '--inventory', '-', '--state-dir', state], inventory, env, signal, this.config.timeoutMs)
      if (result.schema !== 1 || result.ok !== true || result.ip !== inventory.ip || !Array.isArray(result.components)) {
        throw new Error('runtime-assessment-invalid')
      }
      return result
    } finally { await rm(state, { recursive: true, force: true }) }
  }

  private async record(run: FleetLedgerRun, evidence: Record<string, unknown>, signal?: AbortSignal): Promise<FleetLedgerRun> {
    const response = await this.config.ledger!.record({
      runId: run.id, expectedRevision: run.revision, expectedLeaseEpoch: run.leaseEpoch,
      workerId: this.config.workerId, writeChallenge: run.writeChallenge, evidence,
    }, signal)
    if (!response.ok || !response.run) throw new Error('ledger-record-failed')
    const after = checkedRun(response.run, this.config, run.ip, run.sessionId)
    assertRunAdvance(run, after, 0)
    assertRunBinding(after, { provenance: { target_fingerprint: run.targetFingerprint }, desired: { browser_count: run.browserCount } }, this.config)
    assertLeaseOwner(after, this.config)
    return after
  }

  private async finish(run: FleetLedgerRun, status: 'complete' | 'failed', inventory: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<FleetLedgerRun> {
    const completionEvidence: Record<string, unknown> = {
      origin: 'dsh-fleet-onboard-finish-v1', observedAt: new Date().toISOString(),
      targetFingerprint: run.targetFingerprint, runId: run.id, nodeId: run.nodeId, ip: run.ip,
      sessionId: run.sessionId, workerId: this.config.workerId, revision: run.revision,
      leaseEpoch: run.leaseEpoch, writeChallenge: run.writeChallenge, status,
    }
    completionEvidence.attestation = `hmac-sha256:${createHmac('sha256', this.config.hmacKey).update(canonical(completionEvidence)).digest('hex')}`
    const response = await this.config.ledger!.finish({
      runId: run.id, expectedRevision: run.revision, expectedLeaseEpoch: run.leaseEpoch,
      workerId: this.config.workerId, writeChallenge: run.writeChallenge, status, completionEvidence,
      ...(status === 'complete' && inventory ? { inventoryEvidence: inventory } : {}),
    }, signal)
    if (!response.ok || !response.run) throw new Error('ledger-finish-failed')
    const after = checkedRun(response.run, this.config, run.ip, run.sessionId)
    assertRunAdvance(run, after, 0)
    if (after.status !== status || after.leaseOwner !== null) throw new Error('ledger-finish-state-invalid')
    return after
  }

  private async executeStage(run: FleetLedgerRun, inventory: Record<string, unknown>, stage: StageSpec, assessment: Record<string, unknown>, attempt: number, prior: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ run: FleetLedgerRun; inventory: Record<string, unknown>; assessment: Record<string, unknown>; terminal?: 'running' | 'blocked' | 'failed'; reason?: string; needsInput?: boolean }> {
    const before = stageObservation(inventory, stage)
    const priorAction = prior?.status === 'running' && ['installed', 'repaired'].includes(String(prior.action)) ? prior.action as 'installed' | 'repaired' : undefined
    const action: 'installed' | 'repaired' = priorAction ?? (before.present === true ? 'repaired' : 'installed')
    if (prior?.status !== 'running') {
      const running = signedReceipt(this.config, run, inventory, stage, { attempt, status: 'running', action, reasonCode: `${stage.id}-started` })
      run = await this.record(run, running, signal)
    }
    const operationId = `onboard-${createHash('sha256').update(`${run.id}\0${run.targetFingerprint}\0${stage.stage}\0${attempt}\0${run.executorVersion}`).digest('hex').slice(0, 32)}`
    let actionResult: Record<string, unknown>
    if (isHostStage(stage.stage)) {
      const request: Record<string, unknown> = {
        schema: 1, ip: run.ip, contract_sha256: this.config.contractSha256,
        action: { stage: stage.stage, component: stage.id, executor_id: stage.executor_id, operation_id: operationId, reason: safeReason(assessment.reason, 'component-drifted') },
        inventory,
      }
      request.action_attestation = `hmac-sha256:${createHmac('sha256', this.config.hmacKey).update(canonical(request)).digest('hex')}`
      const output = await runJsonProcess(this.config.executor!, [], request, env, signal, this.config.timeoutMs)
      actionResult = output as Record<string, unknown>
      if (actionResult.schema !== 1 || actionResult.executor_id !== stage.executor_id || actionResult.operation_id !== operationId
        || !['succeeded', 'noop', 'blocked', 'failed'].includes(String(actionResult.outcome))) throw new Error('executor-result-invalid')
    } else if (isCloudStage(stage.stage)) {
      let cloud: FleetOnboardCloudResult
      try {
        // Policy attestation is intentionally absent here: the trusted control plane
        // derives contract, fingerprint and desired state from its own registry.
        cloud = await this.config.cloud!.execute({ schema: 1, operationId, stage: stage.stage, ip: run.ip }, signal)
      } catch {
        actionResult = { outcome: 'failed', disposition: 'fatal', reason_code: 'cloud-workflow-transport-failed' }
        cloud = { status: 'failed', action: null, resultCode: 'cloud-workflow-transport-failed' }
      }
      if (cloud.status === 'queued' || cloud.status === 'running') {
        return { run, inventory, assessment, terminal: 'running', reason: 'operation-still-running' }
      }
      if (cloud.status === 'blocked') {
        const reason = safeReason(cloud.resultCode, 'cloud-workflow-blocked')
        actionResult = {
          outcome: 'blocked', reason_code: reason,
          disposition: reason === 'fleet-machine-disabled' ? 'needs-user' : 'repairable',
        }
      } else if (cloud.status === 'failed') {
        actionResult = { outcome: 'failed', disposition: 'fatal', reason_code: safeReason(cloud.resultCode, 'cloud-workflow-failed') }
      } else {
        actionResult = {
          outcome: cloud.action === 'reused' ? 'noop' : 'succeeded',
          reason_code: safeReason(cloud.resultCode, 'readback-verified'),
        }
      }
    } else {
      throw new Error('stage-executor-route-invalid')
    }
    if (actionResult.outcome === 'blocked' && actionResult.reason_code === 'operation-still-running') {
      return { run, inventory, assessment, terminal: 'running', reason: 'operation-still-running' }
    }
    if (actionResult.outcome === 'succeeded' || actionResult.outcome === 'noop') {
      let nextInventory: Record<string, unknown>
      if (isHostStage(stage.stage)) {
        if (!actionResult.inventory || typeof actionResult.inventory !== 'object' || Array.isArray(actionResult.inventory)) throw new Error('executor-result-inventory-required')
        nextInventory = verifiedProbeInventory({ schema: 1, ok: true, operation: 'probe', ip: run.ip, inventory: actionResult.inventory }, run.ip, 'base', this.config)
      } else {
        nextInventory = await this.inventory(run.ip, 'base', env, signal)
      }
      if ((nextInventory.provenance as any).target_fingerprint !== run.targetFingerprint) throw new Error('executor-target-identity-changed')
      const nextAssessment = await this.assess(nextInventory, env, signal)
      if (stageAssessment(nextAssessment, stage.stage).health !== 'healthy') {
        const reason = isCloudStage(stage.stage) ? 'cloud-postcondition-not-healthy' : 'executor-postcondition-not-healthy'
        const evidence = signedReceipt(this.config, run, nextInventory, stage, {
          attempt, status: 'blocked', action: 'blocked', reasonCode: reason, failureClass: 'repairable',
        })
        run = await this.record(run, evidence, signal)
        return { run, inventory: nextInventory, assessment: nextAssessment, terminal: 'blocked', reason }
      }
      const passedAction = actionResult.outcome === 'noop' ? 'reused' : action
      const passed = signedReceipt(this.config, run, nextInventory, stage, {
        attempt, status: 'passed', action: passedAction, reasonCode: safeReason(actionResult.reason_code, 'verified-healthy'),
      })
      run = await this.record(run, passed, signal)
      return { run, inventory: nextInventory, assessment: nextAssessment }
    }
    const terminal = actionResult.outcome === 'failed' ? 'failed' : 'blocked'
    const disposition = actionResult.disposition
    const evidence = signedReceipt(this.config, run, inventory, stage, {
      attempt, status: terminal, action: 'blocked', reasonCode: safeReason(actionResult.reason_code, 'executor-failed'),
      failureClass: failureClass(disposition),
    })
    run = await this.record(run, evidence, signal)
    return {
      run, inventory, assessment: await this.assess(inventory, env, signal), terminal,
      reason: safeReason(actionResult.reason_code, 'executor-failed'), needsInput: failureClass(disposition) === 'needs-user',
    }
  }

  private async drive(run: FleetLedgerRun, inventory: Record<string, unknown>, assessment: Record<string, unknown>, history: Array<Record<string, unknown>>, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ run: FleetLedgerRun; reason?: string; needsInput?: boolean }> {
    const stages = contractStages(this.config)
    while (run.currentStage < 10) {
      const stage = stages[run.currentStage]
      const observed = stageAssessment(assessment, stage.stage)
      const prior = latestAttempt(history, stage.stage)
      const attempt = nextAttempt(history, stage.stage)
      if (observed.health === 'healthy') {
        const action = prior?.status === 'running' && ['installed', 'repaired'].includes(String(prior.action))
          ? prior.action as 'installed' | 'repaired' : 'reused'
        const evidence = signedReceipt(this.config, run, inventory, stage, {
          attempt, status: 'passed', action, reasonCode: safeReason(observed.reason, 'verified-healthy'),
        })
        run = await this.record(run, evidence, signal)
        history.push({ stage: stage.stage, attempt, status: 'passed' })
        continue
      }
      const probeGate = stage.execution_mode === 'probe-gate'
      const executionConfigured = isHostStage(stage.stage)
        ? Boolean(this.config.executor)
        : isCloudStage(stage.stage) ? Boolean(this.config.cloud) : false
      const unattendedProbeRepair = stage.stage === 9 && probeGate && executionConfigured
      if (observed.disposition !== 'repairable' || !executionConfigured || (probeGate && !unattendedProbeRepair)) {
        const reason = probeGate && !unattendedProbeRepair && observed.disposition === 'repairable'
          ? 'probe-gate-not-satisfied'
          : !executionConfigured && observed.disposition === 'repairable'
            ? (isCloudStage(stage.stage) ? 'cloud-transport-not-configured' : 'executor-not-configured')
            : safeReason(observed.reason, 'component-blocked')
        const classified = probeGate && !unattendedProbeRepair && observed.disposition === 'repairable'
          ? 'needs-user'
          : !executionConfigured && observed.disposition === 'repairable' ? 'repairable' : failureClass(observed.disposition)
        const stageStatus = classified === 'fatal' ? 'failed' : 'blocked'
        const evidence = signedReceipt(this.config, run, inventory, stage, {
          attempt, status: stageStatus, action: 'blocked', reasonCode: reason, failureClass: classified,
        })
        run = await this.record(run, evidence, signal)
        if (stageStatus === 'failed') run = await this.finish(run, 'failed', undefined, signal)
        return { run, reason, needsInput: classified === 'needs-user' }
      }
      const executed = await this.executeStage(run, inventory, stage, observed, attempt, prior, env, signal)
      run = executed.run; inventory = executed.inventory; assessment = executed.assessment
      history.push({ stage: stage.stage, attempt, status: executed.terminal ?? 'passed' })
      if (executed.terminal) {
        if (executed.terminal === 'failed') run = await this.finish(run, 'failed', undefined, signal)
        return { run, reason: executed.reason, needsInput: executed.needsInput }
      }
    }
    return { run: await this.finish(run, 'complete', inventory, signal) }
  }

  private async assessed(operation: 'start' | 'resume', ip: string, profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult> {
    const sessionId = executionSessionId(exec)
    if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(sessionId)) return blockedResult(operation, ip, 'dsh-session-id-unavailable')
    let lease: CredentialLease
    try { lease = await this.config.credentials.resolve(ip, exec) }
    catch { return blockedResult(operation, ip, 'credential-provider-unavailable') }
    if (!lease.available) {
      if (lease.material instanceof Uint8Array) lease.material.fill(0)
      await lease.dispose?.().catch(() => undefined)
      return intakeResult(operation, ip, lease.missing ?? [], this.executionAvailable)
    }
    if (!this.config.ledger) {
      if (lease.material instanceof Uint8Array) lease.material.fill(0)
      await lease.dispose?.().catch(() => undefined)
      return blockedResult(operation, ip, 'production-ledger-unavailable')
    }
    let probeAttempted = false
    let run: FleetLedgerRun | undefined
    let created = false
    try {
      return await withCredentialFile(lease, this.config, async env => {
        probeAttempted = true
        const inventory = await this.inventory(ip, profile, env, exec.signal)
        const assessment = await this.assess(inventory, env, exec.signal)
        const provenance = inventory.provenance as Record<string, unknown>
        const desired = inventory.desired as Record<string, unknown>
        let status: FleetLedgerStatus
        if (operation === 'start') {
          const prior = await this.config.ledger!.status({ ip }, exec.signal)
          if (!prior.ok && prior.error !== 'onboarding run not found' && prior.error !== 'not found') {
            throw new Error('ledger-prior-status-failed')
          }
          const mode = startMode(inventory, assessment, prior)
          const response = await this.config.ledger!.start({
            ip, mode, sessionId, workerId: this.config.workerId, contractVersion: this.config.contractSha256,
            executorVersion: this.config.executorVersion, desiredLine: 'line-100', profile: 'base',
            browserCount: desired.browser_count, targetFingerprint: provenance.target_fingerprint,
            reasonCode: 'user-request', inventoryEvidence: inventory,
          }, exec.signal)
          if (!response.ok || !response.run) throw new Error('ledger-start-failed')
          created = response.created === true
          run = checkedRun(response.run, this.config, ip, sessionId)
          assertRunBinding(run, inventory, this.config)
          if (created) assertLeaseOwner(run, this.config)
          status = created ? { ok: true, run, stages: [], events: [] } : await this.config.ledger!.status({ runId: run.id }, exec.signal)
          if (!created) {
            if (!status.ok || !status.run) throw new Error('ledger-status-failed')
            const observedRun = checkedRun(status.run, this.config, ip, sessionId)
            if (observedRun.id !== run.id || observedRun.revision !== run.revision
              || observedRun.leaseEpoch !== run.leaseEpoch || observedRun.writeChallenge !== run.writeChallenge) {
              throw new Error('ledger-start-status-mismatch')
            }
            run = observedRun
            const latestStage = [...(status.stages ?? [])].sort((a, b) => Number(b.stage) - Number(a.stage) || Number(b.attempt) - Number(a.attempt))[0]
            const finalizeOnly = run.status === 'blocked' && latestStage?.failureClass === 'fatal'
            const resumed = await this.config.ledger!.resume({
              runId: run.id, expectedRevision: run.revision, expectedLeaseEpoch: run.leaseEpoch,
              workerId: this.config.workerId, sessionId, writeChallenge: run.writeChallenge,
              targetFingerprint: provenance.target_fingerprint, inventoryEvidence: inventory,
              ...(finalizeOnly ? { finalizeOnly: true } : {}),
              reasonCode: finalizeOnly ? 'finalize-fatal-run' : (run.status === 'blocked' ? 'retry-repairable-stage' : 'recover-interrupted-run'),
            }, exec.signal)
            if (!resumed.ok || !resumed.run) throw new Error('ledger-resume-failed')
            const next = checkedRun(resumed.run, this.config, ip, sessionId); assertRunAdvance(run, next, 1); run = next
            assertLeaseOwner(run, this.config)
            if (finalizeOnly) {
              run = await this.finish(run, 'failed', undefined, exec.signal)
              return {
                schema: 1, ok: false, operation, ip, phase: 'failed', execution_available: this.executionAvailable,
                needs_input: false, run_created: false, probe_executed: true, run_id: run.id,
                revision: run.revision, current_stage: run.currentStage, report_available: Boolean(run.report),
                reason: 'fatal-stage-finalized',
              }
            }
          }
        } else {
          status = await this.config.ledger!.status({ ip }, exec.signal)
          if (!status.ok || !status.run) throw new Error('ledger-run-not-found')
          const before = checkedRun(status.run, this.config, ip, status.run.sessionId)
          if (before.targetFingerprint !== provenance.target_fingerprint) throw new Error('ledger-target-identity-changed')
          const latestStage = [...(status.stages ?? [])].sort((a, b) => Number(b.stage) - Number(a.stage) || Number(b.attempt) - Number(a.attempt))[0]
          const finalizeOnly = before.status === 'blocked' && latestStage?.failureClass === 'fatal'
          const resumed = await this.config.ledger!.resume({
            runId: before.id, expectedRevision: before.revision, expectedLeaseEpoch: before.leaseEpoch,
            workerId: this.config.workerId, sessionId, writeChallenge: before.writeChallenge,
            targetFingerprint: provenance.target_fingerprint, inventoryEvidence: inventory,
            ...(finalizeOnly ? { finalizeOnly: true } : {}), reasonCode: finalizeOnly ? 'finalize-fatal-run' : 'retry-repairable-stage',
          }, exec.signal)
          if (!resumed.ok || !resumed.run) throw new Error('ledger-resume-failed')
          run = checkedRun(resumed.run, this.config, ip, sessionId); assertRunAdvance(before, run, 1); assertRunBinding(run, inventory, this.config); assertLeaseOwner(run, this.config)
          if (finalizeOnly) {
            run = await this.finish(run, 'failed', undefined, exec.signal)
            return {
              schema: 1, ok: false, operation, ip, phase: 'failed', execution_available: this.executionAvailable,
              needs_input: false, run_created: false, probe_executed: true, run_id: run.id,
              revision: run.revision, current_stage: run.currentStage, report_available: Boolean(run.report),
              reason: 'fatal-stage-finalized',
            }
          }
        }
        const driven = await this.drive(run!, inventory, assessment, status!.stages ?? [], env, exec.signal)
        run = driven.run
        const result: FleetToolResult = {
          schema: 1, ok: run.status === 'complete', operation, ip, phase: run.status,
          execution_available: this.executionAvailable, needs_input: driven.needsInput === true, run_created: operation === 'start' && created,
          probe_executed: true, run_id: run.id, revision: run.revision, current_stage: run.currentStage,
          report_available: Boolean(run.report), ...(driven.reason ? { reason: driven.reason } : {}),
        }
        assertNoSecrets(result, 'tool-result')
        return result
      })
    } catch {
      return {
        ...blockedResult(operation, ip, 'host-adapter-failed'), probe_executed: probeAttempted,
        run_created: operation === 'start' && created,
        ...(run ? { run_id: run.id, revision: run.revision } : {}),
      }
    }
  }

  start(ip: string, profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult> { return this.assessed('start', ip, profile, exec) }
  resume(ip: string, profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult> { return this.assessed('resume', ip, profile, exec) }

  private async query(operation: 'status' | 'report', ip: string, exec: ToolExecutionLike): Promise<FleetToolResult> {
    if (!this.config.ledger) return blockedResult(operation, ip, 'production-ledger-unavailable')
    try {
      const raw = await this.config.ledger[operation]({ ip }, exec.signal)
      return projectLedger(operation, ip, raw, this.executionAvailable)
    } catch { return blockedResult(operation, ip, 'central-ledger-unavailable') }
  }

  status(ip: string, exec: ToolExecutionLike): Promise<FleetToolResult> { return this.query('status', ip, exec) }
  report(ip: string, exec: ToolExecutionLike): Promise<FleetToolResult> { return this.query('report', ip, exec) }
}

class UnavailableFleetAdapter implements FleetOnboardHostAdapter {
  readonly executionAvailable = false
  constructor(private readonly credentials: CredentialProvider = sessionCredentialProvider) {}
  async start(ip: string, _profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult> {
    let lease: CredentialLease
    try { lease = await this.credentials.resolve(ip, exec) }
    catch { return blockedResult('start', ip, 'credential-provider-unavailable') }
    if (!lease.available) { await lease.dispose?.().catch(() => undefined); return intakeResult('start', ip, lease.missing ?? [], false) }
    if (lease.material instanceof Uint8Array) lease.material.fill(0)
    await lease.dispose?.().catch(() => undefined)
    return blockedResult('start', ip, 'production-probe-runtime-executor-unavailable')
  }
  async resume(ip: string, _profile: FleetProfile, exec: ToolExecutionLike): Promise<FleetToolResult> {
    let lease: CredentialLease
    try { lease = await this.credentials.resolve(ip, exec) }
    catch { return blockedResult('resume', ip, 'credential-provider-unavailable') }
    if (!lease.available) { await lease.dispose?.().catch(() => undefined); return intakeResult('resume', ip, lease.missing ?? [], false) }
    if (lease.material instanceof Uint8Array) lease.material.fill(0)
    await lease.dispose?.().catch(() => undefined)
    return blockedResult('resume', ip, 'production-probe-runtime-executor-unavailable')
  }
  async status(ip: string): Promise<FleetToolResult> { return blockedResult('status', ip, 'production-runtime-unavailable') }
  async report(ip: string): Promise<FleetToolResult> { return blockedResult('report', ip, 'production-runtime-unavailable') }
}

const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    schema: { type: 'number', required: true }, ok: { type: 'boolean', required: true },
    operation: { type: 'string', required: true }, ip: { type: 'string', required: true },
    phase: { type: 'string', required: true }, execution_available: { type: 'boolean', required: true },
    needs_input: { type: 'boolean', required: true }, run_created: { type: 'boolean', required: true },
    probe_executed: { type: 'boolean', required: true }, reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
  },
} as const

const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

function strictTool(defineTool: (spec: any) => any, spec: any, allowed: readonly string[]): any {
  const execute = spec.execute
  spec.execute = (args: unknown, exec: ToolExecutionLike) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object')
    const extra = Object.keys(args).filter(key => !allowed.includes(key))
    if (extra.length) throw new Error(`unsupported tool argument: ${extra[0]}`)
    return execute(args, exec)
  }
  const definition = defineTool(spec)
  // DSH's authoring API compiles an implicit open parameter root. Tighten the
  // advertised JSON Schema as well as the execute-side check above.
  if (definition.parameters?.type === 'object') definition.parameters = { ...definition.parameters, additionalProperties: false }
  else {
    const properties = definition.parameters ?? {}
    definition.parameters = {
      type: 'object', properties, additionalProperties: false,
      required: Object.entries(properties).filter(([, value]: any) => value?.required === true).map(([key]) => key),
    }
  }
  return definition
}

/** Register exactly four intent-only tools. */
export async function registerFleetOnboardTools(ctx: any, adapter: FleetOnboardHostAdapter = new UnavailableFleetAdapter()): Promise<() => void> {
  const defineTool: (spec: any) => any = process.env.NODE_ENV === 'test' ? (spec => spec) : (await import('@deepseek-ai/dsh-tools')).defineTool
  const disposers = [
    ctx.tools.register(strictTool(defineTool, {
      name: 'fleet_onboard_start',
      description: '开始或幂等评估一个基础 Fleet 节点。宿主自行取得凭据、探测并执行；模型只提供 IP。',
      parameters: {
        ip: { type: 'string', required: true, description: '完整 IPv4 地址。' },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: any, exec: ToolExecutionLike) { return adapter.start(requireIp(args.ip), 'base', exec) },
    }, ['ip'])),
    ctx.tools.register(strictTool(defineTool, {
      name: 'fleet_onboard_status',
      description: '读取一个 Fleet 接入事务的当前状态，不连接目标机。',
      parameters: { ip: { type: 'string', required: true, description: '完整 IPv4 地址。' } },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: any, exec: ToolExecutionLike) { return adapter.status(requireIp(args.ip), exec) },
    }, ['ip'])),
    ctx.tools.register(strictTool(defineTool, {
      name: 'fleet_onboard_resume',
      description: '按宿主持久状态恢复一个可恢复的 Fleet 接入事务。',
      parameters: {
        ip: { type: 'string', required: true, description: '完整 IPv4 地址。' },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: any, exec: ToolExecutionLike) { return adapter.resume(requireIp(args.ip), 'base', exec) },
    }, ['ip'])),
    ctx.tools.register(strictTool(defineTool, {
      name: 'fleet_onboard_report',
      description: '读取 Fleet 接入事务的脱敏验收报告，不连接目标机。',
      parameters: { ip: { type: 'string', required: true, description: '完整 IPv4 地址。' } },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: any, exec: ToolExecutionLike) { return adapter.report(requireIp(args.ip), exec) },
    }, ['ip'])),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export interface FleetOnboardPluginConfig { skillRoot?: string }

export async function apply(ctx: Context, pluginConfig: FleetOnboardPluginConfig = {}): Promise<void> {
  let credentials: CredentialProvider = sessionCredentialProvider
  let adapter: FleetOnboardHostAdapter | undefined
  try {
    const requestedRoot = pluginConfig.skillRoot || process.env.FLEET_ONBOARD_SKILL_ROOT || ''
    if (!isAbsolute(requestedRoot)) throw new Error('fleet-onboard-skill-root-required')
    const skillRoot = await realpath(requestedRoot)
    const scripts = join(skillRoot, 'scripts')
    const credentialCommand = { executable: join(scripts, 'vault-credential-provider.py') }
    const vaultEnvironment: Record<string, string> = {
      FLEET_ONBOARD_VAULT_RESOLVE_URL: process.env.FLEET_ONBOARD_VAULT_RESOLVE_URL || 'https://fleet.vyibc.com/mcp/fleet-onboard-vault',
    }
    if (process.env.FLEET_ONBOARD_VAULT_RESOLVE_TOKEN) {
      vaultEnvironment.FLEET_ONBOARD_VAULT_RESOLVE_TOKEN = process.env.FLEET_ONBOARD_VAULT_RESOLVE_TOKEN
    }
    credentials = await VaultFirstCredentialProvider.create({ command: credentialCommand, environment: vaultEnvironment })

    const agentUrl = process.env.FLEET_ONBOARD_AGENT_MCP_URL
    const agentToken = process.env.FLEET_ONBOARD_AGENT_TOKEN
    const executorUrl = process.env.FLEET_ONBOARD_EXECUTOR_MCP_URL
    const executorToken = process.env.FLEET_ONBOARD_EXECUTOR_TOKEN
    const workerId = process.env.FLEET_ONBOARD_WORKER_ID
    const executorVersion = process.env.FLEET_ONBOARD_EXECUTOR_VERSION
    const hmacKeyFile = process.env.FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE
    const hostConfig = process.env.FLEET_ONBOARD_HOST_CONFIG_FILE
    const cloudUrl = process.env.FLEET_ONBOARD_CLOUD_URL
    const cloudToken = process.env.FLEET_ONBOARD_CLOUD_TOKEN
    if (!agentUrl || !agentToken || !executorUrl || !executorToken || !workerId || !executorVersion || !hmacKeyFile || !hostConfig) {
      throw new Error('fleet-onboard-host-configuration-incomplete')
    }
    const vaultToken = process.env.FLEET_ONBOARD_VAULT_RESOLVE_TOKEN
    if (!vaultToken || vaultToken === agentToken || vaultToken === executorToken) throw new Error('fleet-onboard-scoped-tokens-must-be-distinct')
    const ledger = new HttpFleetOnboardLedger({ agentUrl, agentToken, executorUrl, executorToken, workerId })
    const hostAdapter = { executable: join(scripts, 'host-adapter.py') }
    const executionEnabled = process.env.FLEET_ONBOARD_EXECUTION_ENABLED === '1'
    if (Boolean(cloudUrl) !== Boolean(cloudToken)) throw new Error('fleet-onboard-cloud-configuration-incomplete')
    if (cloudToken && [agentToken, executorToken, vaultToken].includes(cloudToken)) {
      throw new Error('fleet-onboard-scoped-tokens-must-be-distinct')
    }
    const cloud = cloudUrl && cloudToken ? new HttpFleetOnboardCloudTransport({ url: cloudUrl, token: cloudToken }) : undefined
    adapter = await SubprocessFleetOnboardAdapter.create({
      credentials, ledger, probe: hostAdapter, runtime: { executable: join(scripts, 'onboard-runtime.py') },
      ...(executionEnabled ? { executor: hostAdapter } : {}),
      ...(cloud ? { cloud } : {}),
      contractFile: join(skillRoot, 'component-contract.json'), hmacKeyFile,
      hmacForbiddenValues: [agentToken, executorToken, vaultToken, ...(cloudToken ? [cloudToken] : [])],
      environment: { FLEET_ONBOARD_HOST_CONFIG_FILE: hostConfig }, workerId, executorVersion,
    })
  } catch { /* Plugin stays loadable, but every unsafe or missing host dependency fails closed. */ }
  await registerFleetOnboardTools(ctx, adapter ?? new UnavailableFleetAdapter(credentials))
}

export { TOOL_NAMES }
