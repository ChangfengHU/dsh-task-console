import test from 'node:test'
import assert from 'node:assert/strict'
import {apply} from '../src/task-create-tools.ts'

test('all Creator tools pass the actual DSH defineTool parameter parser',async()=>{
 const previous=process.env.NODE_ENV
 delete process.env.NODE_ENV
 const registered:any[]=[]
 try{
  await apply({effect:(f:()=>any)=>f(),tools:{register:(tool:any)=>{registered.push(tool);return ()=>{}}}})
  assert.equal(registered.length,5)
  assert.ok(registered.some(tool=>tool.name==='task_create_studio_sources'))
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous}
})
