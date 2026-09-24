import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {loadStudioRolePack} from '../src/studio-role-pack.ts'
import {planStudioRoleInstall,applyStudioRoleInstall} from '../src/studio-role-install.ts'
import {readSpec,verifyPresetSkills} from '../src/presets.ts'
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
