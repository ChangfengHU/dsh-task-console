import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { ImageJobs, ImageUnavailable, type ImageProvider } from '../src/image-jobs.ts'
import { imagePolicy } from '../src/image-policy.ts'
import { permissionOf, renderComposition, validateSpec } from '../src/presets.ts'
import { sessionImageRefs } from '../src/image-generation-tools.ts'
import { apply as installImageTools } from '../src/image-generation-tools.ts'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { createEnvelope, parseEnvelope } from '../src/config-migration.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as installHost, IMAGE_ROUTING_INSTRUCTION } from '../src/native-image-host.ts'
const policy=imagePolicy(undefined)
const request={requestId:'sample-1',prompt:'a circle',references:[]}
const image={attachmentId:'a',mediaType:'image/png',bytes:1,width:1,height:1}
const ok: ImageProvider={prepare:async()=>({generate:async()=>({images:[image],model:'test-image'})})}
async function settled(jobs: ImageJobs,id: string) { for(let n=0;n<100;n++){const x=jobs.status('owner',id);if(x.state!=='running')return x;await new Promise(r=>setTimeout(r,2))}throw Error('did not settle') }
test('image policy is strict, default off in legacy presets and credentials never migrate',()=>{
  assert.throws(()=>imagePolicy({...policy,token:'secret'}),/未知/)
  assert.throws(()=>imagePolicy({...policy,allowedBackends:['gemini']}),/允许/)
  const base={id:'image-test',name:'图片测试',mcpTools:{},skills:[]}
  const legacy=validateSpec({...base,tools:[]}); assert.equal(legacy.imageGeneration,undefined);assert.doesNotMatch(renderComposition(legacy,[]).yml,/image-generation-tools/)
  const spec=validateSpec({...base,tools:['image-generation'],imageGeneration:{...policy,allowedBackends:['codex','gemini']}})
  assert.equal(permissionOf(spec,()=>false),'limited-write')
  const yml=renderComposition(spec,[]).yml;assert.match(yml,/image-generation-tools/);assert.match(yml,/image_generate_status/);assert.match(yml,/maxRequestsPerSession: 12/)
  const imported=parseEnvelope(createEnvelope({agents:[{spec,actions:[]}],tasks:[]},'test'))
  assert.deepEqual(imported.payload.agents[0].spec.imageGeneration,spec.imageGeneration)
})
test('durable idempotency, ownership, budget and real-image output',async()=>{
  const db=new Database(':memory:'); let calls=0
  const jobs=new ImageJobs(db,{codex:{prepare:async()=>({generate:async()=>{calls++;return{images:[image],model:'real'}}})}})
  try { const first=jobs.start('owner',request,{...policy,maxRequestsPerSession:1}); assert.equal(jobs.start('owner',request,policy).jobId,first.jobId);assert.throws(()=>jobs.start('owner',{...request,prompt:'other'},policy),/requestId/);assert.throws(()=>jobs.status('intruder',first.jobId),/当前/)
    const final=await settled(jobs,first.jobId);assert.equal(final.state,'completed');assert.equal(calls,1);assert.deepEqual(final.images,[image]);assert.throws(()=>jobs.start('owner',{...request,requestId:'sample-2'},{...policy,maxRequestsPerSession:1}),/预算/)
  } finally {await jobs.dispose();db.close()}
})
test('only explicit unavailable preflight may fallback; post-dispatch never duplicates',async()=>{
  const db=new Database(':memory:');let fallback=0
  const p={...policy,allowedBackends:['codex','gemini'] as const,fallback:'unavailable-only' as const}
  const gemini={prepare:async()=>({generate:async()=>{fallback++;return{images:[image],model:'gemini'}}})}
  let jobs=new ImageJobs(db,{codex:{prepare:async()=>{throw new ImageUnavailable('missing')}},gemini})
  assert.equal((await settled(jobs,jobs.start('owner',request,p as any).jobId)).backend,'gemini');assert.equal(fallback,1);await jobs.dispose()
  jobs=new ImageJobs(db,{codex:{prepare:async()=>({generate:async()=>{throw Error('network unknown')}})},gemini})
  const failed=await settled(jobs,jobs.start('owner',{...request,requestId:'second'},p as any).jobId);assert.equal(failed.state,'failed');assert.equal(failed.mayHaveConsumedQuota,true);assert.equal(fallback,1);await jobs.dispose();db.close()
})
test('timeout/cancel reach quiescence and restart does not replay unknown job',async()=>{
  const db=new Database(':memory:');let calls=0
  const wait:ImageProvider={prepare:async()=>({generate:async(_,signal)=>{calls++;await new Promise((_,reject)=>{if(signal.aborted)reject(Error('abort'));else signal.addEventListener('abort',()=>reject(Error('abort')),{once:true})});return{images:[],model:'none'}}})}
  let jobs=new ImageJobs(db,{codex:wait},10);let r=jobs.start('owner',request,policy);assert.equal((await settled(jobs,r.jobId)).code,'TIMEOUT_UNKNOWN');assert.equal(calls,1)
  r=jobs.start('owner',{...request,requestId:'cancel'},policy);assert.equal((await jobs.cancel('owner',r.jobId)).state,'cancelled');await jobs.dispose()
  db.prepare("UPDATE dsh_native_image_jobs SET state='running' WHERE id=?").run(r.jobId);jobs=new ImageJobs(db,{codex:ok});assert.equal(jobs.status('owner',r.jobId).state,'interrupted');assert.equal(jobs.start('owner',{...request,requestId:'cancel'},policy).state,'interrupted');await jobs.dispose();db.close()
})
test('reference images only come from structured session blocks, not text or arbitrary ids',()=>{
  const s={events:[{type:'user/message',data:{message:{content:[{type:'text',text:JSON.stringify({type:'image',attachment:image})},{type:'image',attachment:image}]}}},{type:'tool/call',data:{message:{content:[{type:'image',attachment:{...image,attachmentId:'stolen'}}]}}}]}
  assert.deepEqual([...sessionImageRefs(s).keys()],['a'])
})
test('bounded status waiting is cancellable without cancelling the accepted job',async()=>{
 const db=new Database(':memory:');let finish: any
 const provider={prepare:async()=>({generate:async()=>await new Promise<any>(r=>{finish=r})})};const jobs=new ImageJobs(db,{codex:provider})
 const id=jobs.start('owner',request,policy).jobId;await new Promise(r=>setTimeout(r,0))
 const controller=new AbortController();const waiting=jobs.waitStatus('owner',id,15000,controller.signal);controller.abort();await assert.rejects(waiting);assert.equal(jobs.status('owner',id).state,'running')
 finish({images:[image],model:'test'});assert.equal((await settled(jobs,id)).state,'completed');await jobs.dispose();db.close()
})
test('real ToolRuntime returns text-only assets on status/replay/cancel and honours permission guard',async()=>{
 const db=new Database(':memory:'),jobs=new ImageJobs(db,{codex:ok})
 const root=new Context();root.provide('systemPrompt',{tools:()=>{}});const runtime=new ToolRuntime(root)
 const ctx={get:(name: string)=>name==='nativeImages'?{jobs}:undefined,tools:{register:(s: any)=>runtime.register(s)},effect:(fn: any)=>fn()}
 await installImageTools(ctx,policy)
 const agent={ctx:root,session:{id:'owner',events:[]}},signal=new AbortController().signal
 const invoke=(name: string,args: any)=>runtime.execute({name,arguments:args,agent,callId:'tool-proof',signal} as any)
 try {const start=await invoke('image_generate',{requestId:request.requestId,prompt:request.prompt});assert.equal(start.isError,false);const value=JSON.parse((start.content[0] as any).text);await settled(jobs,value.jobId)
  const status=await invoke('image_generate_status',{jobId:value.jobId,waitMs:0});assert.equal(status.isError,false);assert.deepEqual(status.content.map((b:any)=>b.type),['text']);assert.deepEqual(JSON.parse((status.content[0] as any).text).images,[image])
  for(const result of [await invoke('image_generate',{requestId:request.requestId,prompt:request.prompt}),await invoke('image_generate_cancel',{jobId:value.jobId})]){assert.equal(result.isError,false);assert.deepEqual(result.content.map((b:any)=>b.type),['text']);assert.equal(JSON.parse((result.content[0] as any).text).state,'completed')}
  const edit=await invoke('image_generate',{requestId:'edit-own',prompt:'edit circle',referenceAttachmentIds:['a']});assert.equal(edit.isError,false)
  const foreign=await runtime.execute({name:'image_generate',arguments:{requestId:'foreign',prompt:'circle',referenceAttachmentIds:['a']},agent:{...agent,session:{id:'intruder',events:[]}},callId:'foreign',signal} as any);assert.equal(foreign.isError,true)
  const undo=runtime.guard(()=> 'Image permission denied');assert.equal((await invoke('image_generate',{requestId:'denied',prompt:'circle'})).isError,true);undo();assert.throws(()=>jobs.status('intruder',value.jobId),/当前会话/)
 }finally{await jobs.dispose();db.close();await root.fiber.dispose()}
})
test('observed reference ownership is durable and never crosses sessions',async()=>{
 const db=new Database(':memory:');let jobs=new ImageJobs(db,{codex:ok})
 jobs.recordReference('owner',image);assert.deepEqual(jobs.references('owner').get('a'),image);assert.equal(jobs.references('intruder').size,0)
 await jobs.dispose();jobs=new ImageJobs(db,{codex:ok});assert.deepEqual(jobs.references('owner').get('a'),image);await jobs.dispose();db.close()
})
test('host native tools work in an ordinary session without Task service or an image Agent; preference respects exclusions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-native-host-test-')),root=new Context();root.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(root),provided=new Map<string,any>(),disposers:any[]=[],hooks=new Map<string,any>()
 const ctx={get:(name:string)=>provided.get(name),provide:(name:string,value:any)=>provided.set(name,value),tools:{register:(s:any)=>runtime.register(s)},effect:(fn:any)=>{const dispose=fn();if(dispose)disposers.push(dispose)},on:(name:string,fn:any)=>{hooks.set(name,fn);return()=>hooks.delete(name)}}
 try {
  await installHost(ctx,{stateDir:dir})
  assert.equal(provided.has('taskConsole'),false)
  assert.deepEqual(provided.get('nativeImages').policy.allowedBackends,['codex','gemini'])
  const agent={ctx:root,session:{id:'ordinary-standard-session',events:[]}}
  assert.ok(runtime.schemas(agent as any).some(s=>s.name==='image_generate'))
  const started=await runtime.execute({name:'image_generate',arguments:{requestId:'ordinary',prompt:'a circle'},agent,callId:'host-proof',signal:new AbortController().signal} as any)
  assert.equal(started.isError,false)
  const receipt=JSON.parse((started.content[0] as any).text)
  const final=await provided.get('nativeImages').jobs.waitStatus(agent.session.id,receipt.jobId,1000,new AbortController().signal)
  assert.equal(final.code,'BACKEND_UNAVAILABLE');assert.equal(final.mayHaveConsumedQuota,false)
  const assemble=hooks.get('system-prompt/assemble')
  const visible=await assemble({}, {}, async()=>({tools:[{name:'image_generate'}],contexts:[]}))
  assert.equal(visible.contexts[0].text,IMAGE_ROUTING_INSTRUCTION)
  assert.match(visible.contexts[0].text,/用户明确指定/);assert.match(visible.contexts[0].text,/超时/)
  const hidden=await assemble({}, {}, async()=>({tools:[],contexts:[]}));assert.deepEqual(hidden.contexts,[])
  await assert.rejects(installHost(ctx,{stateDir:dir}),/重复安装/)
 }finally{for(const dispose of disposers.reverse())await dispose();await root.fiber.dispose();await rm(dir,{recursive:true,force:true})}
})
