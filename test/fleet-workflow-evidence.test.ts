import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fleetRoles, fleetReceipts, validateFleetWorkflowEvidence } from '../src/fleet-workflow-evidence.ts'
import { composeRecipe } from '../src/workflow-recipes.ts'

function fixture() {
  const now=Date.parse('2026-09-24T05:00:00Z'), started=now-30*60_000, ip='192.0.2.10', jobId='job-current', nodeId='host-192-0-2-10'
  let seq=0
  const events=(name:string,args:any,value:any)=>{
    const id=String(++seq)
    return [{type:'tool/call',time:now-1000,seq:++seq,data:{callId:id,name,arguments:JSON.stringify(args)}},
      {type:'tool/result',time:now-500,seq:++seq,data:{message:{content:[{type:'tool-result',toolCallId:id,content:[{type:'text',text:JSON.stringify(value)}]}]}}}]
  }
  const base={ip,ok:true,phase:'complete',current_stage:10,probe_executed:true,report_available:true,run_id:'onb-current'}
  const report={...base,report:{checked:['base']},stages:Array.from({length:10},(_,i)=>({stage:i+1,attempt:1,status:'passed',action:'reused'}))}
  const runner={ip,targetId:nodeId,ok:true,phase:'complete',sessionId:'session-runner',updatedAt:new Date(now).toISOString(),signedJobId:jobId,signatureVerified:true,runnerCoverageHealthy:true,nodeHealthy:true,checks:[{name:'proxy.fresh_exit',status:'ok'}],action:'reused'}
  const evidence:any={
    'fleet-installer':{role:'fleet-installer',sessionId:'session-installer',events:[...events('fleet_onboard_start',{ip},base),...events('fleet_onboard_report',{ip},report)]},
    'browser-manager':{role:'browser-manager',sessionId:'session-browser',events:events('mcp__fleet-browser-browser-manager__browser_inspect',{ip},{ip,ok:true})},
    'fleet-runner-operator':{role:'fleet-runner-operator',sessionId:'session-runner',events:[...events('fleet_runner_ensure',{ip},{ok:true,phase:'running',ip}),...events('fleet_runner_status',{ip},runner)]},
  }
  const node:any={id:nodeId,dashboardUrl:'https://clash-192-0-2-10.vyibc.com/',reachable:true,capabilityError:null,browserService:'https://browser-example.invalid',
    reachability:{state:'reachable',fresh:true,source:'signed-runner-result',lastObservedAt:now},
    host:{totalMb:12000,disk:{totalGb:100}},telemetry:{contract:'fleet-host-v1',complete:true,checkedAt:new Date(now).toISOString()},
    network:{status:'fresh',checkedAt:new Date(now).toISOString(),targets:Object.fromEntries(['gemini','claude','chatgpt','youtube','github'].map(k=>[k,{ok:true}]))},
    browsers:[1,2].map(instance=>({browserNo:instance,cdpPort:String(9221+instance),identities:{gemini:'in'},loginVerification:{status:'verified',checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+180000).toISOString()}}))}
  const reads:any={fleet:{nodes:[node]},exits:{rows:[{id:nodeId,jobId,source:'fleet-probe-runner',exitIp:'203.0.113.10',expectedIp:'203.0.113.10',verifiedAt:new Date(now).toISOString(),expiresAt:new Date(now+3900000).toISOString()}]},
    lines:{rows:[{id:nodeId,jobId,source:'fleet-probe-runner',checkedAt:new Date(now).toISOString(),error:null,lines:[{id:'line-100',ok:true},{id:'line-92',ok:false}]}]}}
  const input:any={task:{workflowRecipe:{id:'fleet-base-v3',login:'provision-gemini'},participants:fleetRoles.map(agentId=>({agentId}))},
    batch:{firedAt:new Date(started).toISOString(),turn:{targets:[{kind:'fleet-node',id:ip}]}},profileId:'fleet-runner-operator',sessionId:'session-runner',metadata:{stable:true}}
  const deps={evidence:async(role:any)=>evidence[role],read:async(kind:any)=>reads[kind],now:()=>now}
  function changeResult(role:string,tool:string,update:(value:any)=>void){
    const pairs=fleetReceipts(role as any,evidence[role].events),r=pairs.find(r=>r.name===tool)!
    update(r.value)
    const event=evidence[role].events.find((e:any)=>e.seq===r.seq)
    event.data.message.content[0].content[0].text=JSON.stringify(r.value)
  }
  return {input,deps,evidence,node,reads,changeResult,now}
}

test('v3 runs exactly three existing roles, browser before first Runner acceptance; v2 stays frozen',()=>{
  const v3=composeRecipe({id:'fleet-base-v3',login:'provision-gemini'})
  assert.deepEqual(v3.participants.map(p=>p.agentId),fleetRoles)
  assert.match(v3.participants[1].brief!,/20 分钟/)
  assert.match(v3.participants[2].brief!,/fleet_runner_ensure/)
  assert.deepEqual(composeRecipe({id:'fleet-base-v2',login:'preserve'}).participants.map(p=>p.agentId),['fleet-installer','fleet-runner-operator','browser-manager'])
})

test('full completion joins current role receipts with Fleet readback; an optional line failure is not missing measurement',async()=>{
  const f=fixture(),proof=await validateFleetWorkflowEvidence(f.input,f.deps)
  assert.equal(proof?.scope,'node-and-login');assert.equal(proof?.accepted.length,3)
  assert.equal(proof?.accepted[0].stages[0].action,'reused')
})

test('base role completes only a handoff without requesting future downstream evidence',async()=>{
  const f=fixture();f.input.profileId='fleet-installer';f.input.sessionId='session-installer'
  f.deps.read=async()=>{throw Error('must not read downstream state')}
  delete f.evidence['browser-manager'];delete f.evidence['fleet-runner-operator']
  assert.equal((await validateFleetWorkflowEvidence(f.input,f.deps))?.scope,'role-handoff')
})

test('missing, stale, cross-session and failed native receipts cannot pass using model metadata',async()=>{
  for(const mutate of [
    (f:any)=>delete f.evidence['browser-manager'],
    (f:any)=>f.evidence['fleet-installer'].events.shift(),
    (f:any)=>f.evidence['fleet-installer'].events.forEach((e:any)=>e.time=0),
    (f:any)=>f.changeResult('fleet-installer','fleet_onboard_start',(r:any)=>r.probe_executed=false),
    (f:any)=>f.changeResult('fleet-installer','fleet_onboard_start',(r:any)=>r.phase='blocked'),
    (f:any)=>f.changeResult('fleet-installer','fleet_onboard_report',(r:any)=>r.run_id='old'),
    (f:any)=>f.changeResult('fleet-installer','fleet_onboard_report',(r:any)=>r.stages.pop()),
    (f:any)=>f.changeResult('fleet-runner-operator','fleet_runner_status',(r:any)=>r.sessionId='other'),
    (f:any)=>f.changeResult('fleet-runner-operator','fleet_runner_status',(r:any)=>r.signatureVerified=false),
    (f:any)=>f.changeResult('fleet-runner-operator','fleet_runner_status',(r:any)=>r.phase='running'),
    (f:any)=>f.changeResult('fleet-runner-operator','fleet_runner_status',(r:any)=>r.updatedAt=new Date(0).toISOString()),
    (f:any)=>f.changeResult('fleet-runner-operator','fleet_runner_status',(r:any)=>r.ip='192.0.2.99'),
    (f:any)=>f.evidence['fleet-runner-operator'].events.splice(0,2),
  ]){const f=fixture();mutate(f);await assert.rejects(validateFleetWorkflowEvidence(f.input,f.deps),/验收未通过/)}
})

test('desktop-only, missing Runner observations, old exits and unprobed lines block full success',async()=>{
  for(const mutate of [
    (f:any)=>delete f.node.browserService,
    (f:any)=>f.node.browsers[0].desktopOnly=true,
    (f:any)=>f.node.browsers[0].cdpPort=null,
    (f:any)=>f.node.browsers[0].loginVerification.status='unknown',
    (f:any)=>f.node.browsers[0].loginVerification.expiresAt=new Date(0).toISOString(),
    (f:any)=>f.node.reachability.state='unknown',
    (f:any)=>f.node.reachability.lastObservedAt=0,
    (f:any)=>f.node.telemetry.complete=false,
    (f:any)=>f.node.network.targets.claude.ok=false,
    (f:any)=>f.node.network.checkedAt=new Date(0).toISOString(),
    (f:any)=>f.reads.exits.rows[0].jobId='old',
    (f:any)=>f.reads.exits.rows[0].expiresAt=new Date(0).toISOString(),
    (f:any)=>f.reads.exits.rows[0].exitIp='192.0.2.99',
    (f:any)=>f.reads.lines.rows[0].lines=null,
    (f:any)=>f.reads.lines.rows[0].error='尚未探测',
  ]){const f=fixture();mutate(f);await assert.rejects(validateFleetWorkflowEvidence(f.input,f.deps),/验收未通过/)}
})

test('preserve permits fresh explicitly signed-out, not an unknown detector; login requirement stays strict',async()=>{
  const f=fixture();f.node.browsers[0].identities.gemini='out';f.node.browsers[0].loginVerification.status='signed_out'
  await assert.rejects(validateFleetWorkflowEvidence(f.input,f.deps),/Gemini/)
  f.input.task.workflowRecipe.login='preserve'
  assert.equal((await validateFleetWorkflowEvidence(f.input,f.deps))?.scope,'full-node')
  f.node.browsers[0].loginVerification.status='unknown'
  await assert.rejects(validateFleetWorkflowEvidence(f.input,f.deps),/检测未知/)
})

test('legacy/unrelated workflows do not acquire v3 requirements on upgrade',async()=>{
  const f=fixture();f.input.task.workflowRecipe.id='fleet-base-v2'
  f.deps.evidence=async()=>{throw Error('must not read')}
  assert.equal(await validateFleetWorkflowEvidence(f.input,f.deps),undefined)
})

test('a later failed or malformed native tool result invalidates an earlier success',async()=>{
  for(const failed of [true,false]){
    const f=fixture(),ev=f.evidence['fleet-installer'].events
    const later=JSON.parse(JSON.stringify(ev.slice(0,2)))
    later[0].data.callId='failed-call';later[0].seq=100
    const part=later[1].data.message.content[0];part.toolCallId='failed-call';part.isError=failed;part.content[0].text='not a receipt';later[1].seq=101
    ev.push(...later)
    await assert.rejects(validateFleetWorkflowEvidence(f.input,f.deps),/基础十阶段/)
  }
})

test('existing Fleet aliases are resolved by exact target hostname, never guessed from an IP octet',async()=>{
  const f=fixture();f.node.id='host-legacy'
  f.reads.exits.rows[0].id='host-legacy';f.reads.lines.rows[0].id='host-legacy'
  f.changeResult('fleet-runner-operator','fleet_runner_status',r=>r.targetId='host-legacy')
  assert.equal((await validateFleetWorkflowEvidence(f.input,f.deps))?.scope,'node-and-login')
  f.reads.fleet.nodes.push({...f.node,id:'conflicting-node'})
  await assert.rejects(validateFleetWorkflowEvidence(f.input,f.deps),/不唯一/)
})
