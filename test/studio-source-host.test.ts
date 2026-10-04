import test from 'node:test'
import assert from 'node:assert/strict'
import {discoverStudioSourcesFromHost} from '../src/studio-source-host.ts'
import {TaskConsoleService} from '../src/service.ts'
const tools=['character_search','character_get','character_assets','asset_get']
const host={serverName:'vyibc-cartoon-assets',live:true,tools,config:{transport:'streamable-http',url:'https://catalog.invalid/mcp',headers:{Authorization:'Bearer PRIVATE_FIXTURE'}}}
test('source discovery uses one host transport, only fixed reads, and always closes it',async()=>{
 let connects=0,closes=0;const calls:any[]=[]
 const result=await discoverStudioSourcesFromHost({query:'校园'},[host],{connection:config=>{
  assert.equal(config,host.config)
  return {connect:async()=>{connects++},call:async(name,args)=>{calls.push({name,args});return {characters:[{character_id:'campus-original',name:'校园角色'}],total:1}},close:async()=>{closes++}}
 }})
 assert.equal(connects,1);assert.equal(closes,1);assert.deepEqual(calls,[{name:'character_search',args:{query:'校园',limit:20}}])
 assert.equal(result.status,'character_candidates');assert.equal(result.qualityApproved,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE|catalog.invalid/)
})
test('missing, disabled, duplicate or incompletely enumerated host catalog never connects',async()=>{
 const deps={connection:()=>{assert.fail('unexpected connection')}}
 for(const hosts of [[],[{...host,live:false}],[{...host,disabled:true}],[host,host]])await assert.rejects(discoverStudioSourcesFromHost({query:'x'},hosts,deps),/missing-or-ambiguous/)
 await assert.rejects(discoverStudioSourcesFromHost({query:'x'},[{...host,tools:['character_search']}],deps),/read-tools-unavailable/)
})
test('model transport/path fields fail before connection; provider details are never copied into failure output',async()=>{
 await assert.rejects(discoverStudioSourcesFromHost({query:'x',url:'https://untrusted.invalid'} as any,[host],{connection:()=>{assert.fail('unexpected connection')}}),/input-invalid/)
 let closed=false
 const result=await discoverStudioSourcesFromHost({query:'x'},[host],{connection:()=>({connect:async()=>{throw Error('PRIVATE_FIXTURE')},call:async()=>assert.fail('no call on failed connection'),close:async()=>{closed=true}})})
 assert.equal(closed,true);assert.equal(result.status,'incomplete');assert.equal((result as any).reason,'provider_error');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE/)
})
test('host source entry requires actual native execution identity before registry access',async()=>{
 const service:any=Object.create(TaskConsoleService.prototype)
 service.ready=Promise.resolve();service.hostMcp=()=>assert.fail('no discovery without a live identity')
 await assert.rejects(service.studioSourceDiscovery({query:'x'},{}),/live-session-required/)
})
