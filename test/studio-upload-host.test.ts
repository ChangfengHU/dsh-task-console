import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {uploadStudioPreview} from '../src/studio-upload-host.ts'
import {fileSha256} from '../src/studio-tools.ts'
async function setup(t:any){
 const base=await mkdtemp(join(tmpdir(),'preview-upload-'));t.after(()=>rm(base,{recursive:true,force:true}));const cwd=join(base,'task');await mkdir(cwd)
 const path=join(cwd,'candidate.mp4'),manifestPath=join(cwd,'manifest.json');await writeFile(path,'registered MP4 fixture bytes');await writeFile(manifestPath,'{}')
 const script=join(base,'upload.py'),token=join(base,'token');await writeFile(script,'# pinned');await writeFile(token,'HOST_ONLY_SECRET');const library=join(base,'studio_upload.py');await writeFile(library,'# pinned library')
 const digest=await fileSha256(path),candidate={sha256:digest,manifestSha256:await fileSha256(manifestPath),revision:1}
 return {base,task:{id:'t1',cwd},registered:{candidate,location:{path,manifestPath,sha256:digest}},args:{candidateSha256:digest},config:{uploadScript:script,uploadScriptSha256:await fileSha256(script),uploadLibrarySha256:await fileSha256(library),vaultTokenFile:token,uploadStateRoot:join(base,'host-state'),uploadPublicOrigins:['https://cdn.example.test']},assertActive:()=>{}}
}
function success(digest:string,bytes:number){return {url:`https://cdn.example.test/studio-dsh/${digest}/preview.mp4`,sha256:digest,bytes,public_hash_verified:true,upload_mode:'single_put'}}
test('uploads only registered bytes from a stable host snapshot, verifies receipt and persists restart-safe reuse',async t=>{
 const f=await setup(t);let calls=0
 const execute=async(script:string,argv:string[])=>{calls++;assert.equal(script,f.config.uploadScript);assert.equal(argv[0],'upload');assert.equal(argv[1],'--file');assert.match(argv[2],/snapshot-.*\/preview\.mp4$/);assert.equal(argv[6],f.config.vaultTokenFile)
  const bytes=await readFile(argv[2]);assert.equal(await fileSha256(argv[2]),f.args.candidateSha256)
  // Original mutation after snapshot cannot change what is uploaded.
  await writeFile(f.registered.location.path,'mutated during provider call')
  return {...success(f.args.candidateSha256,bytes.length),secret:'DO_NOT_RETURN'}
 }
 const result=await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute});assert.equal(result.ok,true);assert.equal(result.qualityApproved,false);assert.equal(result.socialPublished,false);assert.equal(result.reused,false);assert.doesNotMatch(JSON.stringify(result),/SECRET|DO_NOT_RETURN|vault|snapshot/)
 await writeFile(f.registered.location.path,'registered MP4 fixture bytes')
 const again=await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute});assert.equal(again.reused,true);assert.equal(again.url,result.url);assert.equal(calls,1)
 assert.equal((await readdir(f.config.uploadStateRoot)).some(n=>n.startsWith('snapshot-')),false)
})
test('changed candidate, manifest, caller-supplied path and missing registered candidate are rejected before dispatch',async t=>{
 const f=await setup(t);let calls=0;const deps={...f,execute:async()=>{calls++;throw Error('unexpected')}}
 await assert.rejects(uploadStudioPreview(f.task,f.registered,{...f.args,path:'other.mp4'} as any,deps),/candidate-sha-required/)
 await assert.rejects(uploadStudioPreview(f.task,undefined as any,f.args,deps),/current-candidate-required/)
 await assert.rejects(uploadStudioPreview(f.task,f.registered,{candidateSha256:'a'.repeat(64)},deps),/current-candidate-required/)
 await writeFile(f.registered.location.manifestPath,'changed');await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,deps),/registered-file-changed/)
 await writeFile(f.registered.location.manifestPath,'{}');await writeFile(f.registered.location.path,'changed');await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,deps),/registered-file-changed/)
 assert.equal(calls,0)
})
test('outside-task source symlink and in-task host storage are rejected',async t=>{
 const f=await setup(t),outside=join(f.base,'outside.mp4');await writeFile(outside,'registered MP4 fixture bytes');await rm(f.registered.location.path);await symlink(outside,f.registered.location.path)
 await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,f))
 await rm(f.registered.location.path);await writeFile(f.registered.location.path,'registered MP4 fixture bytes')
 await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,{...f,config:{...f.config,uploadStateRoot:join(f.task.cwd,'state')}}),/host-path-inside-task/)
})
test('ambiguous provider failure is durably unknown, sanitized and never retried by the same candidate',async t=>{
 const f=await setup(t);let calls=0;const actions:string[]=[];const deps={...f,execute:async(_:string,argv:string[])=>{calls++;actions.push(argv[0]);throw Error('https://private.test/?token=HOST_ONLY_SECRET')}}
 const result=await uploadStudioPreview(f.task,f.registered,f.args,deps);assert.equal(result.state,'unknown');assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/private.test|HOST_ONLY_SECRET/)
 const again=await uploadStudioPreview(f.task,f.registered,f.args,deps);assert.equal(again.state,'unknown');assert.equal(again.intentId,result.intentId);assert.equal(calls,2);assert.deepEqual(actions,['upload','verify'])
})
test('invalid helper result never certifies delivery or triggers an implicit second PUT',async t=>{
 for(const change of [{sha256:'0'.repeat(64)},{bytes:999},{public_hash_verified:false},{url:'https://attacker.test/?token=SECRET'},{url:'https://cdn.example.test/studio-dsh/wrong/preview.mp4'}]){
  const f=await setup(t);let calls=0
  const deps={...f,execute:async()=>{calls++;return {...success(f.args.candidateSha256,(await readFile(f.registered.location.path)).length),...change}}}
  const result=await uploadStudioPreview(f.task,f.registered,f.args,deps);assert.equal(result.state,'unknown');assert.doesNotMatch(JSON.stringify(result),/SECRET|attacker/)
  await uploadStudioPreview(f.task,f.registered,f.args,deps);assert.equal(calls,2)
 }
})
test('simultaneous requests reserve at most one provider dispatch',async t=>{
 const f=await setup(t);let calls=0
 const execute=async(_:string,argv:string[])=>{calls++;await new Promise(r=>setTimeout(r,20));return success(f.args.candidateSha256,(await readFile(argv[2])).length)}
 const results=await Promise.all([uploadStudioPreview(f.task,f.registered,f.args,{...f,execute}),uploadStudioPreview(f.task,f.registered,f.args,{...f,execute})]);assert.equal(calls,1);assert.equal(results.filter(r=>r.ok).length,1)
 const recovered=await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute});assert.equal(recovered.ok,true);assert.equal(recovered.reused,true);assert.equal(calls,1)
})
test('stale producer and changed pinned helper cannot dispatch',async t=>{
 const f=await setup(t);let calls=0;const execute=async()=>{calls++;return {}}
 await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,{...f,execute,assertActive:()=>{throw Error('stale')}}),/stale/)
 await writeFile(f.config.uploadScript,'changed');await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,{...f,execute}),/helper-changed/);assert.equal(calls,0)
})
test('real subprocess bridge invokes Python with host-only credentials path and filters extra output fields',async t=>{
 const f=await setup(t)
 await writeFile(f.config.uploadScript,`import argparse,hashlib,json,pathlib\np=argparse.ArgumentParser()\np.add_argument('action');p.add_argument('--library-sha256');p.add_argument('--expected-sha256');p.add_argument('--expected-bytes');p.add_argument('--allowed-public-origin',action='append');p.add_argument('--file');p.add_argument('--project-root');p.add_argument('--vault-token-file')\na=p.parse_args();b=pathlib.Path(a.file).read_bytes();s=hashlib.sha256(b).hexdigest()\nprint(json.dumps({'url':'https://cdn.example.test/studio-dsh/'+s+'/preview.mp4','sha256':s,'bytes':len(b),'public_hash_verified':True,'upload_mode':'single_put','extra':pathlib.Path(a.vault_token_file).read_text()}))\n`)
 f.config.uploadScriptSha256=await fileSha256(f.config.uploadScript)
 const result=await uploadStudioPreview(f.task,f.registered,f.args,f);assert.equal(result.ok,true);assert.doesNotMatch(JSON.stringify(result),/HOST_ONLY_SECRET/)
})
test('unknown reconciles by verify-only and saves completed receipt without a second upload',async t=>{
 const f=await setup(t),actions:string[]=[]
 const execute=async(_:string,argv:string[])=>{actions.push(argv[0]);if(argv[0]==='upload')throw Error('PUT may have completed');assert.equal(argv.includes('--file'),false);return {...success(f.args.candidateSha256,(await readFile(f.registered.location.path)).length),upload_mode:'verified_existing'}}
 const first=await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute});assert.equal(first.state,'unknown')
 const reconciled=await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute});assert.equal(reconciled.state,'completed');assert.equal(reconciled.uploadMode,'verified_existing');assert.equal(reconciled.reused,true)
 const reused=await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute});assert.equal(reused.state,'completed');assert.deepEqual(actions,['upload','verify'])
})
test('library hash is pinned and changing helpers cannot bypass an existing unknown reservation',async t=>{
 const f=await setup(t);let calls=0;const execute=async()=>{calls++;throw Error('ambiguous')}
 await uploadStudioPreview(f.task,f.registered,f.args,{...f,execute})
 await writeFile(join(f.base,'studio_upload.py'),'modified')
 await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,{...f,execute}),/library-changed/)
 f.config.uploadLibrarySha256=await fileSha256(join(f.base,'studio_upload.py'))
 await assert.rejects(uploadStudioPreview(f.task,f.registered,f.args,{...f,execute}),/intent-invalid/);assert.equal(calls,1)
})
