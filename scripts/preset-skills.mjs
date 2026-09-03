#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  ID_RE, readSpec, syncPresetSkills, userPresetRoot, verifyPresetSkills,
} from '../lib/index.js'

const exec = promisify(execFile)

function usage() {
  console.error('usage: node scripts/preset-skills.mjs [--check|--sync] --source-root /exact/linux-clash-skill [--id fleet-installer] [--root /exact/preset/root]')
  process.exit(2)
}

const args = process.argv.slice(2)
let mode = 'check'
let id = 'fleet-installer'
let root = userPresetRoot()
let sourceRoot = ''
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--check') mode = 'check'
  else if (arg === '--sync') mode = 'sync'
  else if (arg === '--id' && args[index + 1]) id = args[++index]
  else if (arg === '--root' && args[index + 1]) root = resolve(args[++index])
  else if (arg === '--source-root' && args[index + 1]) sourceRoot = resolve(args[++index])
  else usage()
}
if (!ID_RE.test(id) || !sourceRoot) usage()

const manifestPath = new URL(`../presets/${id}/skills.sources.json`, import.meta.url)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.version !== 1 || typeof manifest.repository !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.revision) || !Array.isArray(manifest.skills)
  || manifest.skills.some(row => !row || typeof row.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.name) || typeof row.path !== 'string' || !/^skills\/[a-z0-9][a-z0-9-]*$/.test(row.path))) {
  throw new Error(`invalid canonical skill manifest: ${manifestPath.pathname}`)
}
if (manifest.revisionPending === true) {
  throw new Error(`canonical skill revision refresh required before check/sync: ${manifest.revisionNote || manifestPath.pathname}`)
}
const git = async (...command) => (await exec('git', ['-C', sourceRoot, ...command], { encoding: 'utf8' })).stdout.trim()
const revision = await git('rev-parse', 'HEAD')
if (revision !== manifest.revision) throw new Error(`canonical skill checkout revision mismatch: expected ${manifest.revision}, got ${revision}`)
const remote = (await git('remote', 'get-url', 'origin')).replace(/\.git$/, '')
if (remote !== manifest.repository.replace(/\.git$/, '')) throw new Error(`canonical skill repository mismatch: ${remote}`)
const relativePaths = manifest.skills.map(row => row.path)
const dirty = await git('status', '--porcelain=v1', '--untracked-files=all', '--', ...relativePaths)
if (dirty) throw new Error('canonical skill sources contain uncommitted changes; commit and pin a release before syncing')

const library = manifest.skills.map(row => {
  const dir = resolve(sourceRoot, row.path)
  if (!dir.startsWith(sourceRoot + '/')) throw new Error(`canonical Skill path escapes source root: ${row.path}`)
  return { name: row.name, dir, description: '', root: `git:${revision}` }
})
const dir = resolve(root, id)
if (!dir.startsWith(resolve(root) + '/')) throw new Error('preset id escapes the selected root')
const spec = await readSpec(dir)
if (!spec) throw new Error(`authored preset spec is unavailable: ${join(dir, 'task-console.json')}`)
const selected = [...spec.skills].sort()
const canonical = manifest.skills.map(row => row.name).sort()
if (JSON.stringify(selected) !== JSON.stringify(canonical)) {
  throw new Error(`managed preset skill set differs from its canonical manifest: ${selected.join(', ')}`)
}

if (mode === 'sync') await syncPresetSkills(spec, library, dir)
const rows = await verifyPresetSkills(spec, library, dir)
for (const row of rows) {
  const digest = row.lockedSha256?.slice(0, 12) ?? row.sourceSha256?.slice(0, 12) ?? 'none'
  console.log(`${row.name}\t${row.status}\t${digest}\t${revision.slice(0, 12)}`)
}
if (rows.some(row => row.status !== 'in-sync')) process.exitCode = 1
