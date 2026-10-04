import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {readFileSync} from 'node:fs'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore} from '../src/tasks.js'
import {readStudioRepairRounds} from '../src/studio-repair-budget.js'

function setup(t:any){
 const db=new Database(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,tenant TEXT,round INTEGER,role TEXT,status TEXT); CREATE TABLE dsh_card_bindings(card_id TEXT PRIMARY KEY,spec_id TEXT,batch_id TEXT); CREATE TABLE dsh_studio_state(task_id TEXT,batch_id TEXT,kind TEXT,payload TEXT); CREATE TABLE dsh_studio_preparation(task_id TEXT,batch_id TEXT,round INTEGER);')
 const store={kernel:{db}},input={task:{id:'T'},batch:{id:'B'},card:{round:1}},add=(id:string,round:number,role:string,status='todo',batch='B',task='T')=>{db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(id,batch,round,role,status);db.prepare('INSERT INTO dsh_card_bindings VALUES(?,?,?)').run(id,task,batch)}
 const budget=(repairRounds:number)=>db.prepare("INSERT INTO dsh_studio_state VALUES('T','B','budget',?)").run(JSON.stringify({repairRounds,used:{imageCalls:3,voiceSegments:10},limits:{imageCalls:6,voiceSegments:80},maxRepairRounds:3}))
 return {db,store,input,add,budget,read:()=>readStudioRepairRounds(store,input)}
}
test('candidate revisions and the future decision planner do not consume repair rounds',t=>{
 const f=setup(t);f.add('p1',1,'planner');assert.equal(f.read(),0)
 for(const role of ['studio-stage','gate','executor','reviewer'])f.add('r1-'+role,1,role)
 f.add('p2',2,'planner');f.add('notice',12,'notifier')
 f.db.prepare("INSERT INTO dsh_studio_state VALUES('T','B','candidate',?)").run(JSON.stringify({candidate:{revision:99}}))
 assert.equal(f.read(),0);f.add('e2',2,'executor');assert.equal(f.read(),1)
})
test('counts distinct materialized rounds, not labels or run retries, and retains cancelled preparation',t=>{
 const f=setup(t);f.add('e1',1,'executor','cancelled');f.add('s1',1,'studio-stage','cancelled');f.add('e7',7,'executor');f.add('r7',7,'reviewer')
 assert.equal(f.read(),1);f.db.prepare("INSERT INTO dsh_studio_preparation VALUES('T','B',1)").run();assert.equal(f.read(),1)
 f.db.prepare("INSERT INTO dsh_studio_preparation VALUES('T','B',9)").run();assert.equal(f.read(),2)
 f.add('other-batch',100,'executor','done','other');f.add('other-task',100,'executor','done','B','other');assert.equal(f.read(),2)
})
test('persisted high water mark cannot reset or widen generation budgets',t=>{
 const f=setup(t);f.add('e1',1,'executor');f.budget(3)
 const before=f.db.prepare('SELECT * FROM dsh_studio_state').all();assert.equal(f.read(),3);assert.deepEqual(f.db.prepare('SELECT * FROM dsh_studio_state').all(),before)
 f.db.prepare("UPDATE dsh_studio_state SET payload=? WHERE kind='budget'").run(JSON.stringify({repairRounds:-1}));assert.throws(()=>f.read(),/invalid-recorded-count/)
})
test('service refresh paths all read production history instead of candidate revision',()=>{
 const source=readFileSync(new URL('../src/service.ts',import.meta.url),'utf8')
 assert.equal((source.match(/repairRounds:readStudioRepairRounds\(this\.runner\.store,input\)/g)??[]).length,3)
 assert.ok(!/repairRounds:Math\.max\(0,\(.*revision/.test(source))
})
test('actual Task expansion reserves a production round but not its next decision planner',async t=>{
 const root=await mkdtemp(join(tmpdir(),'studio-repair-round-test-')),store=new EventStore(root);await store.load()
 t.after(async()=>{store.kernel.close();await rm(root,{recursive:true,force:true})})
 const at=new Date().toISOString(),task:any={id:'T',title:'fixture',brief:'fixture',cwd:root,trigger:{kind:'once'},participants:[{agentId:'director'},{agentId:'editor'},{agentId:'quality'}],enabled:true,graphMode:'dynamic-rounds',timeoutSec:300,maxTries:3,onFail:'retry',createdAt:at,design:{evidenceContract:'studio-video-v1',failurePolicy:{maxAttempts:3},studio:{characterId:'test',referenceSha256:'a'.repeat(64),referenceUrl:'https://cdn.vyibc.com/ref.mp4'}}}
 await store.append({t:'task/created',at,taskId:'T',task})
 await store.createBatch(task,{t:'batch/fired',at,taskId:'T',batch:{id:'B',by:'manual',cards:[{id:'B#p1',agentId:'director',deps:[],kind:'agent',role:'planner',round:1}]}})
 const input={task,batch:store.s.batches.get('B')!,card:store.s.cards.get('B#p1')!}
 store.kernel.promoteReadyTasks();assert.ok(await store.claimCard(input.card.id,'p1#1','p1-session',1))
 assert.equal(readStudioRepairRounds(store,input),0)
 await store.expandRound(task,input.batch,input.card,'actual planned round')
 assert.ok(store.s.cards.get('B#p2'));assert.ok(store.s.cards.get('B#e1'));assert.equal(readStudioRepairRounds(store,input),0)
 // A same-round run retry and cancellation cannot add/refund an actual planned round.
 store.kernel.db.prepare("UPDATE tasks SET status='cancelled' WHERE id='B#e1'").run()
 assert.equal(readStudioRepairRounds(store,input),0)
})
