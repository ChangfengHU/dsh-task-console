import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore} from '../src/tasks.js'
import {StudioInterventions} from '../src/studio-interventions.js'
const context={taskId:'T',batchId:'B'}
const entry={...context,id:'recover:r1',cardId:'c',sourceRunId:'run1',kind:'operator-recovery',reason:'Restored host cache'}
async function setup(t:any){const root=await mkdtemp(join(tmpdir(),'studio-audit-')),store=new EventStore(root);await store.load();t.after(async()=>{store.kernel.close();await rm(root,{recursive:true,force:true})});return {store,audit:new StudioInterventions(store)}}
test('global identity, stable replay timestamps and cross-context conflict on real SQLite',async t=>{
 const {store,audit}=await setup(t),first=audit.record(entry)
 assert.equal(first.replay,false);assert.deepEqual(audit.record(entry),{...first,replay:true})
 for(const change of [{batchId:'other'},{taskId:'other'},{reason:'Different'},{sourceRunId:'run2'},{kind:'other'}])assert.throws(()=>audit.record({...entry,...change}),/id-conflict/)
 const reload=new EventStore(store.root);await reload.load();try{assert.deepEqual(new StudioInterventions(reload).record(entry),{...first,replay:true})}finally{reload.kernel.close()}
 assert.equal(audit.assessment(context).status,'assisted');assert.equal(audit.assessment(context).autonomousVerified,false)
 assert.equal(audit.assessment({...context,batchId:'other'}).status,'no_recorded_intervention')
})
test('constructor and record join outer transition and roll back with failed recovery',async t=>{
 const {store,audit}=await setup(t)
 await assert.rejects(store.transition(()=>{new StudioInterventions(store).record(entry);throw Error('recovery failed')},()=>undefined),/recovery failed/)
 assert.deepEqual(audit.list(context),[])
 await store.transition(()=>new StudioInterventions(store).record(entry),()=>undefined)
 assert.equal(audit.list(context).length,1)
})
test('legacy records stay visible without fabricating registration time or autonomy proof',async t=>{
 const {store,audit}=await setup(t)
 store.kernel.db.exec('CREATE TABLE dsh_studio_state(task_id TEXT,batch_id TEXT,kind TEXT,payload TEXT)')
 store.kernel.db.prepare('INSERT INTO dsh_studio_state VALUES(?,?,?,?)').run('T','B','interventions',JSON.stringify([{reason:'Old rescue',at:'2026-09-24T12:00:00.000Z'}]))
 audit.record(entry);const result=audit.assessment(context)
 assert.equal(result.records.length,2);assert.equal(result.records[1].source,'legacy');assert.equal(result.records[1].registeredAt,'');assert.equal(result.autonomousVerified,false)
 assert.deepEqual(audit.list(context),result.records)
})
test('reasons redact common secrets; explicit occurrence time is retained and conflicts reject',async t=>{
 const {audit}=await setup(t),occurredAt='2026-09-24T11:00:00.000Z'
 const value={...entry,reason:'Bearer sensitive-value token=secret-value https://host/path?key=secret',occurredAt}
 const r=audit.record(value).record;assert.equal(r.occurredAt,occurredAt);assert.ok(r.registeredAt);assert.doesNotMatch(r.reason,/sensitive-value|secret-value|https:\/\//)
 assert.equal(audit.record(value).replay,true);assert.throws(()=>audit.record({...value,occurredAt:'2026-09-25T11:00:00.000Z'}),/id-conflict/)
})
