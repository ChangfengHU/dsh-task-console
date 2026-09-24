import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore} from '../src/tasks.js'
import {StudioPreparation,preparationBarrier,assertPreparationWritable} from '../src/studio-preparation.js'
import {StudioWorkflow} from '../src/studio-workflow.js'
import {StudioOperations} from '../src/studio-operations.js'
const sha='a'.repeat(64),at=()=>new Date().toISOString()
async function setup(t:any,visualRunning=true){
 const root=await mkdtemp(join(tmpdir(),'preparation-test-')),s=new EventStore(root);await s.load();t.after(async()=>{s.kernel.close();await rm(root,{recursive:true,force:true})})
 const task:any={id:'T',title:'fixture',brief:'Chinese film',cwd:root,trigger:{kind:'once'},participants:[{agentId:'director'},{agentId:'editor'},{agentId:'quality'}],enabled:true,graphMode:'dynamic-rounds',timeoutSec:300,maxTries:3,onFail:'retry',createdAt:at(),design:{evidenceContract:'studio-video-v1',failurePolicy:{maxAttempts:3},studio:{characterId:'test',referenceSha256:sha,referenceUrl:'https://cdn.vyibc.com/ref.mp4'},studioStages:['storyboard','visual','sound'].map(id=>({id,agentId:id,brief:id}))}}
 await s.append({t:'task/created',at:at(),taskId:'T',task});await s.createBatch(task,{t:'batch/fired',at:at(),taskId:'T',batch:{id:'B',by:'manual',cards:[{id:'B#p1',agentId:'director',deps:[],kind:'agent',role:'planner',round:1}]}})
 const claim=async(id:string)=>{s.kernel.promoteReadyTasks();const c=s.s.cards.get(id)!;const run=await s.claimCard(id,id+'#1',id+'-session',1);assert.ok(run);return {task,batch:s.s.batches.get('B'),card:c,sessionId:id+'-session',profileId:c.agentId}}
 const complete=async(i:any)=>{const run=s.kernel.getTask(i.card.id)!.current_run_id!;await s.transition(()=>s.kernel.completeTask(i.card.id,{expectedRunId:run,summary:'fixture'}),()=>({t:'run/completed',at:at(),taskId:'T',runId:i.card.id+'#1',summary:'fixture'}))}
 const p=await claim('B#p1'),w=new StudioWorkflow(s);w.recordScript(p,{sha256:sha,lines:[{id:'1',text:'完整的原稿。'}]});await s.expandRound(task,s.s.batches.get('B')!,s.s.cards.get('B#p1')!,'fixture');await complete(p)
 const board=await claim('B#s1-storyboard');await complete(board)
 if(visualRunning)await claim('B#s1-visual')
 const input=await claim('B#s1-sound'),prep=new StudioPreparation(s),ops=new StudioOperations(s);ops.configure(input,{imageCalls:6,imageBatches:2,voiceSegments:40})
 const request=()=>prep.request(input,{reason:'Actual utterance exceeds observer range; revise before rendering',evidence:{path:'stages/r1/sound/plan.json',sha256:sha},scriptSha256:sha})
 return {root,s,task,input,prep,ops,w,request}
}
test('request atomically fences old claims and mutations; duplicate is idempotent without paid reservations',async t=>{
 const {s,input,prep,ops,request}=await setup(t,false)
 const [r,a]=await Promise.all([request(),request()]);assert.equal(r.id,a.id);assert.equal(a.replayed,true);assert.equal(prep.rows().length,1)
 assert.equal(await s.claimCard('B#s1-visual','new','new-session',1),undefined)
 assert.equal(await s.claimCard('B#p2','new-p','new-p-session',1),undefined)
 let calls=0
 await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',{segments:[{text:'changed'}]},async()=>{calls++;return {}},()=>assertPreparationWritable(s.kernel.db,input)),/revision-pending/)
 assert.equal(calls,0);assert.equal(ops.snapshot(input).used.voiceSegments,0)
 await assert.rejects(prep.release(r.id),/session-not-stopped/)
 assert.equal(s.kernel.getTask('B#p2')?.status,'todo')
})
test('original known and unknown submissions fence release; status can reconcile without a new charge',async t=>{
 const {s,input,prep,ops,request}=await setup(t)
 await ops.invoke(input,'vyibc-voice_synthesize',{segments:[{text:'原稿'}]},async()=>({job_id:'job',status:'queued'}))
 const r=await request();for(const sid of r.sessionsToStop)prep.markStopped(r.id,sid)
 await assert.rejects(prep.release(r.id),/operations-unsettled/)
 await ops.invoke(input,'vyibc-voice_status',{job_id:'job'},async()=>({job_id:'other',status:'done'}));assert.equal(prep.pending(r).length,1)
 await ops.invoke(input,'vyibc-voice_status',{job_id:'job'},async()=>({job_id:'job',status:'done'}));assert.equal(prep.pending(r).length,0)
 const budget=JSON.stringify(ops.snapshot(input));await prep.release(r.id);assert.equal(JSON.stringify(ops.snapshot(input)),budget)
 assert.equal(s.s.runs.get('B#s1-sound#1')?.status,'cancelled');assert.equal(s.s.cards.get('B#s1-storyboard')?.status,'done')
 assert.equal(s.s.cards.get('B#r1')?.supersededBy,r.id);assert.deepEqual(s.s.cards.get('B#p2')?.deps,['B#p1'])
 assert.ok(preparationBarrier(s.kernel.db,'B#s1-sound'));assert.equal(preparationBarrier(s.kernel.db,'B#p2'),undefined)
 assert.ok((await prep.release(r.id)).replayed)
})
test('released planner can revise exact rejected script and restart replays graph and budgets',async t=>{
 const {root,s,input,prep,w,request}=await setup(t)
 const r=await request();for(const sid of r.sessionsToStop)prep.markStopped(r.id,sid);await prep.release(r.id)
 const next={...input,card:s.s.cards.get('B#p2'),sessionId:'p2'}
 w.recordScript(next,{sha256:'b'.repeat(64),lines:[{id:'1',text:'重新设计的完整新稿。'}]})
 assert.throws(()=>w.recordScript(next,{sha256:'c'.repeat(64),lines:[{id:'1',text:'未经新授权又改稿。'}]}),/independent-review/)
 assert.throws(()=>w.recordStageReceipt(input,{}),/revision-pending/)
 const reload=new EventStore(root);await reload.load();t.after(()=>reload.kernel.close());const actual=new StudioPreparation(reload)
 assert.equal(actual.rows()[0].state,'released');assert.deepEqual(reload.s.cards.get('B#p2')?.deps,['B#p1']);assert.equal(reload.s.cards.get('B#s1-visual')?.status,'cancelled')
 reload.kernel.promoteReadyTasks();assert.ok(await reload.claimCard('B#p2','p2#1','p2',1))
})
test('unknown provider submission remains pending after restart and cannot release or dispatch again',async t=>{
 const {root,s,input,prep,ops,request}=await setup(t)
 await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',{segments:[{text:'原稿'}]},async()=>{throw Error('lost')}),/unknown/)
 const r=await request();for(const sid of r.sessionsToStop)prep.markStopped(r.id,sid)
 const reload=new EventStore(root);await reload.load();t.after(()=>reload.kernel.close());const next=new StudioPreparation(reload)
 await assert.rejects(next.release(r.id),/operations-unsettled/);assert.equal(next.pending(r)[0].state,'unknown');assert.equal(next.pending(r)[0].job_id,null)
 assert.equal(new StudioOperations(reload).snapshot(input).used.voiceSegments,1)
})
test('stale origin and exhausted cumulative rounds reject without graph or budget mutations',async t=>{
 const {s,input,prep,request}=await setup(t)
 const before=JSON.stringify(s.kernel.db.prepare('SELECT * FROM tasks').all())
 input.task.design.failurePolicy.maxAttempts=1;await assert.rejects(request(),/round-limit/);input.task.design.failurePolicy.maxAttempts=3
 await assert.rejects(prep.request({...input,sessionId:'wrong'},{reason:'reason',evidence:{path:'p',sha256:sha},scriptSha256:sha}),/stale-run/)
 assert.equal(prep.rows().length,0);assert.equal(JSON.stringify(s.kernel.db.prepare('SELECT * FROM tasks').all()),before)
})

import {TaskRunner} from '../src/runner.js'
import {writeFile} from 'node:fs/promises'
function attachFlights(runner:any,s:any,fail:()=>boolean){
 let disposed=0
 for(const run of s.s.runs.values())if(run.status==='running')runner.flights.set(run.sessionId,{runId:run.id,sessionId:run.sessionId,cardId:run.cardId,taskId:run.taskId,profileId:run.profileId,sessionCreationAttempted:true,coreRunId:s.coreRunId(run.id),handle:{dispose:async()=>{if(fail())throw Error('dispose failed');disposed++}}})
 return ()=>disposed
}
test('runner waits for confirmed disposal and excludes only explicitly superseded nodes from settlement',async t=>{
 const {s,prep,request}=await setup(t);const runner:any=new TaskRunner({} as any,s);t.after(()=>runner.stop())
 let fail=true;const disposed=attachFlights(runner,s,()=>fail),r=await request()
 await runner.reconcilePreparations();assert.equal(prep.rows()[0].state,'draining');assert.equal(disposed(),0)
 await runner.settleBatches();assert.equal(s.s.batches.get('B')?.settled,undefined)
 fail=false;await runner.reconcilePreparations();assert.equal(prep.rows()[0].state,'released');assert.equal(disposed(),2)
 await runner.settleBatches();assert.equal(s.s.batches.get('B')?.settled,undefined);assert.equal(s.s.cards.get('B#p2')?.status,'todo')
 // Ordinary real failures still terminate; the exclusion is not a blanket waiver.
 await s.transition(()=>s.kernel.giveUpTask('B#p2','ordinary failure'),()=>({t:'card/gave_up',at:at(),taskId:'T',cardId:'B#p2',error:'ordinary failure'}))
 await runner.settleBatches();assert.equal(s.s.batches.get('B')?.settled?.outcome,'failed')
 assert.equal(prep.rows()[0].id,r.id)
})
test('revision during agents.create stops the late handle without sending a prompt',async t=>{
 const {root,s,task,prep,request}=await setup(t,false)
 await writeFile(join(root,'task-console.json'),JSON.stringify({id:'visual',name:'visual',tools:[],mcpTools:{},skills:[]}))
 let entered!:()=>void,resolveHandle!:(h:any)=>void;const creating=new Promise<void>(r=>entered=r),created=new Promise<any>(r=>resolveHandle=r)
 let prompts=0,disposed=0
 const host:any={get:(name:string)=>name==='agentPresets'?{resolve:async()=>({id:'visual',path:join(root,'agent.yaml')}),mount:async()=>{}}:undefined,agents:{create:async()=>{entered();return created}}}
 const runner:any=new TaskRunner(host,s);t.after(()=>runner.stop());s.kernel.promoteReadyTasks()
 const starting=runner.startRun(task,s.s.batches.get('B'),s.s.cards.get('B#s1-visual'))
 await creating;const r=await request()
 resolveHandle({agent:{session:{id:'late'},followup:()=>prompts++},dispose:async()=>{disposed++}});await starting
 assert.equal(prompts,0);assert.equal(disposed,1)
 assert.ok(prep.rows()[0].stoppedSessions.some((sid:string)=>sid.includes('task-')))
 assert.equal(prep.rows()[0].state,'draining');assert.equal(s.s.cards.get('B#p2')?.status,'todo')
})

test('normal disposal started before rejection still records stop for a concurrent sibling request',async t=>{
 const {s,prep,request}=await setup(t);const runner:any=new TaskRunner({} as any,s);t.after(()=>runner.stop())
 let entered!:()=>void,resume!:()=>void;const entering=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>resume=r)
 const run=s.s.runs.get('B#s1-visual#1')!
 const f:any={taskId:'T',cardId:run.cardId,sessionId:run.sessionId,sessionCreationAttempted:true,handle:{dispose:async()=>{entered();await waiting}}}
 const stopping=runner.disposePreparationHandle(f);await entering;const r=await request();resume();await stopping
 assert.ok(prep.rows()[0].stoppedSessions.includes(run.sessionId))
 prep.markStopped(r.id,'B#s1-sound-session');await prep.release(r.id)
 assert.equal(prep.rows()[0].state,'released')
})
test('confirmed normal stop before request is seeded even while core run has not committed terminal',async t=>{
 const {s,prep,request}=await setup(t);const runner:any=new TaskRunner({} as any,s);t.after(()=>runner.stop())
 const run=s.s.runs.get('B#s1-visual#1')!
 await runner.disposePreparationHandle({taskId:'T',cardId:run.cardId,sessionId:run.sessionId,sessionCreationAttempted:true,handle:{dispose:async()=>{}}})
 const r=await request();assert.ok(r.stoppedSessions.includes(run.sessionId))
 prep.markStopped(r.id,'B#s1-sound-session');await prep.release(r.id);assert.equal(prep.rows()[0].state,'released')
})
test('revision during beforeStart confirms no session was ever created and does not wait forever',async t=>{
 const {root,s,task,prep,request}=await setup(t,false)
 await writeFile(join(root,'task-console.json'),JSON.stringify({id:'visual',name:'visual',tools:[],mcpTools:{},skills:[]}))
 let entered!:()=>void,resume!:()=>void;const entering=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>resume=r);let creates=0
 const host:any={get:(name:string)=>name==='agentPresets'?{resolve:async()=>({id:'visual',path:join(root,'agent.yaml')})}:undefined,agents:{create:async()=>{creates++;throw Error('must not create')}}}
 const runner:any=new TaskRunner(host,s,{beforeStart:async()=>{entered();await waiting}});t.after(()=>runner.stop());s.kernel.promoteReadyTasks()
 const starting=runner.startRun(task,s.s.batches.get('B'),s.s.cards.get('B#s1-visual'));await entering;const r=await request();resume();await starting
 assert.equal(creates,0);const actual=prep.rows()[0];assert.ok(actual.stoppedSessions.some((sid:string)=>sid.startsWith('task-')))
 prep.markStopped(r.id,'B#s1-sound-session');await prep.release(r.id);assert.equal(prep.rows()[0].state,'released')
})
