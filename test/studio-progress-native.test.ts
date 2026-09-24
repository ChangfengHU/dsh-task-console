import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {StudioOperations} from '../src/studio-operations.ts'
import {StudioProgress,registerStudioProgress,assertStudioProgressWritable} from '../src/studio-progress.ts'

function kernel(){
 const db=new Database(':memory:');db.exec('CREATE TABLE task_events(id INTEGER PRIMARY KEY,task_id TEXT,run_id INTEGER,kind TEXT,payload TEXT)')
 let current=1
 return{db,getTask:()=>({current_run_id:current}),replace:()=>current++,recordEvent:(id:string,kind:string,payload:any,runId:number)=>db.prepare('INSERT INTO task_events(task_id,run_id,kind,payload) VALUES(?,?,?,?)').run(id,runId,kind,JSON.stringify(payload))}
}
const failed=(field='outputs[0]')=>({isError:true,error:{message:'studio-stage-output-invalid: '+JSON.stringify({field,reason:'File missing stages/r1/visual/file.png'})},content:[]})
const exec=(callId:string,name='studio_register_stage',args:any={})=>({callId,name,arguments:args})

test('actual SDK ToolRuntime delivers real call IDs and error.message; guard prevents dispatch and native pre-step throws',async()=>{
 const require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),agent={ctx,session:{id:'task-native-progress'}},k=kernel(),progress=new StudioProgress(k,'card',1)
 const stop=registerStudioProgress({tools:runtime,on:ctx.on.bind(ctx)},progress,agent.session.id,()=>true)
 let dispatched=0
 const tool=runtime.register(defineTool({name:'studio_register_stage',description:'fixture',parameters:{index:{type:'number',required:true}},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(args:any)=>{dispatched++;throw Error('studio-stage-output-invalid: '+JSON.stringify({field:`outputs[${args.index}]`,reason:'File missing /workspace/file.png'}))}}))
 const run=(index:number)=>runtime.execute({name:'studio_register_stage',arguments:{index},agent,callId:'sdk-'+index,signal:new AbortController().signal} as any)
 try{
  for(let n=0;n<4;n++)assert.equal((await run(n)).isError,true)
  assert.equal(progress.state.reason,'repeated-tool-failure');assert.equal(progress.state.results.length,4)
  assert.equal((await run(4)).isError,true);assert.equal(dispatched,4)
  await assert.rejects(()=>ctx.waterfall('agent/pre-step',{agent,turn:0,step:5,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]})),/STUDIO_PROGRESS_GUARD/)
  assert.throws(()=>assertStudioProgressWritable(k.db,{task:{design:{progressPolicy:'studio-bounded-v1'}},card:{id:'card'}},1),/stop-requested/)
 }finally{stop();tool();k.db.close()}
})

test('actual Cordis pre-step turns accumulate; normal host idle performs no steps',async()=>{
 const require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx=new Context(),k=kernel(),p=new StudioProgress(k,'card',1),agent={session:{id:'task-steps'}}
 const stop=registerStudioProgress({on:ctx.on.bind(ctx),tools:{guard:()=>()=>{}}},p,agent.session.id,()=>true)
 try{
  for(let turn=0;turn<2;turn++)for(let step=1;step<=40;step++)await ctx.waterfall('agent/pre-step',{agent,turn,step},async()=>({kind:'enter'}))
  assert.equal(p.state.steps.length,80)
  await assert.rejects(()=>ctx.waterfall('agent/pre-step',{agent,turn:2,step:1},async()=>({kind:'enter'})),/model-step-limit/)
 }finally{stop();k.db.close()}
})

test('search synonyms and arbitrary successful reads cannot reset; actual asset acquisition can',()=>{
 const k=kernel();try{
  const p=new StudioProgress(k,'card',1)
  for(let n=0;n<7;n++){p.result(exec('search'+n,'asset_search',{query:'variant'+n}),{isError:false,value:{items:[{id:'candidate'}]}});p.result(exec('read'+n,'read'),{isError:false,value:'ok'})}
  assert.equal(p.state.searches,7)
  p.result(exec('get','asset_get',{id:'chosen'}),{isError:false,value:{asset:{id:'chosen',kind:'sfx'}}});assert.equal(p.state.searches,0)
  for(let n=0;n<8;n++){p.result(exec('newsearch'+n,'asset_search',{query:'new'+n}),{isError:false,value:{items:[]}});p.result(exec('reget'+n,'asset_get',{id:'chosen'}),{isError:false,value:{asset:{id:'chosen',kind:'sfx'}}})}
  assert.equal(p.state.reason,'asset-search-without-acquisition')
 }finally{k.db.close()}
})

test('poll error receipts excluded, duplicate/stale events ignored, actual same-tool validation repair clears only its errors',()=>{
 const k=kernel();try{
  const p=new StudioProgress(k,'card',1)
  for(let n=0;n<10;n++)p.result(exec('poll'+n,'vyibc-voice_status',{job_id:'original'}),failed())
  assert.equal(p.state.reason,undefined);assert.equal(Object.keys(p.state.failures).length,0)
  const first=exec('error');p.result(first,failed());p.result(first,failed());assert.equal(Object.values(p.state.failures)[0],1)
  p.result(exec('error2'),failed('outputs[9]'));p.result(exec('error3'),failed());assert.equal(Object.values(p.state.failures)[0],3)
  const receipt={stage:'visual',round:1,batchId:'b',sessionId:'s',cardId:'c',configSha256:'a'.repeat(64),manifest:{path:'stages/manifest.json',sha256:'a'.repeat(64)},outputs:[{path:'stages/file.png',sha256:'a'.repeat(64),bytes:1}],qualityApproved:false}
  p.result(exec('fixed'),{isError:false,value:receipt});assert.equal(Object.keys(p.state.failures).length,0)
  p.result(exec('another-error'),failed());assert.equal(p.state.reason,undefined)
  k.replace();p.result(exec('stale'),failed());assert.equal(p.state.results.includes('stale'),false)
  assert.equal(p.step(1,1),'stale-run')
 }finally{k.db.close()}
})

test('invalid events and corrupt saved state fail closed rather than coalescing undefined IDs',()=>{
 for(const broken of ['{"schemaVersion":1}', '{bad']){
  const k=kernel();try{k.db.prepare('INSERT INTO task_events(task_id,run_id,kind,payload) VALUES(?,?,?,?)').run('card',1,'studio_progress',broken);const p=new StudioProgress(k,'card',1);assert.equal(p.step(0,1),'progress-snapshot-invalid')}finally{k.db.close()}
 }
 const k=kernel();try{const p=new StudioProgress(k,'card',1);assert.equal(p.dispatch({}),'progress-event-invalid')}finally{k.db.close()}
 const k2=kernel();try{const p=new StudioProgress(k2,'card',1);assert.equal(p.step(undefined as any,1),'progress-event-invalid')}finally{k2.db.close()}
})


test('paid pre-dispatch recheck after async probe prevents reservation and invocation once a guard stop is durable',async()=>{
 const k=kernel();try{
  const ops=new StudioOperations({kernel:k}),input={task:{id:'t',design:{progressPolicy:'studio-bounded-v1'}},batch:{id:'b'},card:{id:'card',role:'executor'}}
  ops.configure(input,{imageCalls:1,imageBatches:1,voiceSegments:1})
  let release!:()=>void,entered!:()=>void,dispatched=0
  const enteredProbe=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
  const pending=ops.invoke(input,'vyibc-image_generate_image',{prompt:'fixture'},async()=>{dispatched++;return {}},()=>assertStudioProgressWritable(k.db,input,1),async()=>{entered();await hold})
  await enteredProbe
  k.recordEvent('card','studio_progress_stopped',{schemaVersion:1,policy:'studio-bounded-v1',stopConfirmed:false},1)
  release();await assert.rejects(pending,/stop-requested/)
  assert.equal(dispatched,0);assert.equal(ops.snapshot(input).used.imageCalls,0)
 }finally{k.db.close()}
})
