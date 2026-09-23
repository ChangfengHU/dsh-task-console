import test from 'node:test'
import assert from 'node:assert/strict'
import { fallbackSelection, startupFallbackAllowed, installFallbackSelection } from '../src/model-fallback.ts'
test('startup fallback is opt-in, bounded and excludes tool/approval/cancellation failures', () => {
  assert.equal(fallbackSelection(''), undefined)
  assert.deepEqual(fallbackSelection('llm-deepseek/qwen-plus-latest'), {provider:'llm-deepseek', model:'qwen-plus-latest'})
  assert.throws(() => fallbackSelection('not a route'))
  const state = { provider:'codex-local' }, reason = {kind:'error',error:{code:'TRANSPORT'}}
  assert.equal(startupFallbackAllowed(reason,state,'codex-local'), true)
  for (const patch of [{used:true},{toolCalled:true},{terminal:{}},{provider:'qwen'}]) assert.equal(startupFallbackAllowed(reason,{...state,...patch},'codex-local'),false)
  for (const code of ['TOOL_ERROR','PERMISSION_DENIED','INVALID_REQUEST','TIMEOUT','ABORTED']) assert.equal(startupFallbackAllowed({kind:'error',error:{code}},state,'codex-local'),false)
  assert.equal(startupFallbackAllowed({kind:'cancelled'},state,'codex-local'),false)
})
test('session scoped switch keeps prompt and request consistent and clears incompatible budgets', async () => {
  const handlers = new Map<string, any>()
  const dispose = installFallbackSelection({ on: (name: string, fn: any, opts: any) => { assert.equal(opts.prepend,true); handlers.set(name,fn); return () => handlers.delete(name) } }, {provider:'qwen',model:'plus'})
  assert.deepEqual(await handlers.get('agent/request')({},async()=>({provider:'codex',model:'old',maxTokens:256000,reasoningEffort:'high',temperature:0.2})),{provider:'qwen',model:'plus',temperature:0.2})
  assert.deepEqual((await handlers.get('system-prompt/assemble')({}, {}, async()=>({variables:{provider:'codex',model:'old',unchanged:1}}))).variables,{provider:'qwen',model:'plus',unchanged:1})
  dispose(); assert.equal(handlers.size,0)
})
