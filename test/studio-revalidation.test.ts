import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {EventStore} from '../src/tasks.ts'
import {StudioOperations} from '../src/studio-operations.ts'
import {recoverStudioFailure} from '../src/studio-recovery.ts'
const request={taskId:'T',batchId:'B',cardId:'B#e1',expectedRunId:'R-editor',recoveryId:'recheck-1',reason:'Revalidate actual legacy files, preserve originals and paid jobs; never reset budget.',revalidateFrom:'storyboard' as const}
async function setup(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'studio-revalidate-'));const s=new EventStore(cwd);await s.load();t.after(async()=>{s.kernel.close();await rm(cwd,{recursive:true,force:true})})
 const task:any={id:'T',title:'test',brief:'test',cwd,trigger:{kind:'once'},participants:[{agentId:'a'}],enabled:true,timeoutSec:60,maxTries:2,onFail:'stop',createdAt:new Date().toISOString(),design:{evidenceContract:'studio-video-v1'}};const at=new Date().toISOString()
 await s.append({t:'task/created',at,taskId:'T',task})
 const cards=[{id:'B#s1-storyboard',deps:[],role:'studio-stage'},{id:'B#s1-visual',deps:['B#s1-storyboard'],role:'studio-stage'},{id:'B#s1-sound',deps:['B#s1-storyboard'],role:'studio-stage'},{id:'B#e1',deps:['B#s1-visual','B#s1-sound'],role:'executor'},{id:'B#r1',deps:['B#e1'],role:'reviewer'}].map(c=>({...c,agentId:'a',round:1}))
 await s.createBatch(task,{t:'batch/fired',at,taskId:'T',batch:{id:'B',by:'manual',cards}} as any)
 for(const c of cards.slice(0,4)){
  const claim=s.kernel.claimTask(c.id)!;assert.ok(claim);const runId=c.role==='executor'?'R-editor':'R-'+c.id
  await s.append({t:'run/claimed',at,taskId:'T',cardId:c.id,runId,sessionId:runId,attempt:1})
  if(c.role==='executor'){s.kernel.blockTask(c.id,{expectedRunId:claim.run.id,reason:'Missing runtime',kind:'capability'});await s.append({t:'run/blocked',at,taskId:'T',runId,reason:'Missing runtime',kind:'capability',terminal:true})}
  else{s.kernel.completeTask(c.id,{expectedRunId:claim.run.id,summary:'legacy files'});await s.append({t:'run/completed',at,taskId:'T',runId,summary:'legacy files'})}
 }
 const ops=new StudioOperations(s);ops.configure({task,batch:{id:'B'}},{imageCalls:6,voiceSegments:40})
 s.kernel.db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run('T','B','saved','generate_image','imageCalls',4,'submitted','original-job','{}')
 return {s,task}
}
test('stage revalidation reopens actual DAG without resetting paid work, history or certifying receipts',async t=>{
 const {s}=await setup(t),db=s.kernel.db,ledger=JSON.stringify(db.prepare('SELECT * FROM dsh_studio_operations').all())
 const results=await Promise.all([recoverStudioFailure(s,request),recoverStudioFailure(s,request)])
 assert.equal(results[0].replay,false);assert.equal(results[1].replay,true)
 assert.equal(s.s.cards.get('B#s1-storyboard')?.status,'ready');for(const id of ['B#s1-visual','B#s1-sound','B#e1','B#r1'])assert.equal(s.s.cards.get(id)?.status,'todo')
 assert.equal(s.s.runs.get('R-editor')?.status,'blocked');assert.equal(JSON.stringify(db.prepare('SELECT * FROM dsh_studio_operations').all()),ledger)
 assert.equal(s.s.cards.get('B#s1-storyboard')?.reviewNote,request.reason)
 assert.equal(s.all().filter(e=>e.t==='batch/studio_revalidation').length,1)
 const restored=new EventStore(s.root);await restored.load();assert.equal((await recoverStudioFailure(restored,request)).replay,true);restored.kernel.close()
 await assert.rejects(recoverStudioFailure(s,{...request,reason:'changed'}),/id-conflict/)
})
for(const mode of ['wrong-run','active','archived','settled','wrong-stage'])test(`revalidation refuses ${mode} atomically`,async t=>{
 const {s}=await setup(t);let r={...request}
 if(mode==='wrong-run')r.expectedRunId='stale'
 if(mode==='active'){s.kernel.unblockTask('B#e1');s.kernel.claimTask('B#e1')}
 if(mode==='archived')await s.append({t:'batch/archived',at:new Date().toISOString(),taskId:'T',batchId:'B',archived:true})
 if(mode==='settled')await s.append({t:'batch/settled',at:new Date().toISOString(),taskId:'T',batchId:'B',outcome:'done'})
 if(mode==='wrong-stage')r.revalidateFrom='other' as any
 const before=JSON.stringify(s.kernel.db.prepare('SELECT * FROM tasks').all()),n=s.all().length
 await assert.rejects(recoverStudioFailure(s,r));assert.equal(JSON.stringify(s.kernel.db.prepare('SELECT * FROM tasks').all()),before);assert.equal(s.all().length,n)
})
