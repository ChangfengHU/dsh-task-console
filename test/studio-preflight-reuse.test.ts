import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {refreshStudioCapabilities} from '../src/studio-host.ts'
import {fileSha256} from '../src/studio-tools.ts'

async function fixture(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'studio-preflight-reuse-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const path=join(cwd,'asset'),proofPath=join(cwd,'proof.json'),script=join(cwd,'preflight.py')
 await writeFile(path,'asset');await writeFile(proofPath,'{}');await writeFile(script,'# fixture')
 const sha256=await fileSha256(path),p={ok:true,path,sha256,proofPath}
 const task={id:cwd,cwd,design:{studio:{referenceSha256:sha256,characterId:'c'}}}
 const value={ok:true,capabilities:{reference:p,frames:p,hyperframes:{...p,hyperframes_verified:true,scope:'actual_hyperframes_smoke_render'},character:{...p,characterId:'c',imagePath:path,imageSha256:sha256,profilePath:path}}}
 const records:any[]=[],workflow:any={recordCapability:(_:any,v:any)=>records.push(v)}
 let calls=0
 const config:any={preflightScript:script},execute=async()=>{calls++;return value}
 const refresh=(currentTask:any=task,currentConfig:any=config)=>refreshStudioCapabilities(workflow,currentTask,{config:currentConfig,execute})
 return {cwd,path,proofPath,script,task,value,records,workflow,config,execute,refresh,calls:()=>calls}
}

test('61-second handoff reuses hashes with original expiry; exact expiry probes again',async t=>{
 const s=await fixture(t),start=Date.now();let now=start;t.mock.method(Date,'now',()=>now)
 await s.refresh();const first=s.records.find(v=>v.name==='reference');s.records.length=0
 now=start+61_000;await s.refresh();const reused=s.records.find(v=>v.name==='reference')
 assert.equal(s.calls(),1);assert.equal(reused.checkedAt,first.checkedAt);assert.equal(reused.expiresAt,first.expiresAt)
 now=start+15*60_000;await s.refresh();assert.equal(s.calls(),2)
 const fresh=s.records.filter(v=>v.name==='reference').at(-1);assert.equal(Date.parse(fresh.checkedAt),now)
})

test('changed original output forces fresh probe and cannot pass unchanged expected hash',async t=>{
 const s=await fixture(t);await s.refresh();s.records.length=0;await writeFile(s.path,'changed')
 await s.refresh();assert.equal(s.calls(),2)
 for(const name of ['reference','frames','character','render'])assert.equal(s.records.find(v=>v.name===name).status,'failed')
 await s.refresh();assert.equal(s.calls(),3,'invalid new evidence is not cached')
})

test('changed proof JSON forces fresh probe even when asset hashes still match',async t=>{
 const s=await fixture(t);await s.refresh();await writeFile(s.proofPath,'{"changed":true}')
 await s.refresh();assert.equal(s.calls(),2)
})

test('config, helper bytes, runtime replacement and task scope invalidate reuse',async t=>{
 const s=await fixture(t);await s.refresh()
 await s.refresh(s.task,{...s.config,renderRuntime:join(s.cwd,'runtime')});assert.equal(s.calls(),2)
 await writeFile(s.script,'# replaced helper');await s.refresh();assert.equal(s.calls(),3)
 const runtime=join(s.cwd,'runtime'),packagePath=join(runtime,'node_modules/hyperframes/package.json')
 await mkdir(join(runtime,'node_modules/hyperframes'),{recursive:true});await writeFile(packagePath,'{"version":"1"}')
 const config={...s.config,renderRuntime:runtime};await s.refresh(s.task,config);assert.equal(s.calls(),4)
 await writeFile(packagePath,'{"version":"2"}');await s.refresh(s.task,config);assert.equal(s.calls(),5)
 await s.refresh({...s.task,id:s.task.id+'-new'});assert.equal(s.calls(),6)
 await s.refresh({...s.task,cwd:s.cwd+'-new'});assert.equal(s.calls(),7)
 await s.refresh({...s.task,design:{studio:{...s.task.design.studio,referenceUrl:'https://example.invalid/new'}}});assert.equal(s.calls(),8)
})

test('calibration files are reread on a warm preflight without running the host again',async t=>{
 const s=await fixture(t),calibrationPath=join(s.cwd,'calibration.json'),regressionPath=join(s.cwd,'regression.json')
 const sha256=s.value.capabilities.reference.sha256
 await writeFile(calibrationPath,JSON.stringify({results:[{ok:true,audio_sha256:sha256,observation:{input_modality:'input_audio',finish_reason:'stop',audio_sha256:sha256}}]}))
 await writeFile(regressionPath,'{}')
 const config={...s.config,calibrationPath,calibrationRegressionPath:regressionPath,audioScript:'fixture',vaultTokenFile:'unused'}
 await s.refresh(s.task,config);assert.equal(s.records.find(v=>v.name==='audio').status,'passed')
 s.records.length=0;await writeFile(calibrationPath,'{}');await s.refresh(s.task,config)
 assert.equal(s.calls(),1);assert.equal(s.records.find(v=>v.name==='audio').status,'unknown')
})

test('partial successful transport does not cache an incomplete capability probe',async t=>{
 const s=await fixture(t);delete (s.value.capabilities as any).hyperframes
 await s.refresh();await s.refresh();assert.equal(s.calls(),2)
})

test('invalid character source is not cached and the next probe can repair it',async t=>{
 const s=await fixture(t)
 Object.assign(s.value.capabilities.character,{sourceUrl:'https://cdn.vyibc.com/image.png?token=invalid',sourceSha256:s.value.capabilities.reference.sha256})
 await s.refresh();assert.equal(s.records.find(v=>v.name==='character').status,'failed')
 Object.assign(s.value.capabilities.character,{sourceUrl:'https://cdn.vyibc.com/image.png'})
 s.records.length=0;await s.refresh();assert.equal(s.calls(),2);assert.equal(s.records.find(v=>v.name==='character').status,'passed')
})

test('expiry during cached hash checks reprobes instead of returning expired evidence',async t=>{
 const s=await fixture(t),start=Date.now();t.mock.method(Date,'now',()=>start)
 await s.refresh();let reads=0;const edge=start+15*60_000
 t.mock.method(Date,'now',()=>++reads<=2?edge-1:edge)
 s.records.length=0;await s.refresh();assert.equal(s.calls(),2)
 assert.equal(Date.parse(s.records.find(v=>v.name==='reference').checkedAt),edge)
})

test('clock rollback cannot reuse evidence whose checkedAt is in the future',async t=>{
 const s=await fixture(t),start=Date.now();let now=start;t.mock.method(Date,'now',()=>now)
 await s.refresh();now=start-1;await s.refresh();assert.equal(s.calls(),2)
})

test('simultaneous callers share a successful probe with the same original timestamp',async t=>{
 const s=await fixture(t)
 await Promise.all([s.refresh(),s.refresh(),s.refresh()]);assert.equal(s.calls(),1)
 const refs=s.records.filter(v=>v.name==='reference');assert.equal(refs.length,3)
 assert.equal(new Set(refs.map(v=>v.checkedAt)).size,1);assert.equal(new Set(refs.map(v=>v.expiresAt)).size,1)
})

test('probe execution time consumes original lifetime and environment changes invalidate reuse',async t=>{
 const s=await fixture(t),start=Date.now();let now=start;t.mock.method(Date,'now',()=>now)
 const original=process.env.STUDIO_RENDER_RUNTIME
 t.after(()=>{if(original===undefined)delete process.env.STUDIO_RENDER_RUNTIME;else process.env.STUDIO_RENDER_RUNTIME=original})
 let calls=0;const execute=async()=>{calls++;now+=80_000;return s.value}
 await refreshStudioCapabilities(s.workflow,s.task,{config:s.config,execute})
 const r=s.records.find(v=>v.name==='reference');assert.equal(Date.parse(r.checkedAt),start);assert.equal(Date.parse(r.expiresAt),start+15*60_000)
 process.env.STUDIO_RENDER_RUNTIME=join(s.cwd,'different-runtime')
 await refreshStudioCapabilities(s.workflow,s.task,{config:s.config,execute});assert.equal(calls,2)
})
