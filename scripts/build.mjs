/**
 * Build both halves with esbuild.
 *
 * The host half is plain ESM with the harness packages left external — dsh
 * resolves them from its own install, and bundling a second copy of cordis
 * would give the plugin a different service registry than the app.
 *
 * The client half is trickier: dsh loads plugin bundles through
 * `window.__ModuleLoader__.load({ id, factory })`, handing the factory a
 * `require` that resolves the app's own React. esbuild's CJS output already
 * emits `require("react")`, so the whole job is externalising React and
 * wrapping the result in that envelope. Everything else — including
 * schemastery, which the strict Typert codecs need on both faces — is
 * bundled in, because the browser has no module resolver of its own.
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await mkdir(out, { recursive: true })

/** Harness packages the host must share with the app, never bundle. */
const HOST_EXTERNAL = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*', '@deepseek-ai/schemastery', 'zod', 'yaml', 'node:*']

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/typert.host.ts')],
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: HOST_EXTERNAL,
  logLevel: 'info',
})

const client = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'info',
})

const body = client.outputFiles[0].text
await writeFile(join(out, 'client.js'), `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`)

console.log('built lib/index.js, lib/typert.host.js, lib/client.js')
