import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSpec, userPresetRoot, validateSpec, writePreset } from '../lib/index.js'

const spec = validateSpec(JSON.parse(await readFile(new URL('../presets/task-create-agent/task-console.json', import.meta.url), 'utf8')))
const root = userPresetRoot(), current = await readSpec(join(root, spec.id))
if (current && JSON.stringify(current) !== JSON.stringify(spec) && !process.argv.includes('--force')) throw new Error('已有 Task Creator 与受管版本不同；检查后才能 --force')
await writePreset(spec, [], [], root, [])
console.log(`installed ${spec.id}`)
