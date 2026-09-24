import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {downloadStudioAsset} from '../src/studio-host.ts'
import {fileSha256,registerStudioTools} from '../src/studio-tools.ts'
const digest=(v:string)=>createHash('sha256').update(v).digest('hex')
async function setup(t:any){const cwd=await mkdtemp(join(tmpdir(),'asset-host-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const script=join(cwd,'helper.py');await writeFile(script,'# fixed helper');return {task:{cwd},config:{assetDownloadScript:script,assetDownloadSha256:await fileSha256(script),vaultTokenFile:'/host/private/token'},cwd}}
test('host pins helper, confines task paths and verifies actual downloaded bytes',async t=>{
 const {task,config,cwd}=await setup(t);let count=0
 const execute=async(script:string,args:string[])=>{count++;assert.equal(script,config.assetDownloadScript);assert.deepEqual(args,['--project-root',cwd,'--id','asset-id','--output','clip.wav']);await writeFile(join(cwd,'clip.wav'),'archived bytes');return {ok:true,assetId:'asset-id',path:join(cwd,'clip.wav'),bytes:14,sha256:digest('archived bytes'),kind:'sfx',reused:false,secret:'must not propagate'}}
 const result=await downloadStudioAsset(task,{id:'asset-id',path:'clip.wav'},{config,execute})
 assert.equal(result.path,'clip.wav');assert.equal(result.newGeneration,0);assert.equal(result.qualityApproved,false);assert.equal(count,1);assert.doesNotMatch(JSON.stringify(result),/secret|token|private/)
 for(const path of ['../clip.wav','/tmp/clip.wav','.private/token','credentials.wav'])await assert.rejects(downloadStudioAsset(task,{id:'asset-id',path},{config,execute}),/output-invalid/)
 await assert.rejects(downloadStudioAsset(task,{id:'../asset',path:'clip.wav'},{config,execute}),/id-invalid/)
 await writeFile(config.assetDownloadScript,'# changed');await assert.rejects(downloadStudioAsset(task,{id:'asset-id',path:'clip.wav'},{config,execute}),/helper-changed/)
 assert.equal(count,1)
})
test('source-only and transport failures expose actionable fixed messages without returning secrets',async t=>{
 const {task,config}=await setup(t)
 const r=await downloadStudioAsset(task,{id:'source-card',path:'music.mp3'},{config,execute:async()=>({ok:false,error_code:'asset_metadata_only',nextAction:'untrusted metadata Bearer SECRET'})})
 assert.equal(r.error_code,'source-only');assert.match(r.nextAction,/not an archived file/);assert.doesNotMatch(JSON.stringify(r),/SECRET/)
 const bad=await downloadStudioAsset(task,{id:'source-card',path:'music.mp3'},{config,execute:async()=>({ok:false,error_code:'SECRET',message:'Bearer SECRET'})})
 assert.equal(bad.error_code,'asset-download-failed');assert.doesNotMatch(JSON.stringify(bad),/SECRET/)
})
test('metadata claims cannot certify absent or altered files',async t=>{
 const {task,config,cwd}=await setup(t)
 await writeFile(join(cwd,'clip.wav'),'unauthorized')
 await assert.rejects(downloadStudioAsset(task,{id:'asset-id',path:'clip.wav'},{config,execute:async()=>({ok:true,assetId:'asset-id',path:join(cwd,'clip.wav'),bytes:12,sha256:digest('something else'),kind:'sfx',reused:false})}),/receipt-invalid/)
})
test('native download rejects reviewer and stale sessions before callback',async()=>{
 const definitions=new Map<string,any>();let calls=0,active=true
 const ctx={tools:{register:(d:any)=>{definitions.set(d.name,d);return()=>definitions.delete(d.name)}}}
 const input={task:{cwd:'/unused'},card:{role:'reviewer'},sessionId:'session'}
 const dispose=await registerStudioTools(ctx,{input,workflow:{},isActive:()=>active,downloadAsset:async()=>{calls++;return {ok:true}}})
 const tool=definitions.get('studio_download_asset'),exec={agent:{session:{id:'session'}}}
 await assert.rejects(tool.execute({id:'a',path:'a.wav'},exec),/role-denied/)
 dispose()
 const stop=await registerStudioTools(ctx,{input:{...input,card:{role:'studio-stage'}},workflow:{},isActive:()=>active,downloadAsset:async()=>{calls++;return {ok:true}}})
 const stageTool=definitions.get('studio_download_asset');await stageTool.execute({id:'a',path:'a.wav'},exec);assert.equal(calls,1)
 active=false;await assert.rejects(stageTool.execute({id:'a',path:'a.wav'},exec),/stale-run/);assert.equal(calls,1);stop()
})
