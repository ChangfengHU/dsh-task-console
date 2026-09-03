#!/usr/bin/env node

import { appendFile, writeFile } from 'node:fs/promises'

const input = JSON.parse(await new Promise((resolve, reject) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { text += chunk })
  process.stdin.on('end', () => resolve(text))
  process.stdin.on('error', reject)
}))

await appendFile(process.env.FLEET_FIXTURE_LOG, `${JSON.stringify({
  role: 'vault-provider', argv: process.argv.slice(2), stdin: input,
  scopedTokenPresent: Boolean(process.env.FLEET_ONBOARD_VAULT_RESOLVE_TOKEN),
  scopedUrlPresent: Boolean(process.env.FLEET_ONBOARD_VAULT_RESOLVE_URL),
})}\n`)

if (process.env.FLEET_FIXTURE_VAULT_AVAILABLE !== '1') {
  process.stdout.write(`${JSON.stringify({ schema: 1, available: false, reason_code: 'managed-credential-missing' })}\n`)
  process.exit(2)
}

await writeFile(process.env.FLEET_ONBOARD_CREDENTIAL_FILE, JSON.stringify({
  schema: 1, ip: input.ip, username: 'root', password: process.env.FLEET_FIXTURE_VAULT_SECRET,
  source: 'vault',
}), { flag: 'wx', mode: 0o600 })
process.stdout.write(`${JSON.stringify({ schema: 1, available: true, source: 'vault' })}\n`)
