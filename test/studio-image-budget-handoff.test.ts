import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioOperations} from '../src/studio-operations.js'
const raw='vyibc-image_generate_image'
function setup(t:any){const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'T'},batch:{id:'B'},card:{role:'executor'}};ops.configure(input,{imageCalls:6,imageBatches:2,voiceSegments:20});return {db,ops,input}}
const budget=(r:any)=>r.studioImageBudget??JSON.parse(r.content.at(-1).text).studioImageBudget
test('two one-image calls show actual remaining items and exhausted submissions without resetting',async t=>{
 const {db,ops,input}=setup(t);let calls=0
 for(let n=1;n<=2;n++){
  const provider={content:[{type:'text',text:JSON.stringify({taskId:'job'+n,status:'queued'})}],isError:false}
  const r=await ops.invoke(input,raw,{prompt:'image'+n},async()=>{calls++;return provider})
  assert.deepEqual(r.content.slice(0,-1),provider.content);assert.equal(r.isError,false)
  assert.deepEqual(budget(r).items,{limit:6,used:n,remaining:6-n});assert.deepEqual(budget(r).submissions,{limit:2,used:n,remaining:2-n})
  assert.match(budget(r).instruction,/prompts:\[/);assert.equal(budget(r).qualityApproved,false)
 }
 assert.equal(calls,2);await assert.rejects(ops.invoke(input,raw,{prompt:'third'},async()=>{calls++;return {}}),/batch-limit/);assert.equal(calls,2)
 for(const row of db.prepare('SELECT result FROM dsh_studio_operations').all() as any[])assert.ok(!row.result.includes('studioImageBudget'))
})
test('batched prompts and explicit provider error preserve schema and count reserved units',async t=>{
 const {ops,input}=setup(t),provider={isError:true,structuredContent:{ok:false,error:'provider refused'},content:[{type:'text',text:'unchanged error body'}]}
 const result=await ops.invoke(input,raw,{prompts:['a','b','c','d']},async()=>provider)
 assert.equal(result.isError,true);assert.deepEqual(result.structuredContent,provider.structuredContent);assert.deepEqual(result.content.slice(0,-1),provider.content)
 assert.deepEqual(budget(result).items,{limit:6,used:4,remaining:2});assert.deepEqual(budget(result).submissions,{limit:2,used:1,remaining:1})
 assert.equal(ops.snapshot(input).operations[0].state,'failed')
 const replay=await ops.invoke(input,raw,{prompts:['a','b','c','d']},async()=>{throw Error('must not dispatch')})
 assert.deepEqual(replay.content.slice(0,-1),provider.content);assert.ok(!JSON.stringify(replay).includes('studioImageBudget'));assert.equal(JSON.parse(replay.content.at(-1).text).studioOperation.replayed,true)
})
test('handoff includes original submitted work and text envelopes remain readable',async t=>{
 const {ops,input}=setup(t)
 await ops.invoke(input,raw,{prompts:['earlier-1','earlier-2']},async()=>({taskId:'earlier-job',status:'queued'}))
 const wrapped=await ops.invoke(input,raw,{prompt:'next'},async()=>({type:'text',text:JSON.stringify({taskId:'j1',status:'queued'})}))
 const result=JSON.parse(wrapped.text)
 assert.equal(result.taskId,'j1');assert.deepEqual(budget(result).items,{limit:6,used:3,remaining:3});assert.equal(budget(result).submissions.remaining,0)
 assert.deepEqual(ops.snapshot(input).used,{imageCalls:3,voiceSegments:0,imageBatches:2})
})
