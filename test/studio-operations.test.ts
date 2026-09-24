import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import Database from 'better-sqlite3'
import {StudioOperations} from '../src/studio-operations.js'
function setup(t:any,limits={imageCalls:6,voiceSegments:30}){const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}});const input={task:{id:'task'},batch:{id:'batch'},card:{role:'executor'}};ops.configure(input,limits);return {db,ops,input}}
const receipt=(v:any)=>({content:[{type:'text',text:JSON.stringify(v)}]})
const args={segments:[{text:'你好',voice_type:'voice'}]}
test('canonical requests replay without second dispatch',async t=>{const {ops,input}=setup(t);let calls=0;const call=async()=>{calls++;return receipt({ok:true,job_id:'j1',status:'queued'})};const a=await ops.invoke(input,'vyibc-voice_synthesize',args,call);const b=await ops.invoke(input,'vyibc-voice_synthesize',{segments:[{voice_type:'voice',text:'你好'}]},call);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(ops.snapshot(input).used.voiceSegments,1)})
test('concurrent duplicate cannot dispatch twice',async t=>{const {ops,input}=setup(t);let resolve:any,calls=0;const p=ops.invoke(input,'vyibc-voice_synthesize',args,async()=>{calls++;return new Promise(r=>resolve=r)});await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',args,async()=>{calls++;return {}}),/submission-unknown/);resolve(receipt({job_id:'j1'}));await p;assert.equal(calls,1)})
test('timeout retains budget and blocks same or different paid requests',async t=>{const {ops,input}=setup(t);let calls=0;await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',args,async()=>{calls++;throw Error('timeout')}),/submission-unknown/);await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',args,async()=>{calls++;return {}}),/submission-unknown/);await assert.rejects(ops.invoke(input,'vyibc-image_generate_image',{prompt:'new'},async()=>{calls++;return {}}),/prior-submission-unknown/);assert.equal(calls,1);assert.equal(ops.snapshot(input).unknown,true);assert.equal(ops.snapshot(input).used.voiceSegments,1)})
test('unrecognized success receipt remains unknown',async t=>{const {ops,input}=setup(t);await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',args,async()=>receipt({ok:true})),/submission-unknown/);assert.equal(ops.snapshot(input).operations[0].state,'unknown')})
test('explicit rejection replayed without refund or retry',async t=>{const {ops,input}=setup(t);let n=0;const f=async()=>{n++;return receipt({ok:false,error:'denied'})};await ops.invoke(input,'vyibc-voice_synthesize',args,f);await ops.invoke(input,'vyibc-voice_synthesize',args,f);assert.equal(n,1);assert.equal(ops.snapshot(input).operations[0].state,'failed');assert.equal(ops.snapshot(input).used.voiceSegments,1)})
test('reviewer generation cancellation forbidden; uncertain retry forbidden',async t=>{const {ops,input}=setup(t);let n=0;const f=async()=>{n++;return {}};for(const raw of ['vyibc-voice_synthesize','vyibc-image_generate_image','vyibc-voice_cancel'])await assert.rejects(ops.invoke({...input,card:{role:'reviewer'}},raw,args,f),/executor-only/);await assert.rejects(ops.invoke(input,'vyibc-voice_retry_segments',{...args,retry_uncertain:true},f),/uncertain-retry/);assert.equal(n,0)})
test('batch prompts and segments charge all units before dispatch',async t=>{const {ops,input}=setup(t,{imageCalls:2,voiceSegments:1});let n=0;const f=async()=>{n++;return {}};await assert.rejects(ops.invoke(input,'vyibc-image_generate_image',{prompts:['a','b','c']},f),/budget-exhausted/);await assert.rejects(ops.invoke(input,'vyibc-voice_synthesize',{segments:[{},{}]},f),/budget-exhausted/);assert.equal(n,0);assert.equal(ops.snapshot(input).used.imageCalls,0)})
test('oversized batch reports remaining allowance and permits a smaller request without double reservation',async t=>{
 const {db,ops,input}=setup(t);let dispatched=0
 const send=async()=>receipt({task_id:`image-${++dispatched}`,status:'completed'})
 await ops.invoke(input,'vyibc-image_generate_image',{prompts:['a','b','c','d']},send)
 const before=ops.snapshot(input)
 await assert.rejects(ops.invoke(input,'vyibc-image_generate_image',{prompts:['e','f','g']},send),(error:any)=>{
  const details=JSON.parse(error.message.slice(error.message.indexOf(': ')+2))
  assert.equal(details.error_code,'studio-generation-request-exceeds-remaining')
  assert.equal(details.requestedUnits,3);assert.equal(details.remainingUnits,2)
  assert.equal(details.dispatched,false);assert.equal(details.reservedUnits,0)
  assert.equal(details.retryable,false);assert.equal(details.retryAfterRepair,true)
  return true
 })
 assert.deepEqual(ops.snapshot(input),before);assert.equal(dispatched,1)
 const restarted=new StudioOperations({kernel:{db}})
 await restarted.invoke(input,'vyibc-image_generate_image',{prompts:['e','f']},send)
 assert.equal(dispatched,2);assert.equal(restarted.snapshot(input).used.imageCalls,6)
 await assert.rejects(restarted.invoke(input,'vyibc-image_generate_image',{prompt:'g'},send),(error:any)=>{
  const details=JSON.parse(error.message.slice(error.message.indexOf(': ')+2))
  assert.equal(details.error_code,'studio-generation-budget-exhausted')
  assert.equal(details.remainingUnits,0);assert.equal(details.retryAfterRepair,false)
  return true
 })
 assert.equal(dispatched,2);assert.equal(restarted.snapshot(input).used.imageCalls,6)
})
test('limits immutable and property order independent',t=>{const {ops,input}=setup(t);ops.configure(input,{voiceSegments:30,imageCalls:6});assert.throws(()=>ops.configure(input,{voiceSegments:31,imageCalls:6}),/cannot-change/);assert.throws(()=>ops.configure(input,{imageCalls:-1,voiceSegments:30}),/budget-required/)})
test('recognized poll advances receipt status without consuming units',async t=>{const {ops,input}=setup(t);await ops.invoke(input,'vyibc-voice_synthesize',args,async()=>receipt({job_id:'j1',status:'queued'}));await ops.invoke(input,'vyibc-voice_status',{job_id:'j1'},async()=>({structuredContent:{job_id:'j1',status:'done'}}));assert.equal(ops.snapshot(input).operations[0].state,'completed');assert.equal(ops.snapshot(input).used.voiceSegments,1)})
test('wrong job, failed poll, unrelated tool cannot mark completion',async t=>{const {ops,input}=setup(t);await ops.invoke(input,'vyibc-voice_synthesize',args,async()=>receipt({job_id:'j1'}));await ops.invoke(input,'vyibc-voice_status',{job_id:'j1'},async()=>receipt({job_id:'j2',status:'done'}));await ops.invoke(input,'vyibc-voice_status',{job_id:'j1'},async()=>({isError:true,structuredContent:{status:'done'}}));await ops.invoke(input,'other_tool',{job_id:'j1'},async()=>receipt({status:'done'}));assert.equal(ops.snapshot(input).operations[0].state,'submitted')})
test('immediate completion recognized and batch state isolated',async t=>{const {ops,input}=setup(t);await ops.invoke(input,'vyibc-image_generate_image',{prompt:'a'},async()=>receipt({task:{id:'i1',status:'completed'}}));assert.equal(ops.snapshot(input).operations[0].state,'completed');const other={...input,batch:{id:'other'}};ops.configure(other,{imageCalls:6,voiceSegments:30});assert.equal(ops.snapshot(other).used.imageCalls,0)})
test('read publication list permitted but writes forbidden',async t=>{const {ops,input}=setup(t);let n=0;const f=async()=>{n++;return {}};await ops.invoke(input,'vyibc-douyin_list_published_videos',{},f);await assert.rejects(ops.invoke(input,'vyibc-douyin_publish_video',{},f),/publication-not-authorized/);assert.equal(n,1)})

test('DSH text ToolResult wrapper is parsed and restart retains idempotency',async t=>{const {db,ops,input}=setup(t);let n=0;const f=async()=>{n++;return {type:'text',text:JSON.stringify(receipt({job_id:'j1',status:'queued'}))}};await ops.invoke(input,'vyibc-voice_synthesize',args,f);const restarted=new StudioOperations({kernel:{db}});await restarted.invoke(input,'vyibc-voice_synthesize',args,f);assert.equal(n,1);assert.equal(restarted.snapshot(input).operations[0].job_id,'j1')})

test('specialist generation stays within its media role and shared budget',async t=>{
 const {ops,input}=setup(t,{imageCalls:1,voiceSegments:1});let n=0
 const stage=(id:string)=>({...input,task:{...input.task,design:{studioStages:[{id,agentId:id}]}},card:{role:'studio-stage',id:`batch#s1-${id}`,round:1,agentId:id}})
 const f=async()=>{n++;return receipt({job_id:'stage-job',status:'completed'})}
 await assert.rejects(ops.invoke(stage('sound'),'vyibc-image_generate_image',{prompt:'x'},f),/executor-only/)
 await assert.rejects(ops.invoke(stage('storyboard'),'vyibc-voice_synthesize',args,f),/executor-only/)
 await ops.invoke(stage('visual'),'vyibc-image_generate_image',{prompt:'x'},f)
 await ops.invoke(stage('sound'),'vyibc-voice_synthesize',args,f)
 await assert.rejects(ops.invoke(stage('visual'),'vyibc-image_generate_image',{prompt:'y'},f),/budget-exhausted/)
 assert.equal(n,2);assert.deepEqual(ops.snapshot(input).used,{imageCalls:1,voiceSegments:1})
})

test('public image reference preserves historical operation key and budget after restart',async t=>{
 const {db,input}=setup(t,{imageCalls:2,voiceSegments:0})
 // Current image MCP accepts a public referenceImageUrl, not a local file path.
 // Seed the deployed nine-column ledger rather than re-deriving it via invoke.
 const raw='vyibc-image_generate_image'
 const request={engine:'chatgpt',prompt:'same character smiling',referenceImageUrl:'https://cdn.example.test/characters/sha256-ref-v1.png'}
 const intent=createHash('sha256').update(JSON.stringify({raw,args:request})).digest('hex')
 const original=receipt({task_id:'historical-image-job',status:'completed'})
 db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run(input.task.id,input.batch.id,intent,raw,'imageCalls',1,'completed','historical-image-job',JSON.stringify(original))
 const restarted=new StudioOperations({kernel:{db}});let calls=0
 const replay=await restarted.invoke(input,raw,{referenceImageUrl:request.referenceImageUrl,prompt:request.prompt,engine:request.engine},async()=>{calls++;return receipt({task_id:'unexpected'})})
 assert.deepEqual(replay,original);assert.equal(calls,0)
 assert.equal(restarted.snapshot(input).used.imageCalls,1)
 assert.equal(restarted.snapshot(input).operations[0].intent,intent)
 // A deliberately changed immutable asset URL denotes new input and consumes
 // a new allowance. We do not fetch arbitrary URLs to guess their content.
 await restarted.invoke(input,raw,{...request,referenceImageUrl:'https://cdn.example.test/characters/sha256-ref-v2.png'},async()=>{calls++;return receipt({task_id:'new-reference-job',status:'completed'})})
 assert.equal(calls,1);assert.equal(restarted.snapshot(input).used.imageCalls,2)
 assert.equal(restarted.snapshot(input).operations.length,2)
})

test('unknown image submission cannot be bypassed by changing its public reference URL',async t=>{
 const {db,ops,input}=setup(t);let calls=0
 const request={prompt:'smiling',referenceImageUrl:'https://cdn.example.test/character-v1.png'}
 await assert.rejects(ops.invoke(input,'vyibc-image_generate_image',request,async()=>{calls++;throw Error('response lost')}),/submission-unknown/)
 const restarted=new StudioOperations({kernel:{db}})
 await assert.rejects(restarted.invoke(input,'vyibc-image_generate_image',{...request,referenceImageUrl:'https://cdn.example.test/character-v2.png'},async()=>{calls++;return receipt({task_id:'duplicate-charge'})}),/prior-submission-unknown/)
 assert.equal(calls,1);assert.equal(restarted.snapshot(input).used.imageCalls,1)
 assert.equal(restarted.snapshot(input).operations[0].state,'unknown')
})
