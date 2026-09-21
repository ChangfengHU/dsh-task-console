import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore} from '../src/tasks.ts'
import {StudioOperations} from '../src/studio-operations.ts'
import {recoverStudioFailure} from '../src/studio-recovery.ts'
const input={taskId:'T',batchId:'B',cardId:'e',expectedRunId:'R',recoveryId:'repair-1',reason:'platform stack overflow repaired'}
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'studio-recover-'));const s=new EventStore(root);await s.load();t.after(async()=>{s.kernel.close();await rm(root,{recursive:true,force:true})})
 const task:any={id:'T',title:'test',brief:'frozen',cwd:root,trigger:{kind:'once'},participants:[{agentId:'a'}],enabled:true,timeoutSec:60,maxTries:2,onFail:'retry',createdAt:new Date().toISOString(),design:{evidenceContract:'studio-video-v1'}}
 const at=new Date().toISOString();await s.append({t:'task/created',at,taskId:'T',task})
 await s.createBatch(task,{t:'batch/fired',at,taskId:'T',batch:{id:'B',by:'manual',cards:[{id:'e',agentId:'a',deps:[]},{id:'r',agentId:'a',deps:['e']},{id:'p',agentId:'a',deps:['r']}]}} as any)
 const claim=s.kernel.claimTask('e')!;await s.append({t:'run/claimed',at,taskId:'T',cardId:'e',runId:'R',sessionId:'old',attempt:1})
 s.kernel.failRun('e',{expectedRunId:claim.run.id,outcome:'failed',error:'Maximum call stack size exceeded'});await s.append({t:'run/failed',at,taskId:'T',runId:'R',error:'Maximum call stack size exceeded'})
 s.kernel.giveUpTask('e','platform failure');await s.append({t:'card/gave_up',at,taskId:'T',cardId:'e',error:'platform failure'})
 for(const id of ['r','p']){s.kernel.cancelTask(id,'上游失败，任务不可达');await s.append({t:'card/cancelled',at,taskId:'T',cardId:id})}
 await s.append({t:'batch/settled',at,taskId:'T',batchId:'B',outcome:'failed'})
 new StudioOperations(s).configure({task,batch:{id:'B'}},{imageCalls:6,voiceSegments:80})
 s.kernel.db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run('T','B','image','generate_image','imageCalls',6,'completed','job','{}')
 return s
}
test('same batch recovery is atomic, preserves paid ledger/history and is idempotent after reload',async t=>{
 const s=await fixture(t);const ledger=JSON.stringify(s.kernel.db.prepare('SELECT * FROM dsh_studio_operations').all());const old=s.all().length
 const results=await Promise.all([recoverStudioFailure(s,input),recoverStudioFailure(s,input)])
 assert.equal(results[0].replay,false);assert.equal(results[1].replay,true);assert.equal(s.all().length,old+1)
 assert.equal(s.s.cards.get('e')?.status,'ready');assert.equal(s.s.cards.get('r')?.status,'todo');assert.equal(s.s.cards.get('p')?.status,'todo');assert.equal(s.s.batches.get('B')?.settled,undefined)
 assert.deepEqual(s.s.cards.get('e')?.runIds,['R']);assert.equal(s.s.runs.get('R')?.status,'failed');assert.equal(JSON.stringify(s.kernel.db.prepare('SELECT * FROM dsh_studio_operations').all()),ledger)
 const claim=s.kernel.claimTask('e');assert.ok(claim);assert.equal(s.kernel.listRuns('e').length,2)
 const reloaded=new EventStore(s.root);await reloaded.load();assert.equal((await recoverStudioFailure(reloaded,input)).replay,true);reloaded.kernel.close()
 await assert.rejects(recoverStudioFailure(s,{...input,reason:'different'}),/id-conflict/)
})
for(const mode of ['unknown','submitted','manual-cancel','archived','wrong-run','wrong-batch','success','active','other-failure'])test(`recovery rejects ${mode} without partial mutation`,async t=>{
 const s=await fixture(t);let request={...input}
 if(mode==='unknown'||mode==='submitted')s.kernel.db.prepare('UPDATE dsh_studio_operations SET state=?').run(mode)
 if(mode==='manual-cancel')s.kernel.recordEvent('p','cancelled',{reason:'人工取消'})
 if(mode==='archived')await s.append({t:'batch/archived',at:new Date().toISOString(),taskId:'T',batchId:'B',archived:true})
 if(mode==='wrong-run')request.expectedRunId='stale'
 if(mode==='wrong-batch')request.batchId='different'
 if(mode==='success')await s.append({t:'batch/settled',at:new Date().toISOString(),taskId:'T',batchId:'B',outcome:'done'})
 if(mode==='active'){s.kernel.unblockTask('e');s.kernel.claimTask('e')}
 if(mode==='other-failure')await s.append({t:'card/gave_up',at:new Date().toISOString(),taskId:'T',cardId:'p',error:'other'})
 const before=JSON.stringify(s.kernel.db.prepare('SELECT * FROM tasks').all()),count=s.all().length
 await assert.rejects(recoverStudioFailure(s,request));assert.equal(JSON.stringify(s.kernel.db.prepare('SELECT * FROM tasks').all()),before);assert.equal(s.all().length,count)
})
