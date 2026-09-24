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
test('configured nonoriginal DSH profile reaches the existing downloader CLI explicitly',async t=>{
 const {task,config,cwd}=await setup(t),profile=join(cwd,'other user','web 配置.yml')
 const result=await downloadStudioAsset(task,{id:'source-card',path:'music.mp3'},{config:{...config,dshProfilePath:profile},execute:async(_,argv)=>{
  assert.deepEqual(argv.slice(-2),['--dsh-profile',profile]);return {ok:false,error_code:'asset_metadata_only'}
 }})
 assert.equal(result.error_code,'source-only')
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

const sourcePolicy={purpose:'video_soundtrack' as const,platforms:['user_review'],attributionWillBeIncluded:true as const,platformAllowsAttribution:true as const,noAdditionalRestrictions:true as const,changesDescription:'Trim and fade for the draft; include credit in PUBLICATION.md'}
test('explicit source policy is sent through stdin and host binds real audio plus local author receipt',async t=>{
 const {task,config,cwd}=await setup(t),data='source audio',path=join(cwd,'music.mp3'),receiptPath=path+'.source.json'
 let count=0
 const execute=async(_:string,argv:string[],__:any,___:any,stdin?:string)=>{
  count++;assert.equal(argv.at(-1),'--source-policy-stdin');assert.deepEqual(JSON.parse(stdin!),sourcePolicy)
  const receipt={schema:'studio-public-source-v1',assetId:'source-card',kind:'bgm',path,sha256:digest(data),bytes:data.length,isrc:'USUAN1400011',author:'Kevin MacLeod',title:'Test fixture',technical:{codec:'mp3',durationSeconds:125,measurement:'ffmpeg_full_decode_out_time'},attribution:'Fixture author credit',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',qualityApproved:false,audioDecodeVerified:true,archivePermissionGranted:false,sourceCardRightsUnchanged:true,platformTermsIndependentlyVerified:false,projectUse:sourcePolicy,evidence:[`https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400011`,'https://incompetech.com/music/royalty-free/pieces.json','https://incompetech.com/music/royalty-free/licenses/'].map(url=>({url,sha256:'a'.repeat(64),bytes:100}))}
  await writeFile(path,data);await writeFile(receiptPath,JSON.stringify(receipt))
  return {ok:true,assetId:'source-card',path,sha256:digest(data),bytes:data.length,kind:'bgm',reused:false,receiptPath,receiptSha256:await fileSha256(receiptPath),sourceAcquisition:receipt}
 }
 const result=await downloadStudioAsset(task,{id:'source-card',path:'music.mp3',sourcePolicy},{config,execute})
 assert.equal(result.receiptPath,'music.mp3.source.json');assert.equal(result.sourceAcquisition?.archivePermissionGranted,false);assert.equal(result.sourceAcquisition?.platformTermsIndependentlyVerified,false)
 await assert.rejects(downloadStudioAsset(task,{id:'source-card',path:'music.mp3',sourcePolicy:{...sourcePolicy,noAdditionalRestrictions:false} as any},{config,execute}),/source-policy-invalid/);assert.equal(count,1)
 await assert.rejects(downloadStudioAsset(task,{id:'source-card',path:'music.mp3',sourcePolicy},{config,execute:async(...args)=>{const r=await execute(...args);await writeFile(receiptPath,'{}');return r}}),/source-acquisition-receipt-invalid/)
 await assert.rejects(downloadStudioAsset(task,{id:'source-card',path:'music.mp3',sourcePolicy},{config,execute:async(...args)=>{const r=await execute(...args);r.sourceAcquisition.archivePermissionGranted=true;await writeFile(receiptPath,JSON.stringify(r.sourceAcquisition));r.receiptSha256=await fileSha256(receiptPath);return r}}),/source-acquisition-receipt-invalid/)
})
test('public-source failures expose only bounded known codes and no provider messages',async t=>{
 const {task,config}=await setup(t)
 const result=await downloadStudioAsset(task,{id:'source-card',path:'music.mp3',sourcePolicy},{config,execute:async()=>({ok:false,error_code:'source_license_evidence_unverified',nextAction:'Bearer PRIVATE'})})
 assert.equal(result.error_code,'source_license_evidence_unverified');assert.match(result.nextAction,/Do not repeat/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/)
})
