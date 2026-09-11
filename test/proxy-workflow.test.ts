import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventStore } from '../src/tasks.ts'
import { ProxyWorkflow,proxyRequestId,validProxyProof } from '../src/proxy-workflow.ts'
import { validateDesign,taskAgentIds } from '../src/task-design.ts'

const ip='198.51.100.10',expected='203.0.113.10'
const design=validateDesign({evidenceContract:'browser-patrol-v2',browserPatrol:{scope:'fleet-existing-authorized',actions:['provision','resume'],observationMinutes:20,minSamples:4},proxy:{agentId:'proxy-operator',lineId:'line-100',maxAttempts:2},scope:'fixture',branches:[{id:'check',when:'due',action:'verify first',evidence:'receipt'}],coordination:'independent review',failurePolicy:{isolateItems:true,maxAttempts:3,stopConditions:['unknown']},acceptance:['native proof']})
const wrap=(x:any)=>({content:[{type:'text',text:JSON.stringify(x)}]})
function proof(id:string,action='verify',at=Date.now()){
  return {operationId:id,ip,lineId:'line-100',action,state:'succeeded',startedAt:new Date(at).toISOString(),result:{ok:true,quiescent:true,evidence:{ok:true,expectedIp:expected,verifiedAt:new Date(at).toISOString(),paths:Object.fromEntries(['generic_exit_ip','cloudflare_exit_ip','claude_exit_ip','udp_cloudflare_exit_ip','udp_google_exit_ip'].map(k=>[k,expected]))},snapshot:{serviceActive:true,tunPresent:true,sourceMatches:true}}}
}
async function setup(t:any){
  const root=await mkdtemp(join(tmpdir(),'tc-proxy-workflow-')),store=new EventStore(root);await store.load()
  t.after(async()=>{store.kernel.db.close();await rm(root,{recursive:true,force:true})})
  const task:any={id:'fixture-proxy',title:'Fixture',brief:'read receipts',cwd:root,createdAt:new Date().toISOString(),enabled:false,graphMode:'dynamic-rounds',participants:[{agentId:'planner'},{agentId:'browser-manager'},{agentId:'reviewer'}],trigger:{kind:'manual'},timeoutSec:7200,maxTries:1,onFail:'stop',design}
  await store.append({t:'task/created',at:task.createdAt,taskId:task.id,task})
  await store.createBatch(task,{t:'batch/fired',at:task.createdAt,taskId:task.id,batch:{id:'fixture-batch',by:'manual',cards:[{id:'fixture-batch#p1',agentId:'planner',kind:'agent',role:'planner',round:1,deps:[]}]}})
  await store.claimCard('fixture-batch#p1','fixture-run','task-fixture-planner',1)
  const input:any={task,batch:store.s.batches.get('fixture-batch'),card:store.s.cards.get('fixture-batch#p1'),sessionId:'task-fixture-planner',profileId:'planner'}
  store.kernel.db.exec('CREATE TABLE dsh_patrol_inventory(batch_id TEXT PRIMARY KEY,inventory_json TEXT,session_id TEXT)')
  store.kernel.db.prepare('INSERT INTO dsh_patrol_inventory VALUES (?,?,?)').run(input.batch.id,JSON.stringify({nodes:[{ip,readAuthorized:true}]}),input.sessionId)
  return {store,input,workflow:new ProxyWorkflow(store)}
}
test('reviewed proxy participant is explicit; unsupported fields and missing scope remain denied',()=>{
  assert.ok(taskAgentIds({participants:[{agentId:'planner'}],design}).includes('proxy-operator'))
  for(const proxy of [{...design.proxy,command:'anything'},{...design.proxy,maxAttempts:4},{...design.proxy,lineId:'https://wrong'}])assert.throws(()=>validateDesign({...design,proxy}))
  assert.notEqual(proxyRequestId('task-one','fixture-request-0001'),proxyRequestId('task-two','fixture-request-0001'))
})
test('proxy round and DAG commit atomically with proxy before real gate; legacy graph is unchanged',async t=>{
  const {store,input,workflow}=await setup(t)
  assert.throws(()=>workflow.plan(input,[{ip}],[{ip:'198.51.100.11',action:'repair',reason:'fixture'}]),/invalid/)
  const plan=workflow.plan(input,[{ip}],[{ip,action:'repair',reason:'fixture approved source'}])!
  await assert.rejects(store.expandRound(input.task,input.batch,input.card,'fixture',()=>{plan.commit();throw Error('injected')}),/injected/)
  assert.equal(store.kernel.getTask('fixture-batch#x1'),undefined)
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_proxy_round_items').get() as any).n,0)
  await store.expandRound(input.task,input.batch,input.card,'fixture',plan.commit)
  assert.equal(store.kernel.getTask('fixture-batch#x1')?.role,'proxy')
  assert.ok(store.kernel.db.prepare("SELECT 1 FROM task_links WHERE parent_id='fixture-batch#x1' AND child_id='fixture-batch#g1'").get())
  assert.equal((await store.openReadyGates()).length,0)
  const proxy={...input,card:store.s.cards.get('fixture-batch#x1'),sessionId:'task-fixture-proxy',profileId:'proxy-operator'}
  assert.throws(()=>workflow.complete(proxy),/native-evidence/)
})
test('proxy receipts gate login and require actual independent reviewer rather than executor claims',async t=>{
  const {store,input,workflow}=await setup(t)
  const plan=workflow.plan(input,[{ip}],[{ip,action:'repair',reason:'fixture'}])!;await store.expandRound(input.task,input.batch,input.card,'fixture',plan.commit)
  const proxy={...input,card:store.s.cards.get('fixture-batch#x1'),sessionId:'task-fixture-proxy',profileId:'proxy-operator'}
  const id=randomUUID(),args={ip,requestId:'fixture-request-0001'}
  assert.throws(()=>workflow.assertBrowser(input,{ip}),/proxy-gate/)
  let complete:any
  await workflow.invoke(proxy,'proxy_repair',args,async forwarded=>{assert.notEqual(forwarded.requestId,args.requestId);complete=proof(id,'repair');return wrap({...complete,state:'running',result:null})})
  assert.throws(()=>workflow.assertBrowser(input,{ip}),/proxy-gate/)
  await workflow.invoke(proxy,'proxy_status',{operationId:id},async()=>wrap(complete))
  const recovery={...proxy,sessionId:'task-fixture-proxy-recovery'}
  await workflow.invoke(recovery,'proxy_status',{operationId:id},async()=>wrap(complete))
  assert.equal((store.kernel.db.prepare('SELECT session_id FROM dsh_proxy_checks WHERE operation_id=?').get(id) as any).session_id,proxy.sessionId)
  assert.doesNotThrow(()=>workflow.assertBrowser(input,{ip}))
  assert.ok(workflow.complete(proxy))
  assert.throws(()=>workflow.complete(input),/independent-review/)
  const reviewer={...input,card:store.s.cards.get('fixture-batch#r1'),profileId:'reviewer',sessionId:'task-fixture-reviewer'}
  await assert.rejects(workflow.invoke(reviewer,'proxy_status',{operationId:id},async()=>wrap(complete)),/owned-by-session/)
  await new Promise(r=>setTimeout(r,5))
  await workflow.invoke(reviewer,'proxy_verify',args,async()=>wrap(proof(randomUUID())))
  assert.doesNotThrow(()=>workflow.complete(input))
  const realNow=Date.now, later=Date.now()+21*60_000
  Date.now=()=>later
  try{assert.doesNotThrow(()=>workflow.complete(input));assert.throws(()=>workflow.assertBrowser(input,{ip}),/proxy-gate/)}finally{Date.now=realNow}
  // A newer failed probe invalidates the previously passed independent check.
  await workflow.invoke(reviewer,'proxy_verify',{...args,requestId:'fixture-request-0002'},async()=>wrap({...proof(randomUUID()),state:'blocked',result:{ok:false,quiescent:true}}))
  assert.throws(()=>workflow.assertBrowser(input,{ip}),/proxy-gate/)
  assert.throws(()=>workflow.complete(input),/independent-review/)
})
test('unknown calls reserve the node, deny other sessions and do not become repair retry permission',async t=>{
  const {store,input,workflow}=await setup(t)
  const plan=workflow.plan(input,[{ip}],[{ip,action:'repair',reason:'fixture'}])!;await store.expandRound(input.task,input.batch,input.card,'fixture',plan.commit)
  const proxy={...input,card:store.s.cards.get('fixture-batch#x1'),sessionId:'task-fixture-proxy',profileId:'proxy-operator'}
  const args={ip,requestId:'fixture-request-0001'}
  await assert.rejects(workflow.invoke(proxy,'proxy_repair',args,async()=>{throw Error('lost reply')}),/lost reply/)
  await assert.rejects(workflow.invoke(proxy,'proxy_repair',{...args,requestId:'fixture-request-0002'},async()=>wrap({})),/busy-or-unknown/)
  const caller={...proxy,sessionId:'task-another-session'}
  await assert.rejects(workflow.invoke(caller,'proxy_verify',args,async()=>wrap({})),/busy-or-unknown/)
  await assert.rejects(workflow.invoke(input,'proxy_repair',args,async()=>wrap({})),/not-in-frozen-plan/)
})
test('definitive proxy failure can be handed off but its node cannot copy login or pass the Task',async t=>{
  const {store,input,workflow}=await setup(t)
  const plan=workflow.plan(input,[{ip}],[{ip,action:'repair',reason:'fixture'}])!;await store.expandRound(input.task,input.batch,input.card,'fixture',plan.commit)
  const proxy={...input,card:store.s.cards.get('fixture-batch#x1'),sessionId:'task-fixture-proxy',profileId:'proxy-operator'}
  await workflow.invoke(proxy,'proxy_repair',{ip,requestId:'fixture-request-0001'},async()=>wrap({...proof(randomUUID(),'repair'),state:'blocked',result:{ok:false,quiescent:true,reason:'proxy-exit-mismatch'}}))
  assert.match(workflow.complete(proxy)!.summary,/0\/1/)
  assert.throws(()=>workflow.assertBrowser(input,{ip}),/proxy-gate/)
  assert.throws(()=>workflow.complete(input),/independent-review/)
})

test('freshness and all five paths are necessary; old, mismatched, model flags cannot pass',()=>{
  const at=Date.now(),p=proof(randomUUID(),'verify',at),since=new Date(at-1000).toISOString()
  assert.equal(validProxyProof(p,'line-100',since,at),true)
  assert.equal(validProxyProof(p,'line-92',since,at),false)
  assert.equal(validProxyProof(p,'line-100',since,at+16*60_000),false)
  assert.equal(validProxyProof({...p,result:{ok:true}},'line-100',since,at),false)
  p.result.evidence.paths.udp_google_exit_ip='198.51.100.20'
  assert.equal(validProxyProof(p,'line-100',since,at),false)
})
