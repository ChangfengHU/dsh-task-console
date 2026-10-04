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
import { LlmRuntime, LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { installTaskModelSelection, taskAgentOptions, type TaskModelSelection } from '../src/task-model-selection.ts'
import { installFallbackSelection } from '../src/model-fallback.ts'
import { TaskRunner } from '../src/runner.ts'
import { EventStore } from '../src/tasks.ts'
import { validateDesign } from '../src/task-design.ts'
import { renderComposition, validateSpec } from '../src/presets.ts'

const route = { provider: 'codex-local', model: 'gpt-5.6-sol' }
const high = { ...route, reasoningEffort: 'high' }

/** Real SDK preparation/loop, fake model transport: no credentials or network. */
class RecordingAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  constructor(readonly hold = false) { super() }
  async resolveModel(provider: string, model: string) {
    return {
      provider, id: model, name: model,
      defaultMaxTokens: 1000,
      reasoning: {
        efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(provider === 'fallback' ? 'medium' : 'low'),
      },
    }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.hold) {
      const signal = options.signal!
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function sdk(t: any, adapter: LlmAdapter = new RecordingAdapter()) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  // This suite runs under NODE_ENV=test too, where worker-tools deliberately
  // returns uncompiled descriptors. Keep the real ToolRuntime in this fixture.
  const register = ctx.tools.register.bind(ctx.tools)
  ctx.tools.register = (spec: any) => register(process.env.NODE_ENV === 'test' && spec.parameters?.type !== 'object' ? defineTool(spec) : spec)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['codex-local', 'fallback'], adapter)
  return ctx
}

async function worker(ctx: Context, id: string, selection?: TaskModelSelection, options: any = {}) {
  let disposeSelection: (() => void) | undefined
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: taskAgentOptions(selection ?? route),
    ...options,
    setup: scope => { if (selection) disposeSelection = installTaskModelSelection(scope, selection) },
  })
  return { ...handle, disposeSelection }
}

async function turn(agent: any) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'in-memory contract test' }] }))
  await agent.whenIdle()
  const errors = agent.session.events.filter((e: any) => e.type === 'error' || e.type === 'turn/end' && e.data.reason.kind !== 'completed')
  assert.deepEqual(errors, [])
}

function header(agent: any) { return agent.session.events.findLast((e: any) => e.type === 'request/header')!.data.header }

test('SDK prepared-call, actual request/header and adapter stream agree on explicit high across turns', async t => {
  const adapter = new RecordingAdapter(), ctx = await sdk(t, adapter)
  const selected = { ...high, maxTokens: 777 }, h = await worker(ctx, 'high-worker', selected)
  assert.deepEqual(h.agent.options, { ...route, maxTokens: 777 }, 'effort is not an unsupported AgentOption')
  selected.provider = 'fallback'; selected.model = 'mutated'; selected.reasoningEffort = 'low'
  for (let i = 0; i < 2; i++) {
    await turn(h.agent)
    assert.deepEqual(header(h.agent).config, { ...high, maxTokens: 777 })
    assert.equal(header(h.agent).adapterDefaults?.reasoningEffort, undefined)
    assert.equal(header(h.agent).adapterDefaults?.maxTokens, undefined)
    const call = adapter.calls.at(-1)!
    assert.equal(call.provider, route.provider); assert.equal(call.model, route.model)
    assert.equal(call.reasoningEffort, 'high'); assert.equal(call.maxTokens, 777)
    assert.ok(Object.isFrozen(call), 'actual loop request uses the SDK prepared-call contract')
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(h.agent))
    assert.equal(assembly.variables.provider, route.provider); assert.equal(assembly.variables.model, route.model)
  }
  const other = await worker(ctx, 'unrelated-worker')
  await turn(other.agent)
  assert.equal(adapter.calls.at(-1)!.reasoningEffort, 'low', 'Task effort does not leak into another Agent')
})

test('omitted effort/maxTokens keep adapter defaults and clear old explicit effort on seeded resume', async t => {
  const adapter = new RecordingAdapter(), ctx = await sdk(t, adapter)
  const original = await worker(ctx, 'original-high', high)
  await turn(original.agent)
  const seed = original.agent.session.events
  await original.dispose()
  const resumed = await worker(ctx, 'seeded-default', route, { seed })
  await turn(resumed.agent)
  const actual = header(resumed.agent)
  assert.deepEqual(actual.config, { ...route, reasoningEffort: 'low', maxTokens: 1000 })
  assert.deepEqual(actual.adapterDefaults, { reasoningEffort: true, maxTokens: true })
  assert.equal(resumed.agent.session.events.findLast((e: any) => e.type === 'request/header')!.data.reason, 'resume')
  assert.equal(adapter.calls.at(-1)!.reasoningEffort, 'low')
})

test('fallback prepend remains authoritative and clears inherited effort and maxTokens', async t => {
  const adapter = new RecordingAdapter(), ctx = await sdk(t, adapter)
  const h = await worker(ctx, 'fallback-worker', { ...high, maxTokens: 777 })
  await turn(h.agent)
  const disposeFallback = installFallbackSelection(h.agent.ctx, { provider: 'fallback', model: 'fallback-model' })
  await turn(h.agent)
  const actual = header(h.agent)
  assert.deepEqual(actual.config, { provider: 'fallback', model: 'fallback-model', reasoningEffort: 'medium', maxTokens: 1000 })
  assert.deepEqual(actual.adapterDefaults, { reasoningEffort: true, maxTokens: true })
  assert.equal(adapter.calls.at(-1)!.provider, 'fallback'); assert.equal(adapter.calls.at(-1)!.reasoningEffort, 'medium')
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(h.agent))
  assert.equal(assembly.variables.provider, 'fallback'); assert.equal(assembly.variables.model, 'fallback-model')
  disposeFallback()
  await turn(h.agent)
  assert.equal(adapter.calls.at(-1)!.provider, route.provider); assert.equal(adapter.calls.at(-1)!.reasoningEffort, 'high')
})

test('selection disposal removes both actual scoped listeners, is idempotent, and scope teardown is safe', async t => {
  const ctx = await sdk(t), h = await worker(ctx, 'disposal-worker', high)
  await ctx.systemPrompt.assemble(assembleContextFor(h.agent))
  const seed = { provider: 'baseline', model: 'baseline-model', reasoningEffort: ReasoningEffortId('medium'), maxTokens: 432 }
  const dispatch = agentEvents(ctx, h.agent), payload = { turn: 1, step: 1, signal: new AbortController().signal }
  const before = await dispatch.waterfall('agent/request', payload, async () => seed)
  assert.deepEqual(before, { ...high, maxTokens: 432 })
  h.disposeSelection!(); h.disposeSelection!()
  assert.deepEqual(await dispatch.waterfall('agent/request', payload, async () => seed), seed)
  await h.dispose(); h.disposeSelection!()
  assert.deepEqual(await dispatch.waterfall('agent/request', payload, async () => seed), seed)
})

test('unsupported authored effort fails at real SDK preparation before transport rather than silently clamping', async t => {
  const adapter = new RecordingAdapter(), ctx = await sdk(t, adapter)
  const h = await worker(ctx, 'unsupported-worker', { ...route, reasoningEffort: 'ultra' })
  h.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'in-memory refusal' }] }))
  await h.agent.whenIdle()
  assert.equal(adapter.calls.length, 0)
  const failed = h.agent.session.events.findLast((e: any) => e.type === 'turn/end') as any
  assert.equal(failed.data.reason.kind, 'error')
  assert.equal(failed.data.reason.error.code, 'UNSUPPORTED_REASONING_EFFORT')
})

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), 'isolated model boundary did not start')
}

test('Task fire and host restart recovery both dispatch frozen high through the real SDK loop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-model-sdk-'))
  const runtimes: { ctx: Context; runner: TaskRunner; store: EventStore }[] = []
  t.after(async () => {
    for (const r of runtimes.reverse()) { r.runner.stop(); await r.ctx.fiber.dispose(); if (r.store.kernel.db.open) r.store.kernel.db.close() }
    await rm(root, { recursive: true, force: true })
  })
  const dir = join(root, 'presets', 'a'); await mkdir(dir, { recursive: true })
  const spec = validateSpec({ id: 'a', name: 'A', model: '', tools: [], skills: [] })
  const composition = renderComposition(spec, [], [])
  await writeFile(join(dir, 'task-console.json'), JSON.stringify(spec))
  await writeFile(join(dir, 'agent.cordis.yml'), composition.yml)
  await writeFile(join(dir, 'capabilities.lock.json'), JSON.stringify(composition.capabilities))
  const task: any = {
    id: 'task-model-fixture', title: 'isolated model fixture', brief: 'no business operations', trigger: { kind: 'once' },
    participants: [{ agentId: 'a' }], cwd: root, timeoutSec: 60, onFail: 'retry', maxTries: 3, enabled: true, createdAt: '2026-10-03T00:00:00Z',
    design: validateDesign({ executionBinding: 'agent-runtime-v1', scope: 'fixture', branches: [{ id: 'work', when: 'ready', action: 'work', evidence: 'fixture' }], coordination: 'sequence', failurePolicy: { isolateItems: false, maxAttempts: 3, stopConditions: ['failure'] }, acceptance: ['fixture'] }),
  }
  async function host(defaultSelection: TaskModelSelection) {
    const adapter = new RecordingAdapter(true), ctx = await sdk(t, adapter)
    ctx.provide('agentPresets', { resolve: async () => ({ id: 'a', path: join(dir, 'agent.cordis.yml') }), mount: async () => undefined })
    ctx.provide('agentDefaultModel', { currentSelection: () => defaultSelection })
    ctx.provide('permissionPresets', { set: () => undefined })
    const store = new EventStore(join(root, 'store')), runner = new TaskRunner(ctx, store, { executionRuntimeIdentity: async () => 'a'.repeat(64) })
    runtimes.push({ ctx, store, runner })
    await runner.start()
    return { ctx, store, runner, adapter }
  }
  const first = await host(high)
  await first.store.append({ t: 'task/created', taskId: task.id, at: task.createdAt, task })
  const batch = await first.runner.fire(task.id, 'manual', { batchId: 'sdk-frozen-high' })
  await until(() => first.adapter.calls.length === 1)
  const firstSession = first.ctx.agents.get(SessionId(String(first.adapter.calls[0].sessionId)))!
  assert.equal(header(firstSession).config.reasoningEffort, 'high')
  assert.equal(first.adapter.calls[0].reasoningEffort, 'high')
  const frozen = batch.turn!.executionBinding!.sha256
  const firstFlight = [...(first.runner as any).flights.values()][0]
  first.runner.stop()
  const disposedSeed = { provider: 'unchanged', model: 'unchanged' }
  assert.deepEqual(await agentEvents(first.ctx, firstSession).waterfall('agent/request', { turn: 2, step: 1, signal: new AbortController().signal }, async () => disposedSeed), disposedSeed, 'runner stop releases its model listener even before host scope disposal')
  assert.ok(firstFlight.disposeModelSelection)
  await first.ctx.fiber.dispose(); first.store.kernel.db.close()
  const recovered = await host({ provider: 'fallback', model: 'changed-global', reasoningEffort: 'low' })
  await until(() => recovered.adapter.calls.length === 1)
  assert.equal(recovered.adapter.calls[0].provider, route.provider); assert.equal(recovered.adapter.calls[0].model, route.model)
  assert.equal(recovered.adapter.calls[0].reasoningEffort, 'high')
  const next = recovered.ctx.agents.get(SessionId(String(recovered.adapter.calls[0].sessionId)))!
  assert.equal(header(next).config.reasoningEffort, 'high')
  assert.equal(header(next).adapterDefaults?.reasoningEffort, undefined)
  assert.equal(recovered.store.s.batches.get(batch.id)!.turn!.executionBinding!.sha256, frozen)
  assert.equal(recovered.store.kernel.listRuns(batch.cardIds[0]).length, 2)
  await recovered.runner.cancelBatch(batch.id)
  assert.equal(recovered.ctx.agents.get(next.id), undefined)
  assert.equal((recovered.runner as any).flights.size, 0)
})

/** Optional cross-repository integration, never an installed/paid CLI invocation.
 * Set DSH_CODEX_CLI_SOURCE to a checked-out dsh-codex-claude-cli source directory.
 * Actual adapter/cache/native JSON-RPC code runs over in-memory protocol pipes.
 */
test('real Codex adapter/cache/native turn-start agrees with SDK prepared-call/header high', { skip: !process.env.DSH_CODEX_CLI_SOURCE }, async t => {
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
      let input = '', stopped = false, turnId = 0
      const send = (message: any) => stdout.write(JSON.stringify(message) + '\n')
      stdin.setEncoding('utf8')
      stdin.on('data', chunk => {
        input += chunk
        for (let newline; (newline = input.indexOf('\n')) !== -1;) {
          const line = input.slice(0, newline); input = input.slice(newline + 1)
          if (!line.trim()) continue
          const message = JSON.parse(line); wire.push(message)
          if (message.method === 'initialize') send({ id: message.id, result: { userAgent: `codex_app_server/${CODEX_APP_SERVER_VERSION}` } })
          else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'memory-thread' }, instructionSources: [] } })
          else if (message.method === 'thread/inject_items') send({ id: message.id, result: {} })
          else if (message.method === 'turn/start') {
            const id = `turn-${++turnId}`
            send({ id: message.id, result: { turn: { id } } })
            send({ method: 'turn/completed', params: { threadId: 'memory-thread', turn: { id, status: 'completed', error: null } } })
          }
        }
      })
      return { pid: 0, stdin, stdout, stderr: undefined, collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }, done: outcome.promise,
        terminate: () => { if (!stopped) { stopped = true; stdout.end(); outcome.resolve({ exitCode: 0, signal: null }) } }, waitForExit: async () => true }
    },
  })
  const adapter = new CodexAppServerAdapter({
    provider: route.provider, displayName: 'in-memory Codex', modelProvider: 'openai',
    models: [{ id: route.model, name: route.model, inputModalities: ['text'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }],
    maxRetries: 0, maxRequestImageBytes: 1024, maxCachedSessions: 2, sessionIdleTimeoutMs: 600000,
    resolveAttachments: () => undefined, onCleanupError: (error: unknown) => cleanupErrors.push(error), runner: nativeRunner,
  })
  t.after(() => adapter.dispose())
  const ctx = await sdk(t, adapter), h = await worker(ctx, 'native-high', high)
  await turn(h.agent)
  const actual = header(h.agent)
  assert.deepEqual(actual.config, high)
  assert.equal(actual.adapterDefaults?.reasoningEffort, undefined)
  const thread = wire.find(m => m.method === 'thread/start'), request = wire.find(m => m.method === 'turn/start')
  assert.equal(thread.params.model, route.model)
  assert.equal(request.params.effort, actual.config.reasoningEffort)
  assert.equal(request.params.effort, 'high')
  assert.equal(spawns, 1, 'one protocol fake, zero actual subprocesses')
  assert.deepEqual(cleanupErrors, [])
})
