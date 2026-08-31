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
import {
  NATIVE_TOOLS, mask, readSpec, removePreset, renderComposition, scanSkills, userPresetRoot, validateSpec, writePreset,
  type HostMcp,
} from './presets.ts'
import { TaskRunner } from './runner.ts'
import { EventStore, nextFire, parseCron, validateTask } from './tasks.ts'
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
  static inject = ['loader', 'tools', 'agents']

  readonly runner: TaskRunner

  constructor(ctx: Context) {
    super(ctx, NAMESPACE)
    this.runner = new TaskRunner(ctx, new EventStore())
    void this.runner.start().catch(err => console.error('[task-console] runner failed to start:', err))
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
      rows.push({ entryId: String(entry.options.id), serverName, target, tools: registered.get(serverName) ?? [], disabled, config, live: !disabled })
    }
    return rows
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

  async catalog(): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    const def = this.defaultModel()
    const defaultModel = def ? `${def.provider}/${def.model}` : ''
    const models = [...new Set([defaultModel, ...KNOWN_MODELS].filter(Boolean))]
    const out: Catalog = {
      tools: NATIVE_TOOLS.map(({ rows: _rows, ...t }) => t),
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
    const preview = renderComposition(spec, this.hostMcp())
    return JSON.stringify({ ...preview, yml: mask(preview.yml) } satisfies Preview)
  }

  async saveAgent(payload: string): Promise<string> {
    const spec = validateSpec(JSON.parse(payload))
    const presets = (this.ctx as any).get('agentPresets')
    if (presets && presets.authorable === false) throw new Error('这个部署没有可写的 preset 根')
    const shipped = presets ? (await presets.list() as any[]).find(p => p.id === spec.id && p.trust === 'system') : undefined
    if (shipped) throw new Error(`"${spec.id}" 是出厂 preset,不能覆盖;换个 id`)
    const { path, preview } = await writePreset(spec, this.hostMcp(), await scanSkills())
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

  // ── tasks ──────────────────────────────────────────────────────────────

  /** Every task with its runs, plus the next cron fire time; one payload for the board. */
  async tasks(): Promise<string> {
    const store = this.runner.store
    const tasks = [...store.tasks.values()].map(t => ({
      ...t,
      nextFire: t.trigger.kind === 'cron' && t.enabled ? (nextFire(parseCron(t.trigger.expr)!)?.toISOString() ?? null) : null,
    }))
    const runs = [...store.runs.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt))
    return JSON.stringify({ tasks, runs })
  }

  async createTask(payload: string): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    const ids = new Set<string>(presets ? (await presets.list() as any[]).filter(p => !p.broken).map(p => String(p.id)) : [])
    const task = validateTask(JSON.parse(payload), ids)
    await this.runner.store.append({ t: 'task/created', at: task.createdAt, task })
    if (task.trigger.kind === 'once') await this.runner.fire(task.id, 'manual')
    return JSON.stringify({ id: task.id })
  }

  async setTaskEnabled(payload: string): Promise<string> {
    const { id, enabled } = JSON.parse(payload) as { id: string; enabled: boolean }
    if (!this.runner.store.tasks.has(id)) throw new Error('没有这个任务')
    await this.runner.store.append({ t: 'task/enabled', at: new Date().toISOString(), taskId: id, enabled: !!enabled })
    return JSON.stringify({ ok: true })
  }

  async deleteTask(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    for (const r of this.runner.store.runs.values()) if (r.taskId === id && !r.settled) await this.runner.cancel(r.id)
    await this.runner.store.append({ t: 'task/deleted', at: new Date().toISOString(), taskId: id })
    return JSON.stringify({ ok: true })
  }

  async fireTask(payload: string): Promise<string> {
    const { id, by } = JSON.parse(payload) as { id: string; by?: 'manual' | 'retry' }
    const run = await this.runner.fire(id, by === 'retry' ? 'retry' : 'manual')
    return JSON.stringify({ runId: run.id })
  }

  async cancelRun(payload: string): Promise<string> {
    const { runId } = JSON.parse(payload) as { runId: string }
    await this.runner.cancel(runId)
    return JSON.stringify({ ok: true })
  }

  async taskEvents(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    const runIds = new Set([...this.runner.store.runs.values()].filter(r => r.taskId === id).map(r => r.id))
    const events = this.runner.store.all().filter((e: any) => e.taskId === id || e.task?.id === id || runIds.has(e.runId) || runIds.has(e.run?.id)).slice(-60)
    return JSON.stringify(events)
  }
}
