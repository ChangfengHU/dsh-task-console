import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {assertStudioImageRequest} from '../src/studio-image-request.js'
import {StudioOperations} from '../src/studio-operations.js'
const raw='vyibc-image_generate_image',valid={prompt:'character',referenceImageUrl:'https://cdn.vyibc.com/character.png',wait:false}
test('known invalid references and blocking submission are rejected before dispatch or reservation',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}},ops=new StudioOperations({kernel:{db}})
 ops.configure(input,{imageCalls:6,voiceSegments:40});let calls=0
 for(const args of [{prompt:'description only'},{...valid,referenceImageUrl:'https://cdn.vyibc.com/reference.mp4'},{...valid,referenceImageUrl:'/tmp/a.png'},{...valid,referenceImageUrl:'https://user:pass@cdn.vyibc.com/a.png'},{...valid,wait:true},{...valid,prompt:' '}]){
  await assert.rejects(ops.invoke(input,raw,args,async()=>{calls++;return {}},()=>assertStudioImageRequest(raw,args)),/studio-image-/)
 }
 assert.equal(calls,0);assert.equal(ops.snapshot(input).used.imageCalls,0);assert.equal(ops.snapshot(input).unknown,false)
})
test('image reference check leaves voice and image status reads untouched',()=>{
 assert.doesNotThrow(()=>assertStudioImageRequest('vyibc-image_get_task',{taskId:'j'}))
 assert.doesNotThrow(()=>assertStudioImageRequest('vyibc-voice_synthesize',{}))
 assert.doesNotThrow(()=>assertStudioImageRequest(raw,valid))
})
test('existing receipt replays even when current validation would reject historical no-reference input',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}},ops=new StudioOperations({kernel:{db}})
 ops.configure(input,{imageCalls:6,voiceSegments:0});const args={prompt:'historical'},receipt={structuredContent:{taskId:'existing',status:'done'}}
 await ops.invoke(input,raw,args,async()=>receipt)
 assert.deepEqual(await ops.invoke(input,raw,args,async()=>{throw Error('no repeat')},()=>assertStudioImageRequest(raw,args)),receipt)
 assert.equal(ops.snapshot(input).used.imageCalls,1)
})
test('both prompt and prompts are charged like the upstream concatenated request',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const input={task:{id:'t'},batch:{id:'b'},card:{role:'executor'}},ops=new StudioOperations({kernel:{db}})
 ops.configure(input,{imageCalls:2,voiceSegments:0});let calls=0
 const args={...valid,prompts:['second','third']}
 await assert.rejects(ops.invoke(input,raw,args,async()=>{calls++;return {}},()=>assertStudioImageRequest(raw,args)),/requestedUnits\":3/)
 assert.equal(calls,0);assert.equal(ops.snapshot(input).used.imageCalls,0)
})
