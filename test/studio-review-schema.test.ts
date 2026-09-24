import test from 'node:test'
import assert from 'node:assert/strict'
import {defineTool,ToolRuntime} from '@deepseek-ai/dsh-tools'
import {STUDIO_REVIEW_PARAMETERS,validateReviewShape} from '../src/studio-review-schema.ts'
test('actual SDK accepts nested review schema and publishes required fields and status enums',()=>{
 const tool=defineTool({name:'review_fixture',description:'fixture',parameters:STUDIO_REVIEW_PARAMETERS,output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({})})
 const schema:any=tool.parameters
 assert.ok(schema);const text=JSON.stringify(schema)
 for(const field of ['finding','ranges','evidenceReceiptIds','severity','pending'])assert.ok(text.includes(field))
})
test('actual failed report shape produces aggregated actionable errors without rewriting it',()=>{
 const input={checks:[{dimension:'motion',status:'blocker',evidence:'static frames'}],issues:[{severity:'major',time:'0-2',fix:'repair motion'}]},before=JSON.stringify(input)
 assert.throws(()=>validateReviewShape(input),(e:any)=>{const info=JSON.parse(e.message.split(': ').slice(1).join(': '));assert.equal(info.stored,false);assert.deepEqual(info.issues.map((v:any)=>v.path),['checks[0].status','checks[0].finding','checks[0].ranges','checks[0].evidenceReceiptIds','issues[0].id','issues[0].status']);return true})
 assert.equal(JSON.stringify(input),before)
})
test('well-shaped rejection can reach integrity gate without fabricated evidence for pending dimensions',()=>{
 const input={checks:[{dimension:'motion',status:'fail',finding:'No change in this sampled window.',ranges:[[0,2]],evidenceReceiptIds:['host-receipt']},{dimension:'mix',status:'pending',finding:'Not checked.',ranges:[[0,98.6]],evidenceReceiptIds:[]}],issues:[{id:'motion-1',severity:'major',status:'open',time:'0-2'}]}
 assert.doesNotThrow(()=>validateReviewShape(input))
})


test('actual native runtime rejects malformed report before executing and accepts explicit pending shape',async()=>{
 const {createRequire}=await import('node:module'),{pathToFileURL}=await import('node:url'),{dirname}=await import('node:path'),require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),agent={ctx,session:{id:'review-schema-test'}};let calls=0
 const dispose=runtime.register(defineTool({name:'review_fixture',description:'fixture',parameters:STUDIO_REVIEW_PARAMETERS,output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(a:any)=>{validateReviewShape(a);calls++;return {qualityApproved:false}}}))
 const invoke=(args:any)=>runtime.execute({name:'review_fixture',arguments:args,agent,callId:'shape-test',signal:new AbortController().signal} as any)
 try{
  const bad=await invoke({checks:[{dimension:'motion',status:'blocker',evidence:'static'}],issues:[{severity:'major'}]});assert.equal(bad.isError,true);assert.equal(calls,0)
  const good=await invoke({checks:[{dimension:'motion',status:'pending',finding:'Not inspected.',ranges:[[0,2]],evidenceReceiptIds:[]}],issues:[]});assert.equal(good.isError,false);assert.equal(calls,1)
 }finally{dispose()}
})
