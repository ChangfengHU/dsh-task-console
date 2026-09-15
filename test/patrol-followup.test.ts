import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/tasks.ts'
import { BrowserPatrolWorkflow } from '../src/browser-patrol-workflow.ts'
import { TaskNotifications,patrolNotificationMarkdown } from '../src/task-notifications.ts'
import { patrolFollowup } from '../src/patrol-followup.ts'
import { resendPatrolReport } from '../src/patrol-resend.ts'
import { handleTaskSignalHttp } from '../src/task-intake-http.ts'
import { validateWorkflowBlock } from '../src/workflow-acceptance.ts'

async function fixture(t:any){
  const root=await mkdtemp(join(tmpdir(),'patrol-followup-test-')),store=new EventStore(root);await store.load()
  t.after(async()=>{store.kernel.db.close();await rm(root,{recursive:true,force:true})})
  new BrowserPatrolWorkflow(store).capture({task:{design:{evidenceContract:'browser-patrol-v2'}},card:{},batch:{id:'b-fixture'},profileId:'browser-manager',sessionId:'fixture'} as any,[]);new TaskNotifications(store)
  const db=store.kernel.db,design={evidenceContract:'browser-patrol-v2',failurePolicy:{maxAttempts:3},notifications:{agentId:'notifier',chatIds:['fixture-group']}}
  db.prepare('INSERT INTO dsh_task_specs VALUES (?,?,1,1)').run('T-fixture',JSON.stringify({design,title:'NEVER-EXPOSE-private-input'}))
  db.prepare('INSERT INTO dsh_batches(id,spec_id,fired_by,fired_at) VALUES (?,?,?,?)').run('b-fixture','T-fixture','cron',1)
  db.prepare("INSERT INTO tasks(id,title,status,priority,created_by,created_at,tenant,role) VALUES ('card','fixture','blocked',0,'test',1,'b-fixture','executor')").run()
  db.prepare("INSERT INTO dsh_card_bindings VALUES ('card','T-fixture','b-fixture',0,'')").run()
  db.prepare('INSERT INTO dsh_patrol_inventory VALUES (?,?,?)').run('b-fixture',JSON.stringify({nodes:[{ip:'192.0.2.10',nodeId:'host-test',browsers:[{instance:1}]}]}),'fixture-session')
  db.prepare("INSERT INTO dsh_patrol_observations(batch_id,target_key,card_id,session_id,role,checked_at,state) VALUES ('b-fixture','192.0.2.10:1','card','s','reviewer','2026-01-01T00:00:00Z','signed_out')").run()
  db.prepare("INSERT INTO dsh_browser_issues VALUES (1,'T-fixture','192.0.2.10:1','open',3,'2026-01-01T00:00:00Z',NULL)").run()
  db.prepare("INSERT INTO dsh_browser_operations VALUES ('op',1,'b-fixture','card','login-provision','2026-01-01T00:00:00Z')").run()
  db.prepare("INSERT INTO dsh_browser_operation_outcomes VALUES ('op','imported','sign-in-required','2026-01-01T00:00:00Z')").run()
  return{db,store,design}
}
test('Fleet projection separates observed login, handling and notification without exposing prompts',async t=>{
  const {db}=await fixture(t),before=db.prepare('SELECT COUNT(*) n FROM task_events').get()
  const result=patrolFollowup(db);assert.equal(result.items[0].treatment,'unresolved');assert.equal(result.items[0].repairExhausted,true)
  assert.match(result.items[0].reason,/已导入登录资料/);assert.match(result.items[0].next,/累计修复上限/)
  assert.equal(result.tasks[0].state,'blocked');assert.equal(result.items[0].notification,null)
  assert.doesNotMatch(JSON.stringify(result),/NEVER-EXPOSE|fixture-group/)
  assert.deepEqual(db.prepare('SELECT COUNT(*) n FROM task_events').get(),before)
})
test('operator resend is explicitly recipient-pinned, append-only and idempotent even after an ambiguous send',async t=>{
  const {db}=await fixture(t);let sends=0
  const deliver=async(a:any)=>{sends++;assert.deepEqual(a.chatids,['fixture-group']);assert.match(a.markdown,/已达累计修复上限/);return{sent:1}}
  const one=await resendPatrolReport(db,'T-fixture','request-one','https://dsh.example',deliver)
  assert.equal(one[0].state,'sent');await resendPatrolReport(db,'T-fixture','request-one','https://dsh.example',deliver);assert.equal(sends,1)
  const uncertain=async()=>{sends++;throw Error('network')}
  assert.equal((await resendPatrolReport(db,'T-fixture','request-two','https://dsh.example',uncertain))[0].state,'unknown')
  await resendPatrolReport(db,'T-fixture','request-two','https://dsh.example',deliver);assert.equal(sends,2)
  assert.equal((db.prepare('SELECT attempts FROM dsh_browser_issues').get() as any).attempts,3)
  assert.equal((db.prepare('SELECT status FROM tasks').get() as any).status,'blocked')
})
test('followup HTTP reuses server authentication and cannot submit through read endpoint',async()=>{
  let reads=0;const service={patrolFollowup:async()=>{reads++;return{schemaVersion:1,tasks:[],items:[]}}}
  for(const [method,token,status] of [['GET','wrong',401],['POST','secret',405],['GET','secret',200]]){
    let code=0;const req={method,url:'/dsh-task-console/api/patrol-followup',headers:{authorization:'Bearer '+token}},res={writeHead:(v:number)=>{code=v},end:()=>{}}
    await handleTaskSignalHttp(req,res,service,'secret');assert.equal(code,status)
  }assert.equal(reads,1)
})
test('completed receipt rejects stale running block but preserves other real blockers',async()=>{
  const id='a'.repeat(32),input:any={profileId:'browser-manager',sessionId:'s',metadata:{requestedBlock:{kind:'transient',reason:'operation '+id+' still running'}}}
  const deps={jobs:async()=>[{id,phase:'complete',args:{sessionId:'s'},updatedAt:new Date().toISOString()}]}
  await assert.rejects(validateWorkflowBlock(input,deps),/已结束为 complete/)
  input.metadata.requestedBlock={kind:'needs_input',reason:'请用户进行验证'};await validateWorkflowBlock(input,deps)
})
test('plain-language notification leads with failures rather than every healthy browser',()=>{
  const text=patrolNotificationMarkdown('unresolved',{summary:'2个检查时未登录',items:[{ip:'192.0.2.10',instance:1,state:'signed_out',accepted:false,attempts:3,repairExhausted:true,loginDelivery:{mutation:'imported'}}]},'T-fixture','b-fixture','id')
  assert.match(text,/已处理，未解决/);assert.match(text,/导入登录资料/);assert.match(text,/暂停自动重试/)
})
