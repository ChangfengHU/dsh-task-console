import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, foldTurns, type TaskSpec } from '../src/tasks.ts'
import { appendGraphPage } from '../src/client/graph-stream.ts'
import { replayGraph, type GraphSnapshot } from '../src/graph-data.ts'
import { ledgerPage } from '../src/ledger-page.ts'

test('graph pages and incremental tail reproduce the complete canonical history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tc-graph-page-')), store = new EventStore(root)
  await store.load()
  t.after(async () => { store.kernel.db.close(); await rm(root, { recursive: true, force: true }) })
  const task: TaskSpec = { id:'fixture', title:'fixture', brief:'fixture', trigger:{kind:'once'}, participants:[{agentId:'fixture'}], cwd:root, timeoutSec:60, onFail:'stop', maxTries:1, enabled:true, createdAt:'2026-09-22T00:00:00Z' }
  await store.append({t:'task/created',at:task.createdAt,taskId:task.id,task})
  await store.createBatch(task,{t:'batch/fired',at:task.createdAt,taskId:task.id,batch:{id:'batch',by:'manual',cards:[{id:'batch#0',agentId:'fixture',deps:[]}]}})
  const insert = store.kernel.db.prepare("INSERT INTO task_events(task_id,kind,payload,created_at,graph_id) VALUES ('batch#0','fixture','{}',1,'batch')")
  for (let i=0;i<430;i++) insert.run()
  let merged: GraphSnapshot | null = null
  do {
    const page = store.graphSnapshot(task.id, 'batch', merged?.events.at(-1)?.id ?? 0)
    assert.ok(page.events.length <= 200)
    merged = appendGraphPage(merged, page)
  } while (merged.eventPage?.hasMore)
  const full = store.graphSnapshot(task.id, 'batch')
  assert.deepEqual(merged.events, full.events)
  assert.deepEqual(replayGraph(merged.events), replayGraph(full.events))
  assert.equal(replayGraph(merged.events, 0).runs.length, 0)
  assert.equal(store.graphSnapshot(task.id, 'batch', merged.eventPage!.next).events.length, 0)
  insert.run()
  const tail = store.graphSnapshot(task.id, 'batch', merged.eventPage!.next)
  assert.equal(tail.events.length, 1)
  assert.equal(appendGraphPage(merged, tail).events.length, full.events.length + 1)
  assert.throws(() => appendGraphPage(merged, {...tail, graphId:'other'}), /mismatch/)
  assert.throws(() => store.graphSnapshot(task.id, 'batch', -1), /cursor/)
})

test('Trace pages within a single long turn, preserving full-session totals', () => {
  const base = foldTurns('fixture', [])
  const steps = Array.from({length:23}, (_,step) => ({step,at:'',ms:0,usage:{input:0,output:0,reasoning:0,cacheRead:0},tools:[],text:`response-${step}`}))
  const ledger = {...base,turns:[{turn:1,at:'',user:'request',steps}]}
  const pages = [1,2,3].map(page=>ledgerPage(ledger,page))
  assert.deepEqual(pages.map(p=>p.turns[0].steps.length),[10,10,3])
  assert.deepEqual(pages.flatMap(p=>p.turns.flatMap(t=>t.steps)),steps)
  assert.deepEqual(pages[0].totals,ledger.totals)
  assert.equal(ledgerPage(ledger,99).pagination?.page,3)
  assert.throws(()=>ledgerPage(ledger,-1),/page/)
})
