import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicConfigUrl, createBootstrapCommand, createEnvelope, encodeEnvelope, parseEnvelope, taskConfig, uploadConfig } from '../src/config-migration.ts'
import type { AgentSpec } from '../src/wire.ts'
import type { TaskSpec } from '../src/fold.ts'

const agent: AgentSpec = { id: 'planner', name: '规划者', description: '制定计划', persona: '谨慎规划', model: 'codex-local/gpt-5.6-terra', effort: 'medium', permissionPreset: 'workspace-write', tools: ['ask-user'], mcpTools: {}, mcpPolicy: {}, skills: [] }
const task: TaskSpec = { id: 'T-config', title: '配置迁移', brief: '验证配置迁移流程。', trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' }, participants: [{ agentId: 'planner' }], graphMode: 'static-chain', cwd: '/work', timeoutSec: 600, onFail: 'stop', maxTries: 1, enabled: true, createdAt: '2026-09-16T00:00:00.000Z', origin: { source: 'session', signalId: 'secret-session-reference', decision: 'create' } }

test('configuration envelope contains definitions, not runtime/session state', () => {
  const envelope = createEnvelope({ agents: [{ spec: agent, actions: [] }], tasks: [taskConfig(task, [])] }, '1.0.0', new Date('2026-09-16T01:00:00.000Z'))
  const text = encodeEnvelope(envelope).toString('utf8')
  assert.doesNotMatch(text, /secret-session-reference|task_runs|task_events|sessionId/)
  const parsed = parseEnvelope(JSON.parse(text))
  assert.equal(parsed.payload.tasks[0].trigger.kind, 'cron')
  assert.equal((parsed.payload.tasks[0] as any).enabled, undefined)
})

test('digest rejects tampering', () => {
  const envelope = createEnvelope({ agents: [{ spec: agent, actions: [] }], tasks: [] }, '1.0.0')
  envelope.payload.agents[0].spec.name = '被篡改'
  assert.throws(() => parseEnvelope(envelope), /SHA256/)
})

test('import URL is restricted to configured R2 origin and JSON', () => {
  assert.equal(assertPublicConfigUrl('https://resource.vyibc.com/a/config.json', 'https://resource.vyibc.com').hostname, 'resource.vyibc.com')
  assert.throws(() => assertPublicConfigUrl('http://resource.vyibc.com/a.json', 'https://resource.vyibc.com'), /只允许/)
  assert.throws(() => assertPublicConfigUrl('https://evil.example/a.json', 'https://resource.vyibc.com'), /只允许/)
  assert.throws(() => assertPublicConfigUrl('https://resource.vyibc.com/a.html', 'https://resource.vyibc.com'), /只允许/)
})

test('R2 upload keeps credentials in the request and verifies exact public bytes', async () => {
  const envelope = createEnvelope({ agents: [], tasks: [] }, '1.0.0', new Date('2026-09-16T01:00:00.000Z'))
  const expected = encodeEnvelope(envelope)
  const original = globalThis.fetch
  let uploaded: Buffer | undefined, authorization = ''
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://upload.example') {
      authorization = String((init?.headers as Record<string, string>).Authorization)
      const form = init?.body as FormData, blob = form.get('file') as Blob
      uploaded = Buffer.from(await blob.arrayBuffer())
      return new Response(JSON.stringify({ image_url: 'https://resource.example/dsh-task-console/config-exports/config.json' }), { status: 200 })
    }
    if (url === 'https://resource.example/dsh-task-console/config-exports/config.json') return new Response(uploaded, { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  try {
    const result = await uploadConfig(envelope, { endpoint: 'https://upload.example', domain: 'https://resource.example', token: 'test-only-token' })
    assert.equal(authorization, 'Bearer test-only-token')
    assert.deepEqual(uploaded, expected)
    assert.equal(result.bytes, expected.length)
  } finally { globalThis.fetch = original }
})

test('new-machine command is issued only for the exported R2 package and preserves scoped transport', async () => {
  const original = globalThis.fetch
  let authorization = '', requestBody = ''
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = String((init?.headers as Record<string, string>).Authorization)
    requestBody = String(init?.body)
    return new Response(JSON.stringify({ ok: true, expiresInSeconds: 60, command: 'bash <(curl -fsSL https://skill.vyibc.com/dsh-config-bootstrap/release/install-dsh-config-bootstrap.sh) --bootstrap-token scoped-token --config-url "https://resource.example/dsh-task-console/config-exports/config.json"' }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await createBootstrapCommand('https://resource.example/dsh-task-console/config-exports/config.json', { domain: 'https://resource.example', endpoint: 'https://fleet.example/bootstrap', token: 'server-only-token' })
    assert.equal(authorization, 'Bearer server-only-token')
    assert.equal(JSON.parse(requestBody).configUrl, 'https://resource.example/dsh-task-console/config-exports/config.json')
    assert.match(result.command, /--bootstrap-token scoped-token/)
  } finally { globalThis.fetch = original }
})
