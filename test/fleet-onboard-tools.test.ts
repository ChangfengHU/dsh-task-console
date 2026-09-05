import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  HttpFleetOnboardCloudTransport,
  HttpFleetOnboardLedger,
  ScopedFleetMcpClient,
  SubprocessFleetOnboardAdapter,
  VaultFirstCredentialProvider,
  registerFleetOnboardTools,
  type FleetLedgerRun,
  type FleetOnboardCloudTransport,
  type FleetOnboardHostAdapter,
  type FleetToolResult,
  type ToolExecutionLike,
} from '../src/fleet-onboard-tools.ts'

const IP = '192.0.2.77'
const RANDOM_IP = '198.51.100.91'
const CANARY = 'SENSITIVE_CANARY_PASSWORD_97f1c3'
const HMAC_KEY = '0123456789abcdef'.repeat(4)
const AGENT_TOKEN = 'agent-scope-token-for-local-tests'
const EXECUTOR_TOKEN = 'executor-scope-token-for-local-tests'
const WORKER = 'dsh-host-fixture'
const EXECUTOR_VERSION = 'host-adapter-test-v1'
const COMPONENTS = [
  ['ssh-preflight', 'fleet.ssh-preflight.v1', ['reachable', 'admin', 'systemd', 'tun', 'resources'], []],
  ['standard-account', 'fleet.standard-account.v1', ['login', 'passwordless_sudo', 'vault_writeback'], []],
  ['vault-login', 'fleet.vault-login.v1', ['login', 'passwordless_sudo', 'vault_readback'], []],
  ['resource-snapshot', 'fleet.machine-runtime-reconcile.v1', ['captured', 'ports_inspected', 'services_inspected', 'machined_ready'], []],
  ['mihomo', 'fleet.mihomo-reconcile.v1', ['tun', 'tcp_exit', 'udp_exit', 'line_100'], ['mihomo.service']],
  ['clash-control-plane', 'fleet.clash-control-plane-reconcile.v1', ['controller_health', 'dashboard_health'], ['linux-clash-node-controller.service', 'linux-clash-dashboard.service']],
  ['browser-vnc', 'fleet.browser-vnc-reconcile.v1', ['browser_instances', 'loopback_only', 'https_exit', 'webrtc_exit'], ['linux-browser-vnc-xvfb.service', 'linux-browser-vnc-openbox.service', 'linux-browser-vnc-x11vnc.service', 'linux-browser-vnc-novnc.service', 'linux-browser-vnc-health.service']],
  ['cloudflare-publication', 'fleet.cloudflare-publication-reconcile.v1', ['clash_http', 'vnc_http', 'vnc_websocket'], ['linux-browser-vnc-tunnel.service']],
  ['acceptance', 'fleet.acceptance-reconcile.v1', ['ssh_survives_tun', 'controller', 'dashboard', 'tcp_exit_line_100', 'udp_exit_line_100', 'clash_public', 'vnc_websocket', 'browser_egress', 'timezone_aligned', 'telemetry_fresh', 'disk', 'proxy_latency'], []],
  ['fleet-registration', 'fleet.registration-reconcile.v1', ['registered', 'readback', 'reachable'], []],
] as const

const CONTRACT = {
  schema: 1, default_line: 'line-100', health_states: ['healthy', 'drifted', 'missing', 'blocked'],
  dispositions: ['reusable', 'repairable', 'needs-user', 'fatal'],
  stages: COMPONENTS.map(([id, executor_id, required_checks, required_units], index) => ({
    stage: index + 1, id, executor_id, required_checks, required_units,
    execution_mode: [0, 2, 8].includes(index) ? 'probe-gate' : 'reconcile',
    ...(index === 4 ? { allowed_facts: { desiredLine: {}, actualLine: {}, tcpExit: {}, udpExit: {} } } : {}),
    ...(index === 6 ? { required_unit_template: { format: 'linux-browser-vnc-browser@{index}.service', count_from: 'desired.browser_count' } } : {}),
  })),
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function verifyHmac(value: any): boolean {
  const unsigned = JSON.parse(JSON.stringify(value))
  const supplied = unsigned.attestation ?? unsigned.provenance?.attestation
  if (unsigned.attestation) delete unsigned.attestation
  else delete unsigned.provenance.attestation
  return supplied === `hmac-sha256:${createHmac('sha256', HMAC_KEY).update(canonical(unsigned)).digest('hex')}`
}

function registry(adapter?: FleetOnboardHostAdapter, readOnly = false) {
  const definitions: any[] = []
  const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => undefined } } }
  return registerFleetOnboardTools(ctx, adapter, readOnly).then(dispose => ({ definitions, dispose }))
}

test('read-only onboarding capability registers no start or resume tools', async () => {
  const { definitions, dispose } = await registry(undefined, true)
  assert.deepEqual(definitions.map(tool => tool.name), ['fleet_onboard_status', 'fleet_onboard_report'])
  for (const tool of definitions) {
    const result = await tool.execute({ ip: IP }, execution('Read status only'))
    assert.equal(result.execution_available, false)
    assert.equal(result.run_created, false)
  }
  dispose()
})

function execution(text: string | string[], headerOnly = false): ToolExecutionLike {
  const messages = (Array.isArray(text) ? text : [text]).map(value => ({ role: 'user', content: [{ type: 'text', text: value }] }))
  return {
    agent: {
      id: 'agent-object-id-must-not-win',
      session: {
        ...(headerOnly ? { header: { id: 'session-from-header' } } : { id: 'session-fleet-fixture' }),
        deriveMessages: () => messages,
      },
    },
  }
}

interface FixtureFiles {
  root: string; log: string; keyFile: string; contractFile: string; probe: string; runtime: string; provider: string
}

async function fixtureFiles(): Promise<FixtureFiles> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-onboard-tools-test-'))
  const log = join(root, 'argv.jsonl')
  const keyFile = join(root, 'hmac.key')
  const contractFile = join(root, 'component-contract.json')
  const probe = new URL('./fixtures/fleet-onboard-probe.mjs', import.meta.url).pathname
  const runtime = new URL('./fixtures/fleet-onboard-runtime.mjs', import.meta.url).pathname
  const provider = new URL('./fixtures/fleet-onboard-vault-provider.mjs', import.meta.url).pathname
  await Promise.all([chmod(probe, 0o755), chmod(runtime, 0o755), chmod(provider, 0o755)])
  await writeFile(keyFile, HMAC_KEY, { mode: 0o600 })
  await writeFile(contractFile, JSON.stringify(CONTRACT))
  await writeFile(log, '')
  return { root, log, keyFile, contractFile, probe, runtime, provider }
}

interface LedgerFixture {
  server: Server
  agentUrl: string
  executorUrl: string
  calls: Array<{ scope: string; tool: string; args: any }>
  probeSeenBeforeStart: () => boolean
}

async function ledgerFixture(probeLog: string): Promise<LedgerFixture> {
  const calls: Array<{ scope: string; tool: string; args: any }> = []
  const stages: any[] = []
  let probeFirst = false
  let run: FleetLedgerRun | undefined
  let challenge = 0
  const rotate = () => `challenge-${++challenge}`
  const response = (res: any, id: unknown, payload: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }))
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const scope = req.url === '/agent' ? 'agent' : req.url === '/executor' ? 'executor' : 'unknown'
    const expectedToken = scope === 'agent' ? AGENT_TOKEN : EXECUTOR_TOKEN
    if (req.headers.authorization !== `Bearer ${expectedToken}`) { res.writeHead(401); res.end(); return }
    const tool = message.params.name
    const allowed = scope === 'agent'
      ? new Set(['onboard_start', 'onboard_status', 'onboard_report'])
      : new Set(['onboard_resume', 'onboard_record', 'onboard_finish'])
    if (!allowed.has(tool)) { res.writeHead(403); res.end(); return }
    const args = message.params.arguments
    calls.push({ scope, tool, args })
    if (tool === 'onboard_start') {
      const log = await readFile(probeLog, 'utf8')
      probeFirst = log.includes('"role":"probe"')
      assert.equal(verifyHmac(args.inventoryEvidence), true)
      assert.equal(args.inventoryEvidence.provenance.target_fingerprint, args.targetFingerprint)
      if (!run) {
        run = {
          id: 'onb-fixture', nodeId: `host-${args.ip.replaceAll('.', '-')}`, ip: args.ip,
          sessionId: args.sessionId, mode: args.mode, status: 'running', currentStage: 0,
          revision: 1, leaseEpoch: 1, leaseOwner: args.workerId, writeChallenge: rotate(),
          contractVersion: args.contractVersion, executorVersion: args.executorVersion,
          targetFingerprint: args.targetFingerprint, browserCount: args.browserCount,
        }
      }
      response(res, message.id, { ok: true, created: stages.length === 0 && run.revision === 1, run }); return
    }
    if (tool === 'onboard_status' || tool === 'onboard_report') {
      response(res, message.id, run ? { ok: true, run, stages, events: [] } : { ok: false, error: 'not found' }); return
    }
    assert.ok(run)
    assert.equal(args.runId, run.id)
    assert.equal(args.expectedRevision, run.revision)
    assert.equal(args.expectedLeaseEpoch, run.leaseEpoch)
    assert.equal(args.workerId, WORKER)
    assert.equal(args.writeChallenge, run.writeChallenge)
    if (tool === 'onboard_resume') {
      assert.equal(verifyHmac(args.inventoryEvidence), true)
      assert.equal(args.targetFingerprint, run.targetFingerprint)
      run = { ...run, sessionId: args.sessionId, status: 'running', revision: run.revision + 1, leaseEpoch: run.leaseEpoch + 1, leaseOwner: WORKER, writeChallenge: rotate() }
      response(res, message.id, { ok: true, run }); return
    }
    if (tool === 'onboard_record') {
      const evidence = args.evidence
      assert.equal(verifyHmac(evidence), true)
      assert.equal(evidence.runId, run.id)
      assert.equal(evidence.sessionId, run.sessionId)
      assert.equal(evidence.workerId, WORKER)
      assert.equal(evidence.revision, run.revision)
      assert.equal(evidence.leaseEpoch, run.leaseEpoch)
      assert.equal(evidence.writeChallenge, run.writeChallenge)
      const prior = stages.filter(item => item.stage === evidence.stage).at(-1)
      const expectedAttempt = prior?.status === 'running' ? prior.attempt : (prior?.attempt ?? 0) + 1
      assert.equal(evidence.attempt, expectedAttempt)
      if (prior?.status === 'running') Object.assign(prior, evidence)
      else stages.push({ ...evidence })
      const passed = evidence.status === 'passed'
      run = { ...run, status: passed || evidence.status === 'running' ? 'running' : 'blocked', currentStage: passed ? evidence.stage : evidence.stage - 1, revision: run.revision + 1, writeChallenge: rotate() }
      response(res, message.id, { ok: true, run }); return
    }
    assert.equal(tool, 'onboard_finish')
    assert.equal(verifyHmac(args.completionEvidence), true)
    assert.deepEqual({
      runId: args.completionEvidence.runId, nodeId: args.completionEvidence.nodeId,
      ip: args.completionEvidence.ip, sessionId: args.completionEvidence.sessionId,
      workerId: args.completionEvidence.workerId, revision: args.completionEvidence.revision,
      leaseEpoch: args.completionEvidence.leaseEpoch, writeChallenge: args.completionEvidence.writeChallenge,
      status: args.completionEvidence.status,
    }, {
      runId: run.id, nodeId: run.nodeId, ip: run.ip, sessionId: run.sessionId,
      workerId: WORKER, revision: run.revision, leaseEpoch: run.leaseEpoch,
      writeChallenge: run.writeChallenge, status: args.status,
    })
    if (args.status === 'complete') assert.equal(verifyHmac(args.inventoryEvidence), true)
    run = {
      ...run, status: args.status, revision: run.revision + 1, leaseOwner: null, writeChallenge: rotate(),
      report: { summary: args.summary, blocked: stages.filter(item => item.status === 'blocked') },
    }
    response(res, message.id, { ok: true, run })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return {
    server, calls, agentUrl: `http://127.0.0.1:${address.port}/agent`, executorUrl: `http://127.0.0.1:${address.port}/executor`,
    probeSeenBeforeStart: () => probeFirst,
  }
}

async function createAdapter(files: FixtureFiles, ledger: LedgerFixture, options: { vaultAvailable?: boolean; healthyThrough?: number; badFingerprint?: boolean; executorAvailable?: boolean; cloud?: FleetOnboardCloudTransport } = {}) {
  const credentials = await VaultFirstCredentialProvider.create({
    command: { executable: files.provider },
    environment: {
      FLEET_FIXTURE_LOG: files.log,
      FLEET_FIXTURE_VAULT_AVAILABLE: options.vaultAvailable ? '1' : '0',
      FLEET_FIXTURE_VAULT_SECRET: CANARY,
      FLEET_ONBOARD_VAULT_RESOLVE_TOKEN: 'vault-resolve-scoped-test-token',
      FLEET_ONBOARD_VAULT_RESOLVE_URL: 'https://fleet.invalid/mcp/fleet-onboard-vault',
    },
  })
  return SubprocessFleetOnboardAdapter.create({
    credentials,
    ledger: new HttpFleetOnboardLedger({
      agentUrl: ledger.agentUrl, agentToken: AGENT_TOKEN, executorUrl: ledger.executorUrl,
      executorToken: EXECUTOR_TOKEN, workerId: WORKER,
    }),
    probe: { executable: files.probe }, runtime: { executable: files.runtime },
    ...(options.executorAvailable ? { executor: { executable: files.runtime } } : {}),
    ...(options.cloud ? { cloud: options.cloud } : {}),
    contractFile: files.contractFile, hmacKeyFile: files.keyFile,
    hmacForbiddenValues: [AGENT_TOKEN, EXECUTOR_TOKEN, 'vault-resolve-scoped-test-token'],
    environment: {
      FLEET_FIXTURE_LOG: files.log,
      FLEET_FIXTURE_HEALTHY_THROUGH: String(options.healthyThrough ?? 2),
      ...(options.badFingerprint ? { FLEET_FIXTURE_BAD_FINGERPRINT: '1' } : {}),
    },
    workerId: WORKER, executorVersion: EXECUTOR_VERSION,
  })
}

test('module registers exactly four strict intent-only schemas', async () => {
  const adapter: FleetOnboardHostAdapter = {
    executionAvailable: false,
    async start(ip) { return result('start', ip) }, async status(ip) { return result('status', ip) },
    async resume(ip) { return result('resume', ip) }, async report(ip) { return result('report', ip) },
  }
  const { definitions } = await registry(adapter)
  assert.deepEqual(definitions.map(tool => tool.name), [
    'fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report',
  ])
  for (const tool of definitions) {
    assert.deepEqual(Object.keys(tool.parameters.properties), ['ip'])
    assert.equal(tool.parameters.additionalProperties, false)
    const serialized = JSON.stringify(tool.parameters).toLowerCase()
    for (const unsafe of ['inventory', 'command', 'path', 'password', 'token', 'secret', 'key', 'credential']) {
      assert.ok(!serialized.includes(unsafe), `${tool.name} schema leaked ${unsafe}`)
    }
    assert.throws(() => tool.execute({ ip: IP, inventory: {} }, execution(`repair ${IP}`)), /unsupported tool argument/)
  }
})

test('missing session credentials checks fixed Vault first, then returns needs_input with zero probe and zero ledger run', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: false })
  const value = await adapter.start(RANDOM_IP, 'base', execution(`请检查并幂等修复 ${RANDOM_IP}`))
  assert.deepEqual(value, {
    schema: 1, ok: false, operation: 'start', ip: RANDOM_IP, phase: 'intake', execution_available: false,
    needs_input: true, run_created: false, probe_executed: false,
    reason: 'first-login-credential-required', missing: ['ssh_username', 'ssh_credential'],
  })
  assert.equal(ledger.calls.length, 0)
  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.role), ['vault-provider'])
  assert.deepEqual(records[0].argv, [])
  assert.equal(records[0].scopedTokenPresent, true)
  assert.ok(!JSON.stringify(records).includes(CANARY))
})

test('later standalone username and password replies complete the anchored IP intake without leaking secrets', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: false, healthyThrough: 1 })
  const value = await adapter.start(IP, 'base', execution([
    `@装机者 请接入 ${IP}`,
    'root',
    CANARY,
  ]))
  assert.equal(value.probe_executed, true)
  assert.equal(value.run_created, true)
  assert.equal(value.reason, 'executor-not-configured')
  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.role), ['probe', 'runtime-assess'])
  assert.ok(!JSON.stringify(records).includes(CANARY))
  assert.ok(!JSON.stringify(value).includes(CANARY))
  assert.ok(!JSON.stringify(ledger.calls).includes(CANARY))
  await assert.rejects(() => readFile(records[0].credentialFile), /ENOENT/)
})

test('a later different IP invalidates credential replies and causes zero probe and zero ledger writes', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: false })
  const value = await adapter.start(IP, 'base', execution([
    `@装机者 请接入 ${IP}`,
    'root',
    `改为处理 ${RANDOM_IP}`,
    CANARY,
  ]))
  assert.equal(value.needs_input, true)
  assert.equal(value.probe_executed, false)
  assert.equal(value.run_created, false)
  assert.equal(ledger.calls.length, 0)
  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.role), ['vault-provider'])
  assert.ok(!JSON.stringify(records).includes(CANARY))
})

test('Vault lease, signed probe, scoped central CAS receipts and retry remain secret-free', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 1 })
  const exec = execution(`@装机者 请检查并幂等修复 ${IP}`, true)
  const first = await adapter.start(IP, 'base', exec)
  assert.equal(first.ok, false)
  assert.equal(first.phase, 'blocked')
  assert.equal(first.current_stage, 1)
  assert.equal(first.reason, 'executor-not-configured')
  assert.equal(first.execution_available, false)
  assert.equal(first.run_created, true)
  assert.equal(first.probe_executed, true)
  assert.equal(ledger.probeSeenBeforeStart(), true)
  assert.deepEqual(ledger.calls.map(call => `${call.scope}:${call.tool}`), [
    'agent:onboard_status', 'agent:onboard_start', 'executor:onboard_record', 'executor:onboard_record',
  ])
  const startCall = ledger.calls.find(call => call.tool === 'onboard_start')!
  assert.equal(startCall.args.sessionId, 'session-from-header')
  assert.equal(startCall.args.mode, 'new')
  assert.equal(startCall.args.reasonCode, 'user-request')
  assert.equal(verifyHmac(startCall.args.inventoryEvidence), true)
  assert.ok(!JSON.stringify(first).includes(CANARY))
  assert.ok(!JSON.stringify(ledger.calls).includes(CANARY))
  assert.ok(!JSON.stringify(ledger.calls).includes(HMAC_KEY))
  assert.ok(!JSON.stringify(ledger.calls).includes(AGENT_TOKEN))
  assert.ok(!JSON.stringify(ledger.calls).includes(EXECUTOR_TOKEN))

  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.role), ['vault-provider', 'probe', 'runtime-assess'])
  assert.equal(records[1].credentialMode, 0o600)
  assert.ok(!JSON.stringify(records).includes(CANARY))
  await assert.rejects(() => readFile(records[1].credentialFile), /ENOENT/)

  const resumed = await adapter.resume(IP, 'base', exec)
  assert.equal(resumed.phase, 'blocked')
  const resumeCall = ledger.calls.find(call => call.tool === 'onboard_resume')!
  assert.equal(resumeCall.scope, 'executor')
  assert.equal(resumeCall.args.targetFingerprint, resumeCall.args.inventoryEvidence.provenance.target_fingerprint)
  assert.equal(resumeCall.args.reasonCode, 'retry-repairable-stage')
  assert.equal(verifyHmac(resumeCall.args.inventoryEvidence), true)
  const stageTwo = ledger.calls.filter(call => call.tool === 'onboard_record' && call.args.evidence.stage === 2)
  assert.deepEqual(stageTwo.map(call => call.args.evidence.attempt), [1, 2])

  const status = await adapter.status(IP, exec)
  const rendered = JSON.stringify(status)
  assert.equal(status.run_id, 'onb-fixture')
  for (const forbidden of ['writeChallenge', 'attestation', 'leaseOwner', 'session-from-header', WORKER, CANARY, AGENT_TOKEN, EXECUTOR_TOKEN]) {
    assert.ok(!rendered.includes(forbidden), `projected status leaked ${forbidden}`)
  }
})

test('invalid physical-host fingerprint fails before central start and runtime assessment', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, badFingerprint: true })
  const value = await adapter.start(IP, 'base', execution(`检查 ${IP}`))
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'host-adapter-failed')
  assert.equal(value.run_created, false)
  assert.equal(value.probe_executed, true)
  assert.equal(ledger.calls.length, 0)
  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.role), ['vault-provider', 'probe'])
  assert.ok(!JSON.stringify(value).includes(CANARY))
  await assert.rejects(() => readFile(records[1].credentialFile), /ENOENT/)
})

test('adapter rejects a non-canonical or bearer-equal evidence key before any subprocess', async () => {
  const files = await fixtureFiles()
  const credentials = { async resolve() { return { available: false } } }
  const base = {
    credentials, probe: { executable: files.probe }, runtime: { executable: files.runtime },
    contractFile: files.contractFile, hmacKeyFile: files.keyFile,
    workerId: WORKER, executorVersion: EXECUTOR_VERSION,
  }
  await assert.rejects(() => SubprocessFleetOnboardAdapter.create({
    ...base, hmacForbiddenValues: [HMAC_KEY, EXECUTOR_TOKEN, 'vault-resolve-scoped-test-token'],
  }), /hmac-key-must-differ/)
  await assert.rejects(() => SubprocessFleetOnboardAdapter.create({
    ...base, timeoutMs: 15 * 60_000,
    hmacForbiddenValues: [AGENT_TOKEN, EXECUTOR_TOKEN, 'vault-resolve-scoped-test-token'],
  }), /adapter-timeout-invalid/)
  await writeFile(files.keyFile, 'A'.repeat(64), { mode: 0o600 })
  await assert.rejects(() => SubprocessFleetOnboardAdapter.create({
    ...base, hmacForbiddenValues: [AGENT_TOKEN, EXECUTOR_TOKEN, 'vault-resolve-scoped-test-token'],
  }), /hmac-key-file-format-invalid/)
  assert.equal(await readFile(files.log, 'utf8'), '')
})

test('a bare host is classified as new, not adopt, before central start', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 0 })
  const value = await adapter.start(IP, 'base', execution(`接入 ${IP}`))
  assert.equal(value.phase, 'blocked')
  assert.equal(value.current_stage, 0)
  assert.equal(value.needs_input, true)
  assert.equal(value.reason, 'probe-gate-not-satisfied')
  assert.equal(ledger.calls.find(call => call.tool === 'onboard_start')!.args.mode, 'new')
})

test('execution availability requires ledger, probe, host executors and Cloud transport', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const cloud: FleetOnboardCloudTransport = { async execute() { return { status: 'running', action: null, resultCode: null } } }
  const adapter = await createAdapter(files, ledger, { executorAvailable: true, cloud })
  assert.equal(adapter.executionAvailable, true)
  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.role), ['runtime-capabilities'])
})

test('Cloud transport sends only the fixed four-field request and polls the exact stage idempotently', async () => {
  const token = 'cloud-workflow-scoped-test-token'
  const operationId = 'onboard-0123456789abcdef0123456789abcdef'
  const requests: Array<{ url: string; method: string; authorization: string; body?: string }> = []
  let poll = 0
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({
      url: String(input), method: init.method ?? 'GET',
      authorization: String((init.headers as Record<string, string>)?.authorization ?? ''),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    })
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, operation_id: operationId, status: 'queued', idempotent: poll > 0 }), {
        status: poll > 0 ? 200 : 202, headers: { 'content-type': 'application/json' },
      })
    }
    poll += 1
    return new Response(JSON.stringify({
      ok: true,
      operations: [{
        operation_id: operationId, schema_version: 1, stage: 5, ip: '1.1.1.1', node_id: 'host-1-1-1-1',
        status: poll === 1 ? 'running' : 'succeeded', result_code: poll === 1 ? null : 'readback-verified',
        action: poll === 1 ? null : 'reused',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const cloud = new HttpFleetOnboardCloudTransport({
    url: 'https://control.invalid/api/fleet-onboard-cloud/v1/operations', token, fetch: fakeFetch,
  })
  assert.deepEqual(await cloud.execute({ schema: 1, operationId, stage: 5, ip: '1.1.1.1' }), {
    status: 'running', action: null, resultCode: null,
  })
  assert.deepEqual(await cloud.execute({ schema: 1, operationId, stage: 5, ip: '1.1.1.1' }), {
    status: 'succeeded', action: 'reused', resultCode: 'readback-verified',
  })
  const posts = requests.filter(request => request.method === 'POST')
  assert.equal(posts.length, 2)
  assert.deepEqual(posts.map(request => JSON.parse(request.body!)), [
    { schema: 1, operation_id: operationId, stage: 5, ip: '1.1.1.1' },
    { schema: 1, operation_id: operationId, stage: 5, ip: '1.1.1.1' },
  ])
  assert.ok(requests.every(request => request.authorization === `Bearer ${token}`))
  assert.ok(requests.every(request => !String(request.body ?? '').includes(token)))
  assert.ok(requests.filter(request => request.method === 'GET').every(request => request.url === `https://control.invalid/api/fleet-onboard-cloud/v1/operations/${operationId}`))
})

test('Cloud transport configuration rejects non-fixed URLs without exposing the token', () => {
  const token = 'cloud-workflow-scoped-test-token'
  for (const url of [
    'http://control.invalid/api/fleet-onboard-cloud/v1/operations',
    'https://user@control.invalid/api/fleet-onboard-cloud/v1/operations',
    'https://control.invalid/api/fleet-onboard-cloud/v1/operations?token=x',
    'https://control.invalid/api/other',
  ]) {
    assert.throws(() => new HttpFleetOnboardCloudTransport({ url, token }), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes(token))
      return /url-unsafe/.test(error.message)
    })
  }
})

test('Cloud disabled status becomes a needs-user blocker and never passes the stage', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const cloud: FleetOnboardCloudTransport = {
    async execute() { return { status: 'blocked', action: null, resultCode: 'fleet-machine-disabled' } },
  }
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 4, cloud })
  const value = await adapter.start(IP, 'base', execution(`修复 ${IP}`))
  assert.equal(value.phase, 'blocked')
  assert.equal(value.reason, 'fleet-machine-disabled')
  assert.equal(value.needs_input, true)
  const stage = ledger.calls.filter(call => call.tool === 'onboard_record' && call.args.evidence.stage === 5)
  assert.deepEqual(stage.map(call => call.args.evidence.status), ['running', 'blocked'])
})

test('resume polls a running Cloud stage with the same durable operation id and ledger attempt', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const operationIds: string[] = []
  const cloud: FleetOnboardCloudTransport = {
    async execute(input) {
      operationIds.push(input.operationId)
      return { status: 'running', action: null, resultCode: null }
    },
  }
  const adapter = await createAdapter(files, ledger, {
    vaultAvailable: true, healthyThrough: 4, executorAvailable: true, cloud,
  })
  const exec = execution(`修复 ${IP}`)
  assert.equal((await adapter.start(IP, 'base', exec)).reason, 'operation-still-running')
  assert.equal((await adapter.resume(IP, 'base', exec)).reason, 'operation-still-running')
  assert.equal(operationIds.length, 2)
  assert.equal(operationIds[0], operationIds[1])
  const stage = ledger.calls.filter(call => call.tool === 'onboard_record' && call.args.evidence.stage === 5)
  assert.deepEqual(stage.map(call => [call.args.evidence.attempt, call.args.evidence.status]), [[1, 'running']])
})

test('Cloud success cannot pass until a fresh host probe proves the stage healthy', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const cloud: FleetOnboardCloudTransport = {
    async execute() { return { status: 'succeeded', action: 'changed', resultCode: 'readback-verified' } },
  }
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 4, cloud })
  const value = await adapter.start(IP, 'base', execution(`修复 ${IP}`))
  assert.equal(value.phase, 'blocked')
  assert.equal(value.reason, 'cloud-postcondition-not-healthy')
  const stage = ledger.calls.filter(call => call.tool === 'onboard_record' && call.args.evidence.stage === 5)
  assert.deepEqual(stage.map(call => call.args.evidence.status), ['running', 'blocked'])
  const records = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(records.filter(record => record.role === 'probe').length, 2)
})

test('missing Cloud configuration fails closed at the first unhealthy Cloud stage', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 4, executorAvailable: true })
  assert.equal(adapter.executionAvailable, false)
  const value = await adapter.start(IP, 'base', execution(`修复 ${IP}`))
  assert.equal(value.phase, 'blocked')
  assert.equal(value.reason, 'cloud-transport-not-configured')
  assert.equal(value.current_stage, 4)
})

test('a durable executor still running keeps the same ledger attempt open', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 1, executorAvailable: true })
  const value = await adapter.start(IP, 'base', execution(`修复 ${IP}`))
  assert.equal(value.phase, 'running')
  assert.equal(value.reason, 'operation-still-running')
  const stage = ledger.calls.filter(call => call.tool === 'onboard_record' && call.args.evidence.stage === 2)
  assert.deepEqual(stage.map(call => call.args.evidence.status), ['running'])
})

test('configured Stage 9 remediation runs before the acceptance probe gate is retried', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 8, executorAvailable: true })
  const value = await adapter.start(IP, 'base', execution(`验收并修复 ${IP}`))
  assert.equal(value.phase, 'running')
  assert.equal(value.reason, 'operation-still-running')
  assert.equal(value.current_stage, 8)
  assert.equal(value.needs_input, false)
  const stage = ledger.calls.filter(call => call.tool === 'onboard_record' && call.args.evidence.stage === 9)
  assert.deepEqual(stage.map(call => call.args.evidence.status), ['running'])
})

test('already-healthy node records ten verified stages and binds final inventory to finish', async t => {
  const files = await fixtureFiles()
  const ledger = await ledgerFixture(files.log)
  t.after(() => new Promise<void>(resolve => ledger.server.close(() => resolve())))
  const adapter = await createAdapter(files, ledger, { vaultAvailable: true, healthyThrough: 10 })
  const value = await adapter.start(IP, 'base', execution(`验收 ${IP}`))
  assert.equal(value.ok, true)
  assert.equal(value.phase, 'complete')
  assert.equal(value.current_stage, 10)
  assert.equal(value.execution_available, false)
  assert.equal(ledger.calls.find(call => call.tool === 'onboard_start')!.args.mode, 'verify-only')
  const records = ledger.calls.filter(call => call.tool === 'onboard_record')
  assert.equal(records.length, 10)
  assert.deepEqual(records.map(call => call.args.evidence.stage), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const finish = ledger.calls.at(-1)!
  assert.equal(finish.tool, 'onboard_finish')
  assert.equal(finish.args.status, 'complete')
  assert.equal(Object.hasOwn(finish.args, 'summary'), false)
  assert.equal(verifyHmac(finish.args.inventoryEvidence), true)
  assert.equal(finish.args.inventoryEvidence.provenance.target_fingerprint, records[0].args.evidence.targetFingerprint)
})

test('scoped MCP clients reject cross-scope methods before HTTP', async t => {
  let requests = 0
  const server = createServer((_req, res) => { requests += 1; res.writeHead(500); res.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  const url = `http://127.0.0.1:${address.port}/agent`
  const agent = new ScopedFleetMcpClient(url, AGENT_TOKEN, WORKER, ['onboard_start', 'onboard_status', 'onboard_report'])
  await assert.rejects(() => (agent as any).call('onboard_record', {}), /scope-denied/)
  const executor = new ScopedFleetMcpClient(url, EXECUTOR_TOKEN, WORKER, ['onboard_resume', 'onboard_record', 'onboard_finish'])
  await assert.rejects(() => (executor as any).call('onboard_status', {}), /scope-denied/)
  assert.equal(requests, 0)
})

function result(operation: FleetToolResult['operation'], ip: string): FleetToolResult {
  return {
    schema: 1, ok: false, operation, ip, phase: 'blocked', execution_available: false,
    needs_input: false, run_created: false, probe_executed: false,
  }
}
