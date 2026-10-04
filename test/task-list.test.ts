import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { taskListIndex } from '../src/task-list.ts'
import { TaskConsoleService } from '../src/service.ts'
import { QueryCache } from '../src/client/query-cache.ts'

test('task list pages summaries, keeps counts, filters and avoids historical handoffs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'task-page-')),store=new EventStore(root);await store.load()
  t.after(async()=>{store.kernel.db.close();await rm(root,{recursive:true,force:true})})
  for(let i=0;i<25;i++){
    const id=`T-${String(i).padStart(2,'0')}`, task:TaskSpec={id,title:id,brief:'brief '.repeat(1000),participants:[{agentId:'fixture',brief:'secret role prompt'}],trigger:{kind:'once'},enabled:true,cwd:root,timeoutSec:60,maxTries:1,onFail:'stop',createdAt:'2026-09-10T00:00:00Z'}
    await store.append({t:'task/created',at:task.createdAt,taskId:id,task})
    for(let j=0;j<3;j++){const batchId=`${id}-${j}`,at=new Date(Date.parse(task.createdAt)+j*1000).toISOString();await store.createBatch(task,{t:'batch/fired',at,taskId:id,batch:{id:batchId,by:'manual',cards:[{id:`${batchId}#0`,agentId:'fixture',deps:[]}]}})}
  }
  const first=taskListIndex(store), second=taskListIndex(store,{page:2}),third=taskListIndex(store,{page:3})
  assert.equal(first.rows.length,10);assert.equal(first.total,25)
  assert.equal(new Set([...first.rows,...second.rows,...third.rows].map(r=>r.task.id)).size,25)
  assert.equal(taskListIndex(store,{pageSize:100}).rows.length,10)
  assert.equal(taskListIndex(store,{query:'display'},new Map([['fixture','Display Name']])).total,25)
  assert.throws(()=>taskListIndex(store,{page:-1}))
  const service:any=Object.create(TaskConsoleService.prototype)
  service.runner={store};service.ready=Promise.resolve();service.ctx={get:()=>({list:async()=>[{id:'fixture',name:'Display Name'}]})};service.taskPageCache=new Map()
  const encoded=await service.taskPage('{}'), result=JSON.parse(encoded)
  assert.equal(result.rows.length,10);assert.equal(result.rows[0].history,3)
  assert.equal(result.rows[0].latest.id,'T-00-2');assert.ok(result.rows[0].task.brief.length<=240)
  assert.ok(!encoded.includes('secret role prompt'));assert.ok(!encoded.includes('handoff'));assert.ok(!encoded.includes(root))
  await store.append({t:'task/archived',at:'2026-09-21T00:00:00Z',taskId:'T-00',archived:true})
  assert.equal(JSON.parse(await service.taskPage('{}')).total,24)
})

test('query cache deduplicates, invalidates stale in-flight writes and bounds entries',async()=>{
  const cache=new QueryCache<number>(10000,2);let resolve!:(n:number)=>void,calls=0
  const a=cache.load('a',()=>{calls++;return new Promise<number>(r=>resolve=r)}),b=cache.load('a',async()=>99)
  await Promise.resolve();assert.equal(calls,1);assert.equal(a,b)
  cache.clear();resolve(1);await a;assert.equal(cache.peek('a'),undefined)
  await cache.load('a',async()=>2);await cache.load('b',async()=>3);await cache.load('c',async()=>4)
  assert.equal(cache.peek('a'),undefined);assert.equal(cache.peek('c'),4)
})
