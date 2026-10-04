import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises'
import {join,dirname,basename} from 'node:path'
import {createHash} from 'node:crypto'
import {withPresetLock} from '../src/preset-lock.ts'
import {tmpdir} from 'node:os'
import {loadStudioRolePack} from '../src/studio-role-pack.ts'
import {planStudioRoleInstall,applyStudioRoleInstall} from '../src/studio-role-install.ts'
import {readSpec,verifyPresetSkills,writePreset} from '../src/presets.ts'
async function setup(t:any){
 const root=await mkdtemp(join(tmpdir(),'studio-role-install-'));t.after(()=>rm(root,{recursive:true,force:true}));const pack=await loadStudioRolePack(),library=[]
 for(const name of pack.requiredSkills){const dir=join(root,'skills',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: fixture\n---\nFixture skill only.\n`);library.push({name,dir,description:'fixture',root:'fixture'})}
 const options={presetRoot:join(root,'presets'),library,hostMcp:Object.entries(pack.requiredMcp).map(([serverName,tools])=>({serverName,tools,sourceEntryId:'fixture-'+serverName,live:false,config:{headers:{Authorization:'Bearer DO-NOT-COPY-SECRET'}}})),systemAgentIds:[],authorable:true}
 return {root,pack,options}
}
test('dry run is read-only and explicit apply writes six normal locked presets without credentials',async t=>{
 const s=await setup(t),before=await readdir(s.root),plan=await planStudioRoleInstall(s.options)
 assert.equal(plan.canApply,true);assert.deepEqual(await readdir(s.root),before);assert.equal(plan.roles.filter(r=>r.action==='install').length,6);assert.ok(plan.dependencies.unverified.some(c=>c.kind==='host-capability'));assert.equal(plan.runtimeVerified,false);assert.ok(!JSON.stringify(plan).includes('DO-NOT-COPY-SECRET'))
 const applied=await applyStudioRoleInstall(s.options,plan.planSha256);assert.equal(applied.applied,true);assert.equal(applied.roles.filter(r=>r.status==='installed').length,6);assert.equal(applied.runtimeVerified,false)
 for(const r of s.pack.roles){const path=join(s.options.presetRoot,r.spec.id);assert.deepEqual(await readSpec(path),r.spec);assert.ok((await verifyPresetSkills(r.spec,s.options.library,path)).every(v=>v.status==='in-sync'));const yml=await readFile(join(path,'agent.cordis.yml'),'utf8');assert.ok(!yml.includes('DO-NOT-COPY-SECRET'));assert.equal((await readSpec(path))?.model,'');await readFile(join(path,'capabilities.lock.json'))}
 const next=await planStudioRoleInstall(s.options);assert.ok(next.roles.every(r=>r.action==='keep'));const kept=await applyStudioRoleInstall(s.options,next.planSha256);assert.equal(kept.applied,true);assert.ok(kept.roles.every(r=>r.status==='kept'))
 assert.ok(!(await readdir(s.options.presetRoot)).some(p=>p.startsWith('.studio-role-install-')))
})
test('existing customized or system roles are conflicts and are never overwritten',async t=>{
 const s=await setup(t),first=s.pack.roles[0],dir=join(s.options.presetRoot,first.spec.id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'task-console.json'),JSON.stringify({...first.spec,persona:'My private custom direction'}));await writeFile(join(dir,'keep.txt'),'DO NOT REPLACE')
 const plan=await planStudioRoleInstall(s.options);assert.equal(plan.canApply,false);assert.equal(plan.roles[0].action,'conflict');assert.ok(!JSON.stringify(plan).includes('My private custom direction'))
 const result=await applyStudioRoleInstall(s.options,plan.planSha256);assert.equal(result.applied,false);assert.equal(await readFile(join(dir,'keep.txt'),'utf8'),'DO NOT REPLACE');assert.deepEqual(await readdir(s.options.presetRoot),[first.spec.id])
 const system=await planStudioRoleInstall({...s.options,presetRoot:join(s.root,'other'),systemAgentIds:[first.spec.id]});assert.equal(system.canApply,false);assert.equal(system.roles[0].reason,'system-role-exists')
})
test('missing and unverified install dependencies block without silently dropping selected tools or skills',async t=>{
 const s=await setup(t)
 const unknown=await planStudioRoleInstall({presetRoot:s.options.presetRoot});assert.equal(unknown.canApply,false);assert.ok(unknown.blockers.some(b=>b.kind==='skill'&&b.status==='unverified'));assert.ok(unknown.blockers.some(b=>b.kind==='preset-registry'))
 const missing=await planStudioRoleInstall({...s.options,library:[],hostMcp:[]});assert.ok(missing.blockers.some(b=>b.kind==='skill'&&b.status==='missing'));assert.ok(missing.blockers.some(b=>b.kind==='mcp-tool'&&b.status==='missing'))
 const noEnumeration=await planStudioRoleInstall({...s.options,hostMcp:s.options.hostMcp.map(m=>({...m,tools:undefined}))});assert.ok(noEnumeration.blockers.some(b=>b.kind==='mcp-tool'&&b.status==='unverified'))
 const inline=await planStudioRoleInstall({...s.options,hostMcp:s.options.hostMcp.map(m=>({...m,sourceEntryId:undefined}))});assert.ok(inline.blockers.some(b=>b.kind==='mcp-reference'));assert.equal(inline.canApply,false);assert.ok(!JSON.stringify(inline).includes('DO-NOT-COPY-SECRET'))
 assert.equal((await applyStudioRoleInstall({...s.options,library:[],hostMcp:[]},missing.planSha256)).applied,false)
 assert.ok(!(await readdir(s.root)).includes('presets'))
})
test('stale reviewed plans reject changed skills, transport references or target contents before writing',async t=>{
 const s=await setup(t),plan=await planStudioRoleInstall(s.options)
 await writeFile(join(s.options.library[0].dir,'SKILL.md'),'changed skill')
 await assert.rejects(applyStudioRoleInstall(s.options,plan.planSha256),/plan-changed/);assert.ok(!(await readdir(s.root)).includes('presets'))
 const fresh=await planStudioRoleInstall(s.options)
 await assert.rejects(applyStudioRoleInstall({...s.options,hostMcp:s.options.hostMcp.map(m=>({...m,sourceEntryId:m.sourceEntryId+'-changed'}))},fresh.planSha256),/plan-changed/)
 const dir=join(s.options.presetRoot,s.pack.roles[0].spec.id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'mine.txt'),'custom')
 await assert.rejects(applyStudioRoleInstall(s.options,fresh.planSha256),/plan-changed/);assert.equal(await readFile(join(dir,'mine.txt'),'utf8'),'custom')
})
test('concurrent applies never replace the winning role or produce duplicate installs',async t=>{
 const s=await setup(t),plan=await planStudioRoleInstall(s.options)
 const results=await Promise.allSettled([applyStudioRoleInstall(s.options,plan.planSha256),applyStudioRoleInstall(s.options,plan.planSha256)])
 assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.applied));assert.equal((await readdir(s.options.presetRoot)).length,6)
 for(const r of s.pack.roles)assert.deepEqual(await readSpec(join(s.options.presetRoot,r.spec.id)),r.spec)
 const installs=results.flatMap(r=>r.status==='fulfilled'?r.value.roles:[]).filter(r=>r.status==='installed');assert.equal(installs.length,6)
})

test('a modified composition is preserved even when authored AgentSpec still matches the template',async t=>{
 const s=await setup(t),plan=await planStudioRoleInstall(s.options);await applyStudioRoleInstall(s.options,plan.planSha256)
 const dir=join(s.options.presetRoot,s.pack.roles[0].spec.id),path=join(dir,'agent.cordis.yml'),custom=(await readFile(path,'utf8'))+'\n# my private composition change\n'
 await writeFile(path,custom);const review=await planStudioRoleInstall(s.options);assert.equal(review.canApply,false);assert.equal(review.roles[0].action,'conflict');assert.ok(!JSON.stringify(review).includes('my private composition'))
 const result=await applyStudioRoleInstall(s.options,review.planSha256);assert.equal(result.applied,false);assert.equal(await readFile(path,'utf8'),custom)
})

test('installer preserves symlinked existing roles instead of reading through or replacing them',async t=>{
 const s=await setup(t),other=join(s.root,'private-role'),target=join(s.options.presetRoot,s.pack.roles[0].spec.id)
 await mkdir(other);await writeFile(join(other,'keep.txt'),'private');await mkdir(s.options.presetRoot);await symlink(other,target)
 const plan=await planStudioRoleInstall(s.options);assert.equal(plan.canApply,false);assert.equal(plan.roles[0].action,'conflict');assert.equal(plan.roles[0].currentFingerprint,null)
 assert.equal((await applyStudioRoleInstall(s.options,plan.planSha256)).applied,false);assert.equal(await readFile(join(other,'keep.txt'),'utf8'),'private')
})

async function oldRuntimeFixture(t:any){
 const s=await setup(t),initial=await planStudioRoleInstall(s.options);assert.equal((await applyStudioRoleInstall(s.options,initial.planSha256)).applied,true)
 const role=s.pack.roles.find(r=>r.role==='storyboard')!,dir=join(s.options.presetRoot,role.spec.id),path=join(dir,'agent.cordis.yml'),current=await readFile(path,'utf8')
 const old=current.replace(/(^  name: ')([^']+\/filtered-mcp-client\.js)(')/gm,(_all,lead,module,tail)=>{
  const release=dirname(dirname(module)),base=basename(release).replace(/-[a-f0-9]{12,40}(?:-[a-z0-9-]+)?$/,'')
  return lead+join(dirname(release),base+'-0123456789ab-old',basename(dirname(module)),'filtered-mcp-client.js')+tail
 })
 assert.notEqual(old,current);await writeFile(path,old)
 const lockPath=join(dir,'capabilities.lock.json'),lock=JSON.parse(await readFile(lockPath,'utf8'));lock.compositionSha256=createHash('sha256').update(old).digest('hex');await writeFile(lockPath,JSON.stringify(lock,null,2)+'\n')
 return {...s,role,dir,path,current,old,lockPath}
}
test('stock runtime-path-only drift is explicit reviewed refresh using the normal writer',async t=>{
 const s=await oldRuntimeFixture(t),meta=await readFile(join(s.dir,'agent-meta.json'),'utf8')
 await writeFile(join(s.dir,'actions.json'),'[]\n')
 const plan=await planStudioRoleInstall(s.options),entry=plan.roles.find(r=>r.agentId===s.role.spec.id)!
 assert.equal(entry.action,'refresh');assert.equal(entry.reason,'generated-runtime-module-path-drift');assert.equal(plan.canApply,true)
 const result=await applyStudioRoleInstall(s.options,plan.planSha256)
 assert.equal(result.applied,true);assert.equal(result.roles.find(r=>r.agentId===s.role.spec.id)?.status,'refreshed');assert.equal(result.runtimeVerified,false);assert.equal(result.qualityApproved,false)
 assert.equal(await readFile(s.path,'utf8'),s.current);assert.equal(await readFile(join(s.dir,'agent-meta.json'),'utf8'),meta);assert.equal(await readFile(join(s.dir,'actions.json'),'utf8'),'[]\n')
 assert.ok((await planStudioRoleInstall(s.options)).roles.every(r=>r.action==='keep'))
})
test('runtime refresh refuses changed raw author fields, copied skills, permissions and arbitrary module paths',async t=>{
 for(const variant of ['author','unknown-author-field','skill','permission','module','unlocked-composition','extra-file'])await t.test(variant,async st=>{
  const s=await oldRuntimeFixture(st)
  if(variant==='author'||variant==='unknown-author-field')await writeFile(join(s.dir,'task-console.json'),JSON.stringify({...s.role.spec,...(variant==='author'?{persona:'custom'}:{unknownPrivateExtension:true})}))
  if(variant==='skill')await writeFile(join(s.dir,'skills',s.role.spec.skills[0],'SKILL.md'),'custom copy')
  if(variant==='extra-file')await writeFile(join(s.dir,'my-extra.txt'),'preserve me')
  if(variant==='permission'||variant==='module'||variant==='unlocked-composition'){
   const custom=variant==='permission'?s.old+'\n# custom permission configuration\n':variant==='module'?s.old.replace(/\/[^/]+-0123456789ab-old\//g,'/unrelated-user-module/'):s.old+'\n# hand edit\n'
   await writeFile(s.path,custom)
   if(variant!=='unlocked-composition'){const lock=JSON.parse(await readFile(s.lockPath,'utf8'));lock.compositionSha256=createHash('sha256').update(custom).digest('hex');await writeFile(s.lockPath,JSON.stringify(lock))}
  }
  const before=await readFile(s.path,'utf8'),plan=await planStudioRoleInstall(s.options)
  assert.equal(plan.roles.find(r=>r.agentId===s.role.spec.id)?.action,'conflict');assert.equal(plan.canApply,false);assert.equal((await applyStudioRoleInstall(s.options,plan.planSha256)).applied,false);assert.equal(await readFile(s.path,'utf8'),before)
 })
})
test('stale refresh plans reject source and target changes without overwriting',async t=>{
 const s=await oldRuntimeFixture(t),plan=await planStudioRoleInstall(s.options)
 await writeFile(join(s.dir,'actions.json'),'[]\n')
 await assert.rejects(applyStudioRoleInstall(s.options,plan.planSha256),/plan-changed/);assert.equal(await readFile(s.path,'utf8'),s.old)
 const next=await planStudioRoleInstall(s.options);await writeFile(join(s.options.library[0].dir,'SKILL.md'),'new source')
 await assert.rejects(applyStudioRoleInstall(s.options,next.planSha256),/plan-changed/);assert.equal(await readFile(s.path,'utf8'),s.old)
})
test('writer guard runs inside the preset lock and refuses a change made while waiting',async t=>{
 const s=await oldRuntimeFixture(t);let release!:()=>void,entered!:()=>void,called=0
 const enteredPromise=new Promise<void>(r=>entered=r),hold=withPresetLock(s.dir,async()=>{entered();await new Promise<void>(r=>release=r)})
 await enteredPromise
 const pending=writePreset(s.role.spec,s.options.hostMcp,s.options.library,s.options.presetRoot,[],{assertCurrent:async dir=>{called++;assert.equal(dir,s.dir);if(await readFile(s.path,'utf8')!==s.old)throw Error('reviewed-state-changed')}})
 const checked=assert.rejects(pending,/reviewed-state-changed/)
 await new Promise(r=>setImmediate(r));assert.equal(called,0)
 await writeFile(s.path,s.old+'\n# another writer\n');release();await hold;await checked
 assert.equal(called,1);assert.equal(await readFile(s.path,'utf8'),s.old+'\n# another writer\n')
})
test('writer guard checks again after staging and preserves the old preset on refusal',async t=>{
 const s=await oldRuntimeFixture(t);let calls=0
 await assert.rejects(writePreset(s.role.spec,s.options.hostMcp,s.options.library,s.options.presetRoot,[],{assertCurrent:async()=>{calls++;if(calls===2)throw Error('state-changed-during-staging')}}),/state-changed-during-staging/)
 assert.equal(calls,2);assert.equal(await readFile(s.path,'utf8'),s.old)
 assert.ok(!(await readdir(s.options.presetRoot)).some(name=>name.startsWith('.'+s.role.spec.id+'-')))
})
test('concurrent reviewed refreshes replace a stock role at most once',async t=>{
 const s=await oldRuntimeFixture(t),plan=await planStudioRoleInstall(s.options)
 const results=await Promise.allSettled([applyStudioRoleInstall(s.options,plan.planSha256),applyStudioRoleInstall(s.options,plan.planSha256)])
 assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.applied))
 assert.equal(results.flatMap(r=>r.status==='fulfilled'?r.value.roles:[]).filter(r=>r.status==='refreshed').length,1)
 assert.equal(await readFile(s.path,'utf8'),s.current);assert.deepEqual(await readSpec(s.dir),s.role.spec)
})
