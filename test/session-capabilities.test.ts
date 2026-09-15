import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SessionCapabilities, ChatProgress, restrictedBrowserTool, CAPABILITY_TOOLS } from '../src/session-capabilities.ts'

const event = (type: string, data: any) => ({ type, data })
function pair(state: ChatProgress, id: string, name: string, args: any, text = '{"ok":true}') {
  state.observe(event('tool/call', { callId: id, name, arguments: JSON.stringify(args) }))
  state.observe(event('tool/result', { message: { source: { callId: id }, content: [{ type: 'text', text }] } }))
}

test('progress detects interleaved unchanged calls; argument key order does not reset detection', () => {
  const p = new ChatProgress(); p.observe(event('turn/start', { turn: 1 }))
  for (let i = 0; i < 4; i++) {
    pair(p, `a${i}`, 'browser_login_candidates', i % 2 ? { instance: 1, ip: '192.0.2.1' } : { ip: '192.0.2.1', instance: 1 })
    pair(p, `b${i}`, 'other', { page: i })
  }
  assert.match(p.boundary(12), /相同结果/)
  p.observe(event('turn/start', { turn: 2 }))
  assert.equal(p.boundary(1), '')
  assert.match(p.boundary(25), /24/)
})

test('changed results reset repetitions and status polling is not counted as duplicate discovery', () => {
  const p = new ChatProgress()
  for (let i = 0; i < 10; i++) {
    pair(p, `a${i}`, 'read', {}, JSON.stringify({ revision: i }))
    pair(p, `b${i}`, 'browser_status', { operationId: 'same' })
  }
  assert.equal(p.boundary(21), '')
  assert.equal(p.calls.size, 0)
})

test('standard chat hides only restricted browser identity schemas without changing Task schemas', () => {
  const schema = { name: 'mcp__fleet-browser__browser_create', parameters: { properties: { sessionId: { type: 'string' } } } }
  const standard = { session: { id: 'session-test', header: { agentPreset: 'standard' } } }
  assert.equal(restrictedBrowserTool(schema, standard), true)
  assert.equal(restrictedBrowserTool({ ...schema, parameters: { properties: {} } }, standard), false)
  assert.equal(restrictedBrowserTool(schema, { session: { id: 'task-test', header: {} } }), false)
  assert.equal(restrictedBrowserTool(schema, { session: { id: 'agent-browser-manager-test', header: { agentPreset: 'browser-manager' } } }), false)
  assert.ok(schema.parameters.properties.sessionId)
})

test('capability API shares facts, never probes tools or exposes schema/config secrets; cold view is historical', async () => {
  const db = new DatabaseSync(':memory:')
  const listeners = new Map<string, any>(), registered = new Map<string, any>()
  const agent = { session: { id: 'session-fixture', header: { agentPreset: 'standard' }, events: [] as any[] } }
  const schemas = [{ name: 'read_file', description: 'secret-not-to-copy' }, { name: 'skill' }, { name: 'mcp__fleet-browser__browser_create', parameters: { properties: { sessionId: {} } } }]
  let live: any = agent, envReads = 0
  let guard: any
  const ctx: any = {
    agents: { get: () => live },
    tools: { schemas: () => schemas, get: (name: string) => schemas.find(s => s.name === name), register: (tool: any) => { registered.set(tool.name, tool); return () => registered.delete(tool.name) }, guard: (g: any) => { guard = g; return () => { guard = undefined } } },
    get: (name: string) => name === 'skills' ? { snapshot: async () => ({ complete: true, skills: [{ name: 'example', provider: 'fixture', invocation: { modelInvocable: true }, content: 'secret-skill-body' }] }) } : undefined,
    on: (name: string, fn: any) => { listeners.set(name, fn); return () => listeners.delete(name) },
  }
  const cap = new SessionCapabilities(ctx, async () => { envReads++; return { scope: 'environment' } }, db)
  const dispose = await cap.install()
  assert.deepEqual([...registered.keys()], CAPABILITY_TOOLS)
  const snapshot = await registered.get('session_capabilities').execute({}, { agent })
  assert.equal(snapshot.current.tools[0].source, 'environment-inherited')
  assert.equal(snapshot.current.tools[2].state, 'restricted')
  assert.equal(snapshot.current.skills[0].state, 'available-on-demand')
  assert.equal(JSON.stringify(snapshot).includes('secret'), false)
  assert.equal(envReads, 0)
  listeners.get('session/event')(agent.session, { type: 'request/header', time: Date.now(), data: { header: { config: { provider: 'fixture', model: 'model', apiKey: 'secret-key' }, system: 'secret-prompt', tools: [{ name: 'read_file', description: 'secret-description' }] } } })
  const observed = await cap.read(agent.session.id)
  assert.deepEqual(observed.lastModelRequest.tools, ['read_file'])
  assert.equal(JSON.stringify(observed).includes('secret'), false)
  assert.match(guard({ agent, name: schemas[2].name }), /未获/)
  assert.equal(guard({ agent, name: 'read_file' }), undefined)
  cap.policy = { standardSkillInheritance: 'discover-only' }
  assert.match(guard({ agent, name: 'skill' }), /不允许继承/)
  assert.equal((await cap.describe(agent)).current.skills[0].state, 'not-callable')
  cap.policy = {}
  const assembly = { tools: schemas, sections: [] }
  const filtered = await listeners.get('system-prompt/assemble')(assembly, { scope: agent }, async () => assembly)
  assert.equal(filtered.tools.length, 2); assert.equal(assembly.tools.length, 3)
  assert.match(filtered.contexts[0].text, /受限不可调用/)
  assert.deepEqual(snapshot.answerContract.cannotCall, ['mcp__fleet-browser__browser_create'])
  const task = { session: { id: 'task-fixture', header: { agentPreset: 'browser-manager' }, events: [] } }
  assert.equal(guard({ agent: task, name: schemas[2].name }), undefined)
  const decision = { kind: 'enter', messages: [] }
  assert.equal(await listeners.get('agent/pre-step')({ agent: task, step: 900 }, async () => decision), decision)
  await assert.rejects(() => listeners.get('agent/pre-step')({ agent, step: 25 }, async () => decision), /SESSION_PROGRESS_GUARD/)
  live = undefined
  const historical = await cap.read(agent.session.id)
  assert.equal(historical.live, false); assert.match(historical.notice!, /历史/)
  assert.equal(envReads, 0)
  await assert.rejects(() => cap.read('../secret'), /Invalid/)
  dispose(); assert.equal(listeners.size, 0); assert.equal(registered.size, 0)
  db.close()
})

test('actual native ToolRuntime refuses standard chat forged browser identity before executing', async () => {
  const require = createRequire(import.meta.url)
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis', { paths: [dirname(require.resolve('@deepseek-ai/dsh-tools'))] })).href)
  const root = new Context(); root.provide('systemPrompt', { tools: () => {} })
  const runtime = new ToolRuntime(root), db = new DatabaseSync(':memory:')
  const agent = { ctx: root, session: { id: 'session-standard-test', header: { agentPreset: 'standard' }, events: [] } }
  let executed = 0
  const name = 'mcp__fleet-browser__browser_create'
  const stop = runtime.register(defineTool({ name, description: 'Fixture only', parameters: { sessionId: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: () => { executed++; return {} } }))
  const tools = { schemas: runtime.schemas.bind(runtime), get: runtime.get.bind(runtime), guard: runtime.guard.bind(runtime), register: (s: any) => runtime.register(defineTool(s)) }
  const cap = new SessionCapabilities({ tools, get: () => undefined, on: () => () => {}, agents: { get: () => agent } }, async () => ({}), db)
  const dispose = await cap.install()
  try {
    const result = await runtime.execute({ name, arguments: { sessionId: 'agent-browser-manager-forged' }, agent, callId: 'denied-call', signal: new AbortController().signal } as any)
    assert.equal(result.isError, true); assert.equal(executed, 0)
  } finally { dispose(); stop(); db.close() }
})
