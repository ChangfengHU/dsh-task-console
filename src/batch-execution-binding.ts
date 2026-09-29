/** Host-created, opt-in batch identities. Digests only: never persist preset
 * bodies, transport configuration, provider credentials or raw model config. */
import {createHash} from 'node:crypto'
import {readFile,readdir,lstat,realpath} from 'node:fs/promises'
import {dirname,join,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {readSpec,hashSkillTree} from './presets.ts'
import {canonical,CAPABILITY_SCHEMA} from './capability-contract.ts'
import {taskAgentIds} from './task-design.ts'
import {withPresetLock} from './preset-lock.ts'

export interface BoundSelection {provider:string;model:string;reasoningEffort?:string}
export interface BoundFallback {fromProvider:string;provider:string;model:string}
interface BoundAgent {id:string;presetId:string;directory:string;selection:BoundSelection;selectionSource:'spec'|'default';permission:string;specSha256:string;compositionSha256:string;capabilitySha256:string;skillLockSha256:string|null;skillsSha256:string|null}
export interface BatchExecutionBinding {schemaVersion:1;mode:'agent-runtime-v1';taskId:string;batchId:string;capturedAt:string;agents:BoundAgent[];runtimeSha256:string;fallback:BoundFallback|null;sha256:string}
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const digest=(v:unknown)=>sha(canonical(v))
const token=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(v)
export class ExecutionBindingError extends Error {constructor(code:string){super('batch-execution-binding-'+code)}}
const fail=(code:string):never=>{throw new ExecutionBindingError(code)}
function selection(value:any):BoundSelection {
 if(!token(value?.provider)||!token(value?.model))return fail('model-unresolved')
 if(value.reasoningEffort!==undefined&&!['low','medium','high','xhigh','max','ultra',''].includes(value.reasoningEffort))return fail('effort-invalid')
 return {provider:value.provider,model:value.model,...(value.reasoningEffort?{reasoningEffort:value.reasoningEffort}:{})}
}
function fallback(value:any):BoundFallback|null {
 if(value===undefined||value===null)return null
 if(!token(value.fromProvider))return fail('fallback-invalid')
 const s=selection(value);return {fromProvider:value.fromProvider,provider:s.provider,model:s.model}
}
async function optionalHash(path:string){try{return sha(await readFile(path))}catch(e:any){if(e.code==='ENOENT')return null;throw e}}
async function captureAgent(ctx:any,id:string,frozenDefault?:BoundSelection):Promise<BoundAgent>{
 try{
  const preset=await ctx.get('agentPresets').resolve(id),directory=await realpath(dirname(String(preset.path)))
  if(preset.broken||preset.id!==id)fail('preset-unavailable')
  const spec=await readSpec(directory);if(!spec||spec.id!==id)fail('authored-preset-required')
  const composition=await readFile(join(directory,'agent.cordis.yml'))
  const capabilityBytes=await readFile(join(directory,'capabilities.lock.json')),capability=JSON.parse(capabilityBytes.toString())
  if(capability.schema!==CAPABILITY_SCHEMA||capability.specSha256!==digest(spec)||capability.compositionSha256!==sha(composition))fail('preset-lock-invalid')
  const fromSpec=spec.model.includes('/'),parts=spec.model.split('/')
  const chosen=fromSpec?{provider:parts.shift(),model:parts.join('/'),...(spec.effort?{reasoningEffort:spec.effort}:{})}:frozenDefault??ctx.get('agentDefaultModel')?.currentSelection?.()
  return {id,presetId:preset.id,directory,selection:selection(chosen),selectionSource:fromSpec?'spec':'default',permission:spec.permissionPreset,
   specSha256:sha(await readFile(join(directory,'task-console.json'))),compositionSha256:sha(composition),capabilitySha256:sha(capabilityBytes),
   skillLockSha256:await optionalHash(join(directory,'skills.lock.json')),
   skillsSha256:spec.skills.length?await hashSkillTree(join(directory,'skills')):null}
 }catch(e){if(e instanceof ExecutionBindingError)throw e;return fail('preset-unavailable')}
}

/** The installed manifest is authoritative when present. Local source builds
 * use package/lock/src bytes. External secret files are never followed. */
export interface ExecutionRuntimeManifest {root:string;files:[string,string][];dependencies:{name:string;sha256:string|null;path:string|null}[];nodeVersion:string;nodeExecutable:string}
export async function executionRuntimeManifest(root=dirname(dirname(fileURLToPath(import.meta.url)))):Promise<ExecutionRuntimeManifest>{
 try{
  const paths:string[]=[]
  const manifest=await optionalHash(join(root,'DEPLOY_MANIFEST.json'))
  if(manifest){
   const rows=JSON.parse(await readFile(join(root,'DEPLOY_MANIFEST.json'),'utf8'))
   if(!rows||typeof rows!=='object'||Array.isArray(rows)||!Object.keys(rows).length)fail('runtime-manifest-invalid')
   paths.push('DEPLOY_MANIFEST.json')
   for(const [name,expected] of Object.entries(rows)){
    const resolved=join(root,name),rel=relative(root,resolved)
    if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||name==='DEPLOY_MANIFEST.json'||isAbsolute(name)||!rel||rel.startsWith('..')||await realpath(resolved)!==resolved||(await lstat(resolved)).isSymbolicLink())fail('runtime-manifest-invalid')
    if(sha(await readFile(resolved))!==expected)fail('runtime-manifest-changed')
    paths.push(name)
   }
  }else{
   paths.push('package.json')
   for(const name of ['package-lock.json','pnpm-lock.yaml','yarn.lock'])if(await optionalHash(join(root,name)))paths.push(name)
   const walk=async(dir:string)=>{for(const entry of await readdir(join(root,dir),{withFileTypes:true})){if(entry.isSymbolicLink())fail('runtime-symlink');if(entry.isDirectory())await walk(join(dir,entry.name));else if(entry.isFile())paths.push(join(dir,entry.name))}}
   await walk('src')
  }
  const files=await Promise.all(paths.sort().map(async name=>[name,sha(await readFile(join(root,name))) as string] as [string,string]))
  // Shared packages are outside deployment archives. Bind their installed
  // manifests and resolved locations rather than assuming package.json ranges
  // identify what this host actually loaded. No transport config is included.
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
  const dependencies=await Promise.all([...new Set([...Object.keys(pkg.dependencies??{}),...Object.keys(pkg.peerDependencies??{})])].sort().map(async name=>{
   if(!/^(@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name))fail('runtime-package-invalid')
   const path=join(root,'node_modules',name,'package.json'),bytes=await optionalHash(path)
   return {name,sha256:bytes,path:bytes?await realpath(path):null}
  }))
  return {root:await realpath(root),files,dependencies,nodeVersion:process.version,nodeExecutable:await realpath(process.execPath)}
 }catch(e){if(e instanceof ExecutionBindingError)throw e;return fail('runtime-unavailable')}
}
export async function executionRuntimeIdentity(root=dirname(dirname(fileURLToPath(import.meta.url)))):Promise<string>{
 const manifest=await executionRuntimeManifest(root)
 return digest(manifest)
}

export function assertBinding(binding:BatchExecutionBinding,taskId:string,batchId:string){
 const {sha256,...body}=binding??{} as BatchExecutionBinding
 if(body.schemaVersion!==1||body.mode!=='agent-runtime-v1'||body.taskId!==taskId||body.batchId!==batchId||!Array.isArray(body.agents)||sha256!==digest(body))fail('invalid')
}
export async function captureExecutionBinding(ctx:any,task:any,batchId:string,allowedFallback:any,runtime=executionRuntimeIdentity,frozen?:BatchExecutionBinding):Promise<BatchExecutionBinding>{
 if(frozen)assertBinding(frozen,task.id,batchId)
 const agents:BoundAgent[]=[]
 for(const id of taskAgentIds(task)){
  const p=await ctx.get('agentPresets').resolve(id)
  const previous=frozen?.agents.find(a=>a.id===id)
  if(frozen&&!previous)fail('assignee-unbound')
  agents.push(await withPresetLock(dirname(String(p.path)),()=>captureAgent(ctx,id,previous?.selectionSource==='default'?previous.selection:undefined)))
 }
 const runtimeSha256=await runtime();if(!/^[a-f0-9]{64}$/.test(runtimeSha256))fail('runtime-invalid')
 const body={schemaVersion:1 as const,mode:'agent-runtime-v1' as const,taskId:task.id,batchId,capturedAt:new Date().toISOString(),agents,runtimeSha256,fallback:fallback(allowedFallback)}
 return {...body,sha256:digest(body)}
}
export async function verifyExecutionBinding(ctx:any,binding:BatchExecutionBinding,taskId:string,batchId:string,agentId:string,runtime=executionRuntimeIdentity){
 assertBinding(binding,taskId,batchId)
 const expected=binding.agents.find(a=>a.id===agentId);if(!expected)fail('assignee-unbound')
 // Bound runs already dispatch this exact selection. A global chat default is
 // only an input to NEW batches, never a reason to change or stall an old one.
 if(digest(await captureAgent(ctx,agentId,expected.selectionSource==='default'?expected.selection:undefined))!==digest(expected))fail('agent-drift')
 if(await runtime()!==binding.runtimeSha256)fail('runtime-drift')
 return expected
}
export async function withBoundPreset<T>(ctx:any,binding:BatchExecutionBinding,taskId:string,batchId:string,agentId:string,run:()=>Promise<T>,runtime=executionRuntimeIdentity){
 assertBinding(binding,taskId,batchId)
 const expected=binding.agents.find(a=>a.id===agentId);if(!expected)fail('assignee-unbound')
 return withPresetLock(expected.directory,async()=>{
  await verifyExecutionBinding(ctx,binding,taskId,batchId,agentId,runtime)
  const result=await run()
  await verifyExecutionBinding(ctx,binding,taskId,batchId,agentId,runtime)
  return result
 })
}
