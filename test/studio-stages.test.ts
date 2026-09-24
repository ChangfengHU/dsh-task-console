import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {validateStudioStages,studioStageRows,studioStageCardId} from '../src/studio-stages.ts'
import {registerStageFiles,requireStudioStages,verifyStageReceipt} from '../src/studio-stage-files.ts'
import {HermesKernel} from '../src/hermes-kernel.ts'
const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:`video-${id}`,brief:`Prepare ${id}`})))
test('fixed dependency graph fans out and joins only after both real parents complete',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'stage-dag-'));t.after(()=>rm(dir,{recursive:true,force:true}));const k=new HermesKernel(join(dir,'db.sqlite'));t.after(()=>k.close())
 k.createTask({id:'B#p1',title:'director',assignee:'director',tenant:'B'})
 const rows=studioStageRows({design:{studioStages:stages}},'B',1,'B#p1')
 for(const r of rows)k.createTask({id:r.id,title:r.brief,assignee:r.agentId,parents:r.deps,tenant:'B'})
 const finish=(id:string)=>{const c=k.claimTask(id)!;assert.ok(c);k.completeTask(id,{expectedRunId:c.run.id,summary:'real stage files'})}
 assert.equal(k.claimTask(rows[0].id),undefined);finish('B#p1');finish(rows[0].id)
 assert.equal(k.getTask(rows[1].id)?.status,'ready');assert.equal(k.getTask(rows[2].id)?.status,'ready')
 k.createTask({id:'B#compose',title:'compose',assignee:'editor',parents:[rows[1].id,rows[2].id],tenant:'B'})
 finish(rows[1].id);assert.equal(k.claimTask('B#compose'),undefined);finish(rows[2].id);assert.ok(k.claimTask('B#compose'))
 assert.throws(()=>k.linkTasks('B#compose','B#p1'),/cycle/)
})
test('stage manifests bind real files, session, round and config; archived parents and tampering fail',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'stage-files-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const receipts=new Map(),states=new Map()
 const db={prepare:()=>({get:(id:string)=>states.get(id)})},workflow={script:()=>({sha256:'a'.repeat(64),lines:[{id:'line-1',text:'原始台词'}]}),stageReceipt:(i:any,id:string)=>receipts.get(`${i.card.round}:${id}`),recordStageReceipt:(i:any,r:any)=>receipts.set(`${i.card.round}:${r.stage}`,r)}
 const input=(id:string)=>({task:{cwd,design:{studioStages:stages}},batch:{id:'B'},card:{id:studioStageCardId('B',1,id as any),agentId:`video-${id}`,role:'studio-stage',round:1},sessionId:`session-${id}`})
 const make=async(id:string,ext:string)=>{const dir=`stages/r1/${id}`;await mkdir(join(cwd,dir),{recursive:true});await writeFile(join(cwd,dir,`asset.${ext}`),id==='storyboard'?JSON.stringify({scenes:[{sound:'line-1'}],scriptSha256:'a'.repeat(64)}):'fixture');const path=`${dir}/manifest.json`;await writeFile(join(cwd,path),JSON.stringify({stage:id,round:1,outputs:[`${dir}/asset.${ext}`],summary:'Artifact fixture; semantic review pending'}));return path}
 const story=await registerStageFiles(input('storyboard'),await make('storyboard','json'),workflow,db)
 assert.equal(story.qualityApproved,false);assert.match(story.outputs[0].sha256,/^[a-f0-9]{64}$/)
 const visual=await make('visual','png');await assert.rejects(registerStageFiles(input('visual'),visual,workflow,db),/dependency-required/)
 states.set('B#s1-storyboard',{status:'archived',tenant:'B',assignee:'video-storyboard'});await assert.rejects(registerStageFiles(input('visual'),visual,workflow,db),/dependency-required/)
 states.set('B#s1-storyboard',{status:'done',tenant:'other',assignee:'video-storyboard'});await assert.rejects(registerStageFiles(input('visual'),visual,workflow,db),/dependency-required/)
 states.set('B#s1-storyboard',{status:'done',tenant:'B',assignee:'video-storyboard'});await registerStageFiles(input('visual'),visual,workflow,db)
 await assert.rejects(verifyStageReceipt({...input('storyboard'),batch:{id:'different'}},story,workflow),/receipt-required/)
 await writeFile(join(cwd,story.outputs[0].path),'changed');await assert.rejects(requireStudioStages(input('sound'),workflow,db),/file-changed/)
})
test('stage configuration rejects duplicate, missing or unknown stages',()=>{
 assert.throws(()=>validateStudioStages(stages.slice(1)),/requires/)
 assert.throws(()=>validateStudioStages([...stages.slice(0,2),stages[0]]),/invalid/)
 assert.throws(()=>validateStudioStages(stages.map(s=>({...s,agentId:'same'}))),/distinct/)
})
