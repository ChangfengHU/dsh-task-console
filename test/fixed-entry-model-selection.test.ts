import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { LlmRuntime, LlmAdapter, CallId, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { TaskConsoleService } from '../src/service.ts'
import { decideTaskSignalWithAgent } from '../src/task-intake-agent.ts'
import { validateTaskSignal } from '../src/task-intake.ts'
import { validateSpec } from '../src/presets.ts'
import type { TaskModelSelection } from '../src/task-model-selection.ts'

const route = { provider: 'codex-local', model: 'gpt-5.6-sol' }
const high = { ...route, reasoningEffort: 'high' }

/** Actual SDK assembly/preparation/loop/tools, memory-only model transport. */
class RecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(readonly mode: 'text' | 'intake' | 'error' | 'hold' = 'text') { super() }
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1000, reasoning: {
      efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
      defaultEffort: ReasoningEffortId('low'),
    } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.mode === 'error') throw new Error('MEMORY_TRANSPORT_FAILURE')
    if (this.mode === 'hold') {
      if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    if (this.mode === 'intake' && this.calls.length < 3) {
      const name = this.calls.length === 1 ? 'task_intake_context' : 'task_intake_decide'
      const args = this.calls.length === 1 ? {} : { action: 'batch', reason: 'No actionable incidents in the fixture report.', confidence: 1, decisions: [] }
      const id = CallId(`intake-${this.calls.length}`), argumentsText = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'MEMORY_ONLY_MARKER' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'MEMORY_ONLY_MARKER' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(t: any, input: { spec?: Record<string, unknown>; selection?: TaskModelSelection; adapter?: LlmAdapter & { calls: GenerateOptions[] }; mountError?: boolean; mutateDefaultDuringMount?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fixed-entry-model-'))
  const ctx = new Context(), adapter = input.adapter ?? new RecordingAdapter(), mounted: any[] = [], permissions: string[] = []
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const register = ctx.tools.register.bind(ctx.tools)
  ctx.tools.register = (tool: any) => register(process.env.NODE_ENV === 'test' && tool.parameters?.type !== 'object' ? defineTool(tool) : tool)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['codex-local', 'other'], adapter)
  const spec = validateSpec({ id: 'fixed-entry-fixture', name: 'Fixed entry fixture', model: `${route.provider}/${route.model}`, effort: 'high', permissionPreset: 'workspace-write', tools: [], mcpTools: {}, skills: [], ...input.spec })
  const dir = join(root, spec.id); await mkdir(dir)
  await writeFile(join(dir, 'task-console.json'), JSON.stringify(spec))
  const selected = input.selection
  ctx.provide('agentDefaultModel', { currentSelection: () => selected })
  ctx.provide('agentPresets', {
    resolve: async (id: string) => { assert.equal(id, spec.id); return { id, path: join(dir, 'agent.cordis.yml') } },
    mount: async (scope: Context, id: string) => {
      assert.equal(id, spec.id); mounted.push(scope.agent)
      if (input.mutateDefaultDuringMount && selected) selected.reasoningEffort = 'low'
      if (input.mountError) throw new Error('MEMORY_MOUNT_FAILURE')
    },
  })
  ctx.provide('permissionPresets', { set: (_session: unknown, name: string) => permissions.push(name) })
  const service = { ctx, defaultModel: () => selected }
  return { ctx, adapter, mounted, permissions, service, spec }
}

function header(agent: any) { return agent.session.events.findLast((event: any) => event.type === 'request/header')!.data.header }
function assertCall(call: GenerateOptions, effort: string, explicit: boolean, agent: any) {
  assert.equal(call.provider, route.provider); assert.equal(call.model, route.model)
  assert.equal(call.reasoningEffort, effort); assert.equal(call.maxTokens, 1000)
  assert.ok(Object.isFrozen(call), 'the real SDK prepared-call contract reaches the adapter')
  const actual = header(agent)
  assert.equal(actual.config.provider, call.provider); assert.equal(actual.config.model, call.model)
  assert.equal(actual.config.reasoningEffort, call.reasoningEffort)
  assert.equal(actual.adapterDefaults?.reasoningEffort, explicit ? undefined : true)
}
async function assertDisposed(ctx: Context, agent: any) {
  assert.equal(ctx.agents.get(SessionId(agent.id)), undefined)
  const baseline = { provider: 'untouched', model: 'untouched', reasoningEffort: ReasoningEffortId('medium'), maxTokens: 987 }
  assert.deepEqual(await agentEvents(ctx, agent).waterfall('agent/request', { turn: 9, step: 1, signal: new AbortController().signal }, async () => baseline), baseline, 'fixed selection listeners do not survive entry teardown')
}

test('ordinary Agent authored effort reaches first actual SDK request before user dispatch', async t => {
  const f = await fixture(t, { spec: { effort: 'medium' } })
  Object.assign(f.service, { chats: new Map(), workspaces: () => [] })
  const result = JSON.parse(await TaskConsoleService.prototype.startAgentSession.call(f.service as any, JSON.stringify({agentId:f.spec.id,text:'Memory-only ordinary Agent.'})))
  assert.equal(result.agentPreset, f.spec.id)
  for (let i = 0; i < 200 && f.adapter.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(f.adapter.calls.length, 1)
  assertCall(f.adapter.calls[0], 'medium', true, f.mounted[0])
  assert.deepEqual(f.mounted[0].options, route)
  assert.deepEqual(f.permissions, ['workspace-write'])
})

test('tryRun authored high reaches real SDK header/stream, preserves permissions, and disposes its scope', async t => {
  const f = await fixture(t, { selection: { provider: 'other', model: 'default-other', reasoningEffort: 'low' } })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Return only a memory marker.' })))
  assert.equal(result.error, undefined); assert.equal(result.answer, 'MEMORY_ONLY_MARKER')
  assert.equal(f.adapter.calls.length, 1); assert.equal(f.mounted.length, 1)
  assertCall(f.adapter.calls[0], 'high', true, f.mounted[0])
  assert.deepEqual(f.mounted[0].options, route, 'unsupported effort is not stuffed into AgentOptions')
  assert.deepEqual(f.permissions, ['workspace-write'])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun inherited default high is detached before asynchronous preset mount mutates the default object', async t => {
  const selected = { ...high }, f = await fixture(t, { spec: { model: '', effort: '' }, selection: selected, mutateDefaultDuringMount: true })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only.' })))
  assert.equal(result.error, undefined); assert.equal(selected.reasoningEffort, 'low')
  assertCall(f.adapter.calls[0], 'high', true, f.mounted[0])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun explicit authored route without effort keeps model defaults instead of inheriting host high', async t => {
  const f = await fixture(t, { spec: { effort: '' }, selection: { ...high } })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only.' })))
  assert.equal(result.error, undefined)
  assertCall(f.adapter.calls[0], 'low', false, f.mounted[0])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun unsupported selected effort fails in actual SDK preparation with zero transport calls', async t => {
  const f = await fixture(t, { spec: { model: '', effort: '' }, selection: { ...route, reasoningEffort: 'ultra' } })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only.' })))
  assert.match(result.error, /UNSUPPORTED_REASONING_EFFORT/); assert.equal(f.adapter.calls.length, 0)
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun preset setup failure rolls back the real SDK Agent and selection listeners before any model call', async t => {
  const f = await fixture(t, { mountError: true })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only.' })))
  assert.match(result.error, /MEMORY_MOUNT_FAILURE/); assert.equal(f.adapter.calls.length, 0)
  assert.deepEqual(f.permissions, [])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun actual adapter failure is reported without replacing the fixed selection or leaking a live Agent', async t => {
  const f = await fixture(t, { adapter: new RecordingAdapter('error') })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only.' })))
  assert.match(result.error, /MEMORY_TRANSPORT_FAILURE/); assert.equal(f.adapter.calls.length, 1)
  assertCall(f.adapter.calls[0], 'high', true, f.mounted[0])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun success clears its unchanged 120-second deadline rather than leaving a process-holding timer', async t => {
  const f = await fixture(t), scheduled: { delay: number; handle: ReturnType<typeof setTimeout> }[] = [], cleared: ReturnType<typeof setTimeout>[] = []
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: any, ms: number, ...args: any[]) => {
    const handle = originalSetTimeout(fn, ms, ...args)
    scheduled.push({ delay: ms, handle }); return handle
  })
  t.mock.method(globalThis, 'clearTimeout', (handle: ReturnType<typeof setTimeout>) => {
    cleared.push(handle); return originalClearTimeout(handle)
  })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only.' })))
  assert.equal(result.error, undefined)
  const deadline = scheduled.filter(timer => timer.delay === 120_000)
  assert.equal(deadline.length, 1); assert.ok(cleared.includes(deadline[0].handle), 'success finally clears the exact still-refed deadline timer')
  assert.equal(f.adapter.calls.length, 1)
  await assertDisposed(f.ctx, f.mounted[0])
})

test('tryRun real stalled SDK request stays pending for 119999ms then times out at 120000ms and disposes the request', async t => {
  const f = await fixture(t, { adapter: new RecordingAdapter('hold') })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const pending = TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only stalled transport.' }))
  void pending.then(() => { settled = true })
  for (let i = 0; i < 1000 && !f.adapter.calls.length; i++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.adapter.calls.length, 1, 'actual SDK transport started before deadline simulation')
  t.mock.timers.tick(119_999); await Promise.resolve()
  assert.equal(settled, false, 'the existing timeout threshold was not shortened')
  t.mock.timers.tick(1)
  const result = JSON.parse(await pending)
  assert.equal(result.error, '120 秒没等到回合结束')
  assert.equal(f.adapter.calls.length, 1); assert.equal(f.adapter.calls[0].signal!.aborted, true)
  await assertDisposed(f.ctx, f.mounted[0])
})

function signal() {
  return validateTaskSignal({ schemaVersion: 1, id: 'effort-sdk-intake', source: 'test', kind: 'inspection.completed', observedAt: '2026-10-03T00:00:00Z', goal: { title: 'Memory-only summary', objective: 'Inspect a frozen empty fixture report without any business operations.' }, items: [] })
}
async function intake(f: Awaited<ReturnType<typeof fixture>>) {
  return decideTaskSignalWithAgent(f.ctx, signal(), { agents: [], candidateTasks: [], policy: [], items: [] }, { timeoutMs: 2000 })
}

test('Task Intake authored high reaches every real SDK tool/model step and disposes tools plus selection', async t => {
  const f = await fixture(t, { spec: { id: 'task-intake' }, selection: { provider: 'other', model: 'default-other', reasoningEffort: 'low' }, adapter: new RecordingAdapter('intake') })
  const result = await intake(f)
  assert.equal(result.decision.action, 'batch'); assert.equal(f.adapter.calls.length, 3)
  for (const call of f.adapter.calls) {
    assertCall(call, 'high', true, f.mounted[0])
    assert.deepEqual(call.tools?.map(tool => tool.name).sort(), ['task_intake_context', 'task_intake_decide'])
  }
  const assembly = await f.ctx.systemPrompt.assemble(assembleContextFor(f.mounted[0]))
  assert.deepEqual(assembly.tools, [], 'entry-local tools are removed after the accepted routing proposal')
  assert.deepEqual(f.permissions, ['workspace-write'])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('Task Intake default high remains fixed across real context-read/proposal steps when host selection mutates', async t => {
  const selected = { ...high }, f = await fixture(t, { spec: { id: 'task-intake', model: '', effort: '' }, selection: selected, mutateDefaultDuringMount: true, adapter: new RecordingAdapter('intake') })
  await intake(f)
  assert.equal(selected.reasoningEffort, 'low'); assert.equal(f.adapter.calls.length, 3)
  for (const call of f.adapter.calls) assertCall(call, 'high', true, f.mounted[0])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('Task Intake selected route without effort preserves actual adapter-default effort', async t => {
  const f = await fixture(t, { spec: { id: 'task-intake', effort: '' }, selection: { ...high }, adapter: new RecordingAdapter('intake') })
  await intake(f)
  assert.equal(f.adapter.calls.length, 3)
  for (const call of f.adapter.calls) assertCall(call, 'low', false, f.mounted[0])
  await assertDisposed(f.ctx, f.mounted[0])
})

test('Task Intake setup failure never starts the real SDK model transport and rolls back selection ownership', async t => {
  const f = await fixture(t, { spec: { id: 'task-intake' }, mountError: true, adapter: new RecordingAdapter('intake') })
  await assert.rejects(intake(f), /MEMORY_MOUNT_FAILURE/)
  assert.equal(f.adapter.calls.length, 0); assert.deepEqual(f.permissions, [])
  await assertDisposed(f.ctx, f.mounted[0])
})

/** Cross-repository boundary integration, still zero actual subprocess/network. */
test('tryRun actual SDK/adapter/cache/native turn-start agree on authored high', { skip: !process.env.DSH_CODEX_CLI_SOURCE }, async t => {
  const source = process.env.DSH_CODEX_CLI_SOURCE!
  const { CodexAppServerAdapter } = await import(pathToFileURL(join(source, 'adapter.ts')).href)
  const { CodexAppServerRunner, CODEX_APP_SERVER_VERSION } = await import(pathToFileURL(join(source, 'runner.ts')).href)
  const wire: any[] = [], cleanupErrors: unknown[] = []
  let spawns = 0
  const nativeRunner = new CodexAppServerRunner({
    timeoutMs: 2000, disposeGraceMs: 25, maxJsonRpcLineBytes: 100000, maxStderrBytes: 1000, env: {},
    spawn: () => {
      spawns++
      const stdin = new PassThrough(), stdout = new PassThrough(), outcome = Promise.withResolvers<any>()
      let input = '', stopped = false
      const send = (message: any) => stdout.write(JSON.stringify(message) + '\n')
      stdin.setEncoding('utf8')
      stdin.on('data', chunk => {
        input += chunk
        for (let newline; (newline = input.indexOf('\n')) !== -1;) {
          const line = input.slice(0, newline); input = input.slice(newline + 1)
          if (!line.trim()) continue
          const message = JSON.parse(line); wire.push(message)
          if (message.method === 'initialize') send({ id: message.id, result: { userAgent: `codex_app_server/${CODEX_APP_SERVER_VERSION}` } })
          else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'fixed-entry-memory-thread' }, instructionSources: [] } })
          else if (message.method === 'thread/inject_items') send({ id: message.id, result: {} })
          else if (message.method === 'turn/start') {
            send({ id: message.id, result: { turn: { id: 'memory-turn-1' } } })
            send({ method: 'turn/completed', params: { threadId: 'fixed-entry-memory-thread', turn: { id: 'memory-turn-1', status: 'completed', error: null } } })
          }
        }
      })
      return { pid: 0, stdin, stdout, stderr: undefined,
        collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }, done: outcome.promise,
        terminate: () => { if (!stopped) { stopped = true; stdout.end(); outcome.resolve({ exitCode: 0, signal: null }) } },
        waitForExit: async () => true }
    },
  })
  const native = new CodexAppServerAdapter({
    provider: route.provider, displayName: 'fixed-entry-memory Codex', modelProvider: 'openai',
    models: [{ id: route.model, name: route.model, inputModalities: ['text'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }],
    maxRetries: 0, maxRequestImageBytes: 1024, maxCachedSessions: 2, sessionIdleTimeoutMs: 600000,
    resolveAttachments: () => undefined, resolveImageGenerationEnabled: () => false,
    onCleanupError: (error: unknown) => cleanupErrors.push(error), runner: nativeRunner,
  })
  t.after(() => native.dispose())
  const calls: GenerateOptions[] = []
  class BoundaryAdapter extends LlmAdapter {
    readonly calls = calls
    resolveModel(provider: string, model: string, signal?: AbortSignal) { return native.resolveModel(provider, model, signal) }
    stream(options: GenerateOptions) { calls.push(options); return native.stream(options) }
  }
  const f = await fixture(t, { adapter: new BoundaryAdapter() })
  const result = JSON.parse(await TaskConsoleService.prototype.tryRun.call(f.service as any, JSON.stringify({ id: f.spec.id, prompt: 'Memory-only native boundary.' })))
  assert.equal(result.error, undefined); assert.equal(calls.length, 1)
  const actual = header(f.mounted[0]), thread = wire.find(message => message.method === 'thread/start'), turn = wire.find(message => message.method === 'turn/start')
  assert.deepEqual(actual.config, high); assert.equal(actual.adapterDefaults?.reasoningEffort, undefined)
  assert.equal(calls[0].reasoningEffort, 'high'); assert.equal(thread.params.model, route.model)
  assert.equal(turn.params.effort, actual.config.reasoningEffort)
  assert.equal(spawns, 1, 'one in-memory protocol process, zero actual providers')
  assert.deepEqual(cleanupErrors, [])
  await assertDisposed(f.ctx, f.mounted[0])
})
