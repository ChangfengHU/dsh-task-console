import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioOperations,readStudioOperationStatus,readStudioGenerationAllowance} from '../src/studio-operations.ts'
import {StudioWorkflow} from '../src/studio-workflow.ts'
import {registerStudioTools} from '../src/studio-tools.ts'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

function setup(t:any){
 const db=new Database(':memory:');t.after(()=>db.close())
 const operations=new StudioOperations({kernel:{db}})
 const input={task:{id:'task'},batch:{id:'batch'}}
 operations.configure(input,{imageCalls:6,imageBatches:6,voiceSegments:30})
 const insert=(intent:string,tool:string,state:string,jobId:string|null,taskId='task',batchId='batch')=>db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run(taskId,batchId,intent,tool,tool.includes('image')?'imageCalls':'voiceSegments',1,state,jobId,JSON.stringify({authorization:'Bearer PRIVATE',audio_url:'https://example.invalid/private?token=PRIVATE',status:'queued'}))
 return {db,input,insert,operations}
}

test('status discovers only this task/batch jobs and gives exact existing read calls without ledger mutation',t=>{
 const s=setup(t)
 s.insert('voice','vyibc-voice_synthesize','submitted','voice-job')
 s.insert('image','vyibc-image_generate_image','completed','image-job')
 s.insert('other-task','vyibc-voice_synthesize','submitted','other-task-job','other-task')
 s.insert('other-batch','vyibc-voice_synthesize','submitted','other-batch-job','task','other-batch')
 const before=s.db.prepare('SELECT * FROM dsh_studio_operations ORDER BY task_id,batch_id,intent').all()
 const changes=s.db.prepare('SELECT total_changes() n').get().n
 const status=readStudioOperationStatus(s.db,s.input)
 assert.equal(status.providerPolled,false);assert.equal(status.qualityApproved,false);assert.match(status.stateFreshness,/may be stale/)
 assert.equal(status.operations.length,2)
 assert.deepEqual(status.operations.find((v:any)=>v.jobId==='voice-job').nextCalls,[
  {tool:'vyibc-voice_status',arguments:{job_id:'voice-job'}},
  {tool:'vyibc-voice_result',arguments:{job_id:'voice-job'}},
 ])
 assert.deepEqual(status.operations.find((v:any)=>v.jobId==='image-job').nextCalls,[{tool:'vyibc-image_get_task',arguments:{taskId:'image-job'}}])
 assert.match(status.operations.find((v:any)=>v.jobId==='voice-job').action,/preserve every frozen dialogue line/)
 assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes)
 assert.deepEqual(s.db.prepare('SELECT * FROM dsh_studio_operations ORDER BY task_id,batch_id,intent').all(),before)
 const output=JSON.stringify(status);for(const forbidden of ['PRIVATE','authorization','audio_url','other-task-job','other-batch-job'])assert.ok(!output.includes(forbidden))
})

test('unknown submission without an ID never invents a status call or proposes new generation',t=>{
 const s=setup(t);s.insert('unknown','vyibc-voice_synthesize','unknown',null)
 const row=readStudioOperationStatus(s.db,s.input).operations[0]
 assert.equal(row.jobId,null);assert.equal(row.state,'unknown');assert.deepEqual(row.nextCalls,[])
 assert.match(row.action,/do not invent an ID or submit again/)
})

test('completed and failed jobs retain inspect-only calls, never replay a historical receipt',t=>{
 const s=setup(t);s.insert('completed','vyibc-voice_retry_segments','completed','done-job');s.insert('failed','vyibc-voice_synthesize','failed','failed-job')
 const status=readStudioOperationStatus(s.db,s.input)
 assert.deepEqual(status.operations.map((v:any)=>v.state),['completed','failed'])
 for(const row of status.operations)for(const call of row.nextCalls)assert.match(call.tool,/vyibc-voice_(status|result)$/)
 assert.ok(!JSON.stringify(status).includes('"status":"queued"'))
})

test('legacy status read creates no missing operation table or budget',t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 assert.deepEqual(readStudioOperationStatus(db,{task:{id:'task'},batch:{id:'batch'}}).operations,[])
 assert.equal(db.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n,0)
})

test('unsafe job values and unrecognized tool records cannot become executable advice',t=>{
 const s=setup(t);s.insert('bad-job','vyibc-voice_synthesize','submitted','https://bad.invalid/?token=PRIVATE');s.insert('bad-tool','unknown-secret-PRIVATE','submitted','private-job')
 const status=readStudioOperationStatus(s.db,s.input)
 assert.equal(status.operations.length,1);assert.equal(status.operations[0].jobId,null);assert.deepEqual(status.operations[0].nextCalls,[])
 assert.ok(!JSON.stringify(status).includes('PRIVATE'))
})

test('actual studio_status returns current batch voice handoff even before capabilities pass',async t=>{
 const s=setup(t),cwd=await mkdtemp(join(tmpdir(),'studio-job-status-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 s.insert('voice','vyibc-voice_synthesize','submitted','current-voice-job')
 const workflow=new StudioWorkflow({kernel:{db:s.db}})
 const input={...s.input,task:{...s.input.task,cwd,design:{evidenceContract:'studio-video-v1',studio:{characterId:'character',referenceSha256:'b'.repeat(64),referenceUrl:'https://cdn.vyibc.com/approved.mp4'}}},card:{role:'studio-stage'},sessionId:'sound-session'}
 const tools:any={},ctx={tools:{register:(tool:any)=>{tools[tool.name]=tool;return()=>{}}}}
 await registerStudioTools(ctx,{input,workflow,isActive:()=>true})
 const before=s.db.prepare('SELECT * FROM dsh_studio_operations').all()
 const response=await tools.studio_status.execute({})
 assert.equal(response.preflight.ok,false)
 const jobs=response.state.mediaOperations
 assert.equal(jobs.operations[0].jobId,'current-voice-job');assert.equal(jobs.providerPolled,false)
 assert.equal(jobs.operations[0].nextCalls[1].tool,'vyibc-voice_result')
 assert.deepEqual(s.db.prepare('SELECT * FROM dsh_studio_operations').all(),before)
})


test('current allowance counts failed/reserved batches and denies new images despite spare items',t=>{
 const s=setup(t)
 s.db.prepare('UPDATE dsh_studio_limits SET limits=? WHERE task_id=? AND batch_id=?').run(JSON.stringify({imageCalls:6,imageBatches:2,voiceSegments:30}),'task','batch')
 s.insert('a','vyibc-image_generate_image','failed','a')
 s.insert('b','vyibc-image_generate_image','completed','b')
 s.insert('v','vyibc-voice_synthesize','completed','v')
 s.insert('foreign','vyibc-image_generate_image','submitted','foreign','task','other')
 const changes=s.db.prepare('SELECT total_changes() n').get().n
 const a=readStudioGenerationAllowance(s.db,s.input)
 assert.equal(a.available,true);assert.deepEqual(a.imageItems,{limit:6,used:2,remaining:4});assert.deepEqual(a.imageSubmissions,{limit:2,used:2,remaining:0})
 assert.equal(a.canSubmitImages,false);assert.equal(a.canSubmitVoice,true);assert.match(a.imageAction!,/No new image generation/)
 assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes)
 s.db.prepare("UPDATE dsh_studio_operations SET state='unknown' WHERE intent='v'").run()
 assert.equal(readStudioGenerationAllowance(s.db,s.input).canSubmitVoice,false)
})

test('allowance handles batches with multiple image items and absent legacy limits truthfully',t=>{
 const s=setup(t);s.insert('a','vyibc-image_generate_image','submitted','a')
 s.db.prepare("UPDATE dsh_studio_operations SET units=4 WHERE intent='a'").run()
 let a=readStudioGenerationAllowance(s.db,s.input)
 assert.equal(a.imageItems!.remaining,2);assert.equal(a.imageSubmissions!.used,1);assert.equal(a.canSubmitImages,true);assert.match(a.imageAction!,/prompts/)
 s.db.prepare('UPDATE dsh_studio_limits SET limits=?').run(JSON.stringify({imageCalls:6,voiceSegments:30}))
 a=readStudioGenerationAllowance(s.db,s.input);assert.equal(a.imageSubmissions,null);assert.equal(a.canSubmitImages,false);assert.equal(a.canSubmitVoice,true)
 s.db.prepare('UPDATE dsh_studio_limits SET limits=?').run('invalid')
 assert.equal(readStudioGenerationAllowance(s.db,s.input).available,false)
})

test('fresh status does not invent limits or create tables and overrides stale stage budget through top-level allowance',async t=>{
 const empty=new Database(':memory:');t.after(()=>empty.close())
 assert.equal(readStudioGenerationAllowance(empty,{task:{id:'none'},batch:{id:'none'}}).available,false)
 assert.equal(empty.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n,0)
 const s=setup(t),cwd=await mkdtemp(join(tmpdir(),'studio-budget-status-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 s.insert('a','vyibc-image_generate_image','failed','a');s.insert('b','vyibc-image_generate_image','completed','b')
 s.db.prepare('UPDATE dsh_studio_limits SET limits=?').run(JSON.stringify({imageCalls:6,imageBatches:2,voiceSegments:30}))
 const workflow=new StudioWorkflow({kernel:{db:s.db}})
 const input={...s.input,task:{...s.input.task,cwd,design:{evidenceContract:'studio-video-v1',studio:{characterId:'character',referenceSha256:'b'.repeat(64),referenceUrl:'https://cdn.vyibc.com/approved.mp4'}}},card:{role:'planner'},sessionId:'planner-session'}
 workflow.recordBudget(input,{used:{imageCalls:0,imageBatches:0,voiceSegments:0},limits:{imageCalls:6,imageBatches:2,voiceSegments:30},exceeded:false})
 const tools:any={};await registerStudioTools({tools:{register:(tool:any)=>{tools[tool.name]=tool;return()=>{}}}},{input,workflow,isActive:()=>true})
 const response=await tools.studio_status.execute({})
 assert.equal(response.generationAllowance.canSubmitImages,false);assert.equal(response.generationAllowance.imageItems.remaining,4)
 assert.equal(response.state.generationAllowance,undefined);assert.equal(response.statusProjection.aliases['state.generationAllowance'],'generationAllowance')
 assert.equal(response.state.budget.used.imageCalls,0)
})
