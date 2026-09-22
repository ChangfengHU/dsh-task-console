import test from 'node:test'
import assert from 'node:assert/strict'
import { serialPoll } from '../src/client/poll.ts'

test('poll waits for completion, pauses hidden pages and stops after disposal', async () => {
  let hidden=false, calls=0, resolve:()=>void=()=>{}
  let next:(()=>void)|undefined
  const env={hidden:()=>hidden,schedule:(fn:()=>void)=>{next=fn;return 1},cancel:()=>{next=undefined}}
  const stop=serialPoll(async()=>{calls++;await new Promise<void>(r=>{resolve=r})},10,env)
  assert.equal(calls,1);assert.equal(next,undefined)
  resolve();await Promise.resolve();await Promise.resolve()
  assert.ok(next)
  hidden=true;next!();assert.equal(calls,1)
  hidden=false;next!();assert.equal(calls,2)
  stop();resolve();await Promise.resolve();await Promise.resolve()
  assert.equal(next,undefined)
})

test('terminal result stops polling', async()=>{
  let scheduled=0
  serialPoll(async()=>false,10,{hidden:()=>false,schedule:()=>{scheduled++;return 1},cancel:()=>{}})
  await Promise.resolve();await Promise.resolve();assert.equal(scheduled,0)
})
