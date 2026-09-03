#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto'
import { appendFile, readFile, stat } from 'node:fs/promises'

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const input = JSON.parse(await new Promise((resolve, reject) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { text += chunk })
  process.stdin.on('end', () => resolve(text))
  process.stdin.on('error', reject)
}))
const credentialFile = process.env.FLEET_ONBOARD_CREDENTIAL_FILE
if (!credentialFile) process.exit(21)
const metadata = await stat(credentialFile)
if ((metadata.mode & 0o777) !== 0o600) process.exit(22)
const credential = JSON.parse(await readFile(credentialFile, 'utf8'))
if (!credential.username || !credential.password || credential.ip !== input.ip) process.exit(23)
await appendFile(process.env.FLEET_FIXTURE_LOG, `${JSON.stringify({
  role: 'probe', argv: process.argv.slice(2), stdin: input, credentialFile, credentialMode: metadata.mode & 0o777,
})}\n`)
const contract = JSON.parse(await readFile(process.env.FLEET_ONBOARD_CONTRACT_FILE, 'utf8'))
const key = (await readFile(process.env.FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE, 'utf8')).trimEnd()
const through = Number(process.env.FLEET_FIXTURE_HEALTHY_THROUGH || 0)
const components = {}
for (const stage of contract.stages) {
  const healthy = stage.stage <= through
  const units = Object.fromEntries((stage.required_units || []).map(name => [name, { exists: healthy, active: healthy, enabled: healthy }]))
  if (stage.required_unit_template?.format) {
    for (let index = 1; index <= 2; index += 1) {
      const name = stage.required_unit_template.format.replace('{index}', String(index))
      units[name] = { exists: healthy, active: healthy, enabled: healthy }
    }
  }
  components[stage.id] = {
    present: healthy, healthy, conflict: false, fatal: false,
    checks: Object.fromEntries((stage.required_checks || []).map(name => [name, healthy])), units,
    facts: stage.stage === 5 ? {
      desiredLine: 'line-100', actualLine: healthy ? 'line-100' : null,
      tcpExit: healthy ? '8.8.8.8' : null, udpExit: healthy ? '8.8.8.8' : null,
    } : {},
  }
}
const inventory = {
  schema: 1,
  ip: input.ip,
  provenance: {
    origin: 'dsh-fleet-probe-v1', executor_id: 'fleet.inventory-probe.v1', observed_at: new Date().toISOString(),
    target_fingerprint: process.env.FLEET_FIXTURE_BAD_FINGERPRINT === '1'
      ? 'sha256:not-a-real-target-binding'
      : `sha256:${createHash('sha256').update(`ssh-host-key\0machine-id\0${input.ip}`).digest('hex')}`,
    contract_sha256: createHash('sha256').update(canonical(contract)).digest('hex'),
  },
  desired: { line: 'line-100', browser_count: 2, profile: 'base' },
  fleet: { registered: through >= 10, reachable: through >= 10, ...(through >= 10 ? { node_id: `host-${input.ip.replaceAll('.', '-')}` } : {}) },
  credentials: { available: true, source: credential.source || 'intake' },
  components,
}
inventory.provenance.attestation = `hmac-sha256:${createHmac('sha256', key).update(canonical(inventory)).digest('hex')}`
process.stdout.write(`${JSON.stringify({ schema: 1, ok: true, operation: 'probe', ip: input.ip, inventory })}\n`)
