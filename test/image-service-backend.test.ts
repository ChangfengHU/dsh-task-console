import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {selectImagePool,DEFAULT_IMAGE_SERVICE} from '../src/image-pool-routes.ts'
import {imageBackends} from '../src/image-backends.ts'
const model='gemini-3.1-flash-image',signal=new AbortController().signal
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1kAAAAASUVORK5CYII='
test('no pool authentication uses the built-in CF address with a host-only scoped capability',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-default-cf-')),previous=process.env.DSH_IMAGE_SERVICE_TOKEN
 try{process.env.DSH_IMAGE_SERVICE_TOKEN='fixture-scoped';const calls:string[]=[]
  const selected=await selectImagePool({geminiImagePoolDir:dir},model,signal,(async(url:any,options:any)=>{calls.push(String(url));assert.equal(options.headers.authorization,'Bearer fixture-scoped');return Response.json({models:[{name:'models/'+model}]})}) as any)
  assert.equal(selected.id,DEFAULT_IMAGE_SERVICE.id);assert.equal(selected.reason,'cf-fallback-authenticated');assert.deepEqual(calls,['https://image-api.vyibc.com/images/v1/models'])
 }finally{if(previous===undefined)delete process.env.DSH_IMAGE_SERVICE_TOKEN;else process.env.DSH_IMAGE_SERVICE_TOKEN=previous;await rm(dir,{recursive:true,force:true})}
})
test('CF fallback is last, uses only the dedicated service protocol and keeps credential private',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-cf-route-')),previous=process.env.DSH_TEST_CF_KEY
 try{process.env.DSH_TEST_CF_KEY='fixture-cf';const config={geminiImagePoolDir:dir,geminiImageFallback:{id:'cf',origin:'https://images.example',apiKeyEnv:'DSH_TEST_CF_KEY'}},calls:string[]=[]
  const selected=await selectImagePool(config,model,signal,(async(url:any)=>{calls.push(String(url));return Response.json({models:[{name:'models/'+model}]})}) as any)
  assert.equal(selected.id,'cf');assert.equal(selected.protocol,'images-v1');assert.equal(selected.reason,'cf-fallback-authenticated');assert.deepEqual(calls,['https://images.example/images/v1/models'])
 }finally{if(previous===undefined)delete process.env.DSH_TEST_CF_KEY;else process.env.DSH_TEST_CF_KEY=previous;await rm(dir,{recursive:true,force:true})}
})
test('older pools retain their authenticated Gemini protocol',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-legacy-route-'))
 try{await writeFile(join(dir,'runtime.json'),JSON.stringify({port:18741}));await writeFile(join(dir,'proxy-key'),'fixture');const selected=await selectImagePool({geminiImagePoolDir:dir},model,signal,(async(url:any)=>String(url).endsWith('/images/v1/models')?new Response('',{status:404}):Response.json({models:[{name:'models/'+model}]})) as any);assert.equal(selected.protocol,'gemini-v1beta')}
 finally{await rm(dir,{recursive:true,force:true})}
})
test('DSH backend polls the same service job, forwards reference bytes, saves real attachments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-service-route-')),previousFetch=globalThis.fetch;let requests:any[]=[],saved:any[]=[]
 const ref={attachmentId:'reference',mediaType:'image/png'},store={readImage:async()=>({data:Buffer.from(pixel,'base64')}),saveImages:async(images:any[])=>{saved=images;return [{attachmentId:'output',mediaType:'image/png'}]}}
 try{await writeFile(join(dir,'runtime.json'),JSON.stringify({port:18741}));await writeFile(join(dir,'proxy-key'),'fixture')
  globalThis.fetch=(async(url:any,options:any)=>{
   if(String(url).endsWith('/models'))return Response.json({models:[{name:'models/'+model}]})
   requests.push(JSON.parse(options.body));return requests.length===1?Response.json({task:{state:'queued'},images:[]},{status:202}):Response.json({task:{state:'completed',model},images:[{mimeType:'image/png',data:pixel}]})
  }) as any
  const provider=await imageBackends({get:(name:string)=>name==='attachments'?store:null},{geminiImagePoolDir:dir}).gemini.prepare(signal)
  const result=await provider.generate({requestId:'session-scoped',executionId:'globally-unique',prompt:'edit duck',references:[ref]},signal)
  assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].requestId,'globally-unique');assert.equal(requests[0].references[0].data,pixel);assert.equal(saved[0].data.toString('base64'),pixel);assert.equal(result.images[0].attachmentId,'output');assert.equal(result.route,'local')
 }finally{globalThis.fetch=previousFetch;await rm(dir,{recursive:true,force:true})}
})

test('image backend reuses remote host authentication independently of the conversation provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-host-auth-route-')),previousFetch=globalThis.fetch,calls:{url:string,method:string}[]=[]
 const services={
  attachments:{saveImages:async()=>[{attachmentId:'remote-output',mediaType:'image/png'}]},
  settings:{get:()=>({providers:{'ag-pool-remote':{baseURL:'https://pool.example/v1',apiKeyEnv:'DMC_POOL_REF'}}})},
  credentials:{resolve:async(ref:string)=>ref==='DMC_POOL_REF'?{value:'fixture-host-key'}:undefined},
  // DeepSeek is the conversation model; it neither receives image bytes nor
  // contributes a key/URL to generation. The host pool remains a separate route.
  llm:{listProviders:()=>[{id:'deepseek-official'},{id:'ag-pool-remote'}]},
 }
 try{
  globalThis.fetch=(async(url:any,options:any)=>{
   assert.equal(options.headers.authorization,'Bearer fixture-host-key');assert.equal(options.redirect,'error')
   calls.push({url:String(url),method:options.method||'GET'})
   return options.method==='POST'?Response.json({task:{state:'completed',model},images:[{mimeType:'image/png',data:pixel}]}):Response.json({models:[{name:'models/'+model}]})
  }) as any
  const provider=await imageBackends({get:(name:keyof typeof services)=>services[name]},{geminiImagePoolDir:dir}).gemini.prepare(signal)
  const result=await provider.generate({requestId:'host-remote',executionId:'unique-remote',prompt:'duck',references:[]},signal)
  assert.equal(result.route,'ag-pool-remote');assert.equal(result.routeReason,'remote-provider-authenticated-model-available')
  assert.equal(result.images[0].attachmentId,'remote-output')
  assert.deepEqual(calls,[{url:'https://pool.example/images/v1/models',method:'GET'},{url:'https://pool.example/images/v1/generate',method:'POST'}])
  globalThis.fetch=(async(url:any,options:any)=>{calls.push({url:String(url),method:options.method||'GET'});throw Error('uncertain submit')}) as any
  await assert.rejects(provider.generate({requestId:'host-remote-2',executionId:'unique-remote-2',prompt:'duck',references:[]},signal),/uncertain submit/)
  assert.deepEqual(calls.slice(2),[{url:'https://pool.example/images/v1/generate',method:'POST'}])
 }finally{globalThis.fetch=previousFetch;await rm(dir,{recursive:true,force:true})}
})
