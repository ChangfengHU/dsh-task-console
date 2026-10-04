import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {invokeStudioRenderJob} from '../src/studio-render-host.ts'
import {StudioRenderLedger} from '../src/studio-render-ledger.ts'
import {fileSha256} from '../src/studio-tools.ts'
const h=(c:string)=>c.repeat(64)
async function fixture(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'render-dispatch-')),db=new Database(':memory:')
 t.after(async()=>{db.close();await rm(cwd,{recursive:true,force:true})})
 await mkdir(join(cwd,'composition'));await writeFile(join(cwd,'composition/index.html'),'<html/>');await writeFile(join(cwd,'storyboard.json'),'{}')
 const script=join(cwd,'render.py');await writeFile(script,'# trusted fixture helper')
 const config={renderJobScript:script,renderJobSha256:await fileSha256(script),renderRuntime:'/trusted/runtime'}
 const input={task:{id:'T',cwd,design:{studio:{width:1080,height:1920,fps:30}}},batch:{id:'B'},card:{id:'e1',role:'executor',round:1},sessionId:'s1'}
 const store:any={kernel:{db},s:{runs:new Map([['r1',{id:'r1',cardId:'e1',sessionId:'s1',status:'running'}]])}},ledger=new StudioRenderLedger(store)
 const args={composition:'composition',output:'candidate.mp4'}
 const success=(command:string[],changes:any={})=>({ok:true,intentId:ledger.rows(input)[0].intentId,jobId:h('a'),inputSha256:h('b'),state:'running',composition:args.composition,output:args.output,...changes})
 return{cwd,db,input,store,ledger,args,config,success}
}

test('fresh JSON-as-composition validation never reserves or dispatches; repaired request reserves before bridge execution',async t=>{
 const f=await fixture(t);let calls=0
 const execute=async(_:string,argv:string[])=>{calls++;const rows=f.ledger.rows(f.input);assert.equal(rows.length,1);assert.equal(rows[0].state,'submitting');assert.equal(argv[argv.indexOf('--intent-id')+1],rows[0].intentId);return f.success(argv)}
 await assert.rejects(invokeStudioRenderJob(f.input,'start',{...f.args,composition:'storyboard.json'},f.ledger,()=>{},{config:f.config,execute}),/composition-invalid/)
 assert.equal(calls,0);assert.deepEqual(f.ledger.rows(f.input),[])
 const result=await invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:f.config,execute})
 assert.equal(calls,1);assert.equal(result.state,'running');assert.equal(f.ledger.rows(f.input)[0].jobId,h('a'))
})

test('claim lost during preflight creates no intent; once execution may occur even identically named validation error remains unknown',async t=>{
 const f=await fixture(t);let checks=0,calls=0
 await assert.rejects(invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{if(++checks===2)throw Error('stale-run')},{config:f.config,execute:async()=>{calls++;return {}}}),/stale-run/)
 assert.equal(calls,0);assert.deepEqual(f.ledger.rows(f.input),[])
 await assert.rejects(invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:f.config,execute:async()=>{calls++;throw Error('studio-render-composition-invalid')}}),/composition-invalid/)
 assert.equal(calls,1);const row=f.ledger.rows(f.input)[0];assert.equal(row.state,'unknown');assert.equal(row.jobId,undefined)
 assert.throws(()=>f.ledger.prepare(f.input,'start',{...f.args,output:'another.mp4'},f.config),/prior-job-pending/)
})

test('new precheck failure never changes a prior legacy submitting or unknown reservation',async t=>{
 for(const state of ['submitting','unknown']){
  const f=await fixture(t),row=f.ledger.prepare(f.input,'start',{...f.args,composition:'storyboard.json'},f.config)
  delete row.revision;row.state=state
  f.db.prepare('UPDATE dsh_studio_render_jobs SET payload=? WHERE intent_id=?').run(JSON.stringify(row),row.intentId)
  const before=f.db.prepare('SELECT * FROM dsh_studio_render_jobs').all()
  await assert.rejects(invokeStudioRenderJob(f.input,'start',{...f.args,composition:'storyboard.json'},f.ledger,()=>{},{config:f.config,execute:async()=>assert.fail('precheck cannot execute')}),/composition-invalid/)
  assert.deepEqual(f.db.prepare('SELECT * FROM dsh_studio_render_jobs').all(),before)
 }
})

test('lost reply retries the exact durable intent and pinned helper; a known job uses status',async t=>{
 const f=await fixture(t);let intent:string|undefined,calls=0,workers=0;const launched=new Set<string>()
 const execute=async(_:string,argv:string[])=>{
  calls++;const row=f.ledger.rows(f.input)[0]
  assert.equal(row.helperSha256,f.config.renderJobSha256)
  if(argv[0]==='start'){
   const id=argv[argv.indexOf('--intent-id')+1];intent??=id;assert.equal(id,intent)
   if(!launched.has(id)){launched.add(id);workers++}
   if(calls===1)throw Error('reply-lost')
  }else{assert.equal(argv[0],'status');assert.equal(argv[argv.indexOf('--job-id')+1],h('a'))}
  return f.success(argv)
 }
 await assert.rejects(invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:f.config,execute}),/reply-lost/)
 const changedConfig={...f.config,renderJobScript:'/new/untrusted.py',renderJobSha256:h('f')}
 await invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:changedConfig,execute})
 await invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:changedConfig,execute})
 assert.equal(calls,3);assert.equal(workers,1);assert.equal(f.ledger.rows(f.input).length,1)
})

test('concurrent old callback cannot downgrade a newer valid completed job',async t=>{
 const f=await fixture(t);let release!:(v:any)=>void,entered!:()=>void
 const started=new Promise<void>(r=>entered=r),hold=new Promise<any>(r=>release=r)
 const first=invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:f.config,execute:async()=>{entered();return hold}})
 await started
 await writeFile(join(f.cwd,f.args.output),'actual fixture bytes')
 const complete={state:'completed',outputSha256:await fileSha256(join(f.cwd,f.args.output)),bytes:20,width:1080,height:1920,fps:30,durationSeconds:100}
 await invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{},{config:f.config,execute:async(_:string,argv:string[])=>f.success(argv,complete)})
 const before=f.ledger.rows(f.input)[0];assert.equal(before.state,'completed')
 release(f.success([]));await first
 assert.deepEqual(f.ledger.rows(f.input)[0],before)
 // Generic late errors and older status snapshots cannot erase a valid job.
 f.ledger.record(f.input,{...before,revision:0},{ok:false,errorCode:'render_host_failed'})
 assert.deepEqual(f.ledger.rows(f.input)[0],before)
})

test('concurrent reservation with a different pinned helper cannot be dispatched using the preflighted helper',async t=>{
 const f=await fixture(t);let checks=0,calls=0
 const different={...f.config,renderJobScript:'/original/helper.py',renderJobSha256:h('e')}
 await assert.rejects(invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{
  if(++checks===2)f.ledger.prepare(f.input,'start',f.args,different)
 },{config:f.config,execute:async()=>{calls++;return {}}}),/origin-changed-before-dispatch/)
 assert.equal(calls,0);const row=f.ledger.rows(f.input)[0]
 assert.equal(row.state,'submitting');assert.equal(row.helperPath,different.renderJobScript)
})

test('an original valid job receipt is retained when the calling session becomes inactive after dispatch',async t=>{
 const f=await fixture(t);let active=true
 await assert.rejects(invokeStudioRenderJob(f.input,'start',f.args,f.ledger,()=>{if(!active)throw Error('stale-run')},{config:f.config,execute:async(_:string,argv:string[])=>{active=false;return f.success(argv)}}),/stale-run/)
 const row=f.ledger.rows(f.input)[0];assert.equal(row.jobId,h('a'));assert.equal(row.state,'running');assert.equal(row.originSessionId,'s1')
})
