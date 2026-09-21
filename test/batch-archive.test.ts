import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { TaskConsoleService } from '../src/service.ts'
import { TaskRunner } from '../src/runner.ts'

test('archive one parked execution without deleting its evidence or changing the reusable Task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tc-batch-archive-')), store = new EventStore(root)
  await store.load()
  t.after(async () => { if (store.kernel.db.open) store.kernel.db.close(); await rm(root, { recursive: true, force: true }) })
  const task: TaskSpec = { id:'fixture', title:'fixture', brief:'fixture', trigger:{kind:'once'}, participants:[{agentId:'browser-manager'}], cwd:root, timeoutSec:60, onFail:'stop', maxTries:1, enabled:true, createdAt:'2026-09-10T00:00:00Z' }
  await store.append({t:'task/created',at:task.createdAt,taskId:task.id,task})
  await store.createBatch(task,{t:'batch/fired',at:task.createdAt,taskId:task.id,batch:{id:'old',by:'manual',cards:[{id:'old#0',agentId:'browser-manager',deps:[]}]}})
  await assert.rejects(store.setBatchArchived(task.id,'old',true),/待执行|仍在执行/)
  const claim=await store.claimCard('old#0','old-run','old-session',1)
  assert.ok(claim)
  await assert.rejects(store.setBatchArchived(task.id,'old',true),/仍在执行/)
  await store.transition(()=>store.kernel.blockTask('old#0',{expectedRunId:claim.run.id,reason:'fixture challenge',kind:'needs_input'}),ok=>ok?{t:'run/blocked',at:task.createdAt,taskId:task.id,runId:'old-run',kind:'needs_input',reason:'fixture challenge'}:undefined)
  const graph=store.graphSnapshot(task.id,'old'), beforeEvents=store.all().length
  await assert.rejects(store.setBatchArchived('another-task','old',true),/不属于/)
  const service:any=Object.create(TaskConsoleService.prototype)
  service.ready=Promise.resolve(); service.runner={store}
  await assert.rejects(service.setBatchArchived(JSON.stringify({taskId:task.id,batchId:'old',archived:'true'})),/明确/)
  const request=JSON.stringify({taskId:task.id,batchId:'old',archived:true})
  assert.equal(JSON.parse(await service.setBatchArchived(request)).changed,true)
  assert.equal(JSON.parse(await service.setBatchArchived(request)).changed,false)
  assert.equal(store.all().length,beforeEvents+1)
  assert.ok(store.s.batches.get('old')?.archivedAt)
  assert.deepEqual(store.graphSnapshot(task.id,'old'),graph)
  assert.equal(store.s.cards.get('old#0')?.status,'blocked')
  assert.equal(store.tasks.get(task.id)?.enabled,true)
  assert.equal(JSON.parse(await service.tasks()).runs.length,0)
  assert.equal(JSON.parse(await service.taskSnapshot(JSON.stringify({id:task.id}))).batchId,null)
  assert.equal(JSON.parse(await service.taskSnapshot(JSON.stringify({id:task.id,batchId:'old'}))).batchId,'old')
  assert.equal(await store.claimCard('old#0','forged-run','forged-session',2),undefined)
  const runner=new TaskRunner({} as any,store)
  await assert.rejects(runner.unblockCard('old#0'),/归档/)
  await assert.rejects(runner.cancelBatch('old'),/归档/)
  store.kernel.db.close(); await store.load()
  assert.ok(store.s.batches.get('old')?.archivedAt)
  assert.deepEqual(store.graphSnapshot(task.id,'old'),graph)
  await store.createBatch(task,{t:'batch/fired',at:'2026-09-10T01:00:00Z',taskId:task.id,batch:{id:'new',by:'manual',cards:[{id:'new#0',agentId:'browser-manager',deps:[]}]}})
  assert.equal(JSON.parse(await service.taskSnapshot(JSON.stringify({id:task.id}))).batchId,'new')
  assert.deepEqual(JSON.parse(await service.tasks()).runs.map((r:any)=>r.id),['new'])
  assert.equal(store.s.tasks.size,1); assert.equal(store.s.batches.size,2)
  await store.setBatchArchived(task.id,'old',false)
  assert.equal(store.s.cards.get('old#0')?.status,'blocked') // restoring visibility never unblocks it
  assert.equal(store.s.runs.get('old-run')?.sessionId,'old-session')
})
