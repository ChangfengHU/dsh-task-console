import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioOperations,readStudioOperationStatus} from '../src/studio-operations.ts'
import {studioProgressPending} from '../src/studio-progress.ts'
const input=(stage?:string)=>({task:{id:'t',design:{studioStages:['visual','sound','storyboard'].map(id=>({id,agentId:id}))}},batch:{id:'b'},...(stage?{card:{id:`b#s1-${stage}`,role:'studio-stage',round:1,agentId:stage}}:{card:{id:'exec',role:'executor',round:1}})})
function fixture(t:any){
 const db=new Database(':memory:');t.after(()=>db.close());new StudioOperations({kernel:{db}}).configure(input(),{imageCalls:6,imageBatches:2,voiceSegments:40})
 const add=(id:string,kind:any,state='submitted',tool=kind==='voiceSegments'?'vyibc-voice_synthesize':'vyibc-image_generate_image')=>db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run('t','b',id,tool,kind,1,state,id,'{}')
 return {db,add}
}
test('parallel image jobs do not block sound retry; own voice remains authoritative and budget is untouched',t=>{
 const {db,add}=fixture(t);add('image1','imageCalls');add('image2','imageCalls','unknown')
 const before=db.prepare('SELECT * FROM dsh_studio_operations').all(),limits=db.prepare('SELECT * FROM dsh_studio_limits').all(),changes=db.prepare('SELECT total_changes() n').get()
 assert.equal(studioProgressPending(db,input('sound')),undefined)
 assert.match(studioProgressPending(db,input('visual'))!,/image1/)
 assert.match(studioProgressPending(db,input())!,/image2/)
 assert.match(studioProgressPending(db,{task:input().task,batch:input().batch})!,/image2/)
 assert.deepEqual(db.prepare('SELECT * FROM dsh_studio_operations').all(),before);assert.deepEqual(db.prepare('SELECT * FROM dsh_studio_limits').all(),limits);assert.deepEqual(db.prepare('SELECT total_changes() n').get(),changes)
 for(const state of ['submitted','unknown','dispatching']){
  add('voice-'+state,'voiceSegments',state);assert.match(studioProgressPending(db,input('sound'))!,new RegExp('voice-'+state))
 }
})
test('filter uses persisted kind, not tool name; unknown ownership blocks conservatively',t=>{
 const {db,add}=fixture(t);add('voice-owned','voiceSegments','unknown','vyibc-image_generate_image')
 assert.equal(readStudioOperationStatus(db,input()).operations[0].kind,'voiceSegments')
 assert.match(studioProgressPending(db,input('sound'))!,/voice-owned/);assert.equal(studioProgressPending(db,input('visual')),undefined)
 add('untyped',null);assert.match(studioProgressPending(db,input('visual'))!,/untyped/)
 add('hidden','voiceSegments','dispatching','unrecognized-private-tool')
 const pending=studioProgressPending(db,input('sound'))!;assert.ok(!pending.includes('unrecognized-private-tool'));assert.ok(JSON.parse(pending).media.some((r:any)=>r.kind==='voiceSegments'&&r.state==='unknown'))
})
test('terminal media does not block; pending renders remain conservatively batch-wide',t=>{
 const {db,add}=fixture(t);add('voice','voiceSegments','completed');add('image','imageCalls','failed');assert.equal(studioProgressPending(db,input('sound')),undefined)
 db.exec('CREATE TABLE dsh_studio_render_jobs(task_id TEXT,batch_id TEXT,payload TEXT)')
 db.prepare('INSERT INTO dsh_studio_render_jobs VALUES(?,?,?)').run('t','b',JSON.stringify({state:'unknown',cardId:'old-executor',round:0,jobId:'original-render'}))
 assert.match(studioProgressPending(db,input('sound'))!,/original-render/)
 db.prepare('UPDATE dsh_studio_render_jobs SET payload=?').run(JSON.stringify({state:'completed'}));assert.equal(studioProgressPending(db,input('sound')),undefined)
})
test('legacy ledger without kind never guesses ownership from image tool spelling',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE dsh_studio_operations(task_id TEXT,batch_id TEXT,intent TEXT,tool TEXT,state TEXT,job_id TEXT)')
 db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?)').run('t','b','legacy','vyibc-image_generate_image','unknown','legacy-image')
 assert.match(studioProgressPending(db,input('sound'))!,/legacy-image/)
})
