import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TaskConsoleService} from '../src/service.ts'
import {loadStudioRolePack} from '../src/studio-role-pack.ts'
import {METHODS,CONSOLE_INVOCATIONS} from '../src/wire.ts'
import {TYPERT} from '../src/typert.host.ts'
import {CONSOLE_REMOTE} from '../src/client/remote.ts'

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'studio-rpc-')),home=join(root,'dsh'),agents=join(root,'agents'),pack=await loadStudioRolePack()
 const previous={DSH_HOME:process.env.DSH_HOME,DSH_AGENTS_HOME:process.env.DSH_AGENTS_HOME}
 process.env.DSH_HOME=home;process.env.DSH_AGENTS_HOME=agents
 t.after(async()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}await rm(root,{recursive:true,force:true})})
 await mkdir(home)
 for(const name of pack.requiredSkills){const dir=join(home,'skills',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: fixture\n---\nFixture skill.\n`)}
 const rows:any[]=[],registry:any={authorable:true,list:async()=>rows}
 const entries=Object.entries(pack.requiredMcp).map(([serverName])=>({options:{id:'host-'+serverName,name:'@deepseek-ai/dsh-mcp-client',config:{serverName,url:'https://fixture.invalid/mcp',headers:{Authorization:'Bearer PRIVATE_RPC_SECRET'}}}}))
 let schemas=Object.entries(pack.requiredMcp).flatMap(([server,tools])=>tools.map(tool=>({name:`mcp__${server}__${tool}`})))
 const ctx:any={get:(key:string)=>key==='agentPresets'?registry:key==='agentDefaultModel'?{currentSelection:()=>({provider:'host-provider',model:'host-model'})}:undefined,
  tools:{schemas:()=>schemas},loader:{entries:()=>entries},agents:{create:()=>assert.fail('installation must not execute an Agent')}}
 const service:any=Object.create(TaskConsoleService.prototype);Object.defineProperty(service,'ctx',{value:ctx});service.ready=Promise.resolve()
 service.runner={fire:()=>assert.fail('installation must not fire a Task')}
 return {root,home,pack,service,registry,rows,entries,setSchemas:(next:any[])=>{schemas=next}}
}
test('ordinary RPC descriptors expose no-argument plan and one JSON apply on both faces',()=>{
 assert.ok(METHODS.some(([name,count])=>name==='studioRoleInstallPlan'&&count===0))
 assert.ok(METHODS.some(([name,count])=>name==='studioRoleInstallApply'&&count===1))
 assert.equal(TYPERT.invocations,CONSOLE_INVOCATIONS);assert.equal(CONSOLE_REMOTE.descriptors,CONSOLE_INVOCATIONS)
 for(const name of ['studioRoleInstallPlan','studioRoleInstallApply']){
  const d=CONSOLE_INVOCATIONS.find(d=>d.method===name)!
  assert.equal(typeof (TaskConsoleService.prototype as any)[name],'function');assert.equal(d.namespace,'taskConsole')
  assert.equal(d.parameters.length,name.endsWith('Plan')?0:1)
 }
})
test('plan derives host inventory read-only and apply installs only reviewed roles under the host preset root',async t=>{
 const s=await fixture(t),before=await readdir(s.home),plan=JSON.parse(await s.service.studioRoleInstallPlan())
 assert.equal(plan.canApply,true);assert.equal(plan.presetRoot,join(s.home,'.agent-presets'));assert.deepEqual(await readdir(s.home),before)
 assert.ok(plan.dependencies.unverified.some((d:any)=>d.kind==='host-capability'));assert.equal(plan.runtimeVerified,false)
 assert.doesNotMatch(JSON.stringify(plan),/PRIVATE_RPC_SECRET|fixture\.invalid|host-provider/)
 const result=JSON.parse(await s.service.studioRoleInstallApply(JSON.stringify({expectedPlanSha256:plan.planSha256})))
 assert.equal(result.applied,true);assert.equal(result.roles.filter((r:any)=>r.status==='installed').length,6);assert.equal(result.runtimeVerified,false)
 for(const role of s.pack.roles){
  const path=join(plan.presetRoot,role.spec.id),spec=JSON.parse(await readFile(join(path,'task-console.json'),'utf8')),yml=await readFile(join(path,'agent.cordis.yml'),'utf8')
  assert.equal(spec.model,'');assert.equal(spec.permissionPreset,'workspace-write');assert.doesNotMatch(yml,/PRIVATE_RPC_SECRET|fixture\.invalid/)
 }
 const again=JSON.parse(await s.service.studioRoleInstallPlan());assert.ok(again.roles.every((r:any)=>r.action==='keep'))
})
test('apply rejects browser paths, grants, inventories, malformed hashes and credentials before discovery',async t=>{
 const s=await fixture(t),hash='a'.repeat(64);s.registry.list=()=>assert.fail('invalid request must fail before host discovery')
 for(const value of [null,[],{}, {expectedPlanSha256:[hash]},{expectedPlanSha256:hash,presetRoot:s.root},{expectedPlanSha256:hash,hostMcp:[]},{expectedPlanSha256:hash,authorable:true},{expectedPlanSha256:hash,vaultToken:'SECRET'},{expectedPlanSha256:'bad'}])await assert.rejects(s.service.studioRoleInstallApply(JSON.stringify(value)),{message:'studio-role-install-request-invalid'})
 await assert.rejects(s.service.studioRoleInstallApply('{SECRET'),{message:'studio-role-install-request-invalid'})
 await assert.rejects(lstat(join(s.home,'.agent-presets')),{code:'ENOENT'})
})
test('current host dependency drift invalidates the reviewed RPC plan without writes',async t=>{
 const s=await fixture(t),plan=JSON.parse(await s.service.studioRoleInstallPlan())
 s.setSchemas([])
 const missing=JSON.parse(await s.service.studioRoleInstallPlan());assert.equal(missing.canApply,false);assert.ok(missing.blockers.some((b:any)=>b.kind==='mcp-tool'))
 await assert.rejects(s.service.studioRoleInstallApply(JSON.stringify({expectedPlanSha256:plan.planSha256})),/plan-changed/)
 const result=JSON.parse(await s.service.studioRoleInstallApply(JSON.stringify({expectedPlanSha256:missing.planSha256})));assert.equal(result.applied,false)
 await assert.rejects(lstat(join(s.home,'.agent-presets')),{code:'ENOENT'})
})
test('host registry ownership and writable-root policy remain authoritative',async t=>{
 const s=await fixture(t);s.registry.authorable=false;s.rows.push({id:s.pack.roles[0].spec.id,trust:'system'})
 const plan=JSON.parse(await s.service.studioRoleInstallPlan());assert.equal(plan.canApply,false)
 assert.ok(plan.blockers.some((b:any)=>b.id==='authorable'&&b.status==='missing'));assert.equal(plan.roles[0].reason,'system-role-exists')
 const result=JSON.parse(await s.service.studioRoleInstallApply(JSON.stringify({expectedPlanSha256:plan.planSha256})));assert.equal(result.applied,false)
 await assert.rejects(lstat(join(s.home,'.agent-presets')),{code:'ENOENT'})
 s.registry.list=async()=>{throw Error('PRIVATE_REGISTRY_ERROR')}
 const unknown=JSON.parse(await s.service.studioRoleInstallPlan());assert.ok(unknown.blockers.some((b:any)=>b.kind==='preset-registry'&&b.status==='unverified'));assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE_REGISTRY_ERROR/)
})
