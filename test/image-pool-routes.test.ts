import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {selectImagePool} from '../src/image-pool-routes.ts'
const model='gemini-3.1-flash-image',signal=new AbortController().signal
test('local authenticated image route wins; remote used only when preflight rejects local',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-')),old=process.env.DSH_TEST_IMAGE_POOL_KEY
 try{
  await writeFile(join(dir,'runtime.json'),JSON.stringify({port:18741}));await writeFile(join(dir,'proxy-key'),'fixture-local')
  process.env.DSH_TEST_IMAGE_POOL_KEY='fixture-remote'
  const config={geminiImagePoolDir:dir,geminiImageRoutes:[{id:'remote',origin:'https://pool.example',apiKeyEnv:'DSH_TEST_IMAGE_POOL_KEY'}]},calls:string[]=[]
  const catalog=()=>Response.json({models:[{name:'models/'+model}]})
  const local=await selectImagePool(config,model,signal,(async(url:any)=>{calls.push(String(url));return catalog()}) as any)
  assert.equal(local.id,'local');assert.equal(calls.length,1)
  const remote=await selectImagePool(config,model,signal,(async(url:any)=>String(url).includes('127.0.0.1')?new Response('',{status:401}):catalog()) as any)
  assert.equal(remote.id,'remote');assert.equal(remote.reason,'remote-authenticated-model-available')
  await rm(join(dir,'proxy-key'))
  assert.equal((await selectImagePool(config,model,signal,(async()=>catalog()) as any)).id,'remote')
 }finally{if(old===undefined)delete process.env.DSH_TEST_IMAGE_POOL_KEY;else process.env.DSH_TEST_IMAGE_POOL_KEY=old;await rm(dir,{recursive:true,force:true})}
})
test('oversized catalog is cancelled while reading before trying another route',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-bounded-')),old=process.env.DSH_TEST_IMAGE_POOL_KEY
 try{
  await writeFile(join(dir,'runtime.json'),JSON.stringify({port:18741}));await writeFile(join(dir,'proxy-key'),'fixture-local')
  process.env.DSH_TEST_IMAGE_POOL_KEY='fixture-remote'
  let cancelled=false,pulls=0
  const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(600000))},cancel(){cancelled=true}})
  const route=await selectImagePool({geminiImagePoolDir:dir,geminiImageRoutes:[{id:'remote',origin:'https://pool.example',apiKeyEnv:'DSH_TEST_IMAGE_POOL_KEY'}]},model,signal,(async(url:any)=>String(url).includes('127.0.0.1')?new Response(body):Response.json({models:[{name:'models/'+model}]})) as any)
  assert.equal(route.id,'remote');assert.equal(cancelled,true);assert.ok(pulls<=3)
 }finally{if(old===undefined)delete process.env.DSH_TEST_IMAGE_POOL_KEY;else process.env.DSH_TEST_IMAGE_POOL_KEY=old;await rm(dir,{recursive:true,force:true})}
})
test('unsafe routes, missing authorization and absent models never dispatch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-empty-'))
 try{
  for(const origin of ['http://remote.example','https://user:pass@pool.example','https://pool.example/path'])await assert.rejects(selectImagePool({geminiImagePoolDir:dir,geminiImageRoutes:[{id:'remote',origin,apiKeyEnv:'DSH_TEST_IMAGE_MISSING'}]},model,signal),/HTTPS|地址|凭据/)
  await assert.rejects(selectImagePool({geminiImagePoolDir:dir},model,signal),/没有已认证/)
  const c=new AbortController();c.abort();await assert.rejects(selectImagePool({geminiImagePoolDir:dir},model,c.signal))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('Models-page remote auth is discovered from host settings and credential seam',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-host-')),calls:string[]=[],refs:string[]=[]
 try{
  const route=await selectImagePool({geminiImagePoolDir:dir},model,signal,(async(url:any,init:any)=>{
   calls.push(String(url));assert.equal(init.method,undefined);assert.equal(init.redirect,'error')
   assert.equal(init.headers.authorization,'Bearer fixture-host-key')
   return Response.json({models:[{name:'models/'+model}]})
  }) as any,{
   settings:{get(ns){assert.equal(ns,'llm-pi-ai');return {providers:{'ag-pool-remote':{baseURL:'https://pool.example/v1',apiKeyEnv:'DMC_POOL_REF'}}}}},
   credentials:{async resolve(ref){refs.push(ref);return {value:'fixture-host-key'}}},
   llm:{listProviders(){return [{id:'ag-pool-remote'}]}},
  })
  assert.equal(route.id,'ag-pool-remote');assert.equal(route.origin,'https://pool.example')
  assert.equal(route.reason,'remote-provider-authenticated-model-available');assert.deepEqual(refs,['DMC_POOL_REF'])
  assert.deepEqual(calls,['https://pool.example/images/v1/models'])
  assert.equal('apiKeyEnv' in route,false)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('local wins without resolving remote credentials; explicit route overrides discovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-precedence-')),refs:string[]=[]
 try{
  await writeFile(join(dir,'runtime.json'),JSON.stringify({port:18741}));await writeFile(join(dir,'proxy-key'),'fixture-local')
  const config={geminiImagePoolDir:dir,geminiImageRoutes:[{id:'ag-pool-remote',origin:'https://explicit.example',apiKeyEnv:'EXPLICIT_POOL_REF'}]}
  const host={settings:{get(){return {providers:{'ag-pool-remote':{baseURL:'https://discovered.example/v1',apiKeyEnv:'DISCOVERED_POOL_REF'}}}}},credentials:{async resolve(ref:string){refs.push(ref);return {value:'fixture-key'}}},llm:{listProviders(){return [{id:'ag-pool-remote'}]}}}
  const catalog=async()=>Response.json({models:[{name:'models/'+model}]})
  assert.equal((await selectImagePool(config,model,signal,catalog as any,host)).id,'local')
  assert.equal(refs.length,0)
  await rm(join(dir,'proxy-key'))
  const route=await selectImagePool(config,model,signal,catalog as any,host)
  assert.equal(route.origin,'https://explicit.example');assert.deepEqual(refs,['EXPLICIT_POOL_REF'])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('revoked or untrusted host routes fall back before dispatch; credentials are re-resolved per operation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-revoke-')),old=process.env.DMC_POOL_REF,calls:string[]=[]
 try{
  process.env.DMC_POOL_REF='stale-env-must-not-win'
  let remoteKey:string|undefined='fixture-first'
  const profiles={
   'not-a-pool':{baseURL:'https://unrelated.example/v1',apiKeyEnv:'DMC_POOL_REF'},
   'ag-pool-insecure':{baseURL:'http://insecure.example/v1',apiKeyEnv:'DMC_POOL_REF'},
   'ag-pool-userinfo':{baseURL:'https://fixture:secret@credentials.example/v1',apiKeyEnv:'DMC_POOL_REF'},
   'ag-pool-path':{baseURL:'https://path.example/arbitrary',apiKeyEnv:'DMC_POOL_REF'},
   'ag-pool-inline':{baseURL:'https://inline.example/v1',apiKey:'fixture-inline'},
   'ag-pool-dormant':{baseURL:'https://dormant.example/v1',apiKeyEnv:'DMC_POOL_REF'},
   'ag-pool-good':{baseURL:'https://good.example/gemini/v1beta/',apiKeyEnv:'DMC_POOL_REF'},
  }
  const host={settings:{get(){return {providers:profiles}}},credentials:{async resolve(ref:string){return ref==='DMC_POOL_REF'?(remoteKey?{value:remoteKey}:undefined):ref==='FIXTURE_CF_REF'?{value:'fixture-cf'}:undefined}},llm:{listProviders(){return Object.keys(profiles).filter(id=>id!=='ag-pool-dormant').map(id=>({id}))}}}
  const config={geminiImagePoolDir:dir,geminiImageFallback:{id:'fallback',origin:'https://fallback.example',apiKeyEnv:'FIXTURE_CF_REF'}}
  const request=(async(url:any,init:any)=>{calls.push(String(url));assert.ok(['Bearer fixture-first','Bearer fixture-cf'].includes(init.headers.authorization));return Response.json({models:[{name:'models/'+model}]})}) as any
  assert.equal((await selectImagePool(config,model,signal,request,host)).id,'ag-pool-good')
  remoteKey=undefined
  assert.equal((await selectImagePool(config,model,signal,request,host)).id,'fallback')
  assert.deepEqual(calls,['https://good.example/images/v1/models','https://fallback.example/images/v1/models'])
 }finally{if(old===undefined)delete process.env.DMC_POOL_REF;else process.env.DMC_POOL_REF=old;await rm(dir,{recursive:true,force:true})}
})

test('discovered legacy pool must authenticate and advertise the image model',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-legacy-')),calls:string[]=[]
 try{
  const host={settings:{get(){return {providers:{'ag-pool-remote':{baseURL:'https://pool.example/anthropic',apiKeyEnv:'DMC_POOL_REF'}}}}},credentials:{async resolve(){return {value:'fixture-host-key'}}}}
  const route=await selectImagePool({geminiImagePoolDir:dir},model,signal,(async(url:any)=>{
   calls.push(String(url));return String(url).includes('/images/v1/')?new Response('',{status:404}):Response.json({models:[{name:'models/'+model}]})
  }) as any,host)
  assert.equal(route.protocol,'gemini-v1beta');assert.equal(route.id,'ag-pool-remote');assert.equal(calls.length,2)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('configured loopback pool is preferred when the standard local data directory is absent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-route-custom-dir-')),calls:string[]=[]
 try{
  const route=await selectImagePool({geminiImagePoolDir:dir,geminiImageRoutes:[{id:'explicit-remote',origin:'https://explicit.example',apiKeyEnv:'EXPLICIT_POOL_REF'}]},model,signal,(async(url:any)=>{calls.push(String(url));return Response.json({models:[{name:'models/'+model}]})}) as any,{
   settings:{get(){return {providers:{'ag-pool-a-remote':{baseURL:'https://discovered.example/v1',apiKeyEnv:'REMOTE_POOL_REF'},'ag-pool-z-loopback':{baseURL:'http://127.0.0.1:19001/v1',apiKeyEnv:'LOOPBACK_POOL_REF'}}}}},
   credentials:{async resolve(){return {value:'fixture-key'}}},
  })
  assert.equal(route.id,'ag-pool-z-loopback');assert.equal(route.reason,'host-loopback-authenticated-model-available')
  assert.deepEqual(calls,['http://127.0.0.1:19001/images/v1/models'])
 }finally{await rm(dir,{recursive:true,force:true})}
})
