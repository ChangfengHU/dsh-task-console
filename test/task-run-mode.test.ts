import test from 'node:test'
import assert from 'node:assert/strict'
import { taskRunMode } from '../src/client/task-run-mode.ts'
import type { TaskSpec } from '../src/wire.ts'
test('scheduled chat workflows run directly, independent of Actions and paused schedule',()=>{
  const task={trigger:{kind:'cron'},enabled:false,origin:{source:'task-chat',signalId:'signal'}} as TaskSpec
  assert.equal(taskRunMode(task),'direct')
  assert.equal(taskRunMode({...task,trigger:{kind:'once'}}),'parameters')
  assert.equal(taskRunMode({...task,origin:{...task.origin!,source:'fleet'}}),'external')
  assert.equal(taskRunMode({...task,origin:undefined}),'direct')
})
