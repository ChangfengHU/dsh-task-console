import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {canonical} from '../src/capability-contract.ts'
import {executionRuntimeManifest} from '../src/batch-execution-binding.ts'
import {persistExecutionBindingSnapshot,readExecutionBindingSnapshot} from '../src/execution-binding-snapshot.ts'

const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const digest=(v:unknown)=>sha(canonical(v))
async function fixture(t:any,configPatch:Record<string,string>={}){
 const root=await mkdtemp(join(tmpdir(),'execution-binding-snapshot-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const preset=join(root,'presets','role');await mkdir(join(preset,'skills'),{recursive:true})
 const values={
  'task-console.json':'{"id":"role","model":"provider/model"}',
  'agent.cordis.yml':'- id: persona\n  config: {}\n',
  'capabilities.lock.json':'{"schema":"dsh-agent-capabilities-v1","grants":[]}',
  'skills.lock.json':'{"skills":[]}',
  ...configPatch,
 }
 const files:Record<string,string>={}
 for(const [name,value] of Object.entries(values)){await writeFile(join(preset,name),value);files[name]=sha(value)}
 const runtimeRoot=join(root,'runtime');await mkdir(join(runtimeRoot,'src'),{recursive:true});await writeFile(join(runtimeRoot,'package.json'),'{"dependencies":{}}');await writeFile(join(runtimeRoot,'src','entry.js'),'export {}')
 const runtime=await executionRuntimeManifest(runtimeRoot)
 const agent={id:'role',presetId:'role',directory:preset,selection:{provider:'provider',model:'model'},selectionSource:'spec',permission:'read-only',specSha256:files['task-console.json'],compositionSha256:files['agent.cordis.yml'],capabilitySha256:files['capabilities.lock.json'],skillLockSha256:files['skills.lock.json'],skillsSha256:null}
 const body={schemaVersion:1,mode:'agent-runtime-v1',taskId:'task',batchId:'batch',capturedAt:'2026-09-29T00:00:00.000Z',agents:[agent],runtimeSha256:digest(runtime),fallback:null}
 const binding={...body,sha256:digest(body)} as any
 return {root,preset,files,runtime,binding,snapshotRoot:join(root,'snapshots')}
}

test('binding snapshot persists exact role bytes and runtime manifest privately and reads them back',async t=>{
 const s=await fixture(t),created=await persistExecutionBindingSnapshot(s.binding,{root:s.snapshotRoot,runtime:s.runtime})
 assert.equal(created.reused,false)
 const read=await readExecutionBindingSnapshot(s.binding,s.snapshotRoot)
 assert.equal(read.snapshot.runtimeSha256,s.binding.runtimeSha256)
 assert.equal(read.snapshot.roles[0].files['agent.cordis.yml'],s.files['agent.cordis.yml'])
 assert.equal((await stat(created.path)).mode&0o077,0)
 assert.equal((await stat(join(created.path,'snapshot.json'))).mode&0o077,0)
 const reused=await persistExecutionBindingSnapshot(s.binding,{root:s.snapshotRoot,runtime:s.runtime})
 assert.equal(reused.reused,true)
})

test('snapshot refuses credential-bearing configuration and never overwrites altered frozen bytes',async t=>{
 const s=await fixture(t,{'agent.cordis.yml':'- id: api\n  config:\n    api_key: "this-is-a-long-private-secret-value"\n'})
 await assert.rejects(persistExecutionBindingSnapshot(s.binding,{root:s.snapshotRoot,runtime:s.runtime}),/credential-material-rejected/)
 const clean=await fixture(t)
 await persistExecutionBindingSnapshot(clean.binding,{root:clean.snapshotRoot,runtime:clean.runtime})
 await writeFile(join(clean.snapshotRoot,clean.binding.sha256,'role','agent.cordis.yml'),'tampered')
 await assert.rejects(readExecutionBindingSnapshot(clean.binding,clean.snapshotRoot),/snapshot-file-invalid/)
})

test('snapshot is not written when runtime differs from the frozen binding',async t=>{
 const s=await fixture(t),changed={...s.runtime,files:[...s.runtime.files,['src/late.js','f'.repeat(64)]]}
 await assert.rejects(persistExecutionBindingSnapshot(s.binding,{root:s.snapshotRoot,runtime:changed}),/runtime-drift/)
 await assert.rejects(readFile(join(s.snapshotRoot,s.binding.sha256,'snapshot.json')))
})
