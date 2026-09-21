import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workflowDefinition, workflowView } from '../src/workflow-plan.ts'
import { taskForTurn } from '../src/tasks.ts'
import type { TaskSpec, Batch } from '../src/fold.ts'

const task = { id: 'T', title: 'Workflow', brief: 'Reusable goal', participants: [{ agentId: 'a', brief: 'Own work' }],
  graphMode: 'static-chain', timeoutSec: 60, onFail: 'stop', maxTries: 1, cwd: '/tmp', enabled: true,
  createdAt: '2026-09-08T00:00:00Z', trigger: { kind: 'once' }, origin: { source: 'task-chat', signalId: 's', decision: 'create', intakeSessionId: 'creator' } } as TaskSpec

test('direct reuse retains original creator without inventing a new Agent invocation', () => {
  const batch = { turn: { objective: 'Reusable goal\n\n[THIS EXECUTION — USER REQUEST]\nTarget input', participants: task.participants,
    origin: { source: 'task-chat', decision: 'reuse', signalId: 'second' } } } as Batch
  const view = workflowView(task, batch)
  assert.equal(view.directReuse, true)
  assert.deepEqual(view.sessions, [{ id: 'creator', label: '原始创建 Agent' }])
  assert.equal(view.request, 'Target input')
  assert.equal(view.legacy, true)
  assert.equal(view.planId, null)
})
test('creation sessions are deduplicated; real later routing session is separate', () => {
  const batch = { turn: { participants: task.participants, objective: 'x', origin: task.origin } } as Batch
  assert.equal(workflowView(task, batch).sessions.length, 1)
  batch.turn!.origin = { ...task.origin!, intakeSessionId: 'later', decision: 'reuse' }
  assert.equal(workflowView(task, batch).sessions.length, 2)
  assert.equal(workflowView(task, batch).directReuse, false)
  assert.equal(workflowView(task, batch).request, null)
  assert.equal(workflowView({ ...task, origin: undefined }).sessions.length, 0)
})
test('saved plan is independent of later template/preset changes and drives the execution view', () => {
  const definition = workflowDefinition(task)
  definition.participants[0].brief = 'Saved role boundary'
  assert.equal(task.participants[0].brief, 'Own work')
  const batch = { turn: { objective: 'Compiled request', userRequest: 'Only user input', participants: definition.participants,
    workflow: { id: 'abc', definition } } } as Batch
  const changed = { ...task, title: 'Later title', timeoutSec: 999 }
  const view = workflowView(changed, batch)
  assert.equal(view.definition.title, 'Workflow')
  assert.equal(view.request, 'Only user input')
  assert.equal(view.planId, 'abc')
  assert.equal(taskForTurn(changed, batch.turn).timeoutSec, 60)
})
