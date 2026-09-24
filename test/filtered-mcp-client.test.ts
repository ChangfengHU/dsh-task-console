import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeWithTaskScope, taskMediaServer, assertBrowserSession, assertToolArguments, bindBrowserSessionDefinition, instanceServerName, publicToolName, resolveSourceConfig } from '../src/filtered-mcp-client.ts'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

test('filtered MCP public names match the DSH naming contract', () => {
  assert.equal(publicToolName('vault-agent', 'get_config'), 'mcp__vault-agent__get_config')
  const lossy = publicToolName('vault-agent', 'a tool with a very long name '.repeat(4))
  assert.match(lossy, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(lossy.length, 64)
})

test('each Agent gets a valid unique internal MCP namespace', () => {
  const first = instanceServerName('vyibc-fleet-fleet-installer', 'agent-fleet-installer-one')
  const second = instanceServerName('vyibc-fleet-fleet-installer', 'agent-fleet-installer-two')
  assert.match(first, /^[A-Za-z0-9_-]{1,32}$/)
  assert.equal(first.length, 32)
  assert.notEqual(first, second)
  assert.equal(instanceServerName('vyibc-fleet-fleet-installer', 'agent-fleet-installer-one'), first)
})

test('MCP argument policy admits scoped keys and rejects unrelated keys', () => {
  const rule = { valuesOrPrefixes: { key: ['clash:lines', 'ssh:host-'] } }
  assert.doesNotThrow(() => assertToolArguments('get_config', rule, { key: 'clash:lines' }))
  assert.doesNotThrow(() => assertToolArguments('get_config', rule, { key: 'ssh:host-1-2-3-4' }))
  assert.throws(() => assertToolArguments('get_config', rule, { key: 'service:github' }), /policy denied/)
})

test('MCP argument policy checks optional URL patterns when supplied', () => {
  const rule = { patterns: { id: '^host-(?:[0-9]{1,3}-){3}[0-9]{1,3}$', vncUrl: '^https://vnc-' } }
  assert.doesNotThrow(() => assertToolArguments('register_node', rule, { id: 'host-1-2-3-4' }))
  assert.doesNotThrow(() => assertToolArguments('register_node', rule, { id: 'host-1-2-3-4', vncUrl: 'https://vnc-1-2-3-4.vyibc.com/' }))
  assert.throws(() => assertToolArguments('register_node', rule, { id: 'other' }), /policy denied/)
})

test('MCP argument policy can require a scoped audit id', () => {
  const rule = { requiredArguments: ['id'], patterns: { id: '^host-(?:[0-9]{1,3}-){3}[0-9]{1,3}$' } }
  assert.throws(() => assertToolArguments('node_audit', rule, {}), /argument "id" is required/)
  assert.doesNotThrow(() => assertToolArguments('node_audit', rule, { id: 'host-1-2-3-4' }))
})

test('filtered MCP resolves auth from one exact official host entry', () => {
  const secretConfig = { serverName: 'vault', transport: 'streamable-http', url: 'https://vault.invalid/mcp', headers: { Authorization: 'Bearer test-secret' } }
  const official = { options: { id: 'host-vault', name: '@deepseek-ai/dsh-mcp-client', config: secretConfig } }
  const ctx = { get: (name: string) => name === 'loader' ? { entries: () => [official] } : undefined } as any
  assert.deepEqual(resolveSourceConfig(ctx, 'host-vault'), secretConfig)
  official.options.name = 'another-plugin'
  assert.throws(() => resolveSourceConfig(ctx, 'host-vault'), /not an official MCP client/)
})

test('filtered MCP resolves a host entry across a preset loader scope', () => {
  const source = { serverName: 'fleet-browser', command: '/usr/bin/node', args: ['server.mjs'] }
  const ctx = {
    get(name: string) {
      if (name === 'loader') return { entries: () => [] }
      if (name === 'taskConsole') return { sourceMcpConfig: (id: string) => id === 'mcp-fleet-browser' ? source : undefined }
    },
  } as any
  assert.deepEqual(resolveSourceConfig(ctx, 'mcp-fleet-browser'), source)
  assert.throws(() => resolveSourceConfig(ctx, 'missing'), /unavailable/)
})

test('browser identity is bound per execution without changing the MCP schema or accepting spoofed sessions', () => {
  const parameters = {type:'object',properties:{ip:{type:'string'},sessionId:{type:'string'},requestId:{type:'string'}},required:['ip','sessionId','requestId']}
  const calls: any[] = []
  const original = {parameters,description:'Create one',execute:(args:any,exec:any)=>{assertBrowserSession('browser_create',args,exec);calls.push(args);return args}}
  const tool = bindBrowserSessionDefinition('browser_create',original)
  assert.equal(original.parameters,parameters);assert.ok(parameters.properties.sessionId)
  assert.equal(tool.parameters.properties.sessionId,undefined)
  assert.deepEqual(tool.parameters.required,['ip','requestId'])
  assert.match(tool.description,/宿主自动绑定/)
  const input = {ip:'192.0.2.1',requestId:'same-attempt'}
  for (const id of ['agent-browser-manager-one','task-real']) {
    const result = tool.execute(input,{agent:{session:{id}}})
    assert.deepEqual(result,{...input,sessionId:id});assert.equal('sessionId' in input,false)
  }
  assert.equal(tool.execute(input,{agent:{session:{header:{id:'agent-browser-manager-two'}}}}).sessionId,'agent-browser-manager-two')
  assert.throws(()=>tool.execute(input,{agent:{session:{}}}),/unavailable/)
  assert.throws(()=>tool.execute({...input,sessionId:'agent-browser-manager-forged'},{agent:{session:{id:'task-real'}}}),/omit sessionId/)
  assert.equal(calls.length,3)
  assert.equal(bindBrowserSessionDefinition('vault_get',original),original)
  const read = {...original,parameters:{type:'object',properties:{ip:{type:'string'}}}}
  assert.equal(bindBrowserSessionDefinition('browser_inspect',read),read)
})

test('native ToolRuntime executes create and purge without model sessionId; policy and exact purge evidence remain enforced', async () => {
  const require = createRequire(import.meta.url)
  const cordis = require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})
  const {Context} = await import(pathToFileURL(cordis).href)
  const ctx = new Context();ctx.provide('systemPrompt',{tools:()=>{}})
  const runtime = new ToolRuntime(ctx), agent = {ctx,session:{id:'agent-browser-manager-ui-fixture'}}
  const calls: any[] = [], disposers: (()=>void)[] = []
  for (const name of ['browser_create','browser_purge']) {
    const properties:any = {ip:{type:'string'},requestId:{type:'string'},sessionId:{type:'string'}}
    if(name==='browser_purge')Object.assign(properties,{instances:{type:'array',items:{type:'integer'}},planHash:{type:'string'},confirm:{type:'string',enum:['PURGE-EXACT']}})
    disposers.push(runtime.register(bindBrowserSessionDefinition(name,{
      name,description:'Fixture, no network',parameters:{type:'object',properties,required:Object.keys(properties)},
      output:{schema:{type:'object'},render:(_a:any,value:any)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:(args:any,exec:any)=>{
        // The real MCP owns purge validation; this fixture models that boundary.
        assertToolArguments(name,{requiredArguments:Object.keys(properties),valuesOrPrefixes:{ip:['192.0.2.1']}},args)
        assertBrowserSession(name,args,exec);calls.push({name,args});return {ok:true,sessionId:args.sessionId}
      },
    })))
  }
  const run=(name:string,args:any,as=agent)=>runtime.execute({name,arguments:args,agent:as,callId:'fixture-'+name,signal:new AbortController().signal} as any)
  try {
    assert.equal((await run('browser_create',{ip:'192.0.2.1',requestId:'create-once'})).isError,false)
    assert.equal((await run('browser_create',{ip:'192.0.2.9',requestId:'denied'})).isError,true)
    assert.equal((await run('browser_purge',{ip:'192.0.2.1',requestId:'purge-once',instances:[3]})).isError,true)
    assert.equal((await run('browser_purge',{ip:'192.0.2.1',requestId:'purge-once',instances:[3],planHash:'real-fixture-plan',confirm:'PURGE-EXACT'})).isError,false)
    assert.equal(calls.length,2);assert.ok(calls.every(c=>c.args.sessionId===agent.session.id))
    assert.deepEqual(calls[1].args.instances,[3]);assert.equal(calls[1].args.planHash,'real-fixture-plan')
  } finally {disposers.forEach(dispose=>dispose())}
})


test('real renderComposition media names route paid Task calls through the host guard', async () => {
  let dispatched = 0
  const guarded: string[] = []
  const ctx = { get: () => ({ scopedMcp: async (raw: string, args: any, _exec: any, call: any) => { guarded.push(raw); return call({...args,guarded:true}) } }) }
  for (const kind of ['voice','image']) {
    const raw = kind === 'voice' ? 'vyibc-voice_synthesize' : 'vyibc-image_generate_image'
    const identity = {serverName:`vyibc-${kind}-studio-video-producer`,sourceEntryId:`mcp-vyibc-${kind}`,sourceServerName:`vyibc-${kind}`}
    const result: any = await executeWithTaskScope(ctx,identity,raw,{text:'fixture'}, {agent:{session:{id:'task-real-producer'}}}, args => {dispatched++;return args})
    assert.equal(result.guarded,true)
    assert.throws(() => executeWithTaskScope({},identity,raw,{}, {agent:{session:{id:'task-real-producer'}}}, () => {dispatched++}), /scope guard unavailable/)
  }
  assert.equal(dispatched,2);assert.deepEqual(guarded,['vyibc-voice_synthesize','vyibc-image_generate_image'])
  assert.equal(taskMediaServer('renamed-host','mcp-vyibc-image'),true)
  assert.equal(taskMediaServer('renamed-host',undefined,'vyibc-voice'),true)
  assert.equal(taskMediaServer('vyibc-voice-studio-video-producer'),true)
  assert.equal(taskMediaServer('unrelated-voice'),false)
})

test('ordinary Agent media calls stay direct and existing Task proxy/browser routes stay guarded', async () => {
  const seen: string[] = []
  const ctx={get:()=>({scopedMcp:(name:string,args:any)=>{seen.push(name);return args}})}
  let calls=0
  await executeWithTaskScope(ctx,{serverName:'vyibc-voice-studio-video-producer'},'vyibc-voice_synthesize',{}, {agent:{session:{id:'agent-chat'}}},()=>{calls++})
  await executeWithTaskScope(ctx,{serverName:'fleet-proxy-agent'},'proxy_verify',{}, {agent:{session:{id:'task-other'}}},()=>{calls++})
  await executeWithTaskScope(ctx,{serverName:'fleet-browser-agent'},'browser_login_resume',{}, {agent:{session:{id:'task-other'}}},()=>{calls++})
  await executeWithTaskScope(ctx,{serverName:'other'},'read',{}, {agent:{session:{id:'task-other'}}},()=>{calls++})
  assert.equal(calls,2);assert.deepEqual(seen,['proxy_verify','browser_login_resume'])
})

test('real service scope refreshes studio status budget on success and unknown submission', async t => {
  const {default: Database}=await import('better-sqlite3')
  const {StudioOperations}=await import('../src/studio-operations.js')
  const {StudioWorkflow}=await import('../src/studio-workflow.js')
  const {TaskConsoleService}=await import('../src/service.js')
  const db=new Database(':memory:');t.after(()=>db.close())
  const task:any={id:'studio-task',design:{evidenceContract:'studio-video-v1',studio:{characterId:'character-any',referenceSha256:'b'.repeat(64),referenceUrl:'https://cdn.vyibc.com/approved.mp4'}}}
  const batch:any={id:'batch'},card:any={id:'card',role:'executor',agentId:'studio-video-producer'}
  const run={taskId:task.id,batchId:batch.id,cardId:card.id,sessionId:'task-live-producer',status:'running'}
  const store:any={kernel:{db},tasks:new Map([[task.id,task]]),s:{runs:new Map([['run',run]]),batches:new Map([[batch.id,batch]]),cards:new Map([[card.id,card]])}}
  const input={task,batch,card,sessionId:run.sessionId},ops=new StudioOperations(store),workflow=new StudioWorkflow(store)
  workflow.recordScript({...input,card:{...card,role:'planner'}},{sha256:'c'.repeat(64),lines:['one','two','three'].map(text=>({id:text,text}))})
  ops.configure(input,{imageCalls:6,voiceSegments:80})
  const service:any=Object.create(TaskConsoleService.prototype);service.runner={store}
  const exec={agent:{session:{id:run.sessionId}}}
  const first={segments:[{text:'one'}]}
  await service.scopedMcp('vyibc-voice_synthesize',first,exec,async()=>({structuredContent:{job_id:'job-1',status:'done'}}))
  assert.equal(workflow.status(input).budget.used.voiceSegments,1)
  await assert.rejects(service.scopedMcp('vyibc-voice_synthesize',{segments:[{text:'two'},{text:'three'}]},exec,async()=>{throw Error('timeout')}),/submission-unknown/)
  assert.equal(workflow.status(input).budget.used.voiceSegments,3)
  assert.equal(ops.snapshot(input).unknown,true)
})
