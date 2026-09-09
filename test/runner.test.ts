import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskRunner } from '../src/runner.ts'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { groupArtifacts } from '../src/artifact-delivery.ts'
import { TaskCreator } from '../src/task-create.ts'
import { taskCredential } from '../src/task-credentials.ts'

/** A fake dsh host: presets resolve, agents.create hands back a controllable session. */
function fakeHost(presetDir: string) {
  const listeners: ((s: any, e: any) => void)[] = []
  const sessions = new Map<string, { agent: any; tools: any[]; disposed: boolean; followups: any[] }>()
  const permissions: string[] = []
  const ctx: any = {
    on: (name: string, fn: any) => { if (name === 'session/event') listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    effect: () => undefined,
    get: (key: string) => {
      if (key === 'agentPresets') return { resolve: async (id: string) => ({ id, name: id, path: join(presetDir, id, 'agent.cordis.yml') }), mount: async () => undefined }
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (key === 'permissionPresets') return { set: (_session: unknown, preset: string) => { permissions.push(preset) } }
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
  return { ctx, sessions, permissions, emit, consumeFirst, callTool, endTurn }
}

async function setup(taskPatch: Partial<TaskSpec> = {}, runnerPatch: ConstructorParameters<typeof TaskRunner>[2] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tc-run-'))
  const presets = join(root, 'presets'); for (const id of ['a', 'b', 'c']) { await mkdir(join(presets, id), { recursive: true }); await writeFile(join(presets, id, 'task-console.json'), JSON.stringify({ id, name: id.toUpperCase(), description: '', persona: '', model: 'p/m', effort: '', tools: [], mcpTools: {}, skills: [] })) }
  const host = fakeHost(presets)
  const store = new EventStore(join(root, 'store'))
  const runner = new TaskRunner(host.ctx, store, { maxInProgress: 2, ...runnerPatch })
  await runner.start()
  const task: TaskSpec = { id: 'T', title: 't', brief: 'do it', trigger: { kind: 'once' }, participants: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }], cwd: root, timeoutSec: 60, onFail: 'retry', maxTries: 2, enabled: true, createdAt: 'x', ...taskPatch }
  await store.append({ t: 'task/created', at: 'x', taskId: task.id, task })
  return { host, store, runner, task, root }
}
const tick = () => new Promise(r => setTimeout(r, 80))

test('idle model turns retain live async operations without burning nudges or extending watchdog', async () => {
  let pending = true
  const {host,runner,store,root}=await setup({onFail:'stop',maxTries:1},{pendingOperation:async()=>pending?'operation running':undefined})
  try {
    const batch=await runner.fire('T','manual');await tick()
    const session=[...host.sessions.keys()][0];host.consumeFirst(session)
    const flight=(runner as any).flights.get(session), watchdog=flight.timer
    for(let i=0;i<3;i++){host.endTurn(session);await tick()}
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
    assert.equal(host.sessions.get(session)?.disposed,false)
    assert.equal(host.sessions.get(session)?.followups.length,1)
    assert.equal(flight.timer,watchdog)
    assert.ok(flight.idleTimer)
    pending=false;host.endTurn(session);await tick()
    assert.equal(flight.idleTimer,undefined)
    assert.equal(host.sessions.get(session)?.followups.length,2)
    await host.callTool(session,'task_complete',{summary:'actual terminal receipt'});host.endTurn(session);await tick()
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'done')
  } finally {runner.stop();store.kernel.db.close();await (await import('node:fs/promises')).rm(root,{recursive:true,force:true})}
})

test('the block gate can replace stale model prose with observed evidence without erasing tool history', async()=>{
  const {host,runner,store}=await setup({onFail:'stop',maxTries:1},{beforeBlock:()=>({reason:'Actual provider challenge',kind:'needs_input'})})
  try {
    const batch=await runner.fire('T','manual');await tick()
    const session=[...host.sessions.keys()][0];host.consumeFirst(session)
    await host.callTool(session,'task_block',{reason:'Still running',kind:'capability'});host.endTurn(session);await tick()
    assert.equal(store.s.cards.get(batch.cardIds[0])?.lastBlockReason,'Actual provider challenge')
  }finally{runner.stop()}
})

test('a rejected completion gate keeps the run active and permits a corrected submission', async () => {
  const {host,runner,store} = await setup({onFail:'stop',maxTries:1}, {beforeComplete: input => {
    if (input.metadata?.receipt !== 'verified') throw Error('missing acceptance evidence')
  }})
  try {
    const batch = await runner.fire('T','manual'); await tick()
    const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
    await assert.rejects(host.callTool(session,'task_complete',{summary:'a claim without evidence'}),/missing acceptance/)
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
    assert.equal(store.s.cards.get(batch.cardIds[1])?.status,'todo')
    await host.callTool(session,'task_complete',{summary:'verified',metadata:{receipt:'verified'}})
    host.endTurn(session); await tick()
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'done')
  } finally {runner.stop()}
})

test('a pending-operation block gate keeps the run active until the operation is terminal', async () => {
  let running = true
  const {host,runner,store} = await setup({onFail:'stop',maxTries:1}, {beforeBlock: () => { if(running)throw Error('poll running operation') }})
  try {
    const batch = await runner.fire('T','manual'); await tick()
    const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
    await assert.rejects(host.callTool(session,'task_block',{reason:'one minute elapsed',kind:'capability'}),/poll running/)
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
    running = false
    await host.callTool(session,'task_block',{reason:'actual terminal failure',kind:'capability'})
    host.endTurn(session);await tick()
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'blocked')
  } finally {runner.stop()}
})

test('chat workflow: real runner orders three roles, hands off, deduplicates and reuses Task with fresh inputs', async () => {
  const { host, store, runner, root } = await setup()
  const creator = new TaskCreator(runner, async () => ['a','b','c'].map(id => ({ id, name: id } as any)))
  const proposal = { decision: 'create' as const, reason: 'new reusable goal', title: 'Node readiness', brief: 'Inspect and converge the submitted node; preserve healthy components',
    participants: [{ agentId: 'a', brief: 'base' }, { agentId: 'b', brief: 'browser' }, { agentId: 'c', brief: 'runner' }] }
  let timeStep = 1
  const exec = { agent: { session: { id: 'agent-task-create-agent-test', deriveMessages: () => [
    { id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Validate 192.0.2.10 idempotently' }] },
    { id: `clock-${timeStep++}`, role: 'user', source: { kind: 'plugin', plugin: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 2' }] },
  ] } } }
  try {
    const first = await creator.submit(proposal, exec, root)
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'tool results must be lossless JSON, not contain undefined')
    const context = await creator.context()
    assert.deepEqual(JSON.parse(JSON.stringify(context)), context, 'a custom workflow must not poison the next Creator tool result')
    assert.equal(Object.hasOwn(context.tasks[0], 'workflowRecipe'), false)
    assert.equal(first.cards.length, 3)
    assert.equal(first.cards[0].status, 'running')
    assert.equal(first.cards[1].status, 'todo')
    assert.equal(first.cards[1].dependsOn[0], first.cards[0].id)
    const savedTurn = store.s.batches.get(first.batchId)!.turn!
    assert.equal(savedTurn.userRequest, 'Validate 192.0.2.10 idempotently')
    assert.match(savedTurn.workflow!.id, /^[a-f0-9]{64}$/)
    assert.deepEqual(savedTurn.workflow!.definition.participants, proposal.participants)
    const duplicate = await creator.submit({ ...proposal, title: 'LLM repeated with a different title' }, exec, root)
    assert.equal(duplicate.batchId, first.batchId)
    assert.equal(store.s.batches.size, 1)
    for (let i = 0; i < 3; i++) {
      const session = [...host.sessions.keys()].at(-1)!
      const prompt = host.sessions.get(session)!.followups[0].content[0].text
      assert.match(prompt, /192\.0\.2\.10/)
      if (i) assert.match(prompt, new RegExp(`receipt-${i-1}`))
      if (i === 2) assert.match(prompt, /receipt-0/, 'final role receives the original first-role handoff too')
      host.consumeFirst(session)
      await host.callTool(session, 'task_complete', { summary: `receipt-${i}` })
      host.endTurn(session); await tick()
    }
    const completed = creator.status(first.taskId, first.batchId)
    assert.equal(completed.outcome, 'done')
    assert.equal(completed.cards[0].summary, 'receipt-0')
    assert.ok(completed.cards.every(c => c.sessionId), 'completed sessions remain navigable')
    const second = await creator.launch(first.taskId, 'Validate 192.0.2.20', 'second-submission-1234', root)
    assert.equal(second.taskId, first.taskId)
    assert.notEqual(second.batchId, first.batchId)
    assert.equal(store.s.batches.get(second.batchId)!.turn!.workflow!.id, savedTurn.workflow!.id)
    assert.equal(store.s.batches.get(second.batchId)!.turn!.userRequest, 'Validate 192.0.2.20')
    assert.equal(creator.catalog().length, 1)
    const prompt = [...host.sessions.values()].at(-1)!.followups[0].content[0].text
    assert.match(prompt, /192\.0\.2\.20/); assert.doesNotMatch(prompt, /192\.0\.2\.10/)
    const third = await creator.launch(first.taskId, 'Validate 192.0.2.20', 'second-submission-1234', root)
    assert.equal(third.batchId, second.batchId)
    assert.equal(store.s.batches.get(second.batchId)?.turn?.origin?.intakeSessionId, undefined, 'direct workflow has no invented Agent session link')
    await assert.rejects(() => creator.launch(first.taskId, 'Validate 192.0.2.99', 'second-submission-1234', root), /同一提交/)
    await assert.rejects(() => creator.launch('T', 'do old incident', 'invalid-workflow-1234', root), /聊天工作流/)
    await assert.rejects(() => creator.submit({ ...proposal, participants: [{ agentId: 'unregistered' }] }, { agent: { session: { ...exec.agent.session, id: 'another' } } }, root), /没有这个 Agent/)
  } finally { runner.stop() }
})

test('chat recipe materializes exactly the registered roles and rejects mixed definitions', async () => {
  const { store, runner, root } = await setup()
  const ids = ['fleet-installer', 'browser-manager', 'fleet-runner-operator']
  const creator = new TaskCreator(runner, async () => ids.map(id => ({ id, name: id } as any)))
  const exec = { agent: { session: { id: 'recipe-creator', deriveMessages: () => [{ role: 'user', content: 'Configure 192.0.2.10 including Gemini login' }] } } }
  const recipe = { id: 'fleet-base-v1' as const, login: 'provision-gemini' as const }
  try {
    await assert.rejects(() => creator.submit({ decision: 'create', reason: 'recipe', recipe, participants: [{ agentId: 'a' }] }, exec, root), /不能混入/)
    const result = await creator.submit({ decision: 'create', reason: 'explicit login request', recipe }, exec, root)
    const task = store.tasks.get(result.taskId)!
    assert.deepEqual(task.participants.map(p => p.agentId), ids)
    assert.deepEqual(task.workflowRecipe, recipe)
    const context = await creator.context()
    assert.deepEqual(context.tasks[0].workflowRecipe, recipe)
    assert.deepEqual(JSON.parse(JSON.stringify(context)), context, 'managed recipes retain lossless Creator context too')
    assert.deepEqual(store.s.batches.get(result.batchId)!.turn!.workflow!.definition.workflowRecipe, recipe)
    assert.match(task.participants[1].brief!, /browser_login_provision/)
    assert.equal(result.cards.length, 3)
  } finally { runner.stop() }
})

test('chat credentials: no secret in persisted task/events; only active bound installer can resolve exact target', async () => {
  const { host, store, runner, root } = await setup()
  const preset = join(root, 'presets', 'fleet-installer'); await mkdir(preset)
  await writeFile(join(preset, 'task-console.json'), JSON.stringify({ id: 'fleet-installer', name: 'installer', model: 'p/m', tools: [], mcpTools: {}, skills: [] }))
  const creator = new TaskCreator(runner, async () => [{ id: 'fleet-installer' } as any])
  const secret = 'Fixture-Only!123'
  const exec = { agent: { session: { id: 'creator-test', deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: `root ${secret} 192.0.2.10` }] }] } } }
  try {
    const result = await creator.submit({ decision: 'create', reason: 'credential test', title: 'onboard', brief: 'Configure the target node safely', participants: [{ agentId: 'fleet-installer' }] }, exec, root)
    assert.ok(!JSON.stringify(store.all()).includes(secret))
    const sessionId = [...host.sessions.keys()].at(-1)!
    assert.ok(!host.sessions.get(sessionId)!.followups[0].content[0].text.includes(secret))
    const lease = await taskCredential('192.0.2.10', sessionId, store.root)
    assert.equal(lease.available, true)
    assert.equal(JSON.parse(Buffer.from(lease.material!).toString()).password, secret)
    lease.material?.fill(0)
    assert.equal((await taskCredential('192.0.2.20', sessionId, store.root)).available, false)
    assert.equal((await taskCredential('192.0.2.10', 'task-forged', store.root)).available, false)
    host.consumeFirst(sessionId); await host.callTool(sessionId, 'task_complete', { summary: 'done' }); host.endTurn(sessionId); await tick()
    assert.equal((await taskCredential('192.0.2.10', sessionId, store.root)).available, false)
    assert.equal(creator.status(result.taskId, result.batchId).outcome, 'done')
  } finally { runner.stop() }
})

test('runner: pins Agent permission and marks each task session internal before dispatch', async () => {
  const internal: string[] = []
  const { host, runner } = await setup({}, { onSessionCreated: sessionId => { internal.push(sessionId) } })
  const batch = await runner.fire('T', 'manual')
  await tick()

  assert.deepEqual(internal, [`task-t-${batch.id}-1`])
  assert.deepEqual(host.permissions, ['workspace-write'])
  runner.stop()
})

test('runner: one reused Task fires a signal-specific turn with a new objective and Agent team', async () => {
  const { host, store, runner, root } = await setup({ participants: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }], graphMode: 'dynamic-rounds' })
  const batch = await runner.fire('T', 'manual', {
    batchId: 'b-signal-001',
    turn: {
      objective: 'Handle the second incident without inheriting the first incident prompt.',
      participants: [{ agentId: 'c', brief: 'Plan this turn only.' }, { agentId: 'a' }, { agentId: 'b' }],
      cwd: root,
      targets: [{ kind: 'fleet-node', id: 'synthetic-node' }],
      origin: { source: 'test', signalId: 'sig-001', incidentId: 'inc-001', decision: 'reuse' },
    },
  })
  assert.equal(batch.id, 'b-signal-001')
  assert.equal(batch.turn?.origin?.decision, 'reuse')
  const session = [...host.sessions.keys()].at(-1)!
  assert.match(host.sessions.get(session)!.followups[0].content[0].text, /second incident/)
  assert.doesNotMatch(host.sessions.get(session)!.followups[0].content[0].text, /do it/)
  assert.equal(store.s.cards.get('b-signal-001#p1')?.agentId, 'c')
  assert.equal(store.kernel.getTask('b-signal-001#p1')?.workspace_path, root)
  assert.equal((store.kernel.db.prepare('SELECT turn_json FROM dsh_batches WHERE id = ?').get(batch.id) as { turn_json: string }).turn_json.includes('sig-001'), true)
  const duplicate = await runner.fire('T', 'manual', { batchId: 'b-signal-001' })
  assert.equal(duplicate.id, batch.id)
  assert.equal([...store.s.batches.values()].filter(row => row.id === batch.id).length, 1)
  await assert.rejects(() => runner.fire('T', 'retry'), /外部 Signal/)
  assert.equal(store.s.batches.size, 1, 'manual retry cannot dispatch the original template team')
  runner.stop()
})

test('runner: dynamic rounds materialize DB rows only after planner decisions and gates never own runs', async () => {
  const { host, store, runner, root } = await setup({ graphMode: 'dynamic-rounds' })
  await writeFile(join(root, 'result.html'), '<h1>version 1</h1>')
  const batch = await runner.fire('T', 'manual')
  const nextSession = () => [...host.sessions.keys()].at(-1)!
  let session = nextSession(); host.consumeFirst(session)
  assert.deepEqual(store.graphSnapshot('T', batch.id).live.tasks.map(row => row.role), ['planner'])
  assert.ok(host.sessions.get(session)!.tools.some(tool => tool.name === 'task_plan_round'))
  assert.ok(!host.sessions.get(session)!.tools.some(tool => tool.name === 'task_complete'))
  await host.callTool(session, 'task_plan_round', { summary: '第一轮计划' })
  let graph = store.graphSnapshot('T', batch.id)
  assert.equal(graph.live.tasks.length, 5); assert.equal(graph.live.links.length, 4); assert.equal(graph.live.runs.length, 1)
  assert.equal(graph.live.tasks.find(row => row.role === 'gate')!.status, 'todo')
  host.endTurn(session); await tick()
  graph = store.graphSnapshot('T', batch.id)
  assert.equal(graph.live.tasks.find(row => row.role === 'gate')!.status, 'done')
  assert.equal(graph.live.runs.filter(row => row.task_id.includes('#g')).length, 0)

  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: '执行一', artifacts: ['result.html'] }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session)
  assert.equal(host.sessions.get(session)!.tools.some(tool => ['task_request_changes','task_request_review'].includes(tool.name)), false)
  assert.doesNotMatch(host.sessions.get(session)!.followups[0].content[0].text, /调用 task_request_changes/)
  await host.callTool(session, 'task_complete', { summary: '评估：返工', artifacts: ['result.html'] }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_plan_round', { summary: '第二轮返工计划' })
  graph = store.graphSnapshot('T', batch.id)
  assert.equal(graph.live.tasks.length, 9); assert.equal(graph.live.links.length, 8)
  host.endTurn(session); await tick()
  await writeFile(join(root, 'result.html'), '<h1>version 2</h1>')
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: '执行二', artifacts: ['result.html'] }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: '评估：通过', artifacts: ['result.html'] }); host.endTurn(session); await tick()
  session = nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_finalize', { summary: '批准结束', artifact: 'result.html' })
  assert.equal(store.all().filter(event => event.t === 'artifact/finalized').length, 0, 'final result is committed only when the planner run completes')
  host.endTurn(session); await tick()
  graph = store.graphSnapshot('T', batch.id)
  assert.equal(graph.live.tasks.length, 9); assert.equal(graph.live.links.length, 8); assert.equal(graph.live.runs.length, 7)
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'done')
  assert.equal(graph.events.filter(event => event.kind === 'created').length, 9)
  assert.equal(graph.events.filter(event => event.kind === 'linked').length, 8)
  assert.equal(graph.events.filter(event => event.kind === 'artifact_registered').length, 4)
  assert.equal(graph.events.filter(event => event.kind === 'artifact_finalized').length, 1)
  assert.ok(graph.events.findIndex(event => event.kind === 'artifact_finalized') > graph.events.findLastIndex(event => event.kind === 'completed'))
  const artifacts = [...store.s.artifacts.values()]
  assert.equal(artifacts.length, 4)
  const final = artifacts.find(artifact => artifact.final)!
  assert.equal(store.s.cards.get(final.cardId)!.role, 'executor', 'reviewer snapshot must not replace the executor delivery')
  assert.equal(store.s.cards.get(final.cardId)!.round, 2)
  const planner = [...store.s.runs.values()].filter(run => store.s.cards.get(run.cardId)?.role === 'planner').at(-1)!
  assert.equal(planner.metadata?.finalArtifactId, final.id)
  const groups = groupArtifacts(artifacts, [...store.s.cards.values()].map(card => ({ cardId: card.id, role: card.role, round: card.round, name: card.agentId })))
  assert.equal(groups.length, 2, 'executor submission and byte-identical reviewer verification are one version')
  assert.equal(groups.find(group => group.final)?.entries.length, 2)
  runner.stop()
})

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

test('runner: settled batches notify session lifecycle exactly once', async () => {
  const settled: string[] = []
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }] }, { onBatchSettled: batch => { settled.push(batch.id) } })
  const batch = await runner.fire('T', 'manual')
  const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
  await host.callTool(session, 'task_complete', { summary: 'done' }); host.endTurn(session); await tick()
  await runner.tick()
  assert.deepEqual(settled, [batch.id])
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome, 'done')
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

test('runner: explicit batch cancellation closes an orphaned claim without deleting history', async () => {
  const { host, store, runner } = await setup({ participants: [{ agentId: 'a' }] })
  const batch = await runner.fire('T', 'manual')
  runner.stop()
  ;(runner as any).flights.clear() // lost in-memory worker; durable claim still belongs to this batch
  await runner.cancelBatch(batch.id)
  assert.equal(store.kernel.listRuns(batch.cardIds[0])[0].outcome, 'cancelled')
  assert.equal(store.kernel.getTask(batch.cardIds[0])!.status, 'archived')
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome, 'cancelled')
  assert.equal(host.sessions.size, 1)
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
