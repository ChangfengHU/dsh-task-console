import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {installFixedVision,FIXED_VISION_DESCRIPTION} from '../src/fixed-vision.ts'
const image={attachmentId:'owned-image',mediaType:'image/png',width:1,height:1,bytes:1}

async function fixture(options:{backendFailure?:boolean;textOnlyBackend?:boolean}={}){
 const root=new Context();root.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(root),routes:any[]=[],headers:any[]=[],references:any[]=[]
 const llm={resolveModelInfo:async(provider:string,model:string)=>{routes.push([provider,model]);return{inputModalities:options.textOnlyBackend?['text']:['text','image']}},prepareCall:async(config:any)=>({config,async *stream(input:any){
  assert.equal(input.tools.length,0);assert.equal(input.messages[0].content[1].type,'image');routes.push([input.provider,input.model]);if(options.backendFailure)throw Error('VISION_TEST_FAILURE')
  yield {type:'text-delta',id:'description',text:'橙色小猫戴蓝色围巾，白色背景，无文字。'}
  yield {type:'finish',reason:{kind:'stop'}}
 }})}
 const ctx={get:(name:string)=>name==='llm'?llm:name==='attachments'?{readImage:async()=>({data:new Uint8Array([1])})}:name==='nativeImages'?{jobs:{recordReference:(...args:any[])=>references.push(args)}}:undefined,effect:(fn:any)=>root.effect(fn),on:(...args:any[])=>root.on(...args as [any,any])}
 installFixedVision(ctx,{visionProvider:'fixed',visionModel:'vision'})
 const originalHeader={config:{provider:'chat',model:'text-only'}},session={id:'owner',header:{cwd:'/permitted-workspace'},requestHeader:()=>originalHeader}
 const agent:any={session,options:{provider:'chat',model:'text-only'}}
 const scope=createScope(root,agent);agent.ctx=scope.ctx
 scope.ctx.tools.register(defineTool({name:'read_image',description:'native gate',parameters:{file_path:{type:'string',required:true}},output:{schema:{type:'object',additionalProperties:true},render:(_:any,value:any)=>[{type:'image',attachment:value.image}]},async execute(_:any,exec:any){
  headers.push(exec.agent.session.requestHeader().config)
  assert.equal(exec.agent.session.header.cwd,'/permitted-workspace')
  return{path:'/permitted-workspace/probe.png',image}
 }}))
 const invoke=()=>runtime.execute({name:'read_image',arguments:{file_path:'probe.png'},agent,callId:'vision',signal:new AbortController().signal} as any)
 return{root,runtime,agent,session,originalHeader,invoke,routes,headers,references}
}
test('fixed vision returns observation text, leaves caller model untouched and preserves native read value',async()=>{
 const f=await fixture();try{
  const result=await f.invoke();assert.equal(result.isError,false);assert.deepEqual(result.content.map((b:any)=>b.type),['text'])
  const value=JSON.parse((result.content[0] as any).text);assert.match(value.observation,/橙色小猫/);assert.deepEqual(value.observer,{provider:'fixed',model:'vision'})
  assert.deepEqual(f.headers,[{provider:'fixed',model:'vision'}]);assert.equal(f.session.requestHeader(),f.originalHeader);assert.equal(f.agent.options.model,'text-only')
  assert.deepEqual(f.references,[['owner',image]]);assert.deepEqual((result as any).value.image,image)
  f.agent.options.model='another-chat';assert.equal((await f.invoke()).isError,false);assert.ok(f.routes.every(([p,m])=>p==='fixed'&&m==='vision'))
 }finally{await f.root.fiber.dispose()}
})
test('permission guard prevents both native image reads and fixed vision calls',async()=>{
 const f=await fixture();try{const undo=f.runtime.guard(()=> 'denied');assert.equal((await f.invoke()).isError,true);assert.equal(f.routes.length,0);assert.equal(f.headers.length,0);undo()}finally{await f.root.fiber.dispose()}
})
test('vision failure returns an error, never leaks native image blocks or grants reference ownership',async()=>{
 const f=await fixture({backendFailure:true});try{const result=await f.invoke();assert.equal(result.isError,true);assert.ok(result.content.every((b:any)=>b.type==='text'));assert.equal(f.references.length,0);assert.equal(f.session.requestHeader(),f.originalHeader)}finally{await f.root.fiber.dispose()}
})
test('text-only fixed backend is rejected before native filesystem read; tool description declares text output',async()=>{
 const f=await fixture({textOnlyBackend:true});try{assert.equal((await f.invoke()).isError,true);assert.equal(f.headers.length,0);assert.match(FIXED_VISION_DESCRIPTION,/不向聊天模型回传图片/)}finally{await f.root.fiber.dispose()}
})
test('post-execute denial never grants an edit reference or exposes an image',async()=>{
 const f=await fixture();try{
  f.root.on('tools/post-execute',async()=>({kind:'block',feedback:[{type:'text',text:'review denied'}]}))
  const result=await f.invoke();assert.equal(result.isError,true);assert.equal(f.references.length,0);assert.ok(result.content.every((b:any)=>b.type==='text'))
 }finally{await f.root.fiber.dispose()}
})
