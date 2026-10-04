// Paid integration probe: run explicitly, never as part of unit tests.
// Uses the owning machine's existing login/pool; never exports authentication.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import Database from 'better-sqlite3'
import { ImageJobs } from '../src/image-jobs.ts'
import { imageBackends } from '../src/image-backends.ts'
import { imagePolicy } from '../src/image-policy.ts'
const option = key => { const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1] }
const plugin=option('--codex-plugin'), executable=option('--codex-executable'), backend=option('--backend')||'codex'
if (!plugin || !executable || !['codex','gemini'].includes(backend)) throw Error('Required: --codex-plugin <absolute lib/index.js> --codex-executable <path> --backend codex|gemini')
const dir=option('--output-dir') || await mkdtemp(join(tmpdir(),'dsh-native-image-proof-'))
await mkdir(dir,{recursive:true})
const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}});new ToolRuntime(ctx)
await ctx.plugin(LlmRuntime);await ctx.plugin(LocalSubprocessRuntime);await ctx.plugin(LocalAttachmentStore,{dshHome:dir})
await ctx.plugin(await import(pathToFileURL(plugin).href),{executable,claudeEnabled:false,networkProxy:option('--network-proxy')||'',timeoutMs:240000})
const db=new Database(join(dir,'image-probe.sqlite'))
const jobs=new ImageJobs(db,imageBackends(ctx,{}))
try {
  const policy={...imagePolicy(undefined),defaultBackend:backend,allowedBackends:[backend]}
  const initial=jobs.start('native-image-verification',{requestId:`proof-${backend}-${Date.now()}`,prompt:'Generate exactly one simple original flat illustration: a teal circle on an off-white paper background, with one tiny golden star. No text.',references:[]},policy)
  console.log(JSON.stringify({backend,jobId:initial.jobId,state:initial.state}))
  let receipt
  for (;;) { receipt=jobs.status('native-image-verification',initial.jobId);if(receipt.state!=='running')break;await new Promise(r=>setTimeout(r,1000)) }
  await writeFile(join(dir,backend+'-receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  if(receipt.state!=='completed')throw Error(JSON.stringify(receipt))
  for(let i=0;i<receipt.images.length;i++) {const image=await ctx.get('attachments').readImage(receipt.images[i]);await writeFile(join(dir,backend+'-'+i+(image.ref.mediaType==='image/png'?'.png':'.jpg')),image.data)}
  console.log(JSON.stringify({backend,state:receipt.state,model:receipt.model,images:receipt.images,outputDir:dir}))
} finally {await jobs.dispose();db.close();await ctx.fiber.dispose()}
