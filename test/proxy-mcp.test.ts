import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createProxyMcp } from '../src/proxy-mcp.ts'
import { ProxyService, type ProxyTransport } from '../src/proxy-service.ts'
import { loadProxyPolicy, proxyPolicySchema, type ProxyPolicy } from '../src/proxy-policy.ts'
import { spawnSync } from 'node:child_process'
import { tokenFromFile, proxyMaterial, proxyTransport } from '../src/proxy-transport.ts'

const policy=(root='/tmp/proxy-unit',repair=true):ProxyPolicy=>({version:1,principal:'proxy-operator',stateDir:root,
  knownHostsFile:'/fixtures/known_hosts',vaultOrigin:'https://vault.example',vaultTokenFile:'/fixtures/token',sshResolveTokenFile:'/fixtures/ssh-token',
  nodes:[{ip:'198.51.100.10',lineId:'line-fixture',repair}]})
const args={ip:'198.51.100.10',requestId:'request-fixture-0001'}
const settle=async(s:ProxyService)=>Promise.all([...s.pending])
const good={ok:true,quiescent:true,evidence:{paths:{tcp:'203.0.113.10',udp:'203.0.113.10'}}}

test('existing protected env provider is parsed without eval or duplicated credential files',()=>{
  assert.equal(tokenFromFile('OTHER=x\nFLEET_ONBOARD_VAULT_RESOLVE_TOKEN="fixture-only"\n','FLEET_ONBOARD_VAULT_RESOLVE_TOKEN'),'fixture-only')
  assert.throws(()=>tokenFromFile('K=1\nK=2','K'),/credential-file-invalid/)
  assert.equal(tokenFromFile('K=$(not-executed)','K'),'$(not-executed)')
})

test('proxy credentials and approved line are resolved privately, unknown lines fail without SSH',async()=>{
  const root=await mkdtemp(join(tmpdir(),'proxy-material-test-')),original=globalThis.fetch
  try{
    const token=join(root,'token');await writeFile(token,'fixture-only-not-a-real-token',{mode:0o600})
    const p={...policy(root),vaultTokenFile:token,sshResolveTokenFile:token}
    const calls:any[]=[]
    globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options!.body as string);calls.push(body.params)
      const value=body.params.name.endsWith('resolve_ssh')?{ok:true,ip:args.ip,username:'claude',source:'vault',private_key:'fixture-not-an-ssh-key'}:
        {ok:true,value:[{id:'line-fixture',config_url:'https://example.invalid/private-source',expected_ip:'203.0.113.10'}]}
      return new Response(JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(value)}]}}),{status:200})
    }
    const material=await proxyMaterial(p,args.ip,'repair')
    assert.equal(material.key,'fixture-not-an-ssh-key\n');assert.equal(material.line.expected_ip,'203.0.113.10')
    assert.deepEqual(calls.map(x=>x.arguments),[{ip:args.ip},{key:'clash:lines'}])
    await assert.rejects(proxyMaterial({...p,nodes:[{...p.nodes[0],lineId:'line-missing'}]},args.ip,'repair'),/approved-proxy-line-unavailable/)
  }finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true})}
})

test('proxy policy rejects commands, secret arguments, invalid targets and writable policy files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'proxy-policy-test-'))
  try{
    const file=join(root,'policy.json');await writeFile(file,JSON.stringify(policy(root)),{mode:0o600})
    assert.equal((await loadProxyPolicy(file)).nodes[0].repair,true)
    await chmod(file,0o644);await assert.rejects(loadProxyPolicy(file),/private-file/)
    for(const ip of ['127.0.0.1','10.0.0.1','198.51.100.10;touch x','999.1.1.1','198.051.100.10'])
      assert.equal(proxyPolicySchema.safeParse({...policy(),nodes:[{...policy().nodes[0],ip}]}).success,false)
    assert.equal(proxyPolicySchema.safeParse({...policy(),nodes:[...policy().nodes,...policy().nodes]}).success,false)
    assert.equal(proxyPolicySchema.safeParse({...policy(),vaultOrigin:'http://unsafe.example'}).success,false)
    assert.equal(proxyPolicySchema.safeParse({...policy(),command:'anything'}).success,false)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('readonly MCP really denies repair and unknown targets, not just tool-list hiding',async()=>{
  let calls=0;const service=new ProxyService(new Database(':memory:'),policy(undefined,false),async()=>{calls++;return good})
  try{
    assert.equal(service.tools().some(t=>t.name==='proxy_repair'),false)
    await assert.rejects(service.call('proxy_repair',args),/scope-denied/)
    await assert.rejects(service.call('proxy_inspect',{ip:'198.51.100.11'}),/scope-denied/)
    await assert.rejects(service.call('proxy_inspect',{ip:args.ip,command:'restart'}),/invalid-proxy-arguments/)
    await assert.rejects(service.call('proxy_repair',{...args,password:'not-a-real-secret'}),/invalid-proxy-arguments/)
    assert.equal(calls,0)
    assert.equal((await service.call('proxy_inspect',{ip:args.ip})).ok,true)
  }finally{await service.close()}
})

test('same request returns same operation; shared SQLite locks serialize different callers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'proxy-lock-test-'));let finish!:(r:any)=>void,calls=0
  const first=await ProxyService.open(policy(root),async()=>{calls++;return new Promise(r=>finish=r)})
  const second=await ProxyService.open({...policy(root),principal:'another-operator'},async()=>good)
  try{
    const result=await first.call('proxy_repair',args)
    assert.equal((await first.call('proxy_repair',args)).operationId,result.operationId)
    await assert.rejects(first.call('proxy_verify',args),/request-id-conflict/)
    await assert.rejects(second.call('proxy_repair',args),/busy-or-unknown/)
    await assert.rejects(second.call('proxy_status',{operationId:result.operationId}),/not-found/)
    assert.equal(calls,1);finish(good);await settle(first)
    assert.equal((await first.status(result.operationId as string)).state,'succeeded')
    assert.equal((await first.call('proxy_repair',args)).operationId,result.operationId)
    assert.equal(calls,1)
    await second.call('proxy_verify',{...args,requestId:'request-fixture-0002'});await settle(second)
  }finally{finish?.(good);await first.close();await second.close();await rm(root,{recursive:true,force:true})}
})

test('unknown outcomes survive reopening, retain lock and reconcile only the exact remote receipt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'proxy-receipt-test-'));const first=await ProxyService.open(policy(root),async()=>{throw new Error('unexpected secret https://do-not-leak.example')})
  const result=await first.call('proxy_repair',args);await settle(first);await first.close()
  let recovered=false,repairs=0,receiptId=''
  const second=await ProxyService.open(policy(root),async(action,_ip,id)=>{if(action==='repair')repairs++;receiptId=id;return recovered?{...good,receiptOperationId:id}:{ok:false,quiescent:false}})
  try{
    const status=await second.status(result.operationId as string)
    assert.equal(status.state,'unknown');assert.equal(JSON.stringify(status).includes('do-not-leak'),false)
    await assert.rejects(second.call('proxy_repair',{...args,requestId:'request-fixture-0002'}),/busy-or-unknown/)
    recovered=true;assert.equal((await second.status(result.operationId as string)).state,'succeeded')
    assert.equal(receiptId,result.operationId);assert.equal(repairs,0)
    assert.equal(second.db.prepare('SELECT COUNT(*) n FROM proxy_node_locks').get().n,0)
  }finally{await second.close();await rm(root,{recursive:true,force:true})}
})

test('failed receipt providers or unrelated final replies cannot release an unknown reservation',async()=>{
  let reply:any={ok:false,reason:'provider-unavailable',quiescent:true}
  const service=new ProxyService(new Database(':memory:'),policy(),async action=>action==='receipt'?reply:{ok:false,quiescent:false})
  try{
    const result=await service.call('proxy_repair',args);await settle(service)
    for(const value of [reply,{...good,receiptOperationId:'00000000-0000-4000-8000-000000000000'}]){
      reply=value
      assert.equal((await service.status(result.operationId as string)).state,'unknown')
      await assert.rejects(service.call('proxy_repair',{...args,requestId:'request-fixture-0002'}),/busy-or-unknown/)
    }
    const unavailable=proxyTransport({...policy(),vaultTokenFile:'/fixtures/missing-token',sshResolveTokenFile:'/fixtures/missing-token'})
    assert.equal((await unavailable('receipt',args.ip,result.operationId as string,()=>{})).quiescent,false)
    assert.equal((await unavailable('repair',args.ip,result.operationId as string,()=>{})).quiescent,true)
    reply={...good,receiptOperationId:result.operationId}
    assert.equal((await service.status(result.operationId as string)).state,'succeeded')
  }finally{await service.close()}
})

test('definitive failures release their own reservation and status events paginate',async()=>{
  const service=new ProxyService(new Database(':memory:'),policy(),async(_a,_ip,_id,emit)=>{
    for(let i=0;i<75;i++)emit({stage:'fixture',index:i})
    return {ok:false,quiescent:true,reason:'proxy-exit-mismatch'}
  })
  try{
    const result=await service.call('proxy_verify',args);await settle(service)
    const one=await service.status(result.operationId as string),two=await service.status(result.operationId as string,one.nextAfter as number)
    assert.equal(one.state,'blocked');assert.equal((one.events as any[]).length,50);assert.equal(one.hasMore,true)
    assert.equal(two.hasMore,false);assert.ok((two.events as any[])[0].seq>(one.nextAfter as number))
    assert.equal(service.db.prepare('SELECT COUNT(*) n FROM proxy_node_locks').get().n,0)
  }finally{await service.close()}
})

test('SDK client negotiates MCP, lists and invokes a real fixture-backed server',async()=>{
  const service=new ProxyService(new Database(':memory:'),policy(),async()=>good)
  const server=createProxyMcp(service),client=new Client({name:'proxy-fixture-client',version:'1.0.0'})
  const [a,b]=InMemoryTransport.createLinkedPair()
  try{
    await server.connect(a);await client.connect(b)
    assert.equal((await client.listTools()).tools.length,4)
    const response:any=await client.callTool({name:'proxy_verify',arguments:args})
    const result=JSON.parse(response.content[0].text);assert.ok(result.operationId)
    await settle(service)
    const status:any=await client.callTool({name:'proxy_status',arguments:{operationId:result.operationId}})
    assert.equal(JSON.parse(status.content[0].text).state,'succeeded')
    const repair:any=await client.callTool({name:'proxy_repair',arguments:{...args,requestId:'sdk-repair-fixture-0002'}})
    await settle(service)
    assert.equal((await service.status(JSON.parse(repair.content[0].text).operationId)).state,'succeeded')
    const denied:any=await client.callTool({name:'proxy_repair',arguments:{...args,ip:'198.51.100.11'}})
    assert.equal(denied.isError,true)
  }finally{await client.close();await server.close();await service.close()}
})

test('packaged stdio MCP initializes without credentials and defaults to deny-all',async()=>{
  const client=new Client({name:'proxy-stdio-test',version:'1.0.0'})
  const transport=new StdioClientTransport({command:'/usr/bin/node',args:['--import','tsx','src/proxy-mcp.ts'],cwd:process.cwd(),stderr:'pipe'})
  try{
    await client.connect(transport)
    assert.equal((await client.listTools()).tools.length,3)
    const result:any=await client.callTool({name:'proxy_inspect',arguments:{ip:args.ip}})
    assert.equal(result.isError,true);assert.match(result.content[0].text,/proxy-scope-denied/)
  }finally{await client.close()}
})

test('fixed remote adapter fault paths pass with all system and network operations mocked',()=>{
  const result=spawnSync('/usr/bin/python3',['-B','-m','unittest','discover','-s','test','-p','proxy_remote_test.py'],{encoding:'utf8'})
  assert.equal(result.status,0,result.stdout+result.stderr)
})
