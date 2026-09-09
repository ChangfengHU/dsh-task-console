import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { dispatchNotification, isTaskNotification } from '../src/notification-dispatch.ts'

test('notification dispatch uses native parent tokens and canonical MCP receipts', async () => {
  const agent = {}, token = Symbol(), signal = new AbortController().signal, contexts: unknown[] = []
  const exec = { name: 'task_notify', token, callId: 'notify-1', rootCallId: 'root-1', signal, deferContext: (c: unknown) => contexts.push(c) }
  let calls = 0
  const runtime = { async execute(input: any) {
    calls++
    assert.equal(input.parent, token); assert.equal(input.rootCallId, 'root-1'); assert.equal(input.signal, signal)
    assert.equal(isTaskNotification(input), true)
    assert.equal(isTaskNotification({ ...input, parent: { name: 'task_notify' } }), false)
    assert.equal(isTaskNotification({ ...input, parent: Symbol() }), false)
    assert.equal(isTaskNotification({ ...input, agent: {} }), false)
    return { isError: false, value: { content: [{ type: 'text', text: '{"sent":1}' }] }, content: [{ type: 'text', text: 'truncated projection…' }], additionalContexts: ['fixture-context'] }
  } }
  assert.deepEqual(await dispatchNotification(runtime,agent,'wecom',{},exec), { sent: 1 })
  assert.deepEqual(contexts,['fixture-context']); assert.equal(calls,1)
  assert.equal(isTaskNotification({agent,parent:token}),false)
})

test('failed dispatch cannot leak a scoped send grant or blindly retry', async () => {
  const agent = {}, token = Symbol(), exec = { name:'task_notify',token,callId:'n',signal:new AbortController().signal }
  let calls = 0
  await assert.rejects(dispatchNotification({execute:async()=>{calls++;throw Error('timeout')}},agent,'wecom',{},exec),/timeout/)
  assert.equal(calls,1); assert.equal(isTaskNotification({agent,parent:token}),false)
  await assert.rejects(dispatchNotification({},agent,'wecom',{}, {...exec,name:'model-call'}),/parent-required/)
})

test('native ToolRuntime executes one guarded nested notification with a full receipt', async () => {
  const require = createRequire(import.meta.url)
  const cordis = require.resolve('@deepseek-ai/cordis', { paths: [dirname(require.resolve('@deepseek-ai/dsh-tools'))] })
  const { Context } = await import(pathToFileURL(cordis).href)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => {} })
  const runtime = new ToolRuntime(ctx), agent = { ctx }
  let calls = 0
  const disposeSend = runtime.register({ name:'fixture_send',description:'No network',parameters:{type:'object',properties:{}},
    output:{schema:{type:'object'},render:()=>[{type:'text',text:'display projection, not a receipt'}]},
    execute:async (_args:any, exec:any) => {
      assert.equal(isTaskNotification(exec),true); calls++
      return {content:[{type:'text',text:'{"sent":1}'}]}
    } })
  const disposeNotify = runtime.register({ name:'task_notify',description:'No network',parameters:{type:'object',properties:{}},
    output:{schema:{type:'object'},render:(_args:any,value:any)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:(_args:any,exec:any)=>dispatchNotification(runtime,agent,'fixture_send',{},exec) })
  try {
    const result=await runtime.execute({name:'task_notify',arguments:{},agent,callId:'fixture-root',signal:new AbortController().signal} as any)
    assert.equal(result.isError,false); assert.deepEqual(result.value,{sent:1}); assert.equal(calls,1)
  } finally { disposeNotify(); disposeSend() }
})
