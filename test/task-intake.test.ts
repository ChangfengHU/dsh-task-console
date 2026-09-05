import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskRunner } from '../src/runner.ts'
import { EventStore } from '../src/tasks.ts'
import { TaskIntakeCoordinator, validateTaskIntakeDecision, validateTaskSignal, type IntakeAgent, type TaskSignal } from '../src/task-intake.ts'

const roster: IntakeAgent[] = [
  { id: 'a', name: 'Planner', description: 'plans', tools: [], mcpTools: {}, skills: [] },
  { id: 'b', name: 'Executor', description: 'implements', tools: ['fs'], mcpTools: {}, skills: [] },
  { id: 'c', name: 'Reviewer', description: 'verifies', tools: [], mcpTools: {}, skills: [] },
]

function signal(id: string, incidentId: string, objective = 'Verify the synthetic control-plane flow without touching machines.'): TaskSignal {
  return validateTaskSignal({
    schemaVersion: 1, id, source: 'fleet-probe/synthetic', kind: 'incident.confirmed', observedAt: '2026-09-04T12:00:00Z',
    goal: { key: 'runner-control-plane', title: 'Runner control-plane acceptance', objective },
    incident: { id: incidentId, faultKind: 'synthetic.noop', state: 'confirmed', severity: 'test', summary: 'No real node is involved.' },
    targets: [{ kind: 'synthetic-node', id: 'demo-node', label: 'Synthetic only' }],
    constraints: ['Do not connect to or modify any Fleet machine.'], facts: [{ name: 'simulation', value: true }],
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tc-intake-'))
  const presets = join(root, 'presets')
  for (const agent of roster) {
    await mkdir(join(presets, agent.id), { recursive: true })
    await writeFile(join(presets, agent.id, 'task-console.json'), JSON.stringify({ id: agent.id, name: agent.name, description: agent.description, persona: '', model: 'p/m', effort: '', permissionPreset: 'workspace-write', tools: agent.tools, mcpTools: {}, mcpPolicy: {}, skills: [] }))
  }
  const ctx: any = {
    on: () => () => undefined, effect: () => undefined,
    get: (key: string) => key === 'agentPresets' ? { resolve: async (id: string) => ({ id, name: id, path: join(presets, id, 'agent.cordis.yml') }) } : undefined,
  }
  const store = new EventStore(join(root, 'store'))
  const runner = new TaskRunner(ctx, store, { maxInProgress: 0 })
  await runner.start()
  let decisions = 0
  const intake = new TaskIntakeCoordinator(runner, {
    workspace: join(root, 'workspace'), agents: async () => roster,
    decide: async (incoming, context) => {
      decisions++
      return {
        sessionId: `intake-session-${decisions}`,
        decision: {
          action: context.recommendedTaskId ? 'reuse' : 'create',
          ...(context.recommendedTaskId ? { taskId: context.recommendedTaskId } : { title: 'Fleet Runner reliability' }),
          reason: context.recommendedTaskId ? 'The same Incident lifecycle already owns a durable Task.' : 'No matching Task exists for this independent long-lived goal.',
          confidence: 0.98, objective: incoming.goal.objective, workflow: 'dynamic-rounds',
          participants: [{ agentId: 'a', role: 'planner' }, { agentId: 'b', role: 'executor' }, { agentId: 'c', role: 'reviewer' }],
        },
      }
    },
  })
  await intake.start()
  return { root, runner, intake, get decisions() { return decisions } }
}

test('Task Intake is idempotent and reuses one goal Task for later Turns of the same Incident', async () => {
  const f = await fixture()
  const firstSignal = signal('sig-001', 'inc-001')
  await f.intake.submit(firstSignal)
  const first = await f.intake.wait(firstSignal.id)
  assert.equal(first.status, 'materialized')
  assert.equal(first.decision?.action, 'create')
  assert.equal(f.runner.store.s.tasks.size, 1)
  assert.equal(f.runner.store.s.batches.get(first.batchId!)?.turn?.origin?.signalId, 'sig-001')

  const secondSignal = signal('sig-002', 'inc-001', 'Continue the same incident with fresh evidence and a new Turn objective.')
  await f.intake.submit(secondSignal)
  const second = await f.intake.wait(secondSignal.id)
  assert.equal(second.decision?.action, 'reuse')
  assert.equal(second.taskId, first.taskId)
  assert.notEqual(second.batchId, first.batchId)
  assert.equal(f.runner.store.s.tasks.size, 1)
  assert.equal(f.runner.store.s.batches.get(second.batchId!)?.turn?.objective, secondSignal.goal.objective)
  assert.equal(f.runner.store.s.batches.size, 2)

  await f.intake.submit(secondSignal)
  assert.equal(f.decisions, 2, 'an exact duplicate Signal never starts another Task Agent')
  const conflicting = structuredClone(secondSignal)
  conflicting.goal.objective = 'A conflicting payload must never hide behind an already accepted Signal id.'
  await assert.rejects(() => f.intake.submit(conflicting), /内容不同/)
  assert.equal(f.runner.store.s.batches.size, 2)
  const links = f.runner.store.kernel.db.prepare('SELECT * FROM dsh_task_incident_links WHERE incident_id=?').all('inc-001')
  assert.equal(links.length, 1)
  const targets = f.runner.store.kernel.db.prepare('SELECT * FROM dsh_task_targets WHERE task_id=?').all(first.taskId)
  assert.equal(targets.length, 1)
  assert.equal(f.intake.events(secondSignal.id).map(row => row.kind).join(','), 'received,decision_started,decision_recorded,materialization_started,materialized')
  f.runner.stop()
})

test('concurrent Signals for one Incident are routed serially and reuse one Task', async () => {
  const f = await fixture()
  const firstSignal = signal('sig-concurrent-a', 'inc-concurrent')
  const secondSignal = signal('sig-concurrent-b', 'inc-concurrent', 'Continue the concurrent synthetic Incident as a second auditable Turn.')
  await Promise.all([f.intake.submit(firstSignal), f.intake.submit(secondSignal)])
  const [first, second] = await Promise.all([f.intake.wait(firstSignal.id), f.intake.wait(secondSignal.id)])
  assert.equal(first.taskId, second.taskId)
  assert.deepEqual(new Set([first.decision?.action, second.decision?.action]), new Set(['create', 'reuse']))
  assert.equal(f.runner.store.s.tasks.size, 1)
  assert.equal(f.runner.store.s.batches.size, 2)
  f.runner.stop()
})

test('Task Intake creates a separate Task for an independent Incident and never uses target as its identity', async () => {
  const f = await fixture()
  const first = await f.intake.submit(signal('sig-a', 'inc-a'))
  await f.intake.wait(first.signal.id)
  const independent = signal('sig-b', 'inc-b', 'Produce an independent control-plane report for another root cause.')
  independent.goal.key = 'independent-root-cause'
  const second = await f.intake.submit(independent)
  const done = await f.intake.wait(second.signal.id)
  assert.equal(done.decision?.action, 'create')
  assert.equal(f.runner.store.s.tasks.size, 2)
  assert.match(done.taskId!, /^T-intake-/)
  assert.notEqual(done.taskId, 'demo-node')
  f.runner.stop()
})

test('Signal and decision validators reject credential-shaped facts and permission expansion', () => {
  assert.throws(() => validateTaskSignal({
    schemaVersion: 1, id: 's', source: 'x', kind: 'incident', observedAt: new Date().toISOString(),
    goal: { title: 'ok', objective: 'long enough objective' }, facts: [{ name: 'api_token', value: 'leak' }],
  }), /不允许/)
  assert.throws(() => validateTaskSignal({
    schemaVersion: 1, id: 's2', source: 'x', kind: 'incident', observedAt: new Date().toISOString(),
    goal: { title: 'ok', objective: 'Investigate failure with password=do-not-store-this.' }, facts: [],
  }), /凭据/)
  const context = { policy: [], agents: roster, candidateTasks: [], recommendedTaskId: undefined }
  assert.throws(() => validateTaskIntakeDecision({ action: 'create', reason: 'valid reason', confidence: 1, title: 'x', workflow: 'dynamic-rounds', participants: [{ agentId: 'ghost', role: 'planner' }] }, context), /名册/)
})

test('executor capabilities are enforced by actual tool schemas, never a broad role description', () => {
  const participants = [{agentId:'a',role:'planner'},{agentId:'b',role:'executor'},{agentId:'c',role:'reviewer'}]
  const decision = {action:'create',title:'Restore Runner coverage',reason:'Use a released bounded deployment tool',confidence:1,workflow:'dynamic-rounds',participants}
  const context = {policy:[],agents:roster,candidateTasks:[],requiredExecutorTools:['fleet_runner_ensure','fleet_runner_status']}
  assert.throws(()=>validateTaskIntakeDecision(decision,context),/实际工具/)
  const narrow=structuredClone(roster);narrow[1].description='Fleet runtime with all powers';narrow[1].toolSchemas=['fleet_onboard_start','fleet_onboard_status']
  assert.throws(()=>validateTaskIntakeDecision(decision,{...context,agents:narrow}),/实际工具/)
  narrow[1].toolSchemas=['fleet_runner_ensure','fleet_runner_status']
  assert.throws(()=>validateTaskIntakeDecision(decision,{...context,agents:narrow}),/taskExpertise/)
  narrow[0].taskExpertise=['fleet_onboard_start','fleet_onboard_status']
  narrow[2].taskExpertise=[...context.requiredExecutorTools]
  assert.throws(()=>validateTaskIntakeDecision(decision,{...context,agents:narrow}),/taskExpertise/)
  narrow[0].taskExpertise=[...context.requiredExecutorTools]
  assert.equal(validateTaskIntakeDecision(decision,{...context,agents:narrow}).action,'create')
  assert.equal(narrow[0].toolSchemas,undefined,'declared expertise grants no executor tools to a planner')
  assert.equal(validateTaskIntakeDecision({action:'triage',reason:'No exact deployment tool exists',confidence:1},context).action,'triage')
  const incoming=signal('sig-tools','inc-tools');incoming.requiredExecutorTools=context.requiredExecutorTools
  assert.deepEqual(validateTaskSignal(incoming).requiredExecutorTools,context.requiredExecutorTools)
  assert.throws(()=>validateTaskSignal({...incoming,requiredExecutorTools:['bash; ssh anything']}),/requiredExecutorTools/)
})
