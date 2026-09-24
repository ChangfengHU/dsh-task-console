import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioOperations} from '../src/studio-operations.js'
import {assertFrozenVoiceSynthesis} from '../src/studio-voice-script.js'
const script={sha256:'a'.repeat(64),lines:[{id:'hello',text:'你好！'},{id:'last',text:'一起回去吧。'}]},raw='vyibc-voice_synthesize'
const args={segments:[{text:'你好！',voice_type:'voice',speech_rate:10}]}
test('production accepts exact frozen subsets and returns internal bindings without modifying provider arguments',()=>{
 const before=structuredClone(args),result=assertFrozenVoiceSynthesis(raw,args,script)
 assert.equal(result.checked,true);assert.deepEqual(result.bindings,[{segmentIndex:0,lineIds:['hello']}]);assert.deepEqual(args,before)
 assert.doesNotThrow(()=>assertFrozenVoiceSynthesis(raw,{segments:[{text:'一起回去吧。',voice_type:'other'}]},script))
 for(const text of ['你好',' 你好！','你好！\n','一起','我重新编的台词'])assert.throws(()=>assertFrozenVoiceSynthesis(raw,{segments:[{text,voice_type:'voice'}]},script),/exact_frozen_dialogue_text/)
 assert.throws(()=>assertFrozenVoiceSynthesis(raw,args,null),/frozen_script/)
})
test('audition, status, result and other providers are unaffected; retry follows actual optional text schema',()=>{
 for(const name of ['vyibc-voice_audition','vyibc-voice_status','vyibc-voice_result','other_synthesize'])assert.equal(assertFrozenVoiceSynthesis(name,{text:'自由试听'},null).checked,false)
 assert.equal(assertFrozenVoiceSynthesis('vyibc-voice_retry_segments',{job_id:'job',retry_key:'r1',segments:[{index:0}]},null).reason,'retry-retains-upstream-text')
 assert.equal(assertFrozenVoiceSynthesis('vyibc-voice_retry_segments',{job_id:'job',retry_key:'r2',segments:[{index:0,text:'你好！'}]},script).checked,true)
 assert.throws(()=>assertFrozenVoiceSynthesis('vyibc-voice_retry_segments',{job_id:'job',retry_key:'r3',segments:[{index:0,text:'改词了'}]},script),/exact_frozen_dialogue_text/)
})
test('wrong production text is rejected before paid dispatch and budget reservation; completed replay and status remain usable',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'task'},batch:{id:'batch'},card:{role:'executor'}}
 ops.configure(input,{imageCalls:1,voiceSegments:10});let calls=0
 const invoke=async()=>{calls++;return {structuredContent:{job_id:'job',status:'completed'}}}
 const bad={segments:[{text:'换成另一个故事',voice_type:'voice'}]}
 await assert.rejects(ops.invoke(input,raw,bad,invoke,()=>assertFrozenVoiceSynthesis(raw,bad,script)),/studio-voice-script-mismatch/)
 assert.equal(calls,0);assert.equal(ops.snapshot(input).used.voiceSegments,0);assert.equal(ops.snapshot(input).operations.length,0);assert.equal(ops.snapshot(input).unknown,false)
 const first=await ops.invoke(input,raw,args,invoke,()=>assertFrozenVoiceSynthesis(raw,args,script));assert.equal(calls,1)
 const restarted=new StudioOperations({kernel:{db}})
 assert.deepEqual(await restarted.invoke(input,raw,args,invoke,()=>assertFrozenVoiceSynthesis(raw,args,null)),first);assert.equal(calls,1)
 await restarted.invoke(input,'vyibc-voice_status',{job_id:'job'},invoke,()=>{throw Error('status must not invoke semantic hook')});assert.equal(calls,2)
 assert.equal(restarted.snapshot(input).used.voiceSegments,1)
})
test('uncertain prior requests cannot become a fresh paid dispatch after adding validation',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'task'},batch:{id:'batch'},card:{role:'executor'}}
 ops.configure(input,{imageCalls:1,voiceSegments:10});let calls=0
 await assert.rejects(ops.invoke(input,raw,args,async()=>{calls++;throw Error('network lost')}),/submission-unknown/)
 await assert.rejects(ops.invoke(input,raw,args,async()=>{calls++;return {}},()=>assertFrozenVoiceSynthesis(raw,args,script)),/submission-unknown/)
 assert.equal(calls,1);assert.equal(ops.snapshot(input).used.voiceSegments,1)
})
