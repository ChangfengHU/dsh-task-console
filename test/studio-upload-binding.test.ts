import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {registerStudioTools,fileSha256,STUDIO_TOOL_NAMES} from '../src/studio-tools.ts'
import {studioPreviewUploadBinding} from '../src/service.ts'
import {uploadStudioPreview} from '../src/studio-upload-host.ts'
import {readStudioHostConfiguration} from '../src/studio-config.ts'
import {loadStudioRolePack} from '../src/studio-role-pack.ts'
const sha='a'.repeat(64)
function host(role='executor'){
 let active=true,candidate:any={sha256:sha,manifestSha256:'b'.repeat(64),revision:1},location={path:'/trusted/task/candidate.mp4',manifestPath:'/trusted/task/manifest.json',sha256:sha},stopped=false,preparation=false
 const input:any={task:{id:'T',cwd:'/trusted/task',design:{progressPolicy:'studio-bounded-v1'}},batch:{id:'B'},card:{id:'C',role},sessionId:'s'}
 const card={status:'running',current_run_id:4,claim_expires:Math.floor(Date.now()/1000)+1000},run={id:'r',cardId:'C',sessionId:'s',status:'running'}
 const store={kernel:{getTask:()=>card,db:{prepare:(sql:string)=>({get:()=>sql.includes('studio_progress_stopped')&&stopped?{one:1}:sql.includes('sqlite_master')&&preparation?{one:1}:sql.includes('SELECT p.payload')&&preparation?{payload:JSON.stringify({id:'p',state:'requested',round:1,plannerId:'next'})}:undefined})}},s:{runs:new Map([['r',run]])},coreRunId:()=>4}
 const workflow={status:()=>({candidate}),candidateLocation:()=>location}
 return {input,store,workflow,card,run,isActive:()=>active,stop:()=>active=false,stopProgress:()=>stopped=true,stopPreparation:()=>preparation=true,change:()=>candidate={...candidate,revision:2},setCandidate:(v:any)=>candidate=v,setLocation:(v:any)=>location=v}
}
async function native(t:any,h:any,uploadPreview:any){
 const require=createRequire(import.meta.url);const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx:any=new Context();ctx.provide('systemPrompt',{tools:()=>{}});const runtime=new ToolRuntime(ctx),register=runtime.register.bind(runtime)
 runtime.register=(spec:any)=>register(process.env.NODE_ENV==='test'&&spec.parameters?.type!=='object'?defineTool(spec):spec)
 t.after(await registerStudioTools(ctx,{input:h.input,workflow:h.workflow,isActive:h.isActive,uploadPreview}))
 return (args:any,sid='s')=>runtime.execute({name:'studio_upload_preview',arguments:args,agent:{ctx,session:{id:sid}},callId:'upload-test',signal:new AbortController().signal} as any)
}
test('native upload accepts only current candidate SHA; no arbitrary path, URL, key or credential surface',async t=>{
 const h=host();let calls=0;const call=await native(t,h,async(args:any)=>{calls++;assert.deepEqual(args,{candidateSha256:sha});return {ok:true,qualityApproved:false,socialPublished:false}})
 for(const args of [{},{candidateSha256:'wrong'},{candidateSha256:'c'.repeat(64)},...['path','url','key','token'].map(k=>({candidateSha256:sha,[k]:'PRIVATE'}))])assert.equal((await call(args)).isError,true)
 assert.equal(calls,0);const r:any=await call({candidateSha256:sha});assert.equal(r.isError,false);assert.equal(r.value.socialPublished,false);assert.equal(calls,1)
 assert.equal((await call({candidateSha256:sha},'other')).isError,true);h.stop();assert.equal((await call({candidateSha256:sha})).isError,true);assert.equal(calls,1)
})
test('native upload denies planner, reviewer, preparation and unrelated roles',async t=>{
 for(const role of ['planner','reviewer','studio-stage','notifier']){let calls=0;const call=await native(t,host(role),async()=>{calls++});assert.equal((await call({candidateSha256:sha})).isError,true);assert.equal(calls,0)}
})
test('exact service binding derives trusted candidate/location and forwards per-instance host config',async()=>{
 const h=host();let calls=0
 const f=studioPreviewUploadBinding(h.input,h.workflow,h.store,h.isActive,'/host/private config.json',async(task,registered,args,deps)=>{
  calls++;assert.equal(task,h.input.task);assert.deepEqual(registered,{candidate:h.workflow.status().candidate,location:h.workflow.candidateLocation()});assert.deepEqual(args,{candidateSha256:sha});assert.equal(deps.configPath,'/host/private config.json');deps.assertActive();return {ok:true} as any
 })
 assert.equal((await f({candidateSha256:sha})).ok,true);assert.equal(calls,1)
})
test('service binding fences expired/superseded leases, progress/preparation stops and candidate replacement',async()=>{
 for(const mode of ['inactive','expired','superseded','progress','preparation','candidate']){
  const h=host();let dispatched=0
  const f=studioPreviewUploadBinding(h.input,h.workflow,h.store,h.isActive,undefined,async(_t,_r,_a,deps)=>{
   if(mode==='inactive')h.stop();if(mode==='expired')h.card.claim_expires=1;if(mode==='superseded')h.card.current_run_id=5;if(mode==='progress')h.stopProgress();if(mode==='preparation')h.stopPreparation();if(mode==='candidate')h.change()
   deps.assertActive();dispatched++;return {} as any
  })
  await assert.rejects(f({candidateSha256:sha}),/stale-run|stop-requested|revision-pending|candidate-changed/);assert.equal(dispatched,0,mode)
 }
})

test('service does not return a receipt as current after candidate changes during upload',async()=>{
 const h=host();const call=studioPreviewUploadBinding(h.input,h.workflow,h.store,h.isActive,undefined,async()=>{h.change();return {ok:true,state:'completed'} as any})
 await assert.rejects(call({candidateSha256:sha}),/current-candidate-changed/)
})

test('native to service to actual upload host uses registered bytes, pinned helpers and configured binding',async t=>{
 const base=await mkdtemp(join(tmpdir(),'native upload home '));t.after(()=>rm(base,{recursive:true,force:true}));const cwd=join(base,'task');await mkdir(cwd)
 const path=join(cwd,'candidate.mp4'),manifestPath=join(cwd,'manifest.json');await writeFile(path,'actual registered fixture bytes');await writeFile(manifestPath,'{}')
 const script=join(base,'adapter.py'),library=join(base,'studio_upload.py'),token=join(base,'token');await writeFile(script,'# fixture');await writeFile(library,'# library');await writeFile(token,'DO_NOT_RETURN_TOKEN')
 const config={uploadScript:script,uploadScriptSha256:await fileSha256(script),uploadLibrarySha256:await fileSha256(library),vaultTokenFile:token,uploadStateRoot:join(base,'host-state'),uploadPublicOrigins:['https://preview.example.test']},configPath=join(base,'private config.json');await writeFile(configPath,JSON.stringify(config))
 const digest=await fileSha256(path),h=host();h.input.task.cwd=cwd;h.setCandidate({sha256:digest,manifestSha256:await fileSha256(manifestPath),revision:1});h.setLocation({path,manifestPath,sha256:digest});let dispatches=0
 const binding=studioPreviewUploadBinding(h.input,h.workflow,h.store,h.isActive,configPath,(task,registered,args,deps)=>uploadStudioPreview(task,registered,args,{...deps,execute:async(helper,argv)=>{
  dispatches++;assert.equal(helper,script);assert.equal(argv[0],'upload');assert.equal(argv[argv.indexOf('--vault-token-file')+1],token)
  const snapshot=argv[argv.indexOf('--file')+1];assert.notEqual(snapshot,path);assert.equal(await fileSha256(snapshot),digest)
  return {url:`https://preview.example.test/studio-dsh/${digest}/preview.mp4`,sha256:digest,bytes:(await readFile(snapshot)).length,public_hash_verified:true,upload_mode:'single_put'}
 }}))
 const call=await native(t,h,binding),r:any=await call({candidateSha256:digest});assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.value.publicHashVerified,true);assert.equal(r.value.qualityApproved,false);assert.doesNotMatch(JSON.stringify(r),/DO_NOT_RETURN_TOKEN|private config/)
 const repeated:any=await call({candidateSha256:digest});assert.equal(repeated.isError,false);assert.equal(repeated.value.reused,true);assert.equal(dispatches,1)
})
test('upload host configuration group is optional but complete, canonical and sanitized when present',async t=>{
 const base=await mkdtemp(join(tmpdir(),'upload config '));t.after(()=>rm(base,{recursive:true,force:true}));const path=join(base,'config.json')
 const good={uploadScript:'/host/adapter.py',uploadScriptSha256:sha,uploadLibrarySha256:sha,vaultTokenFile:'/host/token',uploadStateRoot:'/host/state',uploadPublicOrigins:['https://preview.example.test']}
 for(const v of [{},good]){await writeFile(path,JSON.stringify(v));assert.deepEqual(await readStudioHostConfiguration(path),v)}
 for(const change of [{uploadScriptSha256:undefined},{uploadLibrarySha256:undefined},{vaultTokenFile:undefined},{uploadStateRoot:'relative SECRET'},{uploadPublicOrigins:[]},{uploadPublicOrigins:['https://SECRET@preview.example.test']},{uploadPublicOrigins:['https://preview.example.test/SECRET']},{uploadPublicOrigins:['http://preview.example.test']}]){await writeFile(path,JSON.stringify({...good,...change}));await assert.rejects(readStudioHostConfiguration(path),(e:any)=>e.message==='studio-host-config-upload-invalid')}
})
test('Studio capability and editor dependency declaration expose actual upload tool',async()=>{
 assert.ok(STUDIO_TOOL_NAMES.includes('studio_upload_preview'));const pack=await loadStudioRolePack();assert.ok(pack.roles.find(r=>r.role==='editor')!.requiredHostTools.includes('studio_upload_preview'))
})
