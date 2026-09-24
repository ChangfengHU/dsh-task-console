import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,mkdir,symlink,stat,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {planStudioWorkspace,ensureStudioWorkspace} from '../src/studio-workspace.ts'

async function root(t:any){const path=await mkdtemp(join(tmpdir(),'studio workspace '));t.after(()=>rm(path,{recursive:true,force:true}));return path}
test('workspace planning needs an existing absolute host root and writes nothing',async t=>{
 const path=await root(t)
 for(const input of [undefined,'relative',''])await assert.rejects(planStudioWorkspace(input,'T-one'),/host-root-required/)
 await assert.rejects(planStudioWorkspace(join(path,'absent'),'T-one'),/host-root-unavailable/)
 await assert.rejects(planStudioWorkspace(path,'../escape'),/task-id-invalid/)
 const planned=await planStudioWorkspace(path,'T-one');assert.equal(planned.path,join(path,'studio-workspaces','T-one'))
 await assert.rejects(stat(join(path,'studio-workspaces')),{code:'ENOENT'})
})
test('allocation is owned, idempotent and never truncates existing project files',async t=>{
 const path=await root(t),plan=await planStudioWorkspace(path,'T-one')
 await ensureStudioWorkspace(plan,'T-one',plan.path,true)
 await writeFile(join(plan.path,'story.txt'),'keep')
 await ensureStudioWorkspace(plan,'T-one',plan.path,true)
 await ensureStudioWorkspace(plan,'T-one',plan.path)
 assert.equal(await readFile(join(plan.path,'story.txt'),'utf8'),'keep')
 assert.equal((await stat(join(plan.path,'.studio-workspace.json'))).mode&0o777,0o600)
 await assert.rejects(ensureStudioWorkspace(plan,'T-other',plan.path),/binding-invalid/)
 await assert.rejects(ensureStudioWorkspace(plan,'T-one',path),/binding-changed/)
})
test('symlink directories, owner markers and changed ownership fail closed',async t=>{
 const path=await root(t),elsewhere=await root(t),plan=await planStudioWorkspace(path,'T-one')
 await symlink(elsewhere,join(path,'studio-workspaces'))
 await assert.rejects(ensureStudioWorkspace(plan,'T-one',plan.path,true),/directory-conflict/)
 await rm(join(path,'studio-workspaces'));await mkdir(join(path,'studio-workspaces'));await symlink(elsewhere,plan.path)
 await assert.rejects(ensureStudioWorkspace(plan,'T-one',plan.path,true),/directory-conflict/)
 await rm(plan.path);await ensureStudioWorkspace(plan,'T-one',plan.path,true)
 const owner=join(plan.path,'.studio-workspace.json');await rm(owner);await writeFile(join(elsewhere,'owner'),JSON.stringify(plan));await symlink(join(elsewhere,'owner'),owner)
 await assert.rejects(ensureStudioWorkspace(plan,'T-one',plan.path),/ownership-conflict/)
 await rm(owner);await writeFile(owner,JSON.stringify({...plan,taskId:'T-other'}))
 await assert.rejects(ensureStudioWorkspace(plan,'T-one',plan.path),/ownership-conflict/)
})
