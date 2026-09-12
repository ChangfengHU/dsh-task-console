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
import { patrolItemView, patrolReportSummary } from '../src/patrol-report.ts'
import { cardMessage } from '../src/tasks.ts'

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
function proof(input: any,at: number,state='verified',seq=10, options: { ttlMs?: number; fingerprint?: string; observedAt?: number } = {}) {
  const checkedAt = new Date(at).toISOString(), id=String(seq).padStart(32,'0')
  return pair(input,seq,'browser_status',{ip:'192.0.2.10',operationId:id},{id,action:'login-verify',phase:'complete',updatedAt:new Date(options.observedAt ?? at).toISOString(),args:{ip:'192.0.2.10',instance:1,sessionId:input.sessionId},result:{verification:{instance:1,loginVerified:state==='verified',identity:{gemini:state==='verified'?'in':'out',account:{source:'gemini-account-control',fingerprint:options.fingerprint ?? '01234567'}},loginVerification:{checkedAt,expiresAt:new Date(at+(options.ttlMs ?? 10*60_000)).toISOString(),status:state}}}})
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
  const {input,patrol,store}=await setup(t), now=Date.now()-2*60_000
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
test('reviewed exclusions stay visible and cannot grant actions or make empty coverage pass',async t=>{
  const {input,patrol,store}=await setup(t)
  input.task.design=validateDesign({...design,browserPatrol:{...design.browserPatrol,excludedNodeIds:['unreachable']}})
  const db=store.kernel.db,inventory=JSON.parse((db.prepare('SELECT inventory_json FROM dsh_patrol_inventory').get() as any).inventory_json)
  inventory.nodes.push({nodeId:'unreachable',reachable:false,browsers:[]})
  db.prepare('UPDATE dsh_patrol_inventory SET inventory_json=?').run(JSON.stringify(inventory))
  const reviewer={...input,card:{...input.card,role:'reviewer'}}
  patrol.capture(reviewer,proof(reviewer,Date.now()))
  assert.equal(patrol.status(input).ready,true)
  assert.equal(patrol.status(input).excluded[0].reachable,false)
  assert.equal(patrol.status(input).uncovered.length,0)
  input.task.design.browserPatrol.excludedNodeIds.push('fixture-node')
  assert.equal(patrol.status(input).ready,false)
  assert.throws(()=>patrol.plan(input,[{ip:'192.0.2.10',instance:1,action:'verify',reason:'excluded'}]),/真实可读清单/)
})
test('recover needs fresh native CDP failure, not generic unknown or a stale failure',async t=>{
  const {input,patrol,store}=await setup(t)
  input.task.design=validateDesign({...design,browserPatrol:{...design.browserPatrol,actions:['provision','resume','recover']}})
  const row={ip:'192.0.2.10',instance:1,action:'recover',reason:'native failure'}
  patrol.capture(input,proof(input,Date.now(),'unknown'))
  assert.throws(()=>patrol.plan(input,[row]),/真实 CDP/)
  const events=proof(input,Date.now(),'unknown',20)
  const part=events[1].data.message!.content[0].content[0]
  const value=JSON.parse(part.text);value.result.verification.loginVerification.reason='cdp-unavailable';part.text=JSON.stringify(value)
  patrol.capture(input,events)
  assert.equal(patrol.plan(input,[row])!.items[0].action,'recover')
  patrol.capture(input,proof(input,Date.now()+1,'verified',30))
  assert.throws(()=>patrol.plan(input,[row]),/真实 CDP/)
  assert.equal((store.kernel.db.prepare("SELECT COUNT(*) n FROM task_events WHERE kind='patrol_service_unavailable'").get() as any).n,1)
})
test('expired independent checks retain their fact but an uncovered node still prevents full acceptance',async t=>{
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
  assert.equal(report.items[0].accepted,true)
  assert.equal(report.items[0].freshness,'expired')
  assert.equal(report.items[0].reason,'independent-verification-passed')
  assert.equal(report.uncovered.length,1)
  assert.equal(report.canCloseUnresolved,true)
  assert.throws(()=>patrol.complete(input),/不能收口/)
  assert.equal(patrol.complete({...input,metadata:{patrolDisposition:'unresolved'}}).metadata.workflowOutcome,'unresolved')
  // A changed target still needs its independent stability window; expiry does not waive it.
  store.kernel.db.prepare("INSERT INTO dsh_browser_issues(spec_id,target_key,status,attempts,opened_at) VALUES ('fixture','192.0.2.10:1','open',1,?)").run(new Date(now-30*60_000).toISOString())
  assert.equal(patrol.status(input,now).canCloseUnresolved,false)
})
test('three-minute expiry during handoff never erases a valid check from the same Batch',async t=>{
  const {input,patrol}=await setup(t), now=Date.now()
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now-11*60_000,'verified',10,{ttlMs:180_000}))
  const report=patrol.status(input,now)
  assert.equal(report.ready,true)
  assert.equal(report.items[0].accepted,true)
  assert.equal(report.items[0].freshness,'expired')
  assert.equal(report.counts.refresh,1)
  assert.equal(report.counts.signedOut,0)
  assert.equal(report.items[0].independentCheckedAt,new Date(now-11*60_000).toISOString())
  assert.match(report.summary,/1 个本轮已验收.*证据待刷新/)
  assert.equal(patrol.complete(input).metadata.browserPatrol.ready,true)
  // An hour later is still a historical check, never a claim about live Fleet.
  assert.equal(patrol.status(input,now+60*60_000).items[0].accepted,true)
  assert.equal(patrol.status({...input,batch:{id:'another-batch',firedAt:input.batch.firedAt}},now).ready,false)
})

test('new executor failure, unknown or identity change invalidates older independent success',async t=>{
  const {input,patrol}=await setup(t), now=Date.now()-2*60_000
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now))
  const executor={...input,card:{id:'batch#e2',role:'executor',round:2}}
  patrol.capture(executor,proof(executor,now+1_000,'signed_out',20))
  assert.equal(patrol.status(input,now+1_000).items[0].reason,'signed-out')
  assert.equal(patrol.status(input,now+1_000).ready,false)
  patrol.capture(executor,proof(executor,now+2_000,'verified',22))
  assert.equal(patrol.status(input,now+2_000).items[0].reason,'independent-recheck-required')
  patrol.capture(reviewer,proof(reviewer,now+3_000,'verified',24))
  assert.equal(patrol.status(input,now+3_000).ready,true)
  patrol.capture(executor,proof(executor,now+4_000,'unknown',26))
  assert.equal(patrol.status(input,now+4_000).items[0].reason,'verification-unknown')
  patrol.capture(reviewer,proof(reviewer,now+5_000,'verified',28))
  assert.equal(patrol.status(input,now+5_000).ready,true)
  patrol.capture(executor,proof(executor,now+6_000,'verified',30,{fingerprint:'abcdef01'}))
  assert.equal(patrol.status(input,now+6_000).ready,false)
  patrol.capture(reviewer,proof(reviewer,now+7_000,'verified',32,{fingerprint:'abcdef01'}))
  assert.equal(patrol.status(input,now+7_000).ready,true)
})

test('a repaired target retains its complete stability requirement even after issue resolution',async t=>{
  const {input,patrol,store}=await setup(t), now=Date.now()-60_000, db=store.kernel.db
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  db.prepare("INSERT INTO dsh_browser_issues(spec_id,target_key,status,attempts,opened_at) VALUES ('fixture','192.0.2.10:1','open',1,?)").run(new Date(now-30*60_000).toISOString())
  db.prepare("INSERT INTO dsh_browser_operations VALUES ('operation',1,'batch','batch#e1','login-provision',?)").run(new Date(now-30*60_000).toISOString())
  for(const [i,minute] of [-21,-14,-7,0].entries())patrol.capture(reviewer,proof(reviewer,now+minute*60_000,'verified',10+i,{ttlMs:180_000}))
  assert.equal(patrol.status(input,now).items[0].observation.passed,true)
  assert.equal(patrol.complete(input).metadata.browserPatrol.ready,true)
  assert.equal((db.prepare('SELECT status FROM dsh_browser_issues').get() as any).status,'resolved')
  assert.equal(patrol.status(input,now+10*60_000).items[0].observation.passed,true)
  assert.equal(patrol.status(input,now+10*60_000).items[0].freshness,'expired')
  // A new side effect after review must reset the window, even on a closed issue.
  db.prepare("INSERT INTO dsh_browser_operations VALUES ('operation2',1,'batch','batch#e2','login-provision',?)").run(new Date(now+10_000).toISOString())
  patrol.capture(reviewer,proof(reviewer,now+20_000,'verified',30))
  const after=patrol.status(input,now+20_000)
  assert.equal(after.ready,false)
  assert.equal(after.items[0].observation.samples,1)
  assert.equal(after.items[0].reason,'observation-window-pending-or-failed')
})

test('expired-at-observation and future receipts cannot become valid point-in-time evidence',async t=>{
  const {input,patrol}=await setup(t), now=Date.now()
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now-5*60_000,'verified',10,{ttlMs:180_000,observedAt:now}))
  assert.equal(patrol.status(input,now).ready,false)
  assert.equal(patrol.status(input,now).items[0].state,'unknown')
  patrol.capture(reviewer,proof(reviewer,now+60_000,'verified',20))
  assert.equal(patrol.status(input,now).ready,false)
})

test('a blocked verification is a separate invalidation event, never a fabricated login sample',async t=>{
  const {input,patrol,store}=await setup(t), now=Date.now()-60_000
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,now))
  assert.equal(patrol.status(input,now).ready,true)
  const events=pair(input,30,'browser_status',{ip:'192.0.2.10',operationId:'blocked-operation'},{id:'blocked-operation',action:'login-verify',phase:'blocked',updatedAt:new Date(now+1_000).toISOString(),args:{ip:'192.0.2.10',instance:1,sessionId:input.sessionId},error:'browser-work-in-progress'})
  patrol.capture(input,events);patrol.capture(input,events)
  assert.equal(store.kernel.listEvents(input.card.id).filter(e=>e.kind==='patrol_verification_unavailable').length,1)
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_patrol_observations').get() as any).n,1)
  const report=patrol.status(input,now+1_000)
  assert.equal(report.ready,false)
  assert.equal(report.items[0].reason,'verification-operation-incomplete')
  assert.equal(report.items[0].state,'verified') // last login fact is not rewritten as logout
  assert.equal(report.items[0].verificationFailure.reason,'browser-work-in-progress')
  patrol.capture(reviewer,proof(reviewer,now+2_000,'verified',32))
  assert.equal(patrol.status(input,now+2_000).ready,true)
  assert.equal(patrol.status(input,now+2_000).items[0].verificationFailure,null)
})

test('stale signed-out evidence never authorizes a login copy; healthy expiry does not either',async t=>{
  const {input,patrol}=await setup(t), now=Date.now(), row={ip:'192.0.2.10',instance:1,action:'provision',reason:'fixture'}
  patrol.capture(input,proof(input,now-5*60_000,'signed_out',10,{ttlMs:180_000}))
  assert.throws(()=>patrol.plan(input,[row]),/新鲜真实未登录证据/)
  patrol.capture(input,proof(input,now-4*60_000,'verified',20,{ttlMs:180_000}))
  assert.throws(()=>patrol.plan(input,[row]),/新鲜真实未登录证据/)
})

test('legacy report presentation separates expiry from logout without rewriting its decision',()=>{
  const legacy={state:'verified',accepted:false,reason:'not-currently-verified',checkedAt:'2026-09-10T08:51:51Z'}
  const before=JSON.stringify(legacy), view=patrolItemView(legacy)
  assert.equal(view.kind,'refresh')
  assert.equal(view.state,'检查时已登录')
  assert.equal(view.freshness,'expired')
  assert.equal(JSON.stringify(legacy),before)
  const report=patrolReportSummary([legacy,{state:'signed_out',accepted:false,reason:'signed-out'},{state:'unknown',accepted:false,reason:'verification-unknown'}],[{nodeId:'fixture-uncovered'}])
  assert.deepEqual(report.counts,{total:3,passed:0,refresh:1,signedOut:1,unknown:1,missing:0,stability:0,scope:0,uncovered:1})
})

test('status polling does not add replay events solely because the assessment clock moved',async t=>{
  const {input,patrol,store}=await setup(t)
  const reviewer={...input,card:{id:'batch#r1',role:'reviewer',round:1},profileId:'fleet-ops-reviewer',sessionId:'task-fixture-reviewer'}
  patrol.capture(reviewer,proof(reviewer,Date.now()-60_000))
  const realStatus=patrol.status.bind(patrol)
  let now=Date.now()
  patrol.status=(value:any)=>realStatus(value,now)
  patrol.snapshot(input)
  const before=store.kernel.listEvents(input.card.id).filter(e=>e.kind==='patrol_snapshot')
  now+=1_000
  patrol.snapshot(input)
  assert.equal(store.kernel.listEvents(input.card.id).filter(e=>e.kind==='patrol_snapshot').length,before.length)
  now+=11*60_000 // expiry is a real freshness change, so that event must be recorded
  patrol.snapshot(input)
  const after=store.kernel.listEvents(input.card.id).filter(e=>e.kind==='patrol_snapshot')
  assert.equal(after.length,before.length+1)
  assert.equal(JSON.parse(after.at(-1)!.payload).items[0].accepted,true)
})

test('patrol role instructions distinguish freshness from acceptance and retain stability',async t=>{
  const {input}=await setup(t)
  const message=cardMessage({...input.task,title:'Fixture',brief:'Read-only fixture',participants:[{agentId:'reviewer'}]}, {...input.card,role:'reviewer',index:0}, 'batch',[])
  assert.match(message,/accepted=true 且 freshness=expired/)
  assert.match(message,/修复后仍须完整观察窗口/)
  assert.doesNotMatch(message,/观察结束时刷新其他已过期目标/)
})

test('new notifications describe receipt expiry without claiming logout or sending externally',async t=>{
  const {input,store}=await setup(t), outbox=new TaskNotifications(store)
  input.task={...input.task,design:{...design,notifications:{channel:'wecom',chatIds:['fixture-group']}}}
  let body=''
  const items=[{ip:'192.0.2.10',instance:1,state:'verified',accepted:true,freshness:'expired',reason:'independent-verification-passed',attempts:0}]
  await outbox.send(input,'restored',{ready:true,items,...patrolReportSummary(items,[])},async args=>{body=args.markdown;return{sent:1}})
  assert.match(body,/检查时已登录/)
  assert.match(body,/实时证据待刷新/)
  assert.doesNotMatch(body,/检查时未登录/)
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
