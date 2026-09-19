/** Session facts and a bounded standard-chat loop. Never probes business tools. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { readSpec, userPresetRoot, NATIVE_TOOLS } from './presets.ts'
import { publicToolName } from './filtered-mcp-client.ts'

export const CAPABILITY_TOOLS = ['session_capabilities', 'environment_capabilities']
const STANDARD_LIMIT = 24
export interface CapabilityPolicy {
  standardMaxSteps?: number
  standardMcpInheritance?: 'inherit' | 'discover-only'
  standardSkillInheritance?: 'inherit' | 'discover-only'
  standardExcludedSkills?: string[]
  standardExcludedMcpServers?: string[]
  standardExcludedTools?: string[]
}
const REPEAT_LIMIT = 4
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const digest = (v: any) => createHash('sha256').update(JSON.stringify(canonical(v)) ?? '').digest('hex')
const standard = (agent: any) => !!agent?.session && !agent.session.id.startsWith('task-') && (!agent.session.header?.agentPreset || agent.session.header.agentPreset === 'standard')
const roleOf = (agent: any) => agent?.session?.header?.agentPreset ?? 'standard'
const toolText = (message: any): string => (message?.content ?? []).flatMap((b: any) => b.type === 'tool-result' ? b.content ?? [] : [b]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')

interface McpIdentity { name: string; server: string; rawName: string }

/** Map an Agent-isolated runtime MCP namespace back to its stable authored identity. */
export function resolveMcpToolIdentity(name: string, declared: McpIdentity[], sources: { serverName: string; tools: string[] }[]): McpIdentity | undefined {
  const candidates = [...declared]
  for (const source of sources) for (const rawName of source.tools) {
    const identity = { name: publicToolName(source.serverName, rawName), server: source.serverName, rawName }
    if (!candidates.some(candidate => candidate.name === identity.name)) candidates.push(identity)
  }
  const exact = candidates.find(candidate => candidate.name === name)
  if (exact) return exact
  if (!name.startsWith('mcp__')) return undefined
  return candidates.find(candidate => {
    const suffix = `__${candidate.rawName}`
    if (!name.endsWith(suffix)) return false
    const namespace = name.slice(5, -suffix.length)
    const stable = candidate.server.replace(/[^A-Za-z0-9_-]/g, '_')
    return namespace === stable || namespace.startsWith(`${stable}-`)
  })
}

export class ChatProgress {
  turn = -1
  calls = new Map<string, { key: string; name: string }>()
  results = new Map<string, { hash: string; repeats: number }>()
  reason = ''
  observe(event: any) {
    const d = event.data ?? {}
    if (event.type === 'turn/start') {
      this.turn = d.turn; this.calls.clear(); this.results.clear(); this.reason = ''
    }
    if (event.type === 'tool/call') {
      let args = d.arguments
      try { if (typeof args === 'string') args = JSON.parse(args) } catch { /* retain invalid input fingerprint */ }
      this.calls.set(d.callId, { key: digest([d.name, args]), name: String(d.name) })
    }
    if (event.type !== 'tool/result') return
    const id = d.message?.source?.callId, call = this.calls.get(id)
    if (!call) return
    this.calls.delete(id)
    // Status/wait tools have legitimate polling semantics. Standard chat still has a total budget.
    if (/(?:^|_)(?:status|wait|poll)$/.test(call.name)) return
    const hash = digest(toolText(d.message)), previous = this.results.get(call.key)
    const repeats = previous?.hash === hash ? previous.repeats + 1 : 1
    this.results.set(call.key, { hash, repeats })
    if (repeats >= REPEAT_LIMIT) this.reason = '同一工具和参数已重复返回相同结果，已停止无进展调用。请根据已有结果回答；需要新操作时由用户明确提出。'
  }
  boundary(step: number, maxSteps = STANDARD_LIMIT): string {
    return this.reason || (step > maxSteps ? `普通会话已达到 ${maxSteps} 步预算，已停止继续调用。请缩小本次范围或转交已配置的任务流程。` : '')
  }
}

export class SessionCapabilities {
  private progress = new WeakMap<object, ChatProgress>()
  policy: CapabilityPolicy = {}
  constructor(private ctx: any, private environment: () => Promise<any>, private db: any, private mcpSources: () => { serverName: string; tools: string[] }[] = () => []) {
    db.exec('CREATE TABLE IF NOT EXISTS dsh_session_capability_snapshots (session_id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, request_json TEXT)')
  }
  private state(agent: any) {
    let state = this.progress.get(agent.session)
    if (!state) { state = new ChatProgress(); for (const event of agent.session.events ?? []) state.observe(event); this.progress.set(agent.session, state) }
    return state
  }
  private restricted(schema: any, agent: any) {
    if (!standard(agent)) return false
    return this.policy.standardExcludedTools?.includes(schema.name) ||
      this.policy.standardMcpInheritance === 'discover-only' && schema.name.startsWith('mcp__') ||
      this.policy.standardSkillInheritance === 'discover-only' && schema.name === 'skill' ||
      this.policy.standardExcludedMcpServers?.some(server => /^[A-Za-z0-9_-]{1,32}$/.test(server) && schema.name.startsWith(`mcp__${server}__`)) ||
      this.mcpSources().some(m => this.policy.standardExcludedMcpServers?.includes(m.serverName) && m.tools.some(n => publicToolName(m.serverName, n) === schema.name))
  }
  private skillRestricted(name: string, agent: any) {
    return standard(agent) && (this.policy.standardSkillInheritance === 'discover-only' || this.policy.standardExcludedTools?.includes('skill') || this.policy.standardExcludedSkills?.includes(name))
  }
  private filterSkillMessages(messages: any[], agent: any) {
    return messages.flatMap(message => {
      const source = message.source ?? {}
      if (source.kind === 'skill-invocation' && this.skillRestricted(source.name, agent)) return []
      if (source.kind !== 'skill-catalog' || !Array.isArray(source.entries)) return [message]
      const entries = source.entries.filter((s: any) => !this.skillRestricted(s.name, agent))
      if (entries.length === source.entries.length) return [message]
      return [{ ...message, source: { ...source, entries }, content: [{ type: 'text', text: `当前允许按需加载的 Skill（替代之前的目录；未列出的被当前策略排除）：\n${entries.map((s: any) => JSON.stringify({ name: s.name, description: s.description })).join('\n')}\n执行匹配任务前使用 skill 工具加载完整说明；目录不是授权绕过其他工具限制。` }] }]
    })
  }
  async describe(agent: any, exposed?: any[]) {
    const session = agent.session, role = roleOf(agent)
    const spec = /^[a-zA-Z0-9_-]+$/.test(role) ? await readSpec(resolve(userPresetRoot(), role)) : null
    const schemas = this.ctx.tools.schemas(agent)
    const available = exposed ?? schemas.filter((s: any) => !this.restricted(s, agent))
    const availableNames = new Set(available.map((s: any) => s.name))
    const declared = new Set<string>(spec ? [...spec.tools.flatMap(id => NATIVE_TOOLS.find(t => t.id === id)?.schemaNames ?? []), ...Object.entries(spec.mcpTools).flatMap(([server, names]) => names.map(n => publicToolName(server, n))), ...(spec.skills.length ? ['skill'] : [])] : [])
    const declaredMcp = spec ? Object.entries(spec.mcpTools).flatMap(([server, names]) => names.map(rawName => ({ name: publicToolName(server, rawName), server, rawName }))) : []
    const mcpSources = this.mcpSources()
    const errors = new Map<string, string>(), loaded = new Set<string>(), calls = new Map<string, any>()
    for (const event of session.events ?? []) {
      const d = event.data ?? {}
      if (event.type === 'user/message' && d.source?.kind === 'skill-invocation' && d.source?.form === 'instructions' && typeof d.source.name === 'string') loaded.add(d.source.name)
      if (event.type === 'tool/call') calls.set(d.callId, d)
      if (event.type !== 'tool/result') continue
      const call = calls.get(d.message?.source?.callId)
      if (!call) continue
      calls.delete(d.message.source.callId)
      const text = toolText(d.message)
      const failed = /^error|"ok"\s*:\s*false|Authentication Fails/i.test(text)
      if (failed) errors.set(call.name, /Authentication Fails|unauthorized|api key.*invalid/i.test(text) ? 'authentication-failed' : /session-required|not.granted|not.authorized|denied/i.test(text) ? 'permission-or-identity-denied' : 'last-call-failed')
      else {
        errors.delete(call.name)
        if (call.name === 'skill') { try { loaded.add(JSON.parse(call.arguments).name) } catch { /* no guessed skill name */ } }
      }
    }
    let skills: any[] = [], skillDiscovery = 'unavailable'
    if (this.ctx.get('skills')) {
      try {
        const catalog = await this.ctx.get('skills').snapshot({ scope: agent, cwd: session.header?.cwd })
        skills = catalog.skills.filter((s: any) => s.invocation?.modelInvocable !== false).map((s: any) => ({ name: s.name, source: spec?.skills.includes(s.name) ? 'agent-definition' : 'environment-inherited', state: this.skillRestricted(s.name, agent) ? 'restricted' : loaded.has(s.name) ? 'loaded-in-session-history' : availableNames.has('skill') ? 'available-on-demand' : 'not-callable', provider: s.provider }))
        skillDiscovery = catalog.complete ? 'complete' : 'partial'
      } catch { skillDiscovery = 'discovery-failed' }
    }
    const registeredStable = new Set<string>()
    const tools = schemas.map((s: any) => {
      const identity = resolveMcpToolIdentity(s.name, declaredMcp, mcpSources)
      if (identity) registeredStable.add(identity.name)
      const stableName = identity?.name ?? s.name
      return { name: stableName, ...(stableName !== s.name ? { runtimeName: s.name } : {}), kind: s.name.startsWith('mcp__') ? 'mcp' : 'native', server: identity?.server ?? null, source: CAPABILITY_TOOLS.includes(s.name) ? 'platform' : declared.has(stableName) ? 'agent-definition' : 'environment-inherited', state: availableNames.has(s.name) ? 'registered' : 'restricted', ...(this.restricted(s, agent) ? { reason: 'explicit-standard-exclusion' } : {}), ...(errors.has(s.name) || errors.has(stableName) ? { lastFailure: errors.get(s.name) ?? errors.get(stableName) } : {}) }
    })
    const out = {
      sessionId: session.id, checkedAt: new Date().toISOString(), live: true,
      inheritancePolicy: { mcp: this.policy.standardMcpInheritance ?? 'inherit', skills: this.policy.standardSkillInheritance ?? 'inherit', excludedSkills: this.policy.standardExcludedSkills ?? [], excludedMcpServers: this.policy.standardExcludedMcpServers ?? [], excludedTools: this.policy.standardExcludedTools ?? [], appliesTo: 'standard-native-session', maxSteps: this.policy.standardMaxSteps ?? STANDARD_LIMIT },
      definition: { role, name: spec?.name, authored: !!spec, observation: spec ? 'task-console-definition' : 'no-task-console-definition; use runtime facts, not an assumed empty preset', tools: [...declared], skills: spec?.skills ?? [] },
      current: { tools, skills, skillDiscovery, permissionPreset: this.ctx.get('permissionPresets')?.current(session.events ?? []) ?? 'not-observed', configuredButNotRegistered: [...declared].filter(n => !schemas.some((s: any) => s.name === n) && !registeredStable.has(n)) },
      answerContract: { language: '用户当前消息的语言', registeredIsNotAuthorized: true, cannotCall: tools.filter((t: any) => t.state === 'restricted').map((t: any) => t.name), requiredCaveat: '必须单独说明受限工具不可调用；其余已注册工具也不保证凭据有效或具体操作获授权。禁止总结为全部能力都可使用。Skill 是可按需加载，不等于已加载。' },
      boundaries: ['registered 表示当前工具已注册，不保证凭据有效或目标操作获授权。', '历史加载的 Skill 不证明其全文仍保留在当前上下文。', '底层 CLI 自行加载的能力未获得运行时证据时标为未知，不能算作已加载。'],
      cliInheritance: /^(codex|claude)-local$/.test(session.requestHeader?.()?.config?.provider ?? agent.options?.provider ?? '') ? 'not-observed' : 'not-applicable-to-native-tool-surface',
    }
    this.db.prepare('INSERT INTO dsh_session_capability_snapshots (session_id,checked_at,snapshot_json) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET checked_at=excluded.checked_at,snapshot_json=excluded.snapshot_json').run(session.id, out.checkedAt, JSON.stringify(out))
    return this.withRequest(out)
  }
  private withRequest(value: any) {
    const row = this.db.prepare('SELECT request_json FROM dsh_session_capability_snapshots WHERE session_id=?').get(value.sessionId)
    return { ...value, lastModelRequest: row?.request_json ? JSON.parse(row.request_json) : null }
  }
  async read(sessionId: string) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) throw Error('Invalid session ID')
    const agent = this.ctx.agents.get(sessionId)
    if (agent) return this.describe(agent)
    const row = this.db.prepare('SELECT snapshot_json FROM dsh_session_capability_snapshots WHERE session_id=?').get(sessionId)
    return row ? this.withRequest({ ...JSON.parse(row.snapshot_json), live: false, notice: '历史快照；会话未加载，不能代表当前可调用能力。' }) : { sessionId, live: false, notice: '没有运行时快照；不启动会话或猜测已加载能力。' }
  }
  async install() {
    const disposers: (() => void)[] = []
    const defineTool = process.env.NODE_ENV === 'test' ? (s: any) => s : (await import('@deepseek-ai/dsh-tools')).defineTool
    for (const name of CAPABILITY_TOOLS) disposers.push(this.ctx.tools.register(defineTool({
      name, description: name === 'session_capabilities' ? '只读查询当前会话真实能力：角色定义、实际注册工具、按需 Skill、环境继承及最近失败。问你有哪些能力时先使用本工具；不要试调用业务工具。' : '只读查询环境已安装能力和已配置 Agent；目录不授予执行权限，不安装、不委派、不运行业务工具。',
      parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: (_: any, v: any) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async (_: any, exec: any) => {
        if (!exec.agent?.session) throw Error('Live session required')
        return name === 'session_capabilities' ? this.describe(exec.agent) : this.environment()
      },
    })))
    disposers.push(this.ctx.tools.guard((exec: any) => {
      if (!standard(exec.agent)) return
      const schema = this.ctx.tools.get(exec.name, exec.agent)
      if (schema && this.restricted(schema, exec.agent) || exec.name === 'skill' && this.skillRestricted(exec.arguments?.name, exec.agent)) return '管理员显式排除了通用 Agent 的这项能力。不得通过其他工具绕过；原生鉴权与审批仍然适用。'
      return this.state(exec.agent).reason || undefined
    }))
    disposers.push(this.ctx.on('session/event', (session: any, event: any) => {
      if (event.type === 'request/header') {
        const header = event.data?.header ?? {}, checkedAt = new Date(event.time ?? Date.now()).toISOString()
        const request = { checkedAt, provider: header.config?.provider, model: header.config?.model, tools: (header.tools ?? []).map((s: any) => s.name) }
        // Persist only allowlisted runtime metadata, never prompt, tool arguments, credentials or schemas.
        this.db.prepare('INSERT INTO dsh_session_capability_snapshots (session_id,checked_at,snapshot_json,request_json) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET request_json=excluded.request_json')
          .run(session.id, checkedAt, JSON.stringify({ sessionId: session.id, checkedAt, live: false, definition: { role: session.header?.agentPreset ?? 'standard' } }), JSON.stringify(request))
      }
      const state = this.progress.get(session)
      if (state) state.observe(event)
    }))
    disposers.push(this.ctx.on('system-prompt/assemble', async (_assembly: any, context: any, next: any) => {
      const assembly = await next(), agent = context.scope
      if (!agent?.session) return assembly
      const tools = assembly.tools.filter((s: any) => !this.restricted(s, agent))
      // Do not inject an expensive full catalog into every LLM request.
      if (!standard(agent)) return { ...assembly, tools }
      this.state(agent)
      // Complete role prompts replace sections after this hook; runtime contexts are retained.
      return { ...assembly, tools, contexts: [...(assembly.contexts ?? []), { name: 'task-console:capability-truth', text: `每次能力自述必须重新查询 session_capabilities；环境目录使用 environment_capabilities。用用户当前语言回答。必须单列受限不可调用项，禁止将全部注册能力称为可以使用。查询有哪些 Skill/MCP/工具时，仅查询目录并直接回答，禁止通过执行、加载 Skill 正文或探测业务来枚举。已安装、当前可见、已注册、授权及验证通过是不同状态。身份由宿主提供，不猜测 sessionId/operationId。缺少能力时说明缺项并推荐目录中的 Agent；未获得委派接口回执，不得声称已委派。普通会话最多${this.policy.standardMaxSteps ?? STANDARD_LIMIT}步；相同参数与结果反复出现时必须总结收口。` }] }
    }))
    disposers.push(this.ctx.on('agent/pre-step', async (input: any, next: any) => {
      const decision = await next()
      if (decision.kind === 'reject' || !standard(input.agent)) return decision
      const reason = this.state(input.agent).boundary(input.step, this.policy.standardMaxSteps ?? STANDARD_LIMIT)
      if (reason) throw Error(`SESSION_PROGRESS_GUARD: ${reason}`)
      return { ...decision, messages: this.filterSkillMessages(decision.messages, input.agent) }
    }, { prepend: true }))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }
}
