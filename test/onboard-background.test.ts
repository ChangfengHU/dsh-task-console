import test from 'node:test'
import assert from 'node:assert/strict'
import { observeOnboardBackground, pendingOnboardOperation } from '../src/onboard-background.ts'

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
