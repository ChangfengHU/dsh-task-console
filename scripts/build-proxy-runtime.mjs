// Build only the stdio proxy server, without touching concurrent UI artifacts.
// Run with the deployment Node binary; the selected SQLite wrapper must match it.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [output, runtime] = process.argv.slice(2)
if (!output || !runtime || !isAbsolute(output) || !isAbsolute(runtime) || process.argv.length !== 4)
  throw Error('usage: node scripts/build-proxy-runtime.mjs ABS_OUTPUT ABS_SQLITE_WRAPPER')
const Database = createRequire(import.meta.url)(runtime)
const probe = new Database(':memory:')
probe.prepare('SELECT 1').get()
probe.close()
await build({
  entryPoints: [fileURLToPath(new URL('../src/proxy-mcp.ts', import.meta.url))],
  outfile: resolve(output), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', packages: 'external',
  plugins: [{ name: 'deployment-sqlite', setup(b) {
    b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: runtime, external: true }))
  } }],
})
console.log('proxy runtime built; deployment SQLite ABI verified')
