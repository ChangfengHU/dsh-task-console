#!/usr/bin/env node

import { appendFile } from 'node:fs/promises'

const argv = process.argv.slice(2)
const operation = argv[0]
const input = JSON.parse(await new Promise((resolve, reject) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { text += chunk })
  process.stdin.on('end', () => resolve(text))
  process.stdin.on('error', reject)
}))
await appendFile(process.env.FLEET_FIXTURE_LOG, `${JSON.stringify({ role: `runtime-${operation}`, argv, stdin: input })}\n`)
if (operation === 'capabilities') {
  const components = [
    ['ssh-preflight', 'fleet.ssh-preflight.v1'], ['standard-account', 'fleet.standard-account.v1'],
    ['vault-login', 'fleet.vault-login.v1'], ['resource-snapshot', 'fleet.resource-snapshot.v1'],
    ['mihomo', 'fleet.mihomo-reconcile.v1'], ['clash-control-plane', 'fleet.clash-control-plane-reconcile.v1'],
    ['browser-vnc', 'fleet.browser-vnc-reconcile.v1'], ['cloudflare-publication', 'fleet.cloudflare-publication-reconcile.v1'],
    ['acceptance', 'fleet.acceptance-reconcile.v1'], ['fleet-registration', 'fleet.registration-reconcile.v1'],
  ]
  process.stdout.write(`${JSON.stringify({
    schema: 1, ok: true, operation: 'capabilities', probe: 'configured',
    stages: components.map(([component, executor_id], index) => {
      const execution_mode = [0, 2, 3, 8].includes(index) ? 'probe-gate' : 'reconcile'
      return { stage: index + 1, component, executor_id, execution_mode, execution: execution_mode === 'probe-gate' ? 'probe-gated' : 'configured' }
    }),
  })}\n`)
  process.exit(0)
}
if (input?.action && input?.inventory) {
  process.stdout.write(`${JSON.stringify({
    schema: 1, executor_id: input.action.executor_id, operation_id: input.action.operation_id,
    outcome: 'blocked', classification: 'blocked', disposition: 'needs-user',
    reason_code: 'operation-still-running',
  })}\n`)
  process.exit(0)
}
if (!input?.provenance?.attestation?.startsWith('hmac-sha256:')) process.exit(41)
if (operation === 'assess') {
  const components = [
    'ssh-preflight', 'standard-account', 'vault-login', 'resource-snapshot', 'mihomo',
    'clash-control-plane', 'browser-vnc', 'cloudflare-publication', 'acceptance', 'fleet-registration',
  ].map((component, index) => {
    const observed = input.components?.[component]
    const healthy = observed?.healthy === true || (index === 9 && input.fleet?.registered === true && input.fleet?.reachable === true)
    return {
      stage: index + 1, component, health: healthy ? 'healthy' : 'missing',
      disposition: healthy ? 'reusable' : 'repairable', reason: healthy ? 'verified-healthy' : 'component-missing',
    }
  })
  const issue = components.find(item => item.health !== 'healthy')
  process.stdout.write(`${JSON.stringify({
    schema: 1, ok: true, ip: input.ip, mode: Object.keys(input.components || {}).length ? 'adopt' : 'new',
    phase: issue ? 'planned' : 'complete', components,
  })}\n`)
} else if (operation === 'start' || operation === 'resume') {
  process.stdout.write(`${JSON.stringify({
    schema: 1, ok: true, ip: input.ip, phase: 'planned', run_kind: operation === 'start' ? 'adopt' : 'resume',
    state_changed: true, changed: false, execution_available: false,
    actions: [{ stage: 6, component: 'clash-control-plane', executor_id: 'fleet.clash-control-plane.v1', operation_id: 'fixture-operation', reason: 'fixture-drift' }],
  })}\n`)
} else {
  process.exit(44)
}
