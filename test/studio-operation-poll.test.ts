import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {pollStudioOperation} from '../src/studio-operation-poll.js'
test('host reconciliation uses only exact read tool and original job through real SDK HTTP transport',async t=>{
 const calls:any[]=[]
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(405).end();return}
  let body='';for await(const b of req)body+=b;const m=JSON.parse(body||'{}')
  if(m.method==='notifications/initialized'){res.writeHead(202).end();return}
  calls.push(m)
  const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{content:[{type:'text',text:JSON.stringify({job_id:'original',status:'done'})}]}
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())))
 const port=(server.address() as any).port
 const p=await pollStudioOperation({transport:'streamable-http',url:`http://127.0.0.1:${port}/mcp`},{tool:'vyibc-voice_synthesize',job_id:'original'})
 assert.equal(p.name,'vyibc-voice_status');assert.deepEqual(p.args,{job_id:'original'})
 assert.deepEqual(calls.filter(c=>c.method==='tools/call').map(c=>c.params),[{name:'vyibc-voice_status',arguments:{job_id:'original'}}])
 assert.equal(calls.filter(c=>c.method==='tools/call').length,1)
})
test('unknown job or non-HTTP configuration never starts any provider request',async()=>{
 await assert.rejects(pollStudioOperation({transport:'stdio'},{tool:'vyibc-voice_synthesize',job_id:'job'}),/transport-required/)
 await assert.rejects(pollStudioOperation({transport:'streamable-http',url:'http://127.0.0.1:1'},{tool:'vyibc-voice_synthesize',job_id:null}),/job-required/)
})
