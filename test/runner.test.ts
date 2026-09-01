import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskRunner } from '../src/runner.ts'
import { EventStore, type TaskSpec } from '../src/tasks.ts'

/** A fake dsh host: presets resolve, agents.create hands back a controllable session. */
function fakeHost(presetDir: string) {
  const listeners: ((s: any, e: any) => void)[] = []
  const sessions = new Map<string, { agent: any; tools: any[]; disposed: boolean; followups: any[] }>()
  const ctx: any = {
    on: (name: string, fn: any) => { if (name === 'session/event') listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    effect: () => undefined,
    get: (key: string) => {
      if (key === 'agentPresets') return { resolve: async (id: string) => ({ id, name: id, path: join(presetDir, id, 'agent.cordis.yml') }), mount: async () => undefined }
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    agents: {
      create: async (opts: any) => {
        const tools: any[] = []
        const rec = { agent: { session: { id: opts.sessionId }, ctx: { tools: { register: (d: any) => { tools.push(d); return () => { const i = tools.indexOf(d); if (i >= 0) tools.splice(i, 1) } } } }, followup: (m: any) => { rec.followups.push(m) } }, tools, disposed: false, followups: [] as any[] }
        await opts.setup?.({})
        sessions.set(opts.sessionId, rec)
        return { agent: rec.agent, dispose: async () => { rec.disposed = true } }
      },
    },
  }
  /** Drive a session: emit raw dsh events as the runner would see them. */
  const emit = (sessionId: string, event: any) => { for (const l of listeners) l({ id: sessionId }, event) }
  const consumeFirst = (sessionId: string) => { const s = sessions.get(sessionId)!; emit(sessionId, { type: 'user/message', data: { id: s.followups[0].id, source: { kind: 'user' } } }) }
  const callTool = async (sessionId: string, name: string, args: any) => { const s = sessions.get(sessionId)!; const t = s.tools.find(x => x.name === name); assert.ok(t, `tool ${name} registered`); return t.execute(args, {}) }
  const endTurn = (sessionId: string) => emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  return { ctx, sessions, emit, consumeFirst, callTool, endTurn }
}

async function setup(taskPatch: Partial<TaskSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tc-run-'))
  const presets = join(root, 'presets'); for (const id of ['a', 'b', 'c']) { await mkdir(join(presets, id), { recursive: true }); await writeFile(join(presets, id, 'task-console.json'), JSON.stringify({ id, name: id.toUpperCase(), description: '', persona: '', model: 'p/m', effort: '', tools: [], mcp: [], skills: [] })) }
  const host = fakeHost(presets)
  const store = new EventStore(join(root, 'store'))
  const runner = new TaskRunner(host.ctx, store, { maxInProgress: 2 })
  await runner.start()
  const task: TaskSpec = { id: 'T', title: 't', brief: 'do it', trigger: { kind: 'once' }, participants: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }], cwd: root, timeoutSec: 60, onFail: 'retry', maxTries: 2, enabled: true, createdAt: 'x', ...taskPatch }
  await store.append({ t: 'task/created', at: 'x', taskId: task.id, task })
  return { host, store, runner, task, root }
}
const tick = () => new Promise(r => setTimeout(r, 80))

test('runner: a 3-card chain records process boundaries and snapshots declared artifacts', async () => {
  const { host, store, runner, root } = await setup()
  await writeFile(join(root, 'result.html'), '<h1>done</h1>')
  const batch = await runner.fire('T', 'manual')
  const s1 = [...host.sessions.keys()][0]
  assert.equal(host.sessions.size, 1, 'only the first card starts; the rest wait on deps')
  assert.ok(host.sessions.get(s1)!.tools.map(t => t.name).includes('task_complete'), 'terminators registered on the agent scope')
  assert.match(host.sessions.get(s1)!.followups[0].content[0].text, /\[CONTRACT\]/)
  host.consumeFirst(s1)
  const types = store.all().filter((e: any) => e.runId === `${batch.id}#0#1`).map(e => e.t)
  assert.deepEqual(types.slice(0, 3), ['run/claimed', 'run/session_created', 'run/prompt_dispatched'])
  await host.callTool(s1, 'task_complete', { summary: 'A 交接单', artifacts: ['result.html'], metadata: { checked: true } }); host.endTurn(s1); await tick()
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status, 'done'); assert.equal(store.s.cards.get(`${batch.id}#0`)!.summary, 'A 交接单')
  const artifact = [...store.s.artifacts.values()][0]
  assert.equal(artifact.name, 'result.html'); assert.equal(artifact.mime, 'text/html'); assert.equal(await readFile(artifact.storagePath, 'utf8'), '<h1>done</h1>')
  assert.deepEqual(store.s.runs.get(`${batch.id}#0#1`)!.metadata, { checked: true })
  assert.equal(host.sessions.get(s1)!.disposed, true)
  const s2 = [...host.sessions.keys()][1]; assert.ok(s2, 'second card started after the first completed')
  assert.match(host.sessions.get(s2)!.followups[0].content[0].text, /\[UPSTREAM HANDOFF from A\]\nA 交接单/)
  host.consumeFirst(s2); await host.callTool(s2, 'task_complete', { summary: 'B 交接单' }); host.endTurn(s2); await tick()
  const s3 = [...host.sessions.keys()][2]; host.consumeFirst(s3); await host.callTool(s3, 'task_complete', { summary: 'C' }); host.endTurn(s3); await tick()
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'done')
  assert.deepEqual(store.all().filter(e => e.t === 'run/completed').length, 3)
  runner.stop()
})

test('runner: request_review cannot settle until a person approves it', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }] })
  const batch = await runner.fire('T', 'manual')
  const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
  await host.callTool(session, 'task_request_review', { summary: '请验收' }); host.endTurn(session); await tick()
  const cardId = `${batch.id}#0`
  assert.equal(store.s.cards.get(cardId)!.status, 'review')
  assert.equal(store.s.batches.get(batch.id)!.settled, undefined)
  await runner.reviewCard(cardId, 'approve', '通过')
  assert.equal(store.s.cards.get(cardId)!.status, 'done')
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'done')
  runner.stop()
})

test('runner: review changes restart the chosen upstream role and replay the downstream chain', async () => {
  const { host, store, runner } = await setup()
  const batch = await runner.fire('T', 'manual')
  const nextSession = () => [...host.sessions.keys()].at(-1)!
  let session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'A1' }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'B1' }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_request_review', { summary: 'R1' }); host.endTurn(session); await tick()
  const reviewer = `${batch.id}#2`; const planner = `${batch.id}#0`
  await runner.reviewCard(reviewer, 'changes', '重新规划交互', planner); await tick()
  assert.equal(store.s.cards.get(planner)!.status, 'running'); assert.equal(store.s.cards.get(`${batch.id}#1`)!.status, 'todo'); assert.equal(store.s.cards.get(reviewer)!.status, 'todo')
  session = nextSession(); assert.match(host.sessions.get(session)!.followups[0].content[0].text, /\[REVIEW CHANGES\]\n重新规划交互/)
  host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'A2' }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'B2' }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_request_review', { summary: 'R2' }); host.endTurn(session); await tick()
  await runner.reviewCard(reviewer, 'approve', '第二轮通过'); await tick()
  assert.deepEqual(batch.cardIds.map(id => store.s.cards.get(id)!.runIds.length), [2, 2, 2])
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'done')
  assert.equal(store.all().filter(event => event.t === 'card/changes_requested').length, 1)
  runner.stop()
})

test('runner: stopping without a terminator gets one nudge, then protocol_violation; breaker trips after maxTries', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }], maxTries: 2 })
  const batch = await runner.fire('T', 'manual')
  const s1 = [...host.sessions.keys()][0]; host.consumeFirst(s1)
  host.endTurn(s1); await tick()
  assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.nudges, 1); assert.equal(host.sessions.get(s1)!.followups.length, 2, 'nudge delivered as a follow-up')
  host.endTurn(s1); await tick()
  assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.outcome, 'protocol_violation')
  // retry: attempt 2 starts automatically (onFail=retry, maxTries=2)
  const s2 = [...host.sessions.keys()][1]; assert.ok(s2, 'second attempt started'); host.consumeFirst(s2)
  host.endTurn(s2); await tick(); host.endTurn(s2); await tick()
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status, 'failed', 'breaker tripped')
  assert.equal(store.kernel.getTask(`${batch.id}#0`)!.status, 'triage', 'core cannot redispatch a gave-up card')
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'failed')
  assert.equal(host.sessions.size, 2)
  runner.stop()
})

test('runner: cancelling a live batch archives active and waiting core tasks', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }, { agentId: 'b' }] })
  const batch = await runner.fire('T', 'manual')
  assert.equal(host.sessions.size, 1)
  await runner.cancelBatch(batch.id); await tick()
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'cancelled')
  assert.deepEqual(batch.cardIds.map(id => store.kernel.getTask(id)!.status), ['archived', 'archived'])
  await runner.tick(); await tick()
  assert.equal(host.sessions.size, 1, 'cancelled core tasks never restart')
  runner.stop()
})

test('runner: task_block(needs_input) closes the run; unblock creates a fresh run', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }] })
  const batch = await runner.fire('T', 'manual')
  const s1 = [...host.sessions.keys()][0]; host.consumeFirst(s1)
  await host.callTool(s1, 'task_block', { reason: '要不要抄送老板?', kind: 'needs_input' }); host.endTurn(s1); await tick()
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status, 'blocked'); assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.question, '要不要抄送老板?')
  assert.equal(host.sessions.get(s1)!.disposed, true, 'terminal block closes the old worker')
  assert.equal(store.kernel.listRuns(`${batch.id}#0`)[0].outcome, 'blocked')
  host.emit(s1, { type: 'user/message', data: { id: 'answer-1', source: { kind: 'user' } } }); await tick()
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status, 'blocked', 'a dead worker cannot be revived by a late message')
  await runner.unblockCard(`${batch.id}#0`); await tick()
  const s2 = [...host.sessions.keys()].at(-1)!; assert.notEqual(s2, s1)
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status, 'running')
  host.consumeFirst(s2); await host.callTool(s2, 'task_complete', { summary: '抄送了' }); host.endTurn(s2); await tick()
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'done')
  runner.stop()
})

test('runner: capability block is a durable human-visible blocker and does not cancel dependencies', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }, { agentId: 'b' }] })
  const batch = await runner.fire('T', 'manual')
  const s1 = [...host.sessions.keys()][0]; host.consumeFirst(s1)
  await host.callTool(s1, 'task_block', { reason: '没有 ssh 工具', kind: 'capability' }); host.endTurn(s1); await tick()
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status, 'blocked'); assert.equal(store.s.cards.get(`${batch.id}#1`)!.status, 'todo')
  assert.equal(store.s.batches.get(batch.id)!.settled, undefined); assert.equal(host.sessions.size, 1)
  assert.equal(store.kernel.getTask(`${batch.id}#0`)!.block_kind, 'capability')
  runner.stop()
})

test('runner: automated same-card review uses reviewer profile, changes_requested, rework, and approval', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }] })
  const batch = await runner.fire('T', 'manual'); const cardId = `${batch.id}#0`
  let session = [...host.sessions.keys()].at(-1)!; host.consumeFirst(session)
  await host.callTool(session, 'task_request_review', { summary: 'round 1', reviewer: 'b', metadata: { tests: 9 } }); host.endTurn(session); await tick()
  assert.equal(store.kernel.getTask(cardId)!.assignee, 'b')
  session = [...host.sessions.keys()].at(-1)!; host.consumeFirst(session)
  await host.callTool(session, 'task_request_changes', { reason: '补 AC1 测试' }); host.endTurn(session); await tick()
  assert.equal(store.kernel.getTask(cardId)!.assignee, 'a')
  session = [...host.sessions.keys()].at(-1)!; assert.match(host.sessions.get(session)!.followups[0].content[0].text, /补 AC1 测试/); host.consumeFirst(session)
  await host.callTool(session, 'task_request_review', { summary: 'round 2: 10 passed', reviewer: 'b' }); host.endTurn(session); await tick()
  session = [...host.sessions.keys()].at(-1)!; host.consumeFirst(session)
  await host.callTool(session, 'task_complete', { summary: 'approved' }); host.endTurn(session); await tick()
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'done')
  assert.deepEqual(store.kernel.listRuns(cardId).map(run => [run.profile, run.outcome]), [
    ['a', 'review_requested'], ['b', 'changes_requested'], ['a', 'review_requested'], ['b', 'completed'],
  ])
  runner.stop()
})

test('runner: concurrency cap holds across batches; restart marks live runs crashed', async () => {
  const { host, store, runner, task, root } = await setup({ participants: [{ agentId: 'a' }] })
  await store.append({ t: 'task/created', at: 'x', taskId: 'T2', task: { ...task, id: 'T2' } }); await store.append({ t: 'task/created', at: 'x', taskId: 'T3', task: { ...task, id: 'T3' } })
  await runner.fire('T', 'manual'); await runner.fire('T2', 'manual'); await runner.fire('T3', 'manual')
  assert.equal(host.sessions.size, 2, 'maxInProgress=2 leaves the third batch waiting')
  runner.stop()
  const store2 = new EventStore(join(root, 'store'))
  const runner2 = new TaskRunner(fakeHost(join(root, 'presets')).ctx, store2, { maxInProgress: 2 })
  await runner2.start()
  assert.equal([...store2.s.runs.values()].filter(r => r.outcome === 'crashed').length, 2, 'the two live runs crashed on restart')
  runner2.stop()
})
