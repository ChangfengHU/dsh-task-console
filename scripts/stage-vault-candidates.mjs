// One-shot local release assembly. Does not restart DSH or touch target nodes.
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const base = '/home/claude/dsh-studio-migration/task-console-studio-7063694a00e2'
const source = '/home/claude/dsh-vault-candidates-build'
const out = '/home/claude/dsh-studio-migration/task-console-vault-920a57c'
await mkdir(out) // Refuse to overwrite an existing release.
await cp(base, out, { recursive: true, verbatimSymlinks: true })
await cp(join(source, 'build'), join(out, 'lib'), { recursive: true })
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
await writeFile(join(out, 'SOURCE_REVISION'), revision + '\n')
execFileSync('git', ['bundle', 'create', join(out, 'source.bundle'), 'HEAD'], { cwd: source })
const ui = '/home/claude/dsh-studio-migration/studio-task-console-ui-7063694a00e2/client.js'
await cp(ui, join(out, 'previous-client.js'))
const client = (await readFile(join(out, 'lib/client.js'), 'utf8')).replace('id: "dsh-task-console"', 'id: "studio-task-console-ui-7063694a00e2"')
if (!client.includes('id: "studio-task-console-ui-7063694a00e2"')) throw Error('client-module-id')
await writeFile(join(out, 'deployment-client.js'), client)
const hashes = {}
async function scan(dir, prefix = '') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, e.name)
    if (e.isSymbolicLink() || rel === 'DEPLOY_MANIFEST.json') continue
    if (e.isDirectory()) await scan(join(dir, e.name), rel)
    else hashes[rel] = createHash('sha256').update(await readFile(join(dir, e.name))).digest('hex')
  }
}
await scan(out)
await writeFile(join(out, 'DEPLOY_MANIFEST.json'), JSON.stringify(hashes, null, 2) + '\n')
console.log(JSON.stringify({ out, revision, files: Object.keys(hashes).length }))
