#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSpec, userPresetRoot, validateSpec, writePreset } from '../lib/index.js'

const source = JSON.parse(await readFile(new URL('../presets/task-intake/task-console.json', import.meta.url), 'utf8'))
const spec = validateSpec(source)
const root = userPresetRoot()
const path = join(root, spec.id)
const current = await readSpec(path)
if (current && JSON.stringify(current) !== JSON.stringify(spec) && !process.argv.includes('--force')) {
  throw new Error(`preset ${spec.id} 已存在且与受管版本不同；检查后用 --force 明确覆盖`)
}
await writePreset(spec, [], [], root, [])
console.log(`installed ${spec.id} at ${path}`)
