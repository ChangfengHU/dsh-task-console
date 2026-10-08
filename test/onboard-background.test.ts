import test from 'node:test'
import assert from 'node:assert/strict'
import { observeOnboardBackground, pendingOnboardOperation, takeOnboardContinuation } from '../src/onboard-background.ts'

test('installer waits on its own durable operation and wakes on terminal without advancing it', async () => {
  let status = 'running', reads = 0
  const dispose = observeOnboardBackground('installer-a', 'onb-a', async () => {
    reads++; return {phase:'running',run_id:'onb-a',async_operation:{status}}
  })
  assert.equal(await pendingOnboardOperation({sessionId:'installer-a',profileId:'browser-manager'}), undefined)
  assert.equal(await pendingOnboardOperation({sessionId:'installer-b',profileId:'fleet-installer'}), undefined)
  assert.equal(reads,0)
  assert.match((await pendingOnboardOperation({sessionId:'installer-a',profileId:'fleet-installer'}))!, /仍在执行/)
  status = 'succeeded'
  assert.equal(await pendingOnboardOperation({sessionId:'installer-a',profileId:'fleet-installer'}), undefined)
  assert.equal(reads,2)
  assert.match(takeOnboardContinuation({sessionId:'installer-a',profileId:'fleet-installer'})!, /收录真实回执/)
  assert.equal(takeOnboardContinuation({sessionId:'installer-a',profileId:'fleet-installer'}), undefined)
  dispose()
})

test('unknown or replaced operation cannot become success; plugin disposal clears observer', async () => {
  let result: any = {phase:'running',run_id:'onb-a',async_operation:{status:'unknown'}}
  const dispose = observeOnboardBackground('installer-c','onb-a',async()=>result)
  await assert.rejects(pendingOnboardOperation({sessionId:'installer-c',profileId:'fleet-installer'}),/无法核验/)
  result = {phase:'complete',run_id:'onb-b'}
  await assert.rejects(pendingOnboardOperation({sessionId:'installer-c',profileId:'fleet-installer'}),/事务已变更/)
  dispose()
  assert.equal(await pendingOnboardOperation({sessionId:'installer-c',profileId:'fleet-installer'}),undefined)
})

test('fast terminal operations retain one continuation through repeated completion guards', async () => {
  const input = {sessionId:'installer-fast',profileId:'fleet-installer'}
  for (const status of ['succeeded', 'failed', 'blocked']) {
    let reads = 0
    const dispose = observeOnboardBackground(input.sessionId,'onb-fast',async()=>{
      reads++;return {phase:'running',run_id:'onb-fast',async_operation:{status}}
    })
    assert.equal(takeOnboardContinuation(input),undefined)
    await pendingOnboardOperation(input);await pendingOnboardOperation(input)
    assert.equal(reads,1)
    assert.equal(takeOnboardContinuation({...input,profileId:'browser-manager'}),undefined)
    assert.match(takeOnboardContinuation(input)!,/后台结束不代表安装或完整节点验收通过/)
    assert.equal(takeOnboardContinuation(input),undefined)
    dispose()
  }
})

test('missing operation status fails closed instead of becoming a terminal edge', async () => {
  const input = {sessionId:'installer-missing',profileId:'fleet-installer'}
  const dispose = observeOnboardBackground(input.sessionId,'onb-missing',async()=>({phase:'running',run_id:'onb-missing'}))
  await assert.rejects(pendingOnboardOperation(input),/无法核验/)
  assert.equal(takeOnboardContinuation(input),undefined)
  dispose()
})
