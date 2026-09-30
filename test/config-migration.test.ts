import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicConfigUrl, createBootstrapCommand, createEnvelope, downloadConfig, encodeEnvelope, FLEET_RUNTIME, openConfig, parseEnvelope, portableAgentSpec, sealConfig, taskConfig, uploadConfig } from '../src/config-migration.ts'
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

test('migration preserves Studio and workflow native grants and refuses unsupported authored configuration', () => {
  const studio = { ...agent, tools: ['studio-runtime','workflow-runtime','fs-text'], taskExpertise: ['studio:review'] }
  assert.deepEqual(portableAgentSpec(studio), studio)
  assert.throws(() => portableAgentSpec({ ...studio, tools: [...studio.tools, 'uninstalled-custom-tool'] }), /不能静默丢失/)
  assert.throws(() => portableAgentSpec({ ...studio, customPluginPolicy: { write: false } }), /不能静默丢失/)
  assert.throws(() => portableAgentSpec({ ...studio, permissionPreset: 'unknown' }), /不能无损迁移/)
})

test('runtime bootstrap capability survives validation without entering the payload digest', () => {
  const envelope = createEnvelope({ agents: [{ spec: agent, actions: [] }], tasks: [] }, '1.0.0', new Date(), structuredClone(FLEET_RUNTIME))
  envelope.runtime!.bootstrap = { issuer: 'https://fleet.vyibc.com/api/hub/dsh-config-bootstrap', token: 'signed.capability', expiresAt: '2026-10-01T00:00:00.000Z' }
  const parsed = parseEnvelope(JSON.parse(encodeEnvelope(envelope).toString('utf8')))
  assert.equal(parsed.runtime?.bootstrap?.token, 'signed.capability')
})

test('package rejects a Task whose Agent definition is absent from the same export', () => {
  const envelope = createEnvelope({ agents: [], tasks: [taskConfig(task, [])] }, '1.0.0')
  assert.throws(() => parseEnvelope(envelope), /不存在的 Agent:planner/)
})

test('import URL is restricted to configured R2 origin and JSON', () => {
  assert.equal(assertPublicConfigUrl('https://resource.vyibc.com/a/config.json', 'https://resource.vyibc.com').hostname, 'resource.vyibc.com')
  assert.throws(() => assertPublicConfigUrl('http://resource.vyibc.com/a.json', 'https://resource.vyibc.com'), /只允许/)
  assert.throws(() => assertPublicConfigUrl('https://evil.example/a.json', 'https://resource.vyibc.com'), /只允许/)
  assert.throws(() => assertPublicConfigUrl('https://resource.vyibc.com/a.html', 'https://resource.vyibc.com'), /只允许/)
})

test('R2 upload keeps credentials in the request and verifies exact public bytes', async () => {
  const envelope = createEnvelope({ agents: [], tasks: [] }, '1.0.0', new Date('2026-09-16T01:00:00.000Z'))
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
    if (url.startsWith('https://resource.example/dsh-task-console/config-exports/config.json?verify=')) return new Response(uploaded, { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  try {
    const result = await uploadConfig(envelope, { endpoint: 'https://upload.example', domain: 'https://resource.example', token: 'test-only-token' })
    assert.equal(authorization, 'Bearer test-only-token')
    assert.equal(result.bytes, uploaded!.length)
    assert.match(result.publicUrl, /#key=[A-Za-z0-9_-]{43}$/)
    assert.doesNotMatch(uploaded!.toString(), /exportedAt|payload|agents|test-only-token/)
    assert.deepEqual(openConfig(JSON.parse(uploaded!.toString()), new URL(result.publicUrl).hash), envelope)
  } finally { globalThis.fetch = original }
})

test('encrypted R2 URL round-trip strips fragment from every HTTP request; no key means no import', async () => {
  const envelope = createEnvelope({ agents: [{ spec: agent, actions: [] }], tasks: [] }, 'test')
  const sealed = sealConfig(envelope), original = globalThis.fetch, seen: string[] = []
  globalThis.fetch = (async (input: any) => { seen.push(String(input)); return new Response(sealed.data) }) as typeof fetch
  try {
    const url = 'https://resource.example/a.json'
    assert.deepEqual((await downloadConfig(url + sealed.fragment, 'https://resource.example')).envelope, envelope)
    assert.deepEqual(seen, [url])
    await assert.rejects(() => downloadConfig(url, 'https://resource.example'), /完整迁移链接/)
    await assert.rejects(() => createBootstrapCommand(url + sealed.fragment, { domain: 'https://resource.example', endpoint: 'https://example.test', token: 'test' }), /旧引导安装器/)
    assert.equal(seen.length, 2, 'installer gets no decryption key or HTTP request')
    const modified = JSON.parse(sealed.data.toString()); modified.tag = 'AAAAAAAAAAAAAAAAAAAAAA'
    assert.throws(() => openConfig(modified, sealed.fragment), /解密校验失败/)
    assert.throws(() => openConfig(JSON.parse(sealed.data.toString()), '#key=' + 'A'.repeat(43)), /解密校验失败/)
    assert.deepEqual(openConfig(envelope), envelope, 'old plaintext exports remain supported')
  } finally { globalThis.fetch = original }
})

test('new-machine command is issued only for the exported R2 package and preserves scoped transport', async () => {
  const original = globalThis.fetch
  let authorization = '', requestBody = ''
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = String((init?.headers as Record<string, string>).Authorization)
    requestBody = String(init?.body)
    return new Response(JSON.stringify({ ok: true, expiresInSeconds: 60, bootstrapToken: 'scoped.token', command: 'bash <(curl -fsSL https://skill.vyibc.com/dsh-config-bootstrap/release/install-dsh-config-bootstrap.sh) --bootstrap-token scoped.token --config-url "https://resource.example/dsh-task-console/config-exports/config.json"' }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await createBootstrapCommand('https://resource.example/dsh-task-console/config-exports/config.json', { domain: 'https://resource.example', endpoint: 'https://fleet.example/bootstrap', token: 'server-only-token' })
    assert.equal(authorization, 'Bearer server-only-token')
    assert.equal(JSON.parse(requestBody).configUrl, 'https://resource.example/dsh-task-console/config-exports/config.json')
    assert.match(result.command, /--bootstrap-token scoped\.token/)
    assert.equal(result.bootstrapToken, 'scoped.token')
  } finally { globalThis.fetch = original }
})
