import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {awaitAgentCapabilities,type ReadinessEvent,type ReadinessSource} from '../src/agent-capability-readiness.ts'
import {inspectCapabilityContract} from '../src/capability-contract.ts'
import {renderComposition,validateSpec,writePreset} from '../src/presets.ts'

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'mcp-readiness-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const spec=validateSpec({id:'mcp-reader',name:'Reader',persona:'Read assets',description:'',model:'p/m',tools:[],skills:[],mcpTools:{assets:['asset_get','character_get']}})
 const initial={serverName:'assets',sourceEntryId:'asset-source',tools:['asset_get','character_get'],live:true}
 const {path}=await writePreset(spec,[initial],[],root)
 let sources:ReadinessSource[]=[{...initial,tools:[]}]
 return {set:(rows:ReadinessSource[])=>{sources=rows},initial,inspect:async()=>{
  const snapshot=sources.map(row=>({...row,tools:[...row.tools]}))
  return {audit:await inspectCapabilityContract(path,renderComposition(spec,snapshot).capabilities!),sources:snapshot}
 }}
}

test('late MCP registration passes the real saved contract without rewriting it',async t=>{
 const f=await fixture(t),events:ReadinessEvent[]=[];let now=0
 const result=await awaitAgentCapabilities({inspect:f.inspect,now:()=>now,intervalMs:10,timeoutMs:40,onEvent:e=>events.push(e),sleep:async ms=>{now+=ms;if(now===20)f.set([f.initial])}})
 assert.equal(result.audit.status,'in-sync');assert.equal(result.attempts,3);assert.equal(result.timedOut,false)
 assert.deepEqual(events.map(e=>e.phase),['waiting','ready'])
})

test('absent, disabled and nonempty incompatible MCP inventories do not trigger retry',async t=>{
 const f=await fixture(t)
 for(const rows of [[],[{...f.initial,live:false}],[{...f.initial,tools:['asset_get']}]] ){
  f.set(rows);let sleeps=0
  const result=await awaitAgentCapabilities({inspect:f.inspect,sleep:async()=>{sleeps++}})
  assert.equal(result.audit.ready,false);assert.ok(['dependency-missing','tool-drift'].includes(result.audit.status));assert.equal(result.timedOut,false);assert.equal(sleeps,0)
 }
})

test('discovery timeout is bounded and records one wait and one terminal event',async t=>{
 const f=await fixture(t),events:ReadinessEvent[]=[];let now=0
 const result=await awaitAgentCapabilities({inspect:f.inspect,now:()=>now,intervalMs:10,timeoutMs:25,onEvent:e=>events.push(e),sleep:async ms=>{now+=ms}})
 assert.equal(result.timedOut,true);assert.equal(result.elapsedMs,25);assert.equal(result.attempts,4)
 assert.deepEqual(events.map(e=>e.phase),['waiting','timeout'])
})

test('a stalled clock cannot create an unbounded readiness retry loop',async t=>{
 const f=await fixture(t)
 const result=await awaitAgentCapabilities({inspect:f.inspect,now:()=>0,intervalMs:10,timeoutMs:25,sleep:async()=>{}})
 assert.equal(result.timedOut,true);assert.equal(result.attempts,4)
})

test('disabling an MCP during discovery stops waiting as a configuration error',async t=>{
 const f=await fixture(t),events:ReadinessEvent[]=[]
 const result=await awaitAgentCapabilities({inspect:f.inspect,onEvent:e=>events.push(e),sleep:async()=>f.set([{...f.initial,live:false}])})
 assert.equal(result.timedOut,false);assert.equal(result.audit.ready,false);assert.equal(result.audit.status,'tool-drift')
 assert.deepEqual(events.map(e=>e.phase),['waiting','rejected'])
})

test('disposed startup never proceeds when delayed discovery completes',async t=>{
 const f=await fixture(t);let active=true,checks=0
 await assert.rejects(awaitAgentCapabilities({inspect:async()=>{checks++;return f.inspect()},isActive:()=>active,sleep:async()=>{active=false;f.set([f.initial])}}),/wait-cancelled/)
 assert.equal(checks,1)
})
