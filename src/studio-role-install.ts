/** Explicit, local install and narrowly checked runtime-path refresh of the portable Studio role pack. */
import {lstat,readFile,readdir,mkdir,mkdtemp,cp,rm} from 'node:fs/promises'
import {join,resolve,dirname,basename,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {loadStudioRolePack,inspectStudioRoleDependencies,type StudioDependencyInventory} from './studio-role-pack.js'
import {writePreset,renderComposition,hashSkillTree,verifyPresetSkills,type HostMcp} from './presets.js'
import {withPresetLock} from './preset-lock.js'
import {canonical} from './capability-contract.js'
import type {SkillEntry} from './wire.js'
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex')
const textHash=(v:string)=>createHash('sha256').update(v).digest('hex')
const exists=async(path:string)=>{try{return await lstat(path)}catch(e:any){if(e.code==='ENOENT')return null;throw Error('studio-role-install-path-unreadable')}}

/** Only generated filtered-MCP module names in sibling versioned releases may change.
 * This does not normalize arbitrary paths, tool config, permissions, or user-authored YAML. */
function runtimePathOnlyDrift(actual:string,expected:string):boolean {
 const rows=actual.split('\n'),next=expected.split('\n');if(rows.length!==next.length)return false
 let changes=0
 for(let i=0;i<rows.length;i++){
  if(rows[i]===next[i])continue
  const old=/^  name: '([^']+\/filtered-mcp-client\.js)'$/.exec(rows[i]),current=/^  name: '([^']+\/filtered-mcp-client\.js)'$/.exec(next[i])
  if(!old||!current||!rows[i-1]?.startsWith('- id: mcp-')||!isAbsolute(old[1])||!isAbsolute(current[1]))return false
  const oldModuleDir=dirname(old[1]),newModuleDir=dirname(current[1]),oldRelease=dirname(oldModuleDir),newRelease=dirname(newModuleDir)
  if(basename(oldModuleDir)!==basename(newModuleDir)||!['lib','src'].includes(basename(newModuleDir))||dirname(oldRelease)!==dirname(newRelease))return false
  const base=basename(newRelease).replace(/-[a-f0-9]{12,40}(?:-[a-z0-9-]+)?$/,'')
  const prefix=base+'-',oldName=basename(oldRelease)
  if(!oldName.startsWith(prefix)||! /^[a-f0-9]{12,40}(?:-[a-z0-9-]+)?$/.test(oldName.slice(prefix.length)))return false
  changes++
 }
 return changes>0
}
async function roleState(target:string,spec:any,library:SkillEntry[]){
 const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())throw Error('nonregular-role-directory')
 const files:Record<string,string>={}
 for(const name of ['task-console.json','agent.cordis.yml','capabilities.lock.json','skills.lock.json']){
  const file=await lstat(join(target,name));if(!file.isFile()||file.isSymbolicLink())throw Error('nonregular-role-file')
  files[name]=await readFile(join(target,name),'utf8')
 }
 const names=await readdir(target)
 for(const name of names){
  if(name==='skills'||name in files)continue
  if(!['preset.yml','agent-meta.json','actions.json'].includes(name))throw Error('unmanaged-role-file')
  const file=await lstat(join(target,name));if(!file.isFile()||file.isSymbolicLink())throw Error('nonregular-role-file')
  files[name]=await readFile(join(target,name),'utf8')
 }
 const skillDir=await lstat(join(target,'skills'));if(!skillDir.isDirectory()||skillDir.isSymbolicLink())throw Error('nonregular-role-skills')
 if(canonical((await readdir(join(target,'skills'))).sort())!==canonical([...spec.skills].sort()))throw Error('unmanaged-role-skills')
 const skills=await verifyPresetSkills(spec,library,target)
 return {rawSpec:JSON.parse(files['task-console.json']),composition:files['agent.cordis.yml'],capability:JSON.parse(files['capabilities.lock.json']),skills,fingerprint:hash({files,skills})}
}

export interface StudioRoleInstallOptions {
 presetRoot:string;packRoot?:string;library?:SkillEntry[];hostMcp?:HostMcp[];
 hostTools?:string[];hostCapabilities?:string[];defaultModelAvailable?:boolean;
 /** From the host preset registry; undefined is unknown, [] is checked and empty. */
 systemAgentIds?:string[];authorable?:boolean
}
async function inspect(options:StudioRoleInstallOptions){
 if(typeof options.presetRoot!=='string'||!options.presetRoot.trim())throw Error('studio-role-install-root-required')
 const root=resolve(options.presetRoot),pack=await loadStudioRolePack(options.packRoot),rootStat=await exists(root)
 const hostMcp=options.hostMcp??[],library=options.library??[],skillEvidence:{name:string;sha256:string|null}[]=[]
 const usableSkills:SkillEntry[]=[]
 for(const name of pack.requiredSkills){
  const entry=library.find(s=>s.name===name)??library.find(s=>s.dir.split('/').at(-1)===name)
  let sha256:string|null=null
  if(entry)try{await readFile(join(entry.dir,'SKILL.md'));sha256=await hashSkillTree(entry.dir);usableSkills.push(entry)}catch{/* an inventory name is not a usable skill tree */}
  skillEvidence.push({name,sha256})
 }
 const inventory:StudioDependencyInventory={...(options.library?{skills:skillEvidence.filter(s=>s.sha256).map(s=>s.name)}:{}),...(options.hostMcp?{mcpTools:Object.fromEntries(hostMcp.map(m=>[m.serverName,m.tools??[]]))}:{}),hostTools:options.hostTools,hostCapabilities:options.hostCapabilities,defaultModelAvailable:options.defaultModelAvailable}
 const dependencies=inspectStudioRoleDependencies(pack,inventory)
 // A discovered transport with no tool enumeration is unknown, not a successful empty tools/list.
 for(const check of dependencies.checks.filter(c=>c.kind==='mcp-tool')){
  const server=check.id.split('/')[0],entries=hostMcp.filter(m=>m.serverName===server)
  if(entries.length===1&&entries[0].tools===undefined)check.status='unverified'
 }
 dependencies.missing=dependencies.checks.filter(c=>c.status==='missing');dependencies.unverified=dependencies.checks.filter(c=>c.status==='unverified');dependencies.inventoryComplete=dependencies.checks.every(c=>c.status==='present-in-inventory')
 const blockers:{kind:string;id:string;status:string}[]=[]
 if(options.authorable!==true)blockers.push({kind:'preset-root',id:'authorable',status:options.authorable===false?'missing':'unverified'})
 if(options.systemAgentIds===undefined)blockers.push({kind:'preset-registry',id:'system-agent-identities',status:'unverified'})
 if(rootStat&&(!rootStat.isDirectory()||rootStat.isSymbolicLink()))blockers.push({kind:'preset-root',id:'plain-directory',status:'conflict'})
 for(const d of dependencies.checks)if(['skill','mcp-tool'].includes(d.kind)&&d.status!=='present-in-inventory')blockers.push({kind:d.kind,id:d.id,status:d.status})
 const references:HostMcp[]=[]
 for(const server of Object.keys(pack.requiredMcp)){
  const entries=hostMcp.filter(m=>m.serverName===server),entry=entries[0]
  if(entries.length!==1||typeof entry.sourceEntryId!=='string'||!entry.sourceEntryId.trim())blockers.push({kind:'mcp-reference',id:server,status:options.hostMcp===undefined?'unverified':entries.length>1?'conflict':'missing'})
  else references.push({serverName:server,sourceEntryId:entry.sourceEntryId,tools:entry.tools?[...entry.tools]:undefined,config:{},live:entry.live})
 }
 const roles:{role:string;agentId:string;action:'install'|'keep'|'refresh'|'conflict';reason:string;templateSha256:string;targetFingerprint:string;currentFingerprint:string|null}[]=[]
 for(const role of pack.roles){
  const expected=renderComposition(role.spec,references),targetFingerprint=hash({composition:expected.yml,capabilities:expected.capabilities})
  const target=join(root,role.spec.id),info=await exists(target);let action:'install'|'keep'|'refresh'|'conflict'='install',reason='new-role',currentFingerprint:string|null=null
  if(options.systemAgentIds?.includes(role.spec.id)){action='conflict';reason='system-role-exists'}
  else if(info){
   action='conflict';reason='existing-custom-or-invalid-role'
   if(info.isDirectory()&&!info.isSymbolicLink())try{
    const state=await roleState(target,role.spec,usableSkills),{rawSpec,composition,capability,skills}=state
    currentFingerprint=state.fingerprint
    const stock=canonical(rawSpec)===canonical(role.spec),skillsMatch=skills.every(s=>s.status==='in-sync')
    if(stock&&composition===expected.yml&&canonical(capability)===canonical(expected.capabilities)&&skillsMatch){action='keep';reason='identical-current-role'}
    else if(stock&&skillsMatch&&capability.compositionSha256===textHash(composition)&&canonical({...capability,compositionSha256:expected.capabilities.compositionSha256})===canonical(expected.capabilities)&&runtimePathOnlyDrift(composition,expected.yml)){
     action='refresh';reason='generated-runtime-module-path-drift'
    }
   }catch{/* Preserve unknown/custom directories rather than overwrite or repair them. */}
  }
  roles.push({role:role.role,agentId:role.spec.id,action,reason,templateSha256:role.sha256,targetFingerprint,currentFingerprint})
 }
 const body={schema:'studio-role-install-plan-v1',packVersion:pack.version,presetRoot:root,roles,dependencies,blockers,canApply:blockers.length===0&&!roles.some(r=>r.action==='conflict'),modelPolicy:'inherit-host-default',runtimeVerified:false,qualityApproved:false,
  sourceFingerprint:hash({skillEvidence,transportReferences:references.map(({serverName,sourceEntryId,tools,live})=>({serverName,sourceEntryId,tools,live})),systemAgentIds:options.systemAgentIds??null,authorable:options.authorable??null})}
 return {plan:{...body,planSha256:hash(body)},pack,references,library:usableSkills}
}
/** Pure filesystem reads. No mkdir, transport call, preset write or model selection mutation. */
export async function planStudioRoleInstall(options:StudioRoleInstallOptions){return (await inspect(options)).plan}
/** Call only for explicit apply. Recomputes the reviewed plan before any write. */
export async function applyStudioRoleInstall(options:StudioRoleInstallOptions,expectedPlanSha256:string){
 const current=await inspect(options),{plan,pack,references,library}=current
 if(!/^[a-f0-9]{64}$/.test(expectedPlanSha256)||plan.planSha256!==expectedPlanSha256)throw Error('studio-role-install-plan-changed')
 if(!plan.canApply)return {applied:false,plan,roles:[],runtimeVerified:false,qualityApproved:false}
 const root=plan.presetRoot,toInstall=pack.roles.filter(r=>['install','refresh'].includes(plan.roles.find(p=>p.agentId===r.spec.id)?.action??''))
 const results:{agentId:string;status:'installed'|'refreshed'|'kept'|'conflict'|'partial';reason?:string}[]=plan.roles.filter(r=>r.action==='keep').map(r=>({agentId:r.agentId,status:'kept'}))
 if(!toInstall.length)return {applied:true,planSha256:plan.planSha256,roles:results,runtimeVerified:false,qualityApproved:false}
 await mkdir(root,{recursive:true,mode:0o700})
 const stagedRoot=await mkdtemp(join(root,'.studio-role-install-'))
 try{
  // Use the standard writer for generation/copy/locks, but never aim its replacement path at a real role.
  for(const role of toInstall)await writePreset(role.spec,references,library,stagedRoot)
  if((await inspect(options)).plan.planSha256!==expectedPlanSha256)return {applied:false,planSha256:plan.planSha256,roles:results,errorCode:'plan-changed-after-staging',runtimeVerified:false,qualityApproved:false}
  for(const role of toInstall){
   const target=join(root,role.spec.id),reviewed=plan.roles.find(r=>r.agentId===role.spec.id)!
   if(reviewed.action==='refresh'){
    try{
     await writePreset(role.spec,references,library,root,[],{assertCurrent:async()=>{
      // Runs inside the standard writer's lock, also after staging, immediately before rename.
      const latest=await inspect(options),entry=latest.plan.roles.find(r=>r.agentId===role.spec.id)
      if(!latest.plan.canApply||latest.plan.sourceFingerprint!==plan.sourceFingerprint||entry?.action!=='refresh'||entry.targetFingerprint!==reviewed.targetFingerprint||entry.currentFingerprint!==reviewed.currentFingerprint)throw Error('studio-role-refresh-plan-changed')
     }})
     results.push({agentId:role.spec.id,status:'refreshed'})
    }catch{results.push({agentId:role.spec.id,status:'conflict',reason:'refresh-state-changed-or-write-failed'});break}
    continue
   }
   const result=await withPresetLock(target,async()=>{
    if(await exists(target))return {agentId:role.spec.id,status:'conflict' as const,reason:'target-created-since-plan'}
    try{await mkdir(target,{mode:0o700})}catch(e:any){if(e.code==='EEXIST')return {agentId:role.spec.id,status:'conflict' as const,reason:'target-created-since-plan'};throw Error('studio-role-install-create-failed')}
    try{
     // Exclusive children prevent clobbering a concurrently written file. Never delete a partial target.
     await cp(join(stagedRoot,role.spec.id),target,{recursive:true,force:false,errorOnExist:true})
     return {agentId:role.spec.id,status:'installed' as const}
    }catch{return {agentId:role.spec.id,status:'partial' as const,reason:'copy-failed-preserved-for-inspection'}}
   })
   results.push(result)
   if(result.status!=='installed')break
  }
  return {applied:results.length===pack.roles.length&&results.every(r=>['kept','installed','refreshed'].includes(r.status)),planSha256:plan.planSha256,roles:results,runtimeVerified:false,qualityApproved:false,notice:'Role definitions installed, explicitly refreshed, or preserved only. Existing sessions are not restarted; new sessions use refreshed definitions. No provider call, Task launch, runtime readiness or film approval is implied.'}
 }catch{return {applied:false,planSha256:plan.planSha256,roles:results,errorCode:'staging-or-create-failed',runtimeVerified:false,qualityApproved:false,notice:'Completed installs and reviewed refreshes are listed; unrelated existing roles were not overwritten. Inspect any partial target before a new plan.'}}finally{await rm(stagedRoot,{recursive:true,force:true})}
}
