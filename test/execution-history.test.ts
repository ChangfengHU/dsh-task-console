import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { executionHistory } from '../src/execution-history.ts'
import { TaskConsoleService } from '../src/service.ts'

test('execution history pages lightweight rows with explicit task, status and archive filters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tc-execution-list-')), store = new EventStore(root)
  await store.load()
  t.after(async () => { store.kernel.db.close(); await rm(root, { recursive: true, force: true }) })
  for (const id of ['A', 'B', 'hidden']) {
    const task: TaskSpec = { id, title:`Workflow ${id}`, brief:'private prompt must not appear in a listing', participants:[{agentId:'fixture'}], trigger:{kind:'once'}, enabled:true, cwd:root, timeoutSec:60, maxTries:1, onFail:'stop', createdAt:'2026-09-10T00:00:00Z' }
    await store.append({ t:'task/created',at:task.createdAt,taskId:id,task })
  }
  for (let i = 0; i < 28; i++) {
    const taskId = i < 25 ? 'A' : i < 27 ? 'B' : 'hidden', task = store.tasks.get(taskId)!
    const id = `batch-${String(i).padStart(2,'0')}`, at = new Date(Date.parse(task.createdAt) + i*1000).toISOString()
    await store.createBatch(task,{ t:'batch/fired',at,taskId,batch:{id,by:'manual',cards:[{id:`${id}#0`,agentId:'fixture',deps:[]}]}})
    if (i !== 26) await store.append({t:'batch/settled',at,taskId,batchId:id,outcome:i%2===0?'done':'failed'})
  }
  await store.append({t:'batch/archived',at:'2026-09-10T01:00:00Z',taskId:'A',batchId:'batch-00',archived:true})
  await store.append({t:'task/archived',at:'2026-09-10T01:00:00Z',taskId:'hidden',archived:true})
  const first = executionHistory(store), second = executionHistory(store,{page:2}), third = executionHistory(store,{page:99})
  assert.equal(first.total,26); assert.equal(first.rows.length,10); assert.equal(first.pages,3)
  assert.equal(third.page,3); assert.equal(third.rows.length,6)
  assert.equal(new Set([...first.rows,...second.rows,...third.rows].map(r=>r.id)).size,26)
  assert.equal(first.rows[0].id,'batch-26'); assert.equal(first.rows[0].status,'running')
  assert.equal(executionHistory(store,{includeArchived:true}).total,27) // archived Tasks are still hidden globally
  assert.equal(executionHistory(store,{taskId:'A'}).total,24)
  assert.equal(executionHistory(store,{taskId:'A',includeArchived:true}).total,25)
  assert.equal(executionHistory(store,{taskId:'B',status:'active'}).total,1)
  assert.equal(executionHistory(store,{taskId:'B',status:'failed'}).total,1)
  assert.equal(executionHistory(store,{taskId:'B',status:'done'}).total,0)
  assert.equal(executionHistory(store,{query:'WORKFLOW B'}).total,2)
  assert.equal(executionHistory(store,{query:'batch-24'}).rows[0].id,'batch-24')
  assert.equal(executionHistory(store,{query:'#BATCH-24'}).rows[0].id,'batch-24')
  assert.equal(executionHistory(store,{query:"' OR 1=1 --"}).total,0)
  assert.equal(executionHistory(store,{query:'%'}).total,0)
  assert.equal(executionHistory(store,{page:-3}).page,1)
  assert.doesNotMatch(JSON.stringify(first),/private prompt|payload|turn_json|summary|metadata/)
  assert.deepEqual(first.tasks.map(t=>t.id),['A','B'])
  assert.throws(()=>executionHistory(store,{taskId:'missing'}),/没有这个任务/)
  assert.throws(()=>executionHistory(store,{includeArchived:'false'} as any),/无效/)
  assert.throws(()=>executionHistory(store,{status:'invented'} as any),/无效/)
  assert.throws(()=>executionHistory(store,null as any),/无效/)
  const before = store.all().length
  const service:any = Object.create(TaskConsoleService.prototype); service.ready=Promise.resolve(); service.runner={store}
  assert.deepEqual(JSON.parse(await service.executionHistory(JSON.stringify({taskId:'A',page:2}))),executionHistory(store,{taskId:'A',page:2}))
  assert.equal(store.all().length,before)
})
