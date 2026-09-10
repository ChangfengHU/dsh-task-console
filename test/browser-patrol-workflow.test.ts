import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/tasks.ts'
import { BrowserPatrolWorkflow } from '../src/browser-patrol-workflow.ts'
import { TaskNotifications } from '../src/task-notifications.ts'
import { validateDesign } from '../src/task-design.ts'
import { publicToolName, assertBrowserSession } from '../src/filtered-mcp-client.ts'

const design = validateDesign({ evidenceContract: 'browser-patrol-v2', browserPatrol: { scope: 'fleet-existing-authorized', actions: ['provision','resume'], observationMinutes: 20, minSamples: 4 },
  scope: 'Fixture only', branches: [{ id: 'check', when: 'due', action: 'read', evidence: 'receipt' }], coordination: 'independent reviewer', failurePolicy: { isolateItems: true, maxAttempts: 3, stopConditions: ['challenge'] }, acceptance: ['real login'] })
async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(),'tc-patrol-')), store = new EventStore(root); await store.load()
  t.after(async()=>{store.kernel.db.close();await rm(root,{recursive:true,force:true})})
  const input: any = { task: { id:'fixture', design, graphMode:'dynamic-rounds' }, batch:{ id:'batch',firedAt:new Date(Date.now()-60*60_000).toISOString() }, card:{id:'batch#p1',role:'planner',round:1}, profileId:'fleet-ops-planner',sessionId:'task-fixture-planner' }
  store.kernel.db.prepare("INSERT INTO tasks(id,title,status,priority,created_by,created_at,tenant) VALUES (?,?, 'running',0,'test',?,'batch')").run(input.card.id,'Fixture',Date.now()/1000)
  const patrol = new BrowserPatrolWorkflow(store)
  patrol.capture(input,pair(input,1,'browser_fleet_inventory',{}, {ok:true,nodes:[{ip:'192.0.2.10',nodeId:'fixture-node',readAuthorized:true,reachable:true,browsers:[{instance:1,loginAuthorized:true}]}]}))
  return { store, patrol, input }
}
function pair(input: any,seq: number,raw: string,args: any,value: any) {
  return [{type:'tool/call',seq,data:{callId:`c${seq}`,name:publicToolName(`fleet-browser-${input.profileId}`,raw),arguments:JSON.stringify(args)}},
    {type:'tool/result',seq:seq+1,data:{message:{content:[{type:'tool-result',toolCallId:`c${seq}`,content:[{type:'text',text:JSON.stringify(value)}]}]}}}]
}
function proof(input: any,at: number,state='verified',seq=10) {
  const checkedAt = new Date(at).toISOString(), id=String(seq).padStart(32,'0')
  return pair(input,seq,'browser_status',{ip:'192.0.2.10',operationId:id},{id,action:'login-verify',phase:'complete',updatedAt:checkedAt,args:{ip:'192.0.2.10',instance:1,sessionId:input.sessionId},result:{verification:{instance:1,loginVerified:state==='verified',identity:{gemini:state==='verified'?'in':'out',account:{source:'gemini-account-control',fingerprint:'01234567'}},loginVerification:{checkedAt,expiresAt:new Date(at+10*60_000).toISOString(),status:state}}}})
}
test('scope freezes atomically, unknown never grants copy and invented target is denied',async t=>{
  const {input,patrol,store}=await setup(t)
  const row={ip:'192.0.2.10',instance:1,action:'provision',reason:'fixture'}
  assert.throws(()=>patrol.plan(input,[row]),/未登录证据/)
  assert.throws(()=>patrol.plan(input,[{...row,instance:2}]),/真实可读清单/)
  patrol.capture(input,proof(input,Date.now(),'signed_out'))
  const plan=patrol.plan(input,[row])!
  // No rows until the DAG transaction commits, and rollback leaves neither grant nor event.
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_patrol_round_items').get() as any).n,0)
  assert.throws(()=>store.kernel.compose(()=>{ plan.commit();throw Error('injected graph failure') }),/injected graph failure/)
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_patrol_round_items').get() as any).n,0)
  store.kernel.compose(()=>plan.commit())
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_patrol_round_items').get() as any).n,1)
  assert.throws(()=>store.kernel.compose(()=>plan.commit()),/已冻结/)
})
test('only independent real receipts pass; changed target needs distinct samples spanning the window',async t=>{
  const {input,patrol,store}=await setup(t), now=Date.now()
  patrol.capture(input,proof(input,now))
  assert.equal(patrol.status(input,now).ready,false)
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now))
  assert.equal(patrol.status(reviewer,now).ready,true)
  const db=store.kernel.db
  db.prepare("INSERT INTO dsh_browser_issues(spec_id,target_key,status,attempts,opened_at) VALUES ('fixture','192.0.2.10:1','open',1,?)").run(new Date(now-30*60_000).toISOString())
  db.prepare("INSERT INTO dsh_browser_operations VALUES ('operation',1,'batch','batch#e1','login-provision',?)").run(new Date(now-30*60_000).toISOString())
  assert.equal(patrol.status(reviewer,now).ready,false)
  patrol.capture(reviewer,proof(reviewer,now)) // polling one receipt must not add another sample
  assert.equal(patrol.status(reviewer,now).items[0].observation.samples,1)
  const history=[-21,-14,-7].flatMap((m,i)=>proof(reviewer,now+m*60_000,'verified',30+i))
  patrol.capture(reviewer,history)
  assert.equal(patrol.status(reviewer,now).ready,true)
  patrol.capture(reviewer,proof(reviewer,now+60_000,'unknown',50))
  assert.equal(patrol.status(reviewer,now+60_000).ready,false)
  assert.throws(()=>patrol.complete(input),/不能收口/)
})
test('an unreachable zero-observation node remains uncovered, not an empty success',async t=>{
  const {input,patrol,store}=await setup(t)
  store.kernel.db.prepare('UPDATE dsh_patrol_inventory SET inventory_json=?').run(JSON.stringify({nodes:[{nodeId:'unreachable',reachable:false,browsers:[]}]}))
  assert.equal(patrol.status(input).ready,false)
  assert.equal(patrol.status(input).uncovered.length,1)
})
test('an uncovered node can close unresolved after unchanged independent checks expire, never pass',async t=>{
  const {input,patrol,store}=await setup(t), now=Date.now()
  const inventory=JSON.parse((store.kernel.db.prepare('SELECT inventory_json FROM dsh_patrol_inventory').get() as any).inventory_json)
  inventory.nodes.push({nodeId:'unreachable',reachable:false,readAuthorized:false,browsers:[]})
  store.kernel.db.prepare('UPDATE dsh_patrol_inventory SET inventory_json=?').run(JSON.stringify(inventory))
  assert.equal(patrol.status(input,now).canCloseUnresolved,false) // missing checks are not excused
  patrol.capture(input,proof(input,now-11*60_000))
  assert.equal(patrol.status(input,now).canCloseUnresolved,false) // executor-only proof is insufficient
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now-11*60_000))
  const report=patrol.status(input,now)
  assert.equal(report.ready,false)
  assert.equal(report.items[0].accepted,false)
  assert.equal(report.items[0].reason,'not-currently-verified')
  assert.equal(report.uncovered.length,1)
  assert.equal(report.canCloseUnresolved,true)
  assert.throws(()=>patrol.complete(input),/不能收口/)
  assert.equal(patrol.complete({...input,metadata:{patrolDisposition:'unresolved'}}).metadata.workflowOutcome,'unresolved')
  // A changed target still needs its independent stability window; expiry does not waive it.
  store.kernel.db.prepare("INSERT INTO dsh_browser_issues(spec_id,target_key,status,attempts,opened_at) VALUES ('fixture','192.0.2.10:1','open',1,?)").run(new Date(now-30*60_000).toISOString())
  assert.equal(patrol.status(input,now).canCloseUnresolved,false)
})
test('without a coverage gap, expired evidence does not bypass the ordinary recheck policy',async t=>{
  const {input,patrol}=await setup(t), now=Date.now()
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now-11*60_000))
  assert.equal(patrol.status(input,now).ready,false)
  assert.equal(patrol.status(input,now).canCloseUnresolved,false)
})
test('a model cannot impersonate another Task session in Browser MCP arguments',()=>{
  assert.throws(()=>assertBrowserSession('browser_login_provision',{sessionId:'agent-browser-manager-forged'},{agent:{session:{id:'task-real'}}}),/must match/)
  assert.doesNotThrow(()=>assertBrowserSession('browser_login_verify',{sessionId:'task-real'},{agent:{session:{id:'task-real'}}}))
})
test('a round past the reviewed budget cannot queue a misleading rework notification',async t=>{
  const {input,store}=await setup(t), outbox=new TaskNotifications(store)
  input.card.round=design.failurePolicy.maxAttempts+1
  input.task={...input.task,design:{...design,notifications:{channel:'wecom',agentId:'wecom-notifier',chatIds:['fixture-group']}}}
  let created=0
  store.createNotification=async()=>{created++;return 'fixture-notice'}
  await assert.rejects(outbox.request(input,'rework',{ready:false}),/回合上限/)
  assert.equal(created,0)
  await outbox.request(input,'unresolved',{ready:false})
  assert.equal(created,1) // reporting the actual unresolved outcome remains possible
})
test('WeCom outbox requires reviewed recipients, deduplicates and never repeats ambiguous delivery',async t=>{
  const {input,store}=await setup(t), outbox=new TaskNotifications(store), calls:any[]=[]
  const report={ready:false,reason:'fixture',items:[]}
  await assert.rejects(outbox.send(input,'started',report,async()=>{}),/收件群/)
  input.task={...input.task,design:{...design,notifications:{channel:'wecom',chatIds:['fixture-group']}}}
  const send=async(args:any)=>{calls.push(args);return {sent:1,node:'fixture-node'}}
  assert.equal((await outbox.send(input,'started',report,send)).notifications[0].state,'sent')
  await outbox.send(input,'started',report,send);assert.equal(calls.length,1)
  assert.deepEqual(calls[0].chatids,['fixture-group'])
  const unknown=async()=>{calls.push('timeout');throw Error('simulated ambiguous transport')}
  assert.equal((await outbox.send(input,'findings',report,unknown)).notifications[0].state,'unknown')
  await outbox.send(input,'findings',report,unknown);assert.equal(calls.length,2)
  const disconnected=async()=>({error:'发送失败',detail:{ok:false,error:'this node is not the connected alerter'}})
  const refused=await outbox.send(input,'rework',report,disconnected)
  assert.equal(refused.notifications[0].state,'failed')
  assert.match(refused.notifications[0].reason,/发送节点未连接/)
  await outbox.send(input,'rework',report,send)
  assert.equal(outbox.rows(input.batch.id).find((r:any)=>r.stage==='rework').state,'sent')
})

test('connection recovery refusal is bounded retryable; unproven delivery is not',async t=>{
  const {input,store}=await setup(t), outbox=new TaskNotifications(store)
  input.task={...input.task,design:{...design,notifications:{channel:'wecom',chatIds:['fixture-group']}}}
  let calls=0
  const send=async()=>{calls++;return {error:'发送失败',detail:{ok:false,code:'wecom_connection_unavailable',delivery:'not_sent',sent:0}}}
  for(let i=0;i<5;i++)await outbox.send(input,'started',{ready:false,items:[]},send)
  const row=outbox.rows(input.batch.id)[0] as any
  assert.equal(calls,3);assert.equal(row.state,'failed');assert.equal(row.attempts,3);assert.match(row.reason,/消息尚未发送/)
  const unproven=await outbox.send(input,'findings',{ready:false,items:[]},async()=>({ok:false,code:'wecom_connection_unavailable',sent:0}))
  assert.equal(unproven.notifications[0].state,'unknown')
})
