import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { TaskRunner } from '../src/runner.ts'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { groupArtifacts } from '../src/artifact-delivery.ts'
import { TaskCreator } from '../src/task-create.ts'
import { taskCredential } from '../src/task-credentials.ts'
import { TaskNotifications } from '../src/task-notifications.ts'

const testResources: { root: string; runner: TaskRunner; store: EventStore }[] = []
after(async () => {
  for (const {root,runner,store} of testResources) {
    runner.stop(); if (store.kernel.db.open) store.kernel.db.close()
    await (await import('node:fs/promises')).rm(root,{recursive:true,force:true})
  }
})

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
  testResources.push({root,runner,store})
  const task: TaskSpec = { id: 'T', title: 't', brief: 'do it', trigger: { kind: 'once' }, participants: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }], cwd: root, timeoutSec: 60, onFail: 'retry', maxTries: 2, enabled: true, createdAt: 'x', ...taskPatch }
  await store.append({ t: 'task/created', at: 'x', taskId: task.id, task })
  return { host, store, runner, task, root }
}
const tick = () => new Promise(r => setTimeout(r, 80))

test('archived tasks cannot fire or resume waiting cards; restore never enables cron', async () => {
  const { runner, store, task, host } = await setup({ trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' } })
  await store.createBatch(task, { t: 'batch/fired', at: new Date().toISOString(), taskId: task.id, batch: { id: 'archive-fixture', by: 'manual', cards: [{ id: 'archive-fixture#0', agentId: 'a', deps: [] }] } })
  await store.setTasksArchived(['T'], true)
  await runner.tick()
  assert.equal(host.sessions.size, 0)
  await assert.rejects(runner.fire('T', 'manual'), /归档/)
  assert.equal(await store.claimCard('archive-fixture#0', 'run-archived', 'session-archived', 1), undefined)
  await assert.rejects(store.createBatch(task, { t: 'batch/fired', at: new Date().toISOString(), taskId: 'T', batch: { id: 'stale-template', by: 'manual', cards: [] } }), /归档/)
  assert.equal(runner.schedule.state('T')?.enabled, 0)
  assert.equal(store.s.batches.size, 1)
  await store.setTasksArchived(['T'], false)
  assert.equal(store.tasks.get('T')?.enabled, false)
  assert.equal(store.tasks.get('T')?.archivedAt, undefined)
})

test('archiving rejects active work and validates the whole selection before writing', async () => {
  const { runner, store, task } = await setup()
  const other = { ...task, id: 'other' }
  await store.append({ t: 'task/created', at: task.createdAt, taskId: other.id, task: other })
  await assert.rejects(store.setTasksArchived(['other', 'missing'], true), /没有这个任务/)
  assert.equal(store.tasks.get('other')?.archivedAt, undefined)
  const b = await runner.fire('T', 'manual')
  await assert.rejects(store.setTasksArchived(['other', 'T'], true), /仍在执行/)
  assert.equal(store.tasks.get('other')?.archivedAt, undefined)
  await runner.cancelBatch(b.id)
})

test('a fresh execution uses a new session while archived blocked history stays inert', async () => {
  const { runner, store, host } = await setup({ participants:[{agentId:'a'}], onFail:'stop', maxTries:1 })
  const old = await runner.fire('T','manual'); await tick()
  const original = [...host.sessions.keys()][0]; host.consumeFirst(original)
  await host.callTool(original,'task_block',{reason:'observed challenge',kind:'needs_input'})
  host.endTurn(original); await tick()
  await store.setBatchArchived('T',old.id,true)
  await runner.tick()
  assert.equal(host.sessions.size,1)
  const fresh = await runner.fire('T','manual'); await tick()
  assert.notEqual(fresh.id,old.id)
  assert.equal(host.sessions.size,2)
  assert.notEqual([...host.sessions.keys()][1],original)
  assert.equal(store.s.cards.get(old.cardIds[0])?.status,'blocked')
  assert.equal(store.tasks.size,1)
  await runner.cancelBatch(fresh.id)
  assert.equal(await store.setBatchArchived('T',fresh.id,true),true)
  assert.equal(store.s.cards.get(fresh.cardIds[0])?.status,'cancelled')
})

test('delegated notifications are real idempotent side cards with frozen reports and independent sessions', async () => {
  let outbox: TaskNotifications
  const delivered:string[]=[]
  const design:any={evidenceContract:'browser-patrol-v2',failurePolicy:{maxAttempts:3},notifications:{channel:'wecom',agentId:'notifier',chatIds:['group-fixture']}}
  const {host,runner,store}=await setup({graphMode:'dynamic-rounds',design},{
    notify:async(input,stage)=>input.card.role==='planner'
      ? outbox.request(input,stage as any,{ready:false,summary:'frozen-before-repair',items:[]})
      : outbox.send(input,stage as any,{ready:true,summary:'must-not-use-live-report'},async args=>{delivered.push(args.markdown);return{sent:1}}),
    beforeComplete:input=>input.card.role==='notifier'?outbox.complete(input):undefined,
  })
  outbox=new TaskNotifications(store)
  const batch=await runner.fire('T','manual'), planner=[...host.sessions.keys()].at(-1)!
  host.consumeFirst(planner)
  const first=await host.callTool(planner,'task_notify',{stage:'started'})
  const duplicate=await host.callTool(planner,'task_notify',{stage:'started'})
  assert.equal(first.cardId,duplicate.cardId)
  assert.equal(store.kernel.getTask(first.cardId)?.status,'todo')
  assert.equal([...store.s.cards.values()].filter(c=>c.role==='notifier').length,1)
  assert.equal(store.graphSnapshot('T',batch.id).live.tasks.find(t=>t.id===first.cardId)?.role,'notifier')
  await host.callTool(planner,'task_plan_round',{summary:'real next round, notifier does not consume planning lock'})
  host.endTurn(planner);await tick()
  const noticeSession=[...store.s.runs.values()].find(r=>r.cardId===first.cardId)!.sessionId
  host.consumeFirst(noticeSession)
  assert.match(host.sessions.get(noticeSession)!.followups[0].content[0].text,/企微通知协作/)
  await assert.rejects(host.callTool(noticeSession,'task_notify',{stage:'restored'}),/冻结的阶段/)
  await host.callTool(noticeSession,'task_notify',{stage:'started'})
  await host.callTool(noticeSession,'task_notify',{stage:'started'})
  assert.equal(delivered.length,1);assert.match(delivered[0],/frozen-before-repair/);assert.doesNotMatch(delivered[0],/must-not-use/)
  await host.callTool(noticeSession,'task_complete',{summary:'model summary'})
  host.endTurn(noticeSession);await tick()
  assert.equal(store.s.cards.get(first.cardId)?.status,'done')
  assert.equal(store.s.cards.get(`${batch.id}#e1`)?.status,'running')
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  assert.equal(store.kernel.getTask(first.cardId)?.max_runtime_seconds,300)
})

test('a failed notification branch does not cancel browser work', async()=>{
  const {host,runner,store}=await setup({graphMode:'dynamic-rounds',onFail:'stop',design:{failurePolicy:{maxAttempts:3},notifications:{agentId:'notifier',chatIds:['fixture']}} as any})
  const batch=await runner.fire('T','manual'), plannerSession=[...host.sessions.keys()].at(-1)!
  host.consumeFirst(plannerSession)
  const planner=store.s.cards.get(batch.cardIds[0])!
  const id=await store.createNotification(store.tasks.get('T')!,batch,planner,'started',{summary:'fixture'})
  // Simulate an exhausted notification worker before the repair dependency is released.
  store.kernel.giveUpTask(id,'notification transport fixture')
  await store.append({t:'card/gave_up',at:new Date().toISOString(),taskId:'T',cardId:id,error:'notification fixture'})
  await host.callTool(plannerSession,'task_plan_round',{summary:'continue browser work'})
  host.endTurn(plannerSession);await tick()
  assert.equal(store.s.cards.get(`${batch.id}#e1`)?.status,'running')
  assert.equal(store.s.cards.get(`${batch.id}#r1`)?.status,'todo')
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
})

test('Creator reviews auxiliary notifier permissions and pins its profile for hourly execution',async()=>{
  const {runner,root}=await setup()
  const design:any={evidenceContract:'browser-patrol-v2',scope:'Existing authorized fleet browsers',branches:[{id:'verify',when:'unknown',action:'read only verify',evidence:'fresh result'}],coordination:'three roles and notifier side branch',failurePolicy:{isolateItems:true,maxAttempts:3,stopConditions:['no permission']},acceptance:['independent login evidence and sent receipts'],browserPatrol:{scope:'fleet-existing-authorized',actions:['provision','resume'],observationMinutes:20,minSamples:4},notifications:{channel:'wecom',agentId:'notifier',chatIds:['fixture-group']}}
  const agents:any[]=['a','browser-manager','c'].map(id=>({id,name:id,tools:[],skills:[],mcpTools:{browser:['browser_fleet_inventory','browser_login_verify','browser_status']}}))
  const notifier:any={id:'notifier',name:'notifier',tools:[],skills:[],mcpTools:{wecom:['vyibc-wecom_send_message']},profileHash:'v1'}
  agents.push(notifier)
  const creator=new TaskCreator(runner,async()=>agents)
  const proposal:any={decision:'create',reason:'isolated reports',title:'Patrol with notifier',brief:'Verify existing authorized browsers and report',participants:['a','browser-manager','c'].map(agentId=>({agentId})),graphMode:'dynamic-rounds',trigger:{kind:'cron',expr:'0 * * * *',timeZone:'Asia/Shanghai'},design}
  const exec:any={agent:{session:{id:'notifier-review-fixture',deriveMessages:()=>[{role:'user',content:'Prepare an hourly browser patrol with independent notifications'}]}}}
  notifier.tools=['bash']
  await assert.rejects(creator.prepare(proposal,exec,root),/通知员仅允许/)
  notifier.tools=[]
  const plan:any=await creator.prepare(proposal,exec,root)
  notifier.profileHash='v2'
  await assert.rejects(creator.review(plan.id,plan.hash,'approve','independent fixture review'),/能力或配置已变化/)
  notifier.profileHash='v1'
  const approved=await creator.review(plan.id,plan.hash,'approve','independent fixture review')
  assert.equal(approved.state,'awaiting_trial')
  const task=runner.store.tasks.get(approved.taskId!)!
  assert.equal(task.enabled,false)
  assert.equal(task.design?.notifications?.agentId,'notifier')
  assert.ok(await creator.scheduledTurn(task,'fixture-hour'))
  notifier.profileHash='v2'
  await assert.rejects(creator.scheduledTurn(task,'fixture-next-hour'),/角色配置已变化/)
})

test('unresolved patrol closes a failed Batch, not a green Task or a permanent cron overlap', async t => {
  const {host,runner,store,root}=await setup({graphMode:'dynamic-rounds',design:{evidenceContract:'browser-patrol-v2'} as any}, {
    beforeComplete: input => input.card.role === 'planner' ? {summary:'Unresolved fixture, not business success',metadata:{workflowOutcome:'unresolved'}} : undefined,
  })
  t.after(async()=>{runner.stop();store.kernel.db.close();await (await import('node:fs/promises')).rm(root,{recursive:true,force:true})})
  const batch=await runner.fire('T','manual')
  let session=[...host.sessions.keys()].at(-1)!;host.consumeFirst(session)
  // This fixture does not expand a business plan; it isolates the final disposition bridge.
  await host.callTool(session,'task_finalize',{summary:'fixture',disposition:'unresolved'})
  host.endTurn(session);await tick()
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'failed')
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_batches WHERE settled_at IS NULL').get() as any).n,0)
})

test('patrol executor hands off before independent waiting; only reviewer can defer', async () => {
  const now=Date.now(), {host,runner,store}=await setup({graphMode:'dynamic-rounds',timeoutSec:1800,design:{evidenceContract:'browser-patrol-v2',failurePolicy:{maxAttempts:3}} as any},{now:()=>now})
  try {
    const batch=await runner.fire('T','manual');await tick()
    let session=[...host.sessions.keys()].at(-1)!;host.consumeFirst(session)
    const wait={until:new Date(now+300_000).toISOString(),reason:'fixture independent observation'}
    await assert.rejects(host.callTool(session,'task_wait',wait),/下游评估者/)
    await host.callTool(session,'task_plan_round',{summary:'fixture read and independent review'});host.endTurn(session);await tick()
    session=[...host.sessions.keys()].at(-1)!;host.consumeFirst(session)
    assert.match(host.sessions.get(session)!.followups[0].content[0].text,/不得 task_wait 等待下游采样/)
    await assert.rejects(host.callTool(session,'task_wait',wait),/ready=false 不代表执行者不能交接/)
    assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_task_wakeups').get() as any).n,0)
    await host.callTool(session,'task_complete',{summary:'fixture operation ended; independent samples pending'});host.endTurn(session);await tick()
    session=[...host.sessions.keys()].at(-1)!;host.consumeFirst(session)
    assert.match(host.sessions.get(session)!.followups[0].content[0].text,/只有你负责分时独立复验/)
    await host.callTool(session,'task_wait',wait);host.endTurn(session);await tick()
    assert.equal((store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_task_wakeups').get() as any).n,1)
    assert.equal(store.s.batches.size,1);assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  } finally {runner.stop()}
})

test('durable wait releases worker, survives reload, and resumes same card without failure', async () => {
  let now = Date.now()
  const { host, runner, store, root } = await setup({ timeoutSec: 1800 }, { now: () => now })
  try {
    const batch = await runner.fire('T', 'manual'); await tick()
    const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
    await host.callTool(session, 'task_wait', { until: new Date(now + 300_000).toISOString(), reason: 'Read-only fixture: verify again after five minutes; no copy' })
    host.endTurn(session); await tick()
    assert.equal(store.kernel.getTask(batch.cardIds[0])?.status, 'scheduled')
    assert.equal(store.kernel.getTask(batch.cardIds[0])?.consecutive_failures, 0)
    assert.equal(host.sessions.get(session)?.disposed, true)
    await assert.rejects(runner.unblockCard(batch.cardIds[0]), /尚未到期/)
    runner.stop(); store.kernel.db.close()
    const restoredStore = new EventStore(join(root, 'store')), restored = new TaskRunner(host.ctx, restoredStore, { now: () => now })
    try {
      await restored.start(); assert.equal(restoredStore.kernel.getTask(batch.cardIds[0])?.status, 'scheduled')
      now += 300_000; await restored.tick(); await tick()
      assert.equal(restoredStore.s.batches.size, 1)
      assert.equal(restoredStore.kernel.getTask(batch.cardIds[0])?.status, 'running')
      assert.equal(restoredStore.kernel.listRuns(batch.cardIds[0]).length, 2)
      assert.match([...host.sessions.values()].at(-1)!.followups[0].content[0].text, /RESUMED DURABLE WAIT/)
    } finally { restored.stop(); restoredStore.kernel.db.close() }
  } finally { runner.stop(); if (store.kernel.db.open) store.kernel.db.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) }
})

test('Creator recurring approval only schedules; frozen turn is checked again at firing', async () => {
  const { host, runner, store, root } = await setup()
  let hash = 'v1'
  const creator = new TaskCreator(runner, async () => [{ id: 'a', name: 'a', profileHash: hash } as any])
  const design = { scope: 'Read fixture', branches: [{ id: 'check', when: 'due', action: 'read', evidence: 'fixture' }], coordination: 'serial', failurePolicy: { isolateItems: true, maxAttempts: 2, stopConditions: ['missing capability'] }, acceptance: ['verified fixture'] }
  try {
    const plan = await creator.prepare({ decision: 'create', reason: 'hourly fixture', title: 'Hourly', brief: 'Check current fixture only', participants: [{ agentId: 'a' }], trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' }, design }, { agent: { session: { id: 'schedule-creator', deriveMessages: () => [{ role: 'user', content: 'Check the fixture hourly' }] } } }, root) as any
    assert.equal(plan.definition.trigger.kind, 'cron'); assert.equal(host.sessions.size, 0)
    const approved = await creator.review(plan.id, plan.hash, 'approve', 'fixture-only recurring scope approved')
    assert.equal(approved.state, 'awaiting_trial'); assert.equal(approved.batchId, null)
    assert.equal(host.sessions.size, 0); assert.equal(store.s.batches.size, 0)
    const task = store.tasks.get(approved.taskId)!
    assert.equal(task.enabled, false)
    assert.equal(runner.schedule.claim(task, Date.now() + 3600000), undefined)
    await assert.rejects(creator.assertScheduleActivation(task), /先对当前已审查计划手动执行/)
    const turn = await creator.scheduledTurn(task, 'scheduled-occurrence')
    assert.equal(turn?.origin?.reviewPlanId, plan.id)
    assert.equal(turn?.origin?.signalId, 'scheduled-occurrence')
    const batch = await runner.fire(task.id, 'manual', { turn })
    await assert.rejects(creator.assertScheduleActivation(task), /尚未结束/)
    const session = [...host.sessions.keys()].at(-1)!
    host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'fixture passed' }); host.endTurn(session); await tick()
    await creator.assertScheduleActivation(task)
    const failed = await runner.fire(task.id,'manual',{turn})
    const failedSession = [...host.sessions.keys()].at(-1)!
    host.consumeFirst(failedSession); await host.callTool(failedSession,'task_block',{reason:'fresh challenge',kind:'needs_input'}); host.endTurn(failedSession); await tick()
    await store.setBatchArchived(task.id,failed.id,true)
    await assert.rejects(creator.assertScheduleActivation(task), /先对当前已审查计划手动执行/)
    await runner.fire(task.id,'manual',{turn})
    const freshSession = [...host.sessions.keys()].at(-1)!
    host.consumeFirst(freshSession); await host.callTool(freshSession,'task_complete',{summary:'fresh acceptance passed'}); host.endTurn(freshSession); await tick()
    await creator.assertScheduleActivation(task)
    creator.scheduleActivated(task); assert.equal(creator.plan(plan.id).state, 'scheduled')
    hash = 'v2'; await assert.rejects(creator.scheduledTurn(task, 'next'), /配置已变化/)
  } finally { runner.stop(); store.kernel.db.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) }
})

test('paused cron remains manually reusable through @ without changing schedule or bypassing review', async () => {
  const {host,runner,store,root}=await setup()
  let profileHash='v1'
  const creator=new TaskCreator(runner,async()=>[{id:'a',name:'A',profileHash} as any])
  const design={scope:'Read fixture only',branches:[{id:'check',when:'requested',action:'read',evidence:'fixture'}],coordination:'serial',failurePolicy:{isolateItems:true,maxAttempts:2,stopConditions:['no permission']},acceptance:['verified fixture']}
  const plan:any=await creator.prepare({decision:'create',reason:'fixture',title:'Paused hourly',brief:'Check fixture with reviewed boundaries',participants:[{agentId:'a'}],trigger:{kind:'cron',expr:'0 * * * *',timeZone:'Asia/Shanghai'},design},{agent:{session:{id:'fixture-creator',deriveMessages:()=>[{role:'user',content:'Check fixture hourly; do not change anything'}]}}},root)
  const approved=await creator.review(plan.id,plan.hash,'approve','fixture approval'),task=store.tasks.get(approved.taskId!)!
  assert.equal(task.enabled,false)
  assert.equal(creator.catalog().find(t=>t.id===task.id)?.scheduleEnabled,false)
  const id='manual-paused-fixture-000001'
  const result=await creator.launch(task.id,'Run the reviewed fixture once',id,root)
  assert.equal((await creator.launch(task.id,'Run the reviewed fixture once',id,root)).batchId,result.batchId)
  assert.equal(store.s.batches.size,1)
  assert.equal(store.tasks.get(task.id)?.enabled,false)
  assert.equal(runner.schedule.claim(task,Date.now()+3600_000),undefined)
  const batch=store.s.batches.get(result.batchId)!
  assert.equal(batch.turn?.origin?.reviewPlanId,plan.id)
  assert.equal(batch.turn?.origin?.intakeSessionId,undefined)
  assert.equal(batch.turn?.userRequest,'Run the reviewed fixture once')
  assert.match(batch.turn!.objective,/do not change anything/)
  await assert.rejects(creator.launch(task.id,'Different parameters',id,root),/同一提交/)
  await assert.rejects(creator.launch(task.id,'Check again','manual-paused-fixture-overlap',root),/已有|未结束|运行/)
  const session=[...host.sessions.keys()].at(-1)!;host.consumeFirst(session)
  await host.callTool(session,'task_complete',{summary:'fixture passed'});host.endTurn(session);await tick()
  await creator.assertScheduleActivation(task)
  assert.equal(task.enabled,false);assert.equal(creator.plan(plan.id).state,'awaiting_trial')
  profileHash='changed'
  await assert.rejects(creator.launch(task.id,'Check once','manual-paused-fixture-000002',root),/配置已变化/)
  profileHash='v1'
  await store.setTasksArchived([task.id],true)
  assert.equal(creator.catalog().some(t=>t.id===task.id),false)
  await assert.rejects(creator.launch(task.id,'Check once','manual-paused-fixture-000003',root),/未归档/)
})

test('idle model turns retain live async operations without burning nudges or extending watchdog', async () => {
  let pending = true
  let outcomeReads = 0
  const {host,runner,store,root}=await setup({onFail:'stop',maxTries:1},{pendingOperation:async()=>pending?'operation running':undefined,operationOutcome:async()=>{outcomeReads++;return 'operation-1 complete; read current receipt before submission'}})
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
    assert.equal(outcomeReads,0)
    pending=false;host.endTurn(session);await tick()
    assert.equal(flight.idleTimer,undefined)
    assert.equal(host.sessions.get(session)?.followups.length,2)
    assert.equal(outcomeReads,1)
    assert.match(host.sessions.get(session)!.followups.at(-1).content[0].text,/operation-1 complete/)
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
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

test('a completion evidence callback replaces model summary and metadata with verified results', async () => {
  const { host, runner, store, root } = await setup({ onFail: 'stop', maxTries: 1 }, {
    beforeComplete: () => ({ summary: 'host evidence: one verified target', metadata: { verified: 1 } }),
  })
  try {
    const batch = await runner.fire('T', 'manual'); await tick()
    const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
    await host.callTool(session, 'task_complete', { summary: 'all 999 verified', metadata: { verified: 999 } })
    host.endTurn(session); await tick()
    const run = [...store.s.runs.values()].find(r => r.cardId === batch.cardIds[0])!
    assert.equal(run.summary, 'host evidence: one verified target'); assert.deepEqual(run.metadata, { verified: 1 })
  } finally { runner.stop(); store.kernel.db.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) }
})

test('review cannot bypass pending operations or an opted-in patrol evidence contract', async () => {
  let pending = true, verified = false
  const { host, runner, store, root } = await setup({ design: { evidenceContract: 'browser-patrol-v1' } as any }, {
    pendingOperation: () => pending ? 'poll operation-1' : undefined,
    beforeComplete: () => { if (!verified) throw Error('missing patrol evidence'); return { summary: 'verified receipt', metadata: {} } },
  })
  try {
    const batch = await runner.fire('T', 'manual'); await tick()
    const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
    await assert.rejects(host.callTool(session, 'task_request_review', { summary: 'a plan' }), /poll operation-1/)
    pending = false
    await assert.rejects(host.callTool(session, 'task_request_review', { summary: 'still only a plan' }), /missing patrol evidence/)
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status, 'running')
    verified = true
    await host.callTool(session, 'task_request_review', { summary: 'model claim' }); host.endTurn(session); await tick()
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status, 'review')
    assert.equal([...store.s.runs.values()][0].summary, 'verified receipt')
  } finally { runner.stop(); store.kernel.db.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) }
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

test('Creator review persists a frozen plan without a Task, fences changed approvals, then dispatches once', async () => {
  const { host, store, runner, root } = await setup()
  let profileHash = 'v1'
  const creator = new TaskCreator(runner, async () => [{ id: 'a', name: 'a', profileHash } as any])
  const design = { scope: 'Inspect authorized targets', branches: [{ id: 'healthy', when: 'valid proof', action: 'reuse', evidence: 'current receipt' }],
    coordination: 'serial changes', failurePolicy: { isolateItems: true, maxAttempts: 1, stopConditions: ['no permission'] }, acceptance: ['all targets accounted for'] }
  const proposal = { decision: 'create' as const, reason: 'new goal', title: 'Reviewed workflow', brief: 'Inspect authorized targets without deleting anything', participants: [{ agentId: 'a' }], design }
  const exec = { agent: { session: { id: 'review-test', deriveMessages: () => [{ role: 'user', content: 'Check 192.0.2.10' }] } } }
  try {
    const before = store.tasks.size, plan = await creator.prepare(proposal, exec, root) as any
    assert.equal(plan.state, 'pending'); assert.equal(store.tasks.size, before); assert.equal(store.s.batches.size, 0); assert.equal(host.sessions.size, 0)
    assert.equal((await creator.prepare(proposal, exec, root) as any).id, plan.id)
    assert.equal(creator.plans().total, 1)
    await assert.rejects(creator.review(plan.id, 'wrong', 'approve', 'checked'), /指纹/)
    profileHash = 'v2'; await assert.rejects(creator.review(plan.id, plan.hash, 'approve', 'checked'), /配置已变化/)
    assert.equal(host.sessions.size, 0); profileHash = 'v1'
    const restarted = new TaskCreator(runner, async () => [{ id: 'a', name: 'a', profileHash } as any])
    const approved = await restarted.review(plan.id, plan.hash, 'approve', 'Scope and outcomes checked')
    assert.equal(approved.state, 'dispatched'); assert.equal(host.sessions.size, 1)
    assert.equal((await restarted.review(plan.id, plan.hash, 'approve', 'duplicate')).batchId, approved.batchId)
    assert.equal(host.sessions.size, 1); assert.equal(store.s.batches.size, 1)
    const turn = store.s.batches.get(approved.batchId)!.turn!
    assert.deepEqual(turn.workflow!.definition.design, design)
    assert.equal(turn.origin?.reviewPlanId, plan.id)
    assert.match([...host.sessions.values()][0].followups[0].content[0].text, /all targets accounted for/)
    assert.match([...host.sessions.values()][0].followups[0].content[0].text, /HOST REVIEW RELEASE/)
    let session = [...host.sessions.keys()][0]; host.consumeFirst(session)
    await host.callTool(session, 'task_request_review', { summary: 'premature plan' }); host.endTurn(session); await tick()
    await runner.reviewCard(`${approved.batchId}#0`, 'changes', 'Execute the approved business contract'); await tick()
    session = [...host.sessions.keys()].at(-1)!
    const retryMessage = host.sessions.get(session)!.followups[0].content[0].text
    assert.match(retryMessage, /ORIGINAL REQUEST — CREATION STAGE ALREADY REVIEWED/)
    assert.match(retryMessage, /CURRENT EXECUTION PHASE/)
    assert.ok(retryMessage.indexOf('[CURRENT EXECUTION PHASE') > retryMessage.indexOf('[CONTRACT]'))
    assert.deepEqual(creator.catalog().find(t => t.id === approved.taskId)?.design, design)
    const nextExec = { agent: { session: { id: 'review-reuse', deriveMessages: () => [{ role: 'user', content: 'Check 192.0.2.11' }] } } }
    const reuse = await creator.prepare({ decision: 'reuse', taskId: approved.taskId, reason: 'same goal', design }, nextExec, root) as any
    assert.equal(reuse.state, 'pending'); assert.equal(store.s.batches.size, 1)
    const reused = await creator.review(reuse.id, reuse.hash, 'approve', 'Same reviewed workflow with new target')
    assert.equal(reused.taskId, approved.taskId); assert.notEqual(reused.batchId, approved.batchId)
    assert.equal(store.tasks.size, before + 1); assert.equal(store.s.batches.size, 2)
    await assert.rejects(creator.prepare({ ...proposal, title: 'change accepted request' }, exec, root), /已有放行计划/)
  } finally { runner.stop(); store.kernel.db.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) }
})

test('Creator revises the same paused Task by review without executing or rewriting old evidence', async () => {
  const { host, store, runner, root } = await setup()
  const agents = [{ id: 'a', name: 'a', profileHash: 'v1' } as any]
  const creator = new TaskCreator(runner, async () => agents)
  const design = { scope: 'Fixture scope', branches: [{ id: 'inspect', when: 'current evidence', action: 'inspect', evidence: 'receipt' }],
    coordination: 'one worker', failurePolicy: { isolateItems: true, maxAttempts: 1, stopConditions: ['permission missing'] }, acceptance: ['independent evidence'] }
  const input = (id: string) => ({ agent: { session: { id, deriveMessages: () => [{ role: 'user', content: 'Inspect the fixture; preserve history' }] } } })
  const create: any = await creator.prepare({ decision: 'create', reason: 'fixture', title: 'Original', brief: 'Inspect fixture only',
    participants: [{ agentId: 'a' }], trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' }, design }, input('revision-create'), root)
  const first: any = await creator.review(create.id, create.hash, 'approve', 'fixture scope')
  const batch = await runner.fire(first.taskId, 'manual', { turn: await creator.scheduledTurn(store.tasks.get(first.taskId)!, 'first-manual') })
  const session = [...host.sessions.keys()].at(-1)!; host.consumeFirst(session)
  await host.callTool(session, 'task_complete', { summary: 'Original fixture evidence' }); host.endTurn(session); await tick()
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome, 'done')
  const original = store.tasks.get(first.taskId)!, oldBatch = JSON.stringify(store.s.batches.get(batch.id))
  const raw = store.kernel.db.prepare('SELECT * FROM task_runs').all()
  const revision = { decision: 'revise' as const, taskId: original.id, reason: 'review changed scope', title: 'Updated',
    brief: 'Inspect the fixture with a stronger prerequisite', design: { ...design, acceptance: [...design.acceptance, 'prerequisite checked'] } }
  const p: any = await creator.prepare(revision, input('revision-new'), root)
  const competing: any = await creator.prepare({ ...revision, title: 'Competing' }, input('revision-competing'), root)
  assert.equal(p.revisionTaskId, original.id); assert.equal(p.previousDefinition.title, 'Original')
  assert.equal(store.tasks.get(original.id)?.title, 'Original')
  const count = store.tasks.size, sessions = host.sessions.size
  const updated: any = await creator.review(p.id, p.hash, 'approve', 'independently reviewed revision')
  assert.equal(updated.state, 'awaiting_trial'); assert.equal(updated.taskId, original.id); assert.equal(updated.batchId, null)
  assert.equal(store.tasks.size, count); assert.equal(host.sessions.size, sessions)
  assert.equal(store.tasks.get(original.id)?.title, 'Updated'); assert.equal(store.tasks.get(original.id)?.enabled, false)
  assert.equal(store.tasks.get(original.id)?.createdAt, original.createdAt)
  assert.equal(JSON.stringify(store.s.batches.get(batch.id)), oldBatch)
  assert.deepEqual(store.kernel.db.prepare('SELECT * FROM task_runs').all(), raw)
  assert.equal(store.all().filter(e => e.t === 'task/revised').length, 1)
  await creator.review(p.id, p.hash, 'approve', 'duplicate approval')
  assert.equal(store.all().filter(e => e.t === 'task/revised').length, 1)
  await assert.rejects(creator.review(competing.id, competing.hash, 'approve', 'stale draft'), /已变化/)
  await assert.rejects(creator.assertScheduleActivation(store.tasks.get(original.id)!), /先对当前已审查计划/)
  const next = await creator.scheduledTurn(store.tasks.get(original.id)!, 'next-fixture')
  assert.equal(next?.workflow?.definition.title, 'Updated')
  runner.stop(); const restored = new EventStore(store.root); await restored.load()
  assert.equal(restored.tasks.get(original.id)?.title, 'Updated')
  assert.equal(JSON.stringify(restored.s.batches.get(batch.id)), oldBatch)
  restored.kernel.db.close()
})

test('Creator exposes blocked rather than running for a parked dependency', async () => {
  const { host, store, runner, task } = await setup({ participants: [{ agentId: 'a' }] })
  const creator = new TaskCreator(runner, async () => [])
  const batch = await runner.fire(task.id, 'manual')
  const session = [...host.sessions.keys()][0]; host.consumeFirst(session)
  assert.equal(creator.status(task.id, batch.id).active, true)
  await host.callTool(session, 'task_block', { reason: 'Fixture dependency unavailable', kind: 'capability' }); host.endTurn(session); await tick()
  assert.equal(creator.status(task.id, batch.id).outcome, 'blocked')
  assert.equal(creator.status(task.id, batch.id).active, false)
  assert.equal(creator.status(task.id, batch.id).blockedCards[0].reason, 'Fixture dependency unavailable')
  assert.equal(store.s.batches.get(batch.id)?.settled, undefined)
})

test('reviewed revision is atomic and refuses enabled, unfinished or unfrozen historical work', async () => {
  const { store, runner, task, root } = await setup({ trigger: { kind: 'cron', expr: '0 * * * *' }, enabled: false })
  const revised = { ...task, title: 'Revision' }
  const before = JSON.stringify(store.kernel.db.prepare('SELECT * FROM dsh_task_specs WHERE id=?').get(task.id))
  await assert.rejects(store.reviseReviewedTask(task,revised,'review-fixture',()=>{ throw new Error('review CAS failed') }), /review CAS failed/)
  assert.equal(JSON.stringify(store.kernel.db.prepare('SELECT * FROM dsh_task_specs WHERE id=?').get(task.id)), before)
  assert.equal(store.all().filter(e=>e.t==='task/revised').length, 0)
  store.kernel.db.prepare('UPDATE dsh_task_specs SET spec_json=? WHERE id=?').run(JSON.stringify({ ...task, title: 'Concurrent definition' }), task.id)
  await assert.rejects(store.reviseReviewedTask(task,revised,'review-fixture',()=>{}), /数据库中的工作流已变化/)
  assert.equal(JSON.parse((store.kernel.db.prepare('SELECT spec_json FROM dsh_task_specs WHERE id=?').get(task.id) as any).spec_json).title, 'Concurrent definition')
  store.kernel.db.prepare('UPDATE dsh_task_specs SET spec_json=? WHERE id=?').run(JSON.stringify(task), task.id)
  await store.append({t:'task/enabled',at:new Date().toISOString(),taskId:task.id,enabled:true})
  await assert.rejects(store.reviseReviewedTask(task,revised,'review-fixture',()=>{}), /已变化/)
  await store.append({t:'task/enabled',at:new Date().toISOString(),taskId:task.id,enabled:false})
  await store.createBatch(task,{t:'batch/fired',at:new Date().toISOString(),taskId:task.id,batch:{id:'legacy-revision',by:'manual',cards:[]}})
  await assert.rejects(store.reviseReviewedTask(task,revised,'review-fixture',()=>{}), /未结束/)
  await store.append({t:'batch/settled',at:new Date().toISOString(),taskId:task.id,batchId:'legacy-revision',outcome:'done'})
  await assert.rejects(store.reviseReviewedTask(task,revised,'review-fixture',()=>{}), /旧执行缺少冻结定义/)
  assert.equal(store.tasks.get(task.id)?.title, task.title)
  assert.equal(store.all().filter(e=>e.t==='task/revised').length, 0)
})

test('rejected/superseded drafts never execute and review keeps original input secrets private', async () => {
  const { host, store, runner, root } = await setup()
  const creator = new TaskCreator(runner, async () => [{ id: 'a', name: 'a' } as any])
  const secret = 'Review-Fixture-Only!123'
  const exec = { agent: { session: { id: 'draft-secret', deriveMessages: () => [{ role: 'user', content: `root ${secret} 192.0.2.10` }] } } }
  const proposal = { decision: 'create' as const, reason: 'draft', title: 'Draft', brief: 'Read authorized target only', participants: [{ agentId: 'a' }],
    design: { scope: `Inspect 192.0.2.10; never expose ${secret}`, branches: [{ id: 'read', when: 'authorized', action: 'inspect', evidence: 'receipt' }], coordination: 'serial',
      failurePolicy: { isolateItems: true, maxAttempts: 1, stopConditions: ['permission missing'] }, acceptance: ['report state'] } }
  try {
    const first = await creator.prepare(proposal, exec, root) as any
    assert.ok(!JSON.stringify(first).includes(secret))
    assert.match(first.definition.design.scope, /\{\{target\}\}/)
    assert.ok(!JSON.stringify(first.definition).includes('192.0.2.10'))
    assert.ok(!String((store.kernel.db.prepare('SELECT payload FROM dsh_task_plans WHERE id=?').get(first.id) as any).payload).includes(secret))
    const second = await creator.prepare({ ...proposal, title: 'Revised draft' }, exec, root) as any
    assert.equal(creator.plan(first.id).state, 'superseded')
    await assert.rejects(creator.review(first.id, first.hash, 'approve', 'old'), /不再待审查/)
    assert.equal((await creator.review(second.id, second.hash, 'reject', 'Missing branch')).state, 'rejected')
    await assert.rejects(creator.review(second.id, second.hash, 'approve', 'too late'), /不再待审查/)
    assert.equal(host.sessions.size, 0); assert.equal(store.s.batches.size, 0)
  } finally { runner.stop(); store.kernel.db.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) }
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
  assert.match(host.sessions.get(nextSession())!.followups[0].content[0].text, /第一轮计划/, 'executor must receive the planner handoff across the Gate')

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

test('native evidence workers expose minimal completion and have bounded actual-tool correction, never automatic completion', async () => {
  const { host, store, runner } = await setup({participants:[{agentId:'a'}],maxTries:1,onFail:'stop',design:{evidenceContract:'browser-patrol-v2'} as any})
  const batch=await runner.fire('T','manual'),session=[...host.sessions.keys()][0]
  host.consumeFirst(session)
  const complete=host.sessions.get(session)!.tools.find(t=>t.name==='task_complete')
  assert.equal(complete.parameters.metadata,undefined)
  host.endTurn(session);await tick();host.endTurn(session);await tick()
  assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.nudges,2)
  assert.equal(store.s.cards.get(`${batch.id}#0`)!.status,'running')
  assert.match(host.sessions.get(session)!.followups.at(-1).content[0].text,/JSON.*summary/)
  assert.match(host.sessions.get(session)!.followups.at(-1).content[0].text,/不要复查或重发/)
  host.endTurn(session);await tick()
  assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.outcome,'protocol_violation')
  assert.equal(store.s.batches.get(batch.id)!.settled?.outcome,'failed')
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
