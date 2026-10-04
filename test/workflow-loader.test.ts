import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {loadWorkflowModules} from '../src/workflow-loader.js'

test('startup loads verified bundle bytes before any dispatch; changed files and duplicate versions fail',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-loader-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'adapter.mjs'),source="export default {id:'audit-fixture',version:'1.0.0',hostApi:1,validatePolicy:p=>p,beforeComplete:async()=>({summary:'host',metadata:{}})}"
 await writeFile(path,source);const sha256=createHash('sha256').update(source).digest('hex')
 const loaded=await loadWorkflowModules([{path,sha256}]);assert.equal(loaded[0].implementationSha256,sha256)
 await assert.rejects(loadWorkflowModules([{path,sha256},{path,sha256}]),/already-registered/)
 await writeFile(path,source+'\n// modified')
 await assert.rejects(loadWorkflowModules([{path,sha256}]),/digest-mismatch/)
 await assert.rejects(loadWorkflowModules([{path:'relative.mjs',sha256}]),/config-invalid/)
})

test('deployment compatibility manifest drives actual startup identity and hashes',async t=>{
 const {mkdir}=await import('node:fs/promises'),{pathToFileURL}=await import('node:url'),{loadBundledWorkflowModules}=await import('../src/workflow-loader.js')
 const root=await mkdtemp(join(tmpdir(),'workflow-bundled-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'lib'))
 const source="export default {id:'bundled-fixture',version:'1.0.0',hostApi:1,validatePolicy:p=>p,beforeComplete:async()=>({summary:'host',metadata:{}})}"
 const implementationSha256=createHash('sha256').update(source).digest('hex')
 await writeFile(join(root,'lib/fixture.mjs'),source)
 const entry={id:'bundled-fixture',version:'1.0.0',implementationSha256,bundle:'lib/fixture.mjs'}
 const save=async(e:any)=>writeFile(join(root,'lib/workflow-compat.json'),JSON.stringify({schemaVersion:1,hostApi:1,extensions:[e]}))
 await save(entry)
 const loaded=await loadBundledWorkflowModules(pathToFileURL(root+'/'));assert.equal(loaded[0].id,'bundled-fixture')
 await save({...entry,version:'2.0.0'});await assert.rejects(loadBundledWorkflowModules(pathToFileURL(root+'/')),/identity-mismatch/)
 await save({...entry,bundle:'lib/../../elsewhere.mjs'});await assert.rejects(loadBundledWorkflowModules(pathToFileURL(root+'/')),/path-invalid/)
})
