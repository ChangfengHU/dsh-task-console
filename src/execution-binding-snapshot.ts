/** Immutable, host-private material needed to verify a frozen execution identity later. */
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,readFile,realpath,lstat,writeFile,rename,rm,stat,access} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {canonical} from './capability-contract.ts'
import {executionRuntimeManifest,type BatchExecutionBinding,type BoundFallback,type ExecutionRuntimeManifest} from './batch-execution-binding.ts'
import {withPresetLock} from './preset-lock.ts'

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const digest=(value:unknown)=>sha(canonical(value))
const runtimeRoot=dirname(dirname(fileURLToPath(import.meta.url)))
const secretPatterns=[
 /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
 /^\s*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*:\s*(?!\$\{|\{\{)["']?[^\s"']{12,}/im,
 /["'](?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']\s*:\s*["'][^"']{12,}["']/i,
]
function assertNoCredentialMaterial(bytes:Buffer){const text=bytes.toString('utf8');if(secretPatterns.some(pattern=>pattern.test(text)))throw new Error('execution-snapshot-credential-material-rejected')}
async function readRegular(path:string){
 const resolved=resolve(path),actual=await realpath(path),info=await lstat(path)
 if(actual!==resolved||info.isSymbolicLink()||!info.isFile())throw new Error('execution-snapshot-source-path-invalid')
 return readFile(path)
}
async function safeSnapshotRoot(root:string){
 await mkdir(root,{recursive:true,mode:0o700})
 if(await realpath(root)!==resolve(root))throw new Error('execution-snapshot-root-invalid')
 const info=await stat(root)
 if((info.mode&0o077)!==0)throw new Error('execution-snapshot-root-permissions-invalid')
}
async function verifyExisting(directory:string,manifestBytes:Buffer,files:Map<string,Buffer>){
 const current=JSON.parse((await readFile(join(directory,'snapshot.json'),'utf8')))
 if(sha(canonical(stripSeal(current)))!==current.sealSha256||sha(manifestBytes)!==sha(await readFile(join(directory,'snapshot.json'))))throw new Error('execution-snapshot-existing-conflict')
 for(const [name,bytes] of files)if(sha(bytes)!==sha(await readFile(join(directory,name))))throw new Error('execution-snapshot-existing-conflict')
}
function stripSeal(value:any){const {sealSha256,...body}=value;return body}

/**
 * Create a content-addressed snapshot before a bound Batch is committed. Existing
 * snapshots are verified and reused; they are never overwritten or repaired in place.
 */
export async function persistExecutionBindingSnapshot(binding:BatchExecutionBinding,options:{root?:string;runtime?:ExecutionRuntimeManifest}={}){
 const root=options.root??join(dirname(runtimeRoot),'evidence','execution-binding-snapshots'),target=join(root,binding.sha256)
 if(!/^[a-f0-9]{64}$/.test(binding.sha256))throw new Error('execution-snapshot-binding-invalid')
 await safeSnapshotRoot(root)
 const runtime=options.runtime??await executionRuntimeManifest()
 if(digest(runtime)!==binding.runtimeSha256)throw new Error('execution-snapshot-runtime-drift')
 const files=new Map<string,Buffer>(),roles:any[]=[]
 for(const agent of binding.agents){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(agent.id))throw new Error('execution-snapshot-agent-id-invalid')
  const roleFiles:Record<string,string|null>={}
  await withPresetLock(agent.directory,async()=>{
   for(const [name,expected] of Object.entries({'task-console.json':agent.specSha256,'agent.cordis.yml':agent.compositionSha256,'capabilities.lock.json':agent.capabilitySha256,'skills.lock.json':agent.skillLockSha256})){ 
    if(expected===null){roleFiles[name]=null;continue}
    const bytes=await readRegular(join(agent.directory,name))
    if(sha(bytes)!==expected)throw new Error('execution-snapshot-agent-drift')
    assertNoCredentialMaterial(bytes)
    files.set(join(agent.id,name),bytes);roleFiles[name]=expected
   }
  })
  roles.push({agentId:agent.id,files:roleFiles})
 }
 const body={schemaVersion:2,bindingSha256:binding.sha256,runtimeSha256:binding.runtimeSha256,runtime,roles}
 const snapshot={...body,sealSha256:digest(body)},manifestBytes=Buffer.from(JSON.stringify(snapshot,null,2)+'\n')
 if(await access(target).then(()=>true,()=>false)){
  const info=await lstat(target)
  if(info.isSymbolicLink()||!info.isDirectory()||await realpath(target)!==resolve(target)||(info.mode&0o077)!==0)throw new Error('execution-snapshot-existing-path-invalid')
  await verifyExisting(target,manifestBytes,files)
  return {snapshotSha256:sha(manifestBytes),path:target,reused:true}
 }
 const temp=join(root,`.pending-${binding.sha256}-${process.pid}-${randomUUID()}`)
 await mkdir(temp,{mode:0o700})
 try{
  for(const [relative,bytes] of files){const path=join(temp,relative);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600,flag:'wx'})}
  await writeFile(join(temp,'snapshot.json'),manifestBytes,{mode:0o600,flag:'wx'})
  await rename(temp,target)
 }catch(error){await rm(temp,{recursive:true,force:true});throw error}
 return {snapshotSha256:sha(manifestBytes),path:target,reused:false}
}

/** Validate the snapshot envelope and its role bytes against the frozen binding. */
export async function readExecutionBindingSnapshot(binding:BatchExecutionBinding,root=join(dirname(runtimeRoot),'evidence','execution-binding-snapshots')){
 const dir=join(root,binding.sha256)
 if(await realpath(dir)!==resolve(dir)||(await lstat(dir)).isSymbolicLink())throw new Error('execution-snapshot-path-invalid')
 const bytes=await readRegular(join(dir,'snapshot.json')),snapshot=JSON.parse(bytes.toString('utf8'))
 if(snapshot.schemaVersion!==2||snapshot.bindingSha256!==binding.sha256||snapshot.runtimeSha256!==binding.runtimeSha256||snapshot.sealSha256!==digest(stripSeal(snapshot))||!Array.isArray(snapshot.roles)||snapshot.roles.length!==binding.agents.length)throw new Error('execution-snapshot-identity-invalid')
 for(const agent of binding.agents){
  const rows=snapshot.roles.filter((row:any)=>row.agentId===agent.id)
  if(rows.length!==1)throw new Error('execution-snapshot-agent-invalid')
  for(const [name,expected] of Object.entries({'task-console.json':agent.specSha256,'agent.cordis.yml':agent.compositionSha256,'capabilities.lock.json':agent.capabilitySha256,'skills.lock.json':agent.skillLockSha256})){
   if(expected===null){if(rows[0].files[name]!==null&&rows[0].files[name]!==undefined)throw new Error('execution-snapshot-file-invalid');continue}
   const file=await readRegular(join(dir,agent.id,name))
   if(rows[0].files[name]!==expected||sha(file)!==expected)throw new Error('execution-snapshot-file-invalid')
  }
 }
 if(digest(snapshot.runtime as ExecutionRuntimeManifest)!==binding.runtimeSha256)throw new Error('execution-snapshot-runtime-invalid')
 return {snapshot,snapshotSha256:sha(bytes),path:dir}
}
