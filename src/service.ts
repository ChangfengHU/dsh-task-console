/**
 * The `taskConsole` Remote service.
 *
 * Reads the live composition (which MCP servers the host runs, which tools
 * they registered), the skill library, and the preset roster; writes preset
 * directories; and runs the one experiment that proves a preset does what
 * the editor says — a real session on it, reporting the exact tool list dsh
 * handed the model (`request/header`), not what the model claims.
 *
 * @module dsh-task-console/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { applyAgentPermission } from './agent-session.ts'
import { discoverLegacyArtifacts, publishHtml, readArtifact } from './artifacts.ts'
import { withFinalArtifact } from './artifact-delivery.ts'
import {
  NATIVE_TOOLS, mask, readSpec, removePreset, renderComposition, scanSkills, userPresetRoot, validateSpec, writePreset,
  type HostMcp,
} from './presets.ts'
import { TaskRunner } from './runner.ts'
import { EventStore, batchStatus, cardRun, foldTurns, nextFire, parseCron, validateTask } from './tasks.ts'
import { TaskIntakeCoordinator, type IntakeAgent } from './task-intake.ts'
import { decideTaskSignalWithAgent } from './task-intake-agent.ts'
import type { Artifact, Card } from './tasks.ts'
import type { ArtifactView, BoardView } from './wire.ts'
import { NAMESPACE } from './wire.ts'
import type { AgentRow, AgentSpec, Catalog, McpServer, Preview, TryRunResult } from './wire.ts'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const TOOL_PREFIX = /^mcp__(.+?)__(.+)$/

/** Models the picker offers besides the deployment default. */
const KNOWN_MODELS = [
  'codex-local/gpt-5.6-terra', 'codex-local/gpt-5.6-mini',
  'claude-local/haiku', 'claude-local/sonnet',
  'llm-deepseek/qwen-plus-latest', 'llm-deepseek/deepseek-v3',
]

export class TaskConsoleService extends TypertRemoteService {
  static inject = ['loader', 'tools', 'agents', 'workspaceRegistry', 'permissionPresets']

  readonly runner: TaskRunner
  readonly intake: TaskIntakeCoordinator
  private readonly ready: Promise<void>

  constructor(ctx: Context) {
    super(ctx, NAMESPACE)
    this.runner = new TaskRunner(ctx, new EventStore(), {
      onSessionCreated: sessionId => this.markTaskSessionInternal(sessionId),
    })
    this.intake = new TaskIntakeCoordinator(this.runner, {
      agents: () => this.intakeAgents(),
      decide: (signal, context) => decideTaskSignalWithAgent(this.ctx as any, signal, context, { markInternal: sessionId => this.markTaskSessionInternal(sessionId) }),
    })
    this.ready = this.runner.start()
      .then(() => this.markExistingTaskSessionsInternal())
      .then(() => this.intake.start())
    void this.ready.catch(err => console.error('[task-console] runner failed to start:', err))
  }

  /** Hide task-owned sessions from ordinary DSH discovery while retaining direct access. */
  private async markTaskSessionInternal(sessionId: string): Promise<void> {
    const registry = (this.ctx as any).get('workspaceRegistry')
    if (!registry?.markSessionInternal) return
    try { await registry.markSessionInternal(sessionId) }
    catch (error) { console.warn(`[task-console] could not mark task session ${sessionId} internal:`, error) }
  }

  /** Migrate every historical task-session relation into the internal set. */
  private async markExistingTaskSessionsInternal(): Promise<void> {
    const projected = [...this.runner.store.s.runs.values()]
      .map(run => run.sessionId).filter((id): id is string => Boolean(id))
    const historical = this.runner.store.all()
      .flatMap(event => event.t === 'run/claimed' || event.t === 'run/session_created' ? [event.sessionId] : [])
    const sessionIds = [...new Set([...projected, ...historical])]
    for (const sessionId of sessionIds) await this.markTaskSessionInternal(sessionId)
  }

  // ── facts ──────────────────────────────────────────────────────────────

  /** MCP servers the HOST composition runs, with the tools they registered. */
  private hostMcp(): (McpServer & HostMcp)[] {
    const registered = new Map<string, string[]>()
    for (const schema of (this.ctx as any).tools.schemas() as { name: string }[]) {
      const m = TOOL_PREFIX.exec(schema.name)
      if (!m) continue
      const list = registered.get(m[1]) ?? []
      list.push(m[2]); registered.set(m[1], list)
    }
    const rows: (McpServer & HostMcp)[] = []
    for (const entry of (this.ctx as any).loader.entries() as any[]) {
      if (entry?.options?.name !== MCP_CLIENT) continue
      const config = (entry.options.config ?? {}) as Record<string, unknown>
      const serverName = String(config.serverName ?? entry.options.id)
      const target = typeof config.url === 'string'
        ? config.url.replace(/\/\/[^@/]+@/, '//••••@')
        : [config.command, ...(Array.isArray(config.args) ? config.args : [])].filter(Boolean).join(' ')
      const disabled = entry.disabled === true || entry.options.disabled === true
      rows.push({ entryId: String(entry.options.id), sourceEntryId: String(entry.options.id), serverName, target, tools: registered.get(serverName) ?? [], disabled, config, live: !disabled })
    }
    return rows
  }

  private hostToolNames(): string[] {
    return ((this.ctx as any).tools.schemas() as { name: string }[]).map(schema => schema.name)
  }

  /** Registered workspaces in sidebar order; empty when the registry is not composed. */
  private workspaces(): { id: string; path: string; title: string }[] {
    try {
      const reg = (this.ctx as any).get('workspaceRegistry')
      return (reg?.list?.() ?? []).map((w: any) => ({ id: String(w.id), path: String(w.path), title: String(w.title ?? w.path.split('/').pop() ?? w.path) }))
    } catch { return [] }
  }

  private defaultModel(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const defaults = (this.ctx as any).get('agentDefaultModel')
    try {
      const sel = defaults?.currentSelection?.()
      if (sel?.provider && sel?.model) return sel
    } catch { /* no default composed */ }
    return undefined
  }

  /** Only authored, tool-compatible presets enter the Task Agent's trusted roster. */
  private async intakeAgents(): Promise<IntakeAgent[]> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return []
    const rows: IntakeAgent[] = []
    for (const preset of await presets.list() as any[]) {
      if (preset.broken || preset.trust !== 'user') continue
      const spec = await readSpec(dirname(String(preset.path)))
      if (!spec || spec.model.startsWith('claude-local')) continue
      rows.push({
        id: spec.id, name: spec.name, description: spec.description, model: spec.model,
        permission: spec.permissionPreset, tools: spec.tools, mcpTools: spec.mcpTools, skills: spec.skills,
        taskExpertise: spec.taskExpertise ?? [],
        toolSchemas: spec.tools.flatMap(id => NATIVE_TOOLS.find(t => t.id === id)?.schemaNames ?? []).concat(Object.entries(spec.mcpTools).flatMap(([server, tools]) => tools.filter(t => t !== '*').map(t => `mcp__${server}__${t}`))),
        toolDescriptions: Object.fromEntries(spec.tools.flatMap(id => { const tool = NATIVE_TOOLS.find(t => t.id === id); return tool ? tool.schemaNames.map(name => [name, tool.description]) : [] })),
      })
      this.runner.rememberName(spec.id, spec.name)
    }
    return rows
  }

  async catalog(): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    const def = this.defaultModel()
    const defaultModel = def ? `${def.provider}/${def.model}` : ''
    const models = [...new Set([defaultModel, ...KNOWN_MODELS].filter(Boolean))]
    const out: Catalog = {
      tools: NATIVE_TOOLS.map(({ rows: _rows, schemaNames: _schemaNames, ...t }) => t),
      mcp: this.hostMcp().map(({ config: _c, live: _l, ...m }) => m),
      skills: await scanSkills(),
      models,
      defaultModel,
      userRoot: presets?.authorable === false ? null : userPresetRoot(),
      workspaces: this.workspaces(),
    }
    return JSON.stringify(out)
  }

  async agents(): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return JSON.stringify([])
    const rows: AgentRow[] = []
    for (const p of await presets.list() as any[]) {
      const dir = dirname(String(p.path))
      const spec = p.trust === 'user' ? await readSpec(dir) : null
      let name = p.name ?? p.id, description = p.description ?? ''
      if (!p.name || !p.description) {
        try {
          const text = await (await import('node:fs/promises')).readFile(`${dir}/preset.yml`, 'utf8')
          const n = /^name:\s*(.*)$/m.exec(text)?.[1]; const d = /^description:\s*(.*)$/m.exec(text)?.[1]
          const unq = (s?: string) => s ? s.trim().replace(/^"(.*)"$/, (_, x) => JSON.parse(`"${x}"`)) : undefined
          name = unq(n) ?? name; description = unq(d) ?? description
        } catch { /* no metadata */ }
      }
      rows.push({ id: p.id, name, description, trust: p.trust, broken: p.broken, path: dir, spec })
    }
    return JSON.stringify(rows)
  }

  // ── authoring ──────────────────────────────────────────────────────────

  async previewAgent(payload: string): Promise<string> {
    const spec = validateSpec(JSON.parse(payload))
    const preview = renderComposition(spec, this.hostMcp(), this.hostToolNames())
    return JSON.stringify({ ...preview, yml: mask(preview.yml) } satisfies Preview)
  }

  async saveAgent(payload: string): Promise<string> {
    const spec = validateSpec(JSON.parse(payload))
    const presets = (this.ctx as any).get('agentPresets')
    if (presets && presets.authorable === false) throw new Error('这个部署没有可写的 preset 根')
    const shipped = presets ? (await presets.list() as any[]).find(p => p.id === spec.id && p.trust === 'system') : undefined
    if (shipped) throw new Error(`"${spec.id}" 是出厂 preset,不能覆盖;换个 id`)
    const { path, preview } = await writePreset(spec, this.hostMcp(), await scanSkills(), userPresetRoot(), this.hostToolNames())
    return JSON.stringify({ path, preview: { ...preview, yml: mask(preview.yml) } })
  }

  async deleteAgent(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    const presets = (this.ctx as any).get('agentPresets')
    const row = presets ? (await presets.list() as any[]).find(p => p.id === id) : undefined
    if (row && row.trust !== 'user') throw new Error('出厂 preset 不能删')
    await removePreset(id)
    return JSON.stringify({ ok: true })
  }

  // ── proof ──────────────────────────────────────────────────────────────

  /**
   * Start a real session on the preset, ask one question, and report what
   * dsh actually handed the model. The session is disposed afterwards but
   * its log stays, so the evidence can be reopened.
   */
  async tryRun(payload: string): Promise<string> {
    const { id, prompt } = JSON.parse(payload) as { id: string; prompt?: string }
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) throw new Error('这个部署没有 preset 服务')
    const preset = await presets.resolve(id)
    if (preset.broken) throw new Error(`preset 坏了:${preset.broken}`)
    const spec = await readSpec(dirname(String(preset.path)))

    let selection = this.defaultModel()
    if (spec?.model && spec.model.includes('/')) {
      const [provider, ...rest] = spec.model.split('/')
      selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) }
    }
    const sessionId = `tc-try-${id}-${Date.now().toString(36)}`
    const started = Date.now()
    const question = prompt?.trim() || '把你当前工具列表里的每个工具名逐行原样列出,不要省略、不要解释。然后用一句话回答:你有 bash 吗?'

    const result: TryRunResult = { sessionId, provider: selection?.provider ?? '', model: selection?.model ?? '', elapsedMs: 0, tools: [], answer: '' }
    let messageId = ''
    let consumed = false
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })

    const dispose = (this.ctx as any).on('session/event', (session: any, event: any) => {
      if (session?.id !== sessionId) return
      if (event.type === 'request/header' && result.tools.length === 0) {
        const tools = event.data?.header?.tools
        if (Array.isArray(tools)) result.tools = tools.map((t: any) => String(t.name))
      }
      if (event.type === 'user/message' && event.data?.id === messageId) consumed = true
      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content
        if (Array.isArray(blocks)) result.answer = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
      }
      if (event.type === 'turn/end' && consumed) {
        const reason = event.data?.reason
        if (reason && reason.kind !== 'completed') result.error = JSON.stringify(reason)
        finish()
      }
    })

    let handle: any
    try {
      handle = await (this.ctx as any).agents.create({
        sessionId,
        ...(selection ? { agentOptions: selection } : {}),
        meta: { cwd: homedir(), agentPreset: preset.id },
        setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
      })
      applyAgentPermission(this.ctx, spec, handle.agent.session)
      messageId = randomUUID()
      handle.agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } })
      const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('120 秒没等到回合结束')), 120_000))
      await Promise.race([done, timeout])
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      try { typeof dispose === 'function' && dispose() } catch { /* already gone */ }
      try { await handle?.dispose?.() } catch { /* already gone */ }
    }
    result.elapsedMs = Date.now() - started
    return JSON.stringify(result)
  }

  // ── chat with an agent ─────────────────────────────────────────────────

  /** Live handles for sessions started from the composer; disposing them would kill the chat. */
  private readonly chats = new Map<string, any>()

  /**
   * Start a root session on an agent's preset, pin a readable title, file it
   * under the workspace, and (optionally) submit the first message. The UI
   * then opens the session; the person keeps talking to it there.
   */
  async startAgentSession(payload: string): Promise<string> {
    const { agentId, text, cwd } = JSON.parse(payload) as { agentId: string; text?: string; cwd?: string }
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) throw new Error('这个部署没有 preset 服务')
    const preset = await presets.resolve(agentId)
    if (preset.broken) throw new Error(`preset 坏了:${preset.broken}`)
    const spec = await readSpec(dirname(String(preset.path)))
    const name = spec?.name ?? preset.name ?? preset.id
    let selection = this.defaultModel()
    if (spec?.model?.includes('/')) { const [provider, ...rest] = spec.model.split('/'); selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) } }
    const workspaces = this.workspaces()
    const dir = cwd && cwd.trim() ? cwd.trim() : (workspaces[0]?.path ?? homedir())
    const sessionId = `agent-${agentId}-${Date.now().toString(36)}`
    const handle = await (this.ctx as any).agents.create({
      sessionId,
      ...(selection ? { agentOptions: selection } : {}),
      meta: { cwd: dir, agentPreset: preset.id },
      setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
    })
    try {
      applyAgentPermission(this.ctx, spec, handle.agent.session)
    } catch (error) {
      try { await handle.dispose?.() } catch { /* creation error wins */ }
      throw error
    }
    this.chats.set(sessionId, handle)
    const head = (text ?? '').trim().replace(/\s+/g, ' ').slice(0, 28)
    try { (this.ctx as any).get('sessionTitle')?.rename?.(handle.agent.session, head ? `${name} · ${head}` : `${name} · 新会话`) } catch { /* cosmetic */ }
    try {
      const registry = (this.ctx as any).get('workspaceRegistry')
      const ws = registry ? (await registry.resolveByPath(dir).catch(() => undefined)) ?? (await registry.create(dir).catch(() => undefined)) : undefined
      await ws?.attachSession?.(sessionId)
    } catch { /* cosmetic */ }
    if (text && text.trim()) handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: text.trim() }], source: { kind: 'user' } })
    return JSON.stringify({ sessionId, agentPreset: preset.id, name })
  }

  // ── turn ledger ────────────────────────────────────────────────────────

  /** Fold one session's own log into turns → steps → tool calls (live or cold). */
  async sessionTurns(payload: string): Promise<string> {
    const { sessionId } = JSON.parse(payload) as { sessionId: string }
    const persistence = (this.ctx as any).get('sessionPersistence')
    let events: any[] = []; let agentPreset: string | undefined
    if (persistence?.inspect) {
      const insp = await persistence.inspect(sessionId)
      events = insp.events ?? []; agentPreset = insp.header?.agentPreset
    } else {
      const live = (this.ctx as any).get('sessions')?.get?.(sessionId)
      events = live?.events ?? []; agentPreset = live?.header?.agentPreset
    }
    return JSON.stringify(foldTurns(sessionId, events, agentPreset))
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  /** Submit one generic, credential-free Signal; the Task Agent routes it asynchronously. */
  async submitTaskSignal(payload: string): Promise<string> {
    await this.ready
    const input = JSON.parse(payload) as { signal?: unknown; wait?: boolean; timeoutMs?: number }
    const view = await this.intake.submit(input && Object.hasOwn(input, 'signal') ? input.signal : input)
    if (input?.wait) return JSON.stringify(await this.intake.wait(view.signal.id, Math.min(Math.max(Number(input.timeoutMs) || 300_000, 1_000), 600_000)))
    return JSON.stringify(view)
  }

  async taskSignal(payload: string): Promise<string> {
    await this.ready
    const { id } = JSON.parse(payload) as { id?: string }
    if (!id) throw new Error('缺少 Signal id')
    const signal = this.intake.get(id)
    if (!signal) throw new Error('没有这个 Task Signal')
    return JSON.stringify({ ...signal, events: this.intake.events(id) })
  }

  async taskSignals(payload: string): Promise<string> {
    await this.ready
    const { limit } = JSON.parse(payload || '{}') as { limit?: number }
    return JSON.stringify(this.intake.list(limit))
  }

  private withNext(t: any) {
    return { ...t, nextFire: t.trigger.kind === 'cron' && t.enabled ? (nextFire(parseCron(t.trigger.expr)!)?.toISOString() ?? null) : null }
  }

  /** Every map as arrays — one payload for the board and the detail page. */
  async board(): Promise<string> {
    const st = this.runner.store.s
    const out: BoardView = {
      tasks: [...st.tasks.values()].map(t => this.withNext(t)),
      batches: [...st.batches.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt)),
      cards: [...st.cards.values()],
      runs: [...st.runs.values()],
    }
    return JSON.stringify(out)
  }

  /**
   * Legacy projection for the 0.4 UI: a batch rendered as the old Run
   * with `legs`. Kept until the 0.5 pages land; then removed.
   */
  async tasks(): Promise<string> {
    const st = this.runner.store.s
    const runs = [...st.batches.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt)).map(b => {
      const legs = b.cardIds.map(id => st.cards.get(id)).filter(Boolean).map(c => {
        const r = cardRun(st, c!)
        const status = c!.status === 'done' ? 'done' : c!.status === 'review' ? 'review' : c!.status === 'running' ? 'running' : c!.status === 'blocked' ? 'blocked' : c!.status === 'failed' ? (r?.status === 'timed_out' ? 'timed_out' : r?.status === 'crashed' ? 'lost' : 'failed') : c!.status === 'cancelled' ? 'cancelled' : 'queued'
        return { agentId: c!.kind === 'gate' ? '系统闸门' : c!.agentId, status, tries: c!.runIds.length, sessionId: r?.sessionId || undefined, startedAt: c!.startedAt, endedAt: c!.endedAt, handoff: c!.summary, question: r?.status === 'blocked' ? r.question : undefined, error: c!.error }
      })
      const bs = batchStatus(st, b)
      const cards = b.cardIds.map(id => st.cards.get(id)).filter(Boolean)
      const artifacts = withFinalArtifact([...st.artifacts.values()].filter(a => a.batchId === b.id), cards as Card[], b)
      const final = artifacts.find(a => a.final)
      const latestArtifact = final ?? artifacts.at(-1)
      const rounds = cards.filter(card => card?.kind === 'gate').length
      return {
        id: b.id, taskId: b.taskId, firedAt: b.firedAt, by: b.by, legs,
        ...(b.settled ? { settled: b.settled } : bs === 'done' ? { settled: { at: b.firedAt, outcome: 'done' } } : {}),
        ...(final ? { finalArtifact: this.artifactView(final) } : {}),
        ...(latestArtifact ? { resultArtifact: this.artifactView(latestArtifact) } : {}),
        ...(rounds ? { rounds, reworks: Math.max(0, rounds - 1) } : {}),
      }
    })
    return JSON.stringify({ tasks: [...st.tasks.values()].map(t => this.withNext(t)), runs })
  }

  async createTask(payload: string): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    const rows = presets ? (await presets.list() as any[]) : []
    const ids = new Set<string>(rows.filter(p => !p.broken).map(p => String(p.id)))
    const task = validateTask(JSON.parse(payload), ids)
    for (const p of rows) { const spec = p.trust === 'user' ? await readSpec(dirname(String(p.path))) : null; this.runner.rememberName(p.id, spec?.name ?? p.name ?? p.id) }
    await this.runner.store.append({ t: 'task/created', at: task.createdAt, taskId: task.id, task })
    if (task.trigger.kind === 'once') await this.runner.fire(task.id, 'manual')
    return JSON.stringify({ id: task.id })
  }

  async setTaskEnabled(payload: string): Promise<string> {
    const { id, enabled } = JSON.parse(payload) as { id: string; enabled: boolean }
    if (!this.runner.store.tasks.has(id)) throw new Error('没有这个任务')
    await this.runner.store.append({ t: 'task/enabled', at: new Date().toISOString(), taskId: id, enabled: !!enabled })
    return JSON.stringify({ ok: true })
  }

  private async removeTask(id: string): Promise<void> {
    if (!this.runner.store.tasks.has(id)) throw new Error('没有这个任务')
    for (const b of this.runner.store.s.batches.values()) if (b.taskId === id && !b.settled) await this.runner.cancelBatch(b.id)
    await this.runner.store.append({ t: 'task/deleted', at: new Date().toISOString(), taskId: id })
  }

  async deleteTask(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    await this.removeTask(id)
    return JSON.stringify({ ok: true })
  }

  /** Deletes only selected task-console records. DSH sessions and workspace files are never targets. */
  async deleteTasks(payload: string): Promise<string> {
    const { ids } = JSON.parse(payload) as { ids?: unknown }
    const unique = [...new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id) : [])]
    if (!unique.length) throw new Error('请选择至少一个任务')
    const missing = unique.find(id => !this.runner.store.tasks.has(id))
    if (missing) throw new Error(`没有这个任务：${missing}`)
    for (const id of unique) await this.removeTask(id)
    return JSON.stringify({ ok: true, deleted: unique.length })
  }

  async fireTask(payload: string): Promise<string> {
    const { id, by } = JSON.parse(payload) as { id: string; by?: 'manual' | 'retry' }
    const presets = (this.ctx as any).get('agentPresets')
    for (const p of presets ? (await presets.list() as any[]) : []) { const spec = p.trust === 'user' ? await readSpec(dirname(String(p.path))) : null; this.runner.rememberName(p.id, spec?.name ?? p.name ?? p.id) }
    const batch = await this.runner.fire(id, by === 'retry' ? 'retry' : 'manual')
    return JSON.stringify({ runId: batch.id, batchId: batch.id })
  }

  async cancelRun(payload: string): Promise<string> {
    const { runId, batchId } = JSON.parse(payload) as { runId?: string; batchId?: string }
    await this.runner.cancelBatch(batchId ?? runId ?? '')
    return JSON.stringify({ ok: true })
  }

  async taskEvents(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    // The browser folds this stream, so task/created and batch/fired may never be truncated.
    return JSON.stringify(this.runner.store.all().filter((e: any) => e.taskId === id).map((e: any) => e.t === 'artifact/registered' ? { ...e, artifact: this.artifactView(e.artifact) } : e))
  }

  /** Initial detail payload in one round trip; live polling stays event-only afterwards. */
  async taskSnapshot(payload: string): Promise<string> {
    const { id, batchId } = JSON.parse(payload) as { id: string; batchId?: string }
    const events = this.runner.store.all().filter((e: any) => e.taskId === id).map((e: any) => e.t === 'artifact/registered' ? { ...e, artifact: this.artifactView(e.artifact) } : e)
    if (!this.runner.store.s.tasks.has(id)) return JSON.stringify({ events, artifacts: [], batchId: null })
    const selected = batchId ?? [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]?.id
    const artifacts = selected ? (await this.artifactsFor(id, selected)).map(a => this.artifactView(a)) : []
    return JSON.stringify({ events, artifacts, batchId: selected ?? null })
  }

  /** Raw normalized rows plus the canonical event log for DB-faithful replay. */
  async taskGraph(payload: string): Promise<string> {
    const { id, batchId } = JSON.parse(payload) as { id: string; batchId?: string }
    if (!this.runner.store.s.tasks.has(id)) throw new Error('没有这个任务')
    const selected = batchId ?? [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]?.id
    if (!selected) throw new Error('这个任务还没有运行')
    return JSON.stringify(this.runner.store.graphSnapshot(id, selected))
  }

  private artifactView(a: Artifact): ArtifactView {
    const { storagePath: _storagePath, ...view } = a
    return view
  }

  private async artifactsFor(taskId: string, batchId?: string): Promise<Artifact[]> {
    const task = this.runner.store.s.tasks.get(taskId)
    if (!task) throw new Error('没有这个任务')
    const registered = [...this.runner.store.s.artifacts.values()].filter(a => a.taskId === taskId && (!batchId || a.batchId === batchId))
    const runs = [...this.runner.store.s.runs.values()].filter(r => r.taskId === taskId && (!batchId || r.batchId === batchId))
    const legacy = await discoverLegacyArtifacts(task, runs, new Set(registered.map(a => a.originalPath)))
    const rows = [...registered, ...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const batches = batchId
      ? [this.runner.store.s.batches.get(batchId)].filter(Boolean)
      : [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === taskId)
    const projected = new Map(rows.map(row => [row.id, row]))
    for (const batch of batches) {
      const selected = rows.filter(row => row.batchId === batch!.id)
      const cards = batch!.cardIds.map(id => this.runner.store.s.cards.get(id)).filter(Boolean)
      for (const artifact of withFinalArtifact(selected, cards as Card[], batch)) projected.set(artifact.id, artifact)
    }
    return [...projected.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async taskArtifacts(payload: string): Promise<string> {
    const { id, batchId } = JSON.parse(payload) as { id: string; batchId?: string }
    return JSON.stringify((await this.artifactsFor(id, batchId)).map(a => this.artifactView(a)))
  }

  async artifactContent(payload: string): Promise<string> {
    const { id, batchId, artifactId } = JSON.parse(payload) as { id: string; batchId?: string; artifactId: string }
    const task = this.runner.store.s.tasks.get(id)
    if (!task) throw new Error('没有这个任务')
    const artifact = (await this.artifactsFor(id, batchId)).find(a => a.id === artifactId)
    if (!artifact) throw new Error('没有这个产物')
    const data = await readArtifact(this.runner.store.root, task, artifact)
    return JSON.stringify({ artifact: this.artifactView(artifact), base64: data.toString('base64') })
  }

  async publishArtifact(payload: string): Promise<string> {
    const { id, artifactId } = JSON.parse(payload) as { id: string; artifactId: string }
    const task = this.runner.store.s.tasks.get(id)
    const artifact = this.runner.store.s.artifacts.get(artifactId)
    if (!task || !artifact || artifact.taskId !== id) throw new Error('只能发布已登记并保存快照的产物')
    const token = process.env.DSH_TASK_CONSOLE_UPLOAD_TOKEN ?? process.env.UPLOAD_R2_TOKEN ?? ''
    if (!token) throw new Error('宿主未配置 DSH_TASK_CONSOLE_UPLOAD_TOKEN,不能发布公网链接')
    const data = await readArtifact(this.runner.store.root, task, artifact)
    const publicUrl = await publishHtml({
      endpoint: process.env.DSH_TASK_CONSOLE_UPLOAD_URL ?? process.env.UPLOAD_R2_URL ?? 'https://upload-r2.vyibc.com',
      domain: process.env.DSH_TASK_CONSOLE_PUBLIC_DOMAIN ?? process.env.UPLOAD_R2_DOMAIN ?? 'https://resource.vyibc.com',
      token,
    }, artifact, data)
    await this.runner.store.append({ t: 'artifact/published', at: new Date().toISOString(), taskId: id, artifactId, publicUrl })
    return JSON.stringify({ publicUrl })
  }

  async reviewCard(payload: string): Promise<string> {
    const { cardId, decision, note, targetCardId } = JSON.parse(payload) as { cardId: string; decision: 'approve' | 'changes'; note?: string; targetCardId?: string }
    if (decision !== 'approve' && decision !== 'changes') throw new Error('不支持的验收决定')
    await this.runner.reviewCard(cardId, decision, note, targetCardId)
    return JSON.stringify({ ok: true })
  }

  async unblockCard(payload: string): Promise<string> {
    const { cardId } = JSON.parse(payload) as { cardId: string }
    if (!cardId?.trim()) throw new Error('缺少 cardId')
    await this.runner.unblockCard(cardId)
    return JSON.stringify({ ok: true })
  }

  /** What one agent has been doing: cards, last run, tasks it takes part in. */
  async agentActivity(payload: string): Promise<string> {
    const { agentId } = JSON.parse(payload) as { agentId: string }
    const st = this.runner.store.s
    const cards = [...st.cards.values()].filter(c => c.agentId === agentId)
    const runs = cards.flatMap(c => c.runIds.map(id => st.runs.get(id)).filter(Boolean)) as any[]
    const last = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    const tasks = [...st.tasks.values()].filter(t => t.participants.some(p => p.agentId === agentId)).map(t => ({ id: t.id, title: t.title }))
    const done = cards.filter(c => c.status === 'done').length
    const failed = cards.filter(c => c.status === 'failed').length
    return JSON.stringify({ cards: cards.length, done, failed, runs: runs.length, lastRunAt: last?.startedAt ?? null, lastOutcome: last?.outcome ?? last?.status ?? null, tasks })
  }
}
