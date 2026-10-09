import {StudioInterventions} from '../src/studio-interventions.js'
import {awaitAgentCapabilities} from '../src/agent-capability-readiness.ts'
import {studioInstallationBlock} from '../src/studio-installation.js'
import {WorkflowExtensions} from '../src/workflow-extensions.js'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { TaskRunner } from '../src/runner.ts'
import { EventStore, type TaskSpec } from '../src/tasks.ts'
import { groupArtifacts } from '../src/artifact-delivery.ts'
import { TaskCreator } from '../src/task-create.ts'
import { taskCredential } from '../src/task-credentials.ts'
import { TaskNotifications } from '../src/task-notifications.ts'
import { composeRecipe } from '../src/workflow-recipes.ts'
import { FleetRepairRequired } from '../src/fleet-workflow-evidence.ts'
import { observeOnboardBackground, pendingOnboardOperation, takeOnboardContinuation } from '../src/onboard-background.ts'

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
        const modelHooks: any[] = []
        const rec = { agent: { session: { id: opts.sessionId }, ctx: { on: (name: string, fn: any) => { const hook = { name, fn }; modelHooks.push(hook); return () => { const i = modelHooks.indexOf(hook); if (i >= 0) modelHooks.splice(i, 1) } }, tools: { register: (d: any) => { tools.push(d); return () => { const i = tools.indexOf(d); if (i >= 0) tools.splice(i, 1) } } } }, followup: (m: any) => { rec.followups.push(m) } }, tools, modelHooks, disposed: false, followups: [] as any[] }
        await opts.setup?.(rec.agent.ctx)
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

test('restart waits for MCP discovery, retains completed predecessor and claims successor once',async()=>{
 const {runner,store,host,root}=await setup({participants:[{agentId:'a'},{agentId:'b'}]})
 const batch=await runner.fire('T','manual');await tick()
 const first=[...host.sessions.keys()][0]
 host.consumeFirst(first)
 await host.callTool(first,'task_complete',{summary:'upstream complete'});host.endTurn(first);await tick()
 const [doneId,nextId]=batch.cardIds
 assert.equal(store.s.cards.get(doneId)!.status,'done');assert.equal(store.s.cards.get(nextId)!.status,'running')
 runner.stop()
 const recoveredStore=new EventStore(join(root,'store')),recoveredHost=fakeHost(join(root,'presets'))
 let connected=false,release!:()=>void,entered!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{entered=resolve})
 const recovered=new TaskRunner(recoveredHost.ctx,recoveredStore,{beforeStart:async input=>{
  const result=await awaitAgentCapabilities({isActive:input.isActive,inspect:async()=>({
   audit:connected?{status:'in-sync'}:{status:'dependency-missing',missingDependencies:['mcp:assets:asset_get']},
   sources:[{serverName:'assets',live:true,tools:connected?['asset_get']:[]}],
  }),sleep:()=>pending,onEvent:e=>{if(e.phase==='waiting')entered()}})
  if(result.timedOut||result.audit.status!=='in-sync')return {kind:'capability',reason:'fixture discovery failure'}
 }})
 testResources.push({root,runner:recovered,store:recoveredStore})
 const starting=recovered.start();await waiting
 assert.equal(recoveredHost.sessions.size,0,'no model before tools are registered')
 assert.equal(recoveredStore.s.cards.get(doneId)!.status,'done')
 assert.equal(recoveredStore.s.cards.get(nextId)!.status,'running','pending discovery stays within one claim')
 await recovered.tick();await recovered.tick()
 connected=true;release();await starting;await tick()
 assert.equal(recoveredHost.sessions.size,1)
 assert.equal(recoveredStore.s.cards.get(doneId)!.runIds.length,1)
 assert.equal(recoveredStore.s.cards.get(nextId)!.runIds.length,2,'one crashed run and exactly one recovery run')
 assert.equal([...recoveredStore.s.runs.values()].filter(r=>r.status==='blocked').length,0)
})

test('incomplete Studio installation blocks once without creating a model session or retry loop',async()=>{
 const {runner,store,host}=await setup({}, {beforeStart:()=>studioInstallationBlock({config:{}})})
 const batch=await runner.fire('T','manual')
 await runner.tick();await runner.tick()
 assert.equal(host.sessions.size,0)
 const card=store.s.cards.get(batch.cardIds[0])!
 assert.equal(card.status,'blocked')
 assert.equal(card.runIds.length,1)
 assert.ok(JSON.stringify(store.all()).includes('visionScript:missing-or-invalid-path'))
})

test('startup fallback retains run/session and permissions, retries once, and releases scoped hooks', async () => {
  const { runner, store, host } = await setup({ participants:[{agentId:'a'}], onFail:'stop', maxTries:1 })
  const get = host.ctx.get
  host.ctx.get = (key: string) => key === 'llm' ? { resolveCallConfig: async (config: any) => config } : get(key)
  runner.modelFallback = { fromProvider:'p', provider:'qwen', model:'plus' }
  await runner.fire('T','manual'); await tick()
  const [sid, rec] = [...host.sessions.entries()][0]
  let hooks = 0
  rec.agent.ctx.on = () => { hooks++; return () => { hooks-- } }
  host.consumeFirst(sid)
  const permissions = [...host.permissions]
  const error = {type:'turn/end',data:{reason:{kind:'error',error:{code:'TRANSPORT',message:'startup failed'}}}}
  host.emit(sid,error); await tick()
  assert.equal(host.sessions.size,1)
  assert.equal(store.s.runs.size,1)
  assert.equal(rec.followups.length,2)
  assert.match(rec.followups[1].content[0].text,/qwen\/plus/)
  assert.equal(hooks,2)
  assert.deepEqual(host.permissions,permissions)
  assert.equal(rec.disposed,false)
  host.emit(sid,error); await tick()
  assert.equal(rec.followups.length,2,'fallback does not loop')
  assert.equal(rec.disposed,true)
  assert.equal(hooks,0)
})

test('model failure after tool dispatch never repeats business work through fallback', async () => {
  const { runner, host } = await setup({ participants:[{agentId:'a'}], onFail:'stop', maxTries:1 })
  runner.modelFallback = { fromProvider:'p', provider:'qwen', model:'plus' }
  await runner.fire('T','manual'); await tick()
  const [sid, rec] = [...host.sessions.entries()][0]
  host.consumeFirst(sid)
  host.emit(sid,{type:'tool/call',data:{name:'business_write',callId:'fixture'}})
  host.emit(sid,{type:'turn/end',data:{reason:{kind:'error',error:{code:'TRANSPORT'}}}}); await tick()
  assert.equal(rec.followups.length,1)
  assert.equal(rec.disposed,true)
})

test('Task Actions use CAS independent storage and frozen fresh inputs; real scheduler creates only a Batch and its role sessions', async () => {
  const { store, runner, host, root } = await setup({ origin: { source: 'task-chat', signalId: 'fixture' } as any })
  const creator = new TaskCreator(runner, async () => ['a','b','c'].map(id => ({ id, name: id } as any)))
  const before = JSON.stringify(store.tasks.get('T'))
  const starter = JSON.parse(await readFile(new URL('../presets/fleet-task-actions.json', import.meta.url), 'utf8'))
  const catalog = creator.actions.save('T', starter, '0')
  assert.equal(JSON.stringify(store.tasks.get('T')), before)
  assert.equal(store.s.batches.size, 0)
  assert.throws(() => creator.actions.save('T', [], '0'), /已被修改/)
  const query = { taskId: 'T', actionId: starter[0].id, revision: catalog.revision, requestId: 'task-action-fixture-0001', cwd: root,
    values: { ip: '192.0.2.30', ssh_mode: '提供首次凭据', username: 'root', password: 'fixture-only-credential', login_mode: '指定账号', account: 'fixture@example.test · accountId=gemini_12345678 · #12345678' } }
  const first = await creator.launchAction(query)
  const turn = store.s.batches.get(first.batchId)!.turn!
  assert.deepEqual(turn.targets, [{kind:'fleet-node',id:'192.0.2.30'}])
  assert.equal(turn.action?.values.password, '[credential supplied privately]')
  assert.equal(turn.action?.revision, catalog.revision)
  assert.doesNotMatch(JSON.stringify(store.all()), /fixture-only-credential/)
  const secret = JSON.parse(await readFile(join(store.root, 'private-inputs', `${first.batchId}.json`), 'utf8'))
  assert.equal(secret.credentials[0].password, query.values.password)
  assert.equal(secret.credentials[0].username, 'root')
  assert.equal(secret.credentials[0].ip, query.values.ip)
  assert.ok([...host.sessions.keys()].every(id => id.startsWith('task-')), 'only task-owned role sessions, no ordinary conversation')
  assert.equal(turn.origin?.intakeSessionId, undefined)
  creator.actions.save('T', [], catalog.revision)
  assert.equal((await creator.launchAction(query, async () => { throw Error('must not re-resolve already accepted account') })).batchId, first.batchId, 'accepted retry survives catalog edits and account-provider downtime')
  await assert.rejects(creator.launchAction({ ...query, values: { ...query.values, ip: '192.0.2.31' } }), /同一提交/)
  await assert.rejects(creator.launchAction({ ...query, requestId: 'task-action-fixture-0002' }), /已更新/)
  assert.equal(store.s.batches.size, 1)
  assert.equal(JSON.stringify(store.tasks.get('T')), before)
})

test('Task Action invalid values create neither Batch nor credential files and ignore historical target inputs', async () => {
  const { store, runner } = await setup({ origin: { source: 'task-chat', signalId: 'fixture' } as any })
  const creator = new TaskCreator(runner, async () => ['a','b','c'].map(id => ({ id } as any)))
  const catalog = creator.actions.save('T', [{ id: 'inspect', name: 'Inspect', template: 'Inspect {{ip}}, note {{note}}', parameters: [
    { key: 'ip', label: 'IP', type: 'text', required: true, binding: 'target-ip' }, { key: 'note', label: 'Note', type: 'text', required: false }
  ] }], '0')
  const query = { taskId: 'T', actionId: 'inspect', revision: catalog.revision, requestId: 'task-action-invalid-01', values: { ip: '999.0.0.1', note: '' } }
  await assert.rejects(creator.launchAction(query), /IPv4/)
  await assert.rejects(creator.launchAction({ ...query, values: { note: '192.0.2.40' } }), /请填写/)
  assert.equal(store.s.batches.size, 0)
  const result = await creator.launchAction({ ...query, values: { ip: '192.0.2.41', note: 'Source 192.0.2.42, not a target' } })
  assert.deepEqual(store.s.batches.get(result.batchId)!.turn!.targets, [{kind:'fleet-node',id:'192.0.2.41'}])
})

test('Creator freezes Actions for independent review, installs only after approval without altering workflow definition', async () => {
  const { store, runner, root, host } = await setup()
  const creator = new TaskCreator(runner, async () => [{id:'a',name:'A'} as any])
  const actions = [{ id:'inspect',name:'Inspect',template:'Inspect {{target}}',parameters:[{key:'target',label:'Target',type:'text' as const,required:true}] }]
  const proposal = { decision:'create' as const, reason:'reusable fixture', title:'Action review',brief:'Inspect input only',participants:[{agentId:'a'}],actions,
    design:{scope:'read fixture',branches:[{id:'inspect',when:'authorized',action:'inspect',evidence:'receipt'}],coordination:'serial',failurePolicy:{isolateItems:true,maxAttempts:1,stopConditions:['no permission']},acceptance:['report']} }
  const exec = {agent:{session:{id:'creator-actions-fixture',deriveMessages:()=>[{id:'input',role:'user',content:'Read fixture only'}]}}}
  const count = store.tasks.size
  const plan: any = await creator.prepare(proposal,exec,root)
  assert.deepEqual(plan.actions, actions.map(a => ({...a,description:''})))
  assert.equal(store.tasks.size,count); assert.equal(host.sessions.size,0)
  assert.equal('actions' in plan.definition,false)
  await assert.rejects(creator.review(plan.id,'wrong-hash','approve','wrong'),/指纹/)
  const approved: any = await creator.review(plan.id,plan.hash,'approve','Fixture independently reviewed')
  assert.equal(creator.actions.read(approved.taskId).actions.length,1)
  assert.equal(store.tasks.size,count+1)
  const revision=creator.actions.read(approved.taskId).revision
  await creator.review(plan.id,plan.hash,'approve','duplicate')
  assert.equal(creator.actions.read(approved.taskId).revision,revision)
})

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
  for(let attempt=0;attempt<30&&!([...store.s.runs.values()].some(r=>r.cardId===first.cardId));attempt++)await tick()
  const noticeRun=[...store.s.runs.values()].find(r=>r.cardId===first.cardId);assert.ok(noticeRun,'notifier should be scheduled within bounded wait')
  const noticeSession=noticeRun.sessionId
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

test('static workflows send one reviewed final-handoff notification from the frozen upstream completion', async()=>{
  let outbox:TaskNotifications
  const delivered:string[]=[]
  const design:any={scope:'fixture',branches:[{id:'done',when:'worker completes',action:'notify',evidence:'completed run'}],coordination:'worker then notifier',failurePolicy:{isolateItems:true,maxAttempts:1,stopConditions:['no receipt']},acceptance:['sent receipt'],notifications:{channel:'wecom',agentId:'b',chatIds:['fixture-group'],mode:'final-handoff'}}
  const {host,runner,store}=await setup({participants:[{agentId:'a'},{agentId:'b'}],graphMode:'static-chain',onFail:'stop',maxTries:1,design},{
    patrolStatus:input=>({ ...outbox.job(input),notifications:outbox.rows(input.batch.id) }),
    notify:(input,stage)=>outbox.send(input,stage as any,undefined,async args=>{delivered.push(args.markdown);return{sent:1}}),
    beforeComplete:input=>input.profileId==='b'?outbox.complete(input):undefined,
  })
  outbox=new TaskNotifications(store)
  const batch=await runner.fire('T','manual'), worker=[...host.sessions.keys()].at(-1)!
  host.consumeFirst(worker);await host.callTool(worker,'task_complete',{summary:'No retirement candidates; no machine changed.'});host.endTurn(worker);await tick()
  const notifier=[...host.sessions.keys()].at(-1)!
  assert.notEqual(notifier,worker);host.consumeFirst(notifier)
  const job=await host.callTool(notifier,'task_patrol_status',{})
  assert.equal(job.stage,'completed');assert.equal(job.report.summary,'No retirement candidates; no machine changed.')
  await assert.rejects(host.callTool(notifier,'task_complete',{summary:'sent without evidence'}),/task_notify/)
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  await assert.rejects(host.callTool(notifier,'task_notify',{stage:'findings'}),/completed/)
  await host.callTool(notifier,'task_notify',{stage:'completed'});await host.callTool(notifier,'task_notify',{stage:'completed'})
  assert.equal(delivered.length,1);assert.match(delivered[0],/No retirement candidates/)
  await host.callTool(notifier,'task_complete',{summary:'model cannot replace receipt'});host.endTurn(notifier);await tick()
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'done')
  assert.equal((outbox.rows(batch.id)[0] as any).state,'sent')
})

test('a genuine blocked role queues an independent notifier without waiting for the blocked dependency', async()=>{
  let outbox: TaskNotifications, storeRef: EventStore
  const design:any={evidenceContract:'browser-patrol-v2',failurePolicy:{maxAttempts:3},notifications:{agentId:'notifier',chatIds:['fixture']}}
  const {host,runner,store}=await setup({graphMode:'dynamic-rounds',design},{
    afterBlock:async input=>{await storeRef.createNotification(input.task,input.batch,input.card,'blocked',{ready:false,summary:'操作受阻，尚未恢复',items:[]})},
    notify:async(input,stage)=>outbox.send(input,stage as any,{},async()=>({sent:1})),
  })
  storeRef=store;outbox=new TaskNotifications(store)
  const batch=await runner.fire('T','manual'),planner=[...host.sessions.keys()].at(-1)!
  host.consumeFirst(planner)
  await host.callTool(planner,'task_block',{reason:'real external blocker',kind:'capability'})
  host.endTurn(planner);await tick()
  const source=store.s.cards.get(batch.cardIds[0])!,notice=[...store.s.cards.values()].find(c=>c.role==='notifier')!
  assert.equal(source.status,'blocked');assert.ok(notice);assert.deepEqual(notice.deps,[])
  assert.equal(store.kernel.db.prepare('SELECT COUNT(*) n FROM task_links WHERE child_id=?').get(notice.id).n,0)
  const again=await store.createNotification(store.tasks.get('T')!,batch,source,'blocked',{})
  assert.equal(again,notice.id);assert.equal([...store.s.cards.values()].filter(c=>c.role==='notifier').length,1)
  const session=[...store.s.runs.values()].find(r=>r.cardId===notice.id)!.sessionId
  host.consumeFirst(session);const receipt=await host.callTool(session,'task_notify',{stage:'blocked'})
  assert.equal(receipt.notifications[0].state,'sent');assert.equal(source.status,'blocked')
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
  const dispatchDeadline=Date.now()+3000
  while(store.s.cards.get(`${batch.id}#e1`)?.status==='ready' && Date.now()<dispatchDeadline)await tick()
  assert.equal(store.s.cards.get(`${batch.id}#e1`)?.status,'running')
  assert.equal(store.s.cards.get(`${batch.id}#r1`)?.status,'todo')
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
})

test('planner closeout releases notifier without waiting for its downstream sent receipt', async () => {
  let outbox: TaskNotifications
  const design:any={evidenceContract:'browser-patrol-v2',failurePolicy:{maxAttempts:3},notifications:{agentId:'notifier',chatIds:['fixture']}}
  const {host,runner,store}=await setup({graphMode:'dynamic-rounds',design},{
    notify:async(input,stage)=>input.card.role==='planner'
      ? outbox.request(input,stage as any,{ready:true,summary:'independent fixture',items:[]})
      : outbox.send(input,stage as any,{ready:true},async()=>({sent:1})),
    beforeComplete:input=>input.card.role==='notifier'?outbox.complete(input):(outbox.requireStage(input,'restored'),undefined),
  })
  outbox=new TaskNotifications(store)
  const batch=await runner.fire('T','manual'), session=[...host.sessions.keys()].at(-1)!
  host.consumeFirst(session)
  const receipt=await host.callTool(session,'task_notify',{stage:'restored'})
  assert.equal(receipt.nextAction,'task_finalize')
  await assert.rejects(host.callTool(session,'task_block',{kind:'dependency',reason:'waiting for notification sent'}),/不能反向等待/)
  await host.callTool(session,'task_finalize',{summary:'hand off accepted evidence'})
  host.endTurn(session);await tick()
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  const notifier=[...store.s.runs.values()].find(r=>r.cardId===receipt.cardId)!.sessionId
  host.consumeFirst(notifier)
  await host.callTool(notifier,'task_notify',{stage:'restored'})
  await host.callTool(notifier,'task_complete',{summary:'actual sent'})
  host.endTurn(notifier);await tick()
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'done')
})

test('dependency blocking without an unfinished parent parks instead of spinning new sessions', async () => {
  const {host,runner,store}=await setup({participants:[{agentId:'a'}]})
  const batch=await runner.fire('T','manual'), session=[...host.sessions.keys()][0]
  host.consumeFirst(session)
  await host.callTool(session,'task_block',{kind:'dependency',reason:'external dependency'})
  host.endTurn(session);await tick()
  for(let i=0;i<4;i++)await runner.tick()
  assert.equal(host.sessions.size,1)
  assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'blocked')
})

test('expired blocked cron patrol closes failed but unknown operations and manual input stay parked', async () => {
  let now=Date.now(), pending:string|undefined='unreconciled operation'
  const {host,runner,store}=await setup({participants:[{agentId:'a'}],design:{evidenceContract:'browser-patrol-v2'} as any},
    {now:()=>now,pendingOperation:async()=>pending})
  const batch=await runner.fire('T','cron'), session=[...host.sessions.keys()][0]
  host.consumeFirst(session)
  await host.callTool(session,'task_block',{kind:'capability',reason:'fixture missing tool'})
  host.endTurn(session);await tick()
  now+=61_000;await runner.tick()
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  pending=undefined;await runner.tick()
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'failed')
  assert.equal(store.kernel.listRuns(batch.cardIds[0]).length,1)
  const next=await runner.fire('T','cron'), nextSession=[...host.sessions.keys()].at(-1)!
  host.consumeFirst(nextSession)
  await host.callTool(nextSession,'task_block',{kind:'needs_input',reason:'explicit user choice'})
  host.endTurn(nextSession);await tick();now+=61_000;await runner.tick()
  assert.equal(store.s.batches.get(next.id)?.settled,undefined)
  await runner.cancelBatch(next.id)
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
    const plan = await creator.prepare({ decision: 'create', reason: 'hourly fixture', title: 'Hourly', brief: 'Check current fixture only', recurringObjective: 'Check current fixture only', participants: [{ agentId: 'a' }], trigger: { kind: 'cron', expr: '0 * * * *', timeZone: 'Asia/Shanghai' }, design }, { agent: { session: { id: 'schedule-creator', deriveMessages: () => [{ role: 'user', content: 'Check the fixture hourly' }] } } }, root) as any
    assert.equal(plan.definition.trigger.kind, 'cron'); assert.equal(host.sessions.size, 0)
    const approved = await creator.review(plan.id, plan.hash, 'approve', 'fixture-only recurring scope approved')
    assert.equal(approved.state, 'awaiting_trial'); assert.equal(approved.batchId, null)
    assert.equal(host.sessions.size, 0); assert.equal(store.s.batches.size, 0)
    const task = store.tasks.get(approved.taskId)!
    assert.equal(task.enabled, false)
    assert.equal(runner.schedule.claim(task, Date.now() + 3600000), undefined)
    await assert.rejects(creator.assertScheduleActivation(task), /先对当前已审查计划手动执行/)
    const turn = await creator.scheduledTurn(task, 'scheduled-occurrence')
    assert.equal(plan.recurringObjective, task.brief)
    assert.equal(turn?.objective, task.brief)
    assert.equal(turn?.userRequest, task.brief)
    assert.equal(creator.plan(plan.id).request, 'Check the fixture hourly')
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

test('operational patrol trial requires native unresolved evidence and every role ended normally',async()=>{
  const {runner,store,root}=await setup()
  try {
    const creator=new TaskCreator(runner,async()=>[]),db=store.kernel.db
    assert.equal((creator as any).completedPatrolTrial('fixture'),false)
    db.prepare("INSERT INTO tasks(id,title,status,priority,created_by,created_at,tenant) VALUES ('fixture#p','Fixture','done',0,'test',0,'fixture')").run()
    assert.equal((creator as any).completedPatrolTrial('fixture'),false)
    store.kernel.recordEvent('fixture#p','patrol_snapshot',{assessmentMode:'point-in-time-v1',ready:false,canCloseUnresolved:true,items:[{accepted:false}]})
    assert.equal((creator as any).completedPatrolTrial('fixture'),true)
    for(const status of ['running','blocked','triage','ready']){
      db.prepare('UPDATE tasks SET status=?').run(status)
      assert.equal((creator as any).completedPatrolTrial('fixture'),false)
    }
    db.prepare("UPDATE tasks SET status='done'").run()
    store.kernel.recordEvent('fixture#p','patrol_snapshot',{assessmentMode:'point-in-time-v1',ready:false,canCloseUnresolved:false,items:[{accepted:false}]})
    assert.equal((creator as any).completedPatrolTrial('fixture'),false)
  }finally{runner.stop();store.kernel.db.close();await(await import('node:fs/promises')).rm(root,{recursive:true,force:true})}
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
    assert.equal(store.s.runs.get(flight.runId)?.nudges,0)
    await host.callTool(session,'task_complete',{summary:'actual terminal receipt'});host.endTurn(session);await tick()
    assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'done')
  } finally {runner.stop();store.kernel.db.close();await (await import('node:fs/promises')).rm(root,{recursive:true,force:true})}
})

test('multiple onboarding terminal receipts continue the same Run without consuming protocol corrections', async () => {
  const input = (x:any)=>({sessionId:x.sessionId,profileId:'fleet-installer'})
  const {host,runner,store}=await setup({onFail:'stop',maxTries:1},{
    pendingOperation:x=>pendingOnboardOperation(input(x)),
    operationContinuation:x=>takeOnboardContinuation(input(x)),
  })
  const dispose:(()=>void)[]=[]
  try {
    const batch=await runner.fire('T','manual');await tick()
    const session=[...host.sessions.keys()][0];host.consumeFirst(session)
    const flight=(runner as any).flights.get(session),watchdog=flight.timer,lock=flight.claimLock
    for (const initial of ['succeeded','running','succeeded','failed']) {
      let status=initial
      dispose.push(observeOnboardBackground(session,'onb-fixture',async()=>({phase:'running',run_id:'onb-fixture',async_operation:{status}})))
      const followups=host.sessions.get(session)!.followups.length
      host.endTurn(session);await tick()
      if (status==='running') {
        assert.equal(host.sessions.get(session)!.followups.length,followups)
        status='succeeded';host.endTurn(session);await tick()
      }
      assert.equal(host.sessions.get(session)!.followups.length,followups+1)
      assert.match(host.sessions.get(session)!.followups.at(-1).content[0].text,/收录真实回执/)
      assert.equal(store.s.runs.get(flight.runId)?.nudges,0)
      assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
      assert.equal(flight.timer,watchdog)
      assert.equal(flight.claimLock,lock)
      assert.equal(host.sessions.size,1,'no premature downstream session')
    }
    const receipts=store.kernel.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='operation_resumed'").get() as any
    assert.equal(receipts.n,4)
    // Consumed receipts cannot keep a silent Agent alive forever.
    host.endTurn(session);await tick()
    assert.equal(store.s.runs.get(flight.runId)?.nudges,1)
    host.endTurn(session);await tick()
    assert.equal(store.s.runs.get(flight.runId)?.outcome,'protocol_violation')
  } finally {dispose.forEach(fn=>fn());runner.stop()}
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
    await tick()
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
    brief: 'Inspect the fixture with a stronger prerequisite', recurringObjective: 'Inspect the fixture with a stronger prerequisite', design: { ...design, acceptance: [...design.acceptance, 'prerequisite checked'] } }
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
  assert.equal(next?.objective, revision.brief)
  assert.equal(next?.userRequest, revision.brief)
  assert.equal(updated.recurringObjective, revision.brief)
  assert.equal(updated.request, 'Inspect the fixture; preserve history')
  runner.stop(); const restored = new EventStore(store.root); await restored.load()
  assert.equal(restored.tasks.get(original.id)?.title, 'Updated')
  assert.equal(JSON.stringify(restored.s.batches.get(batch.id)), oldBatch)
  restored.kernel.db.close()
})

test('Creator context stays lossless JSON with a paused non-recipe revision candidate', async () => {
  const {store,runner,host} = await setup({enabled:false,origin:{source:'task-chat',signalId:'paused-custom',decision:'create'}})
  try {
    const context=await new TaskCreator(runner,async()=>[]).context()
    assert.equal(context.revisionCandidates.length,1)
    assert.equal('workflowRecipe' in context.revisionCandidates[0],false)
    assert.deepEqual(JSON.parse(JSON.stringify(context)),context)
    assert.equal(host.sessions.size,0)
  } finally { runner.stop(); store.kernel.db.close() }
})

test('review upgrades a paused once-only Fleet Task in place without executing, scheduling or weakening login', async () => {
  const recipe = {id:'fleet-base-v2' as const,login:'provision-gemini' as const}
  const {store,runner,host,task,root} = await setup({...composeRecipe(recipe),workflowRecipe:recipe,enabled:false,
    origin:{source:'task-chat',signalId:'fixture-original',decision:'create'}})
  const creator = new TaskCreator(runner,async()=>['fleet-installer','browser-manager','fleet-runner-operator'].map(id=>({id,name:id,profileHash:'fixed'} as any)))
  const design = {scope:'Complete onboarding',branches:[{id:'inspect',when:'current observations',action:'reuse or repair missing components',evidence:'host receipts'}],coordination:'three roles',failurePolicy:{isolateItems:false,maxAttempts:1,stopConditions:['missing authority']},acceptance:['full Fleet readback']}
  const input=(id:string)=>({agent:{session:{id,deriveMessages:()=>[{role:'user',content:'Upgrade this workflow without deleting history; do not start yet'}]}}})
  const revision={decision:'revise' as const,taskId:task.id,reason:'require full node evidence',recipe:{id:'fleet-base-v3' as const,login:'provision-gemini' as const},design}
  assert.ok((await creator.context()).revisionCandidates.some(t=>t.id===task.id))
  const defaults:any=await creator.prepare({...revision,design:undefined},input('default-design'),root)
  assert.equal(defaults.definition.design.failurePolicy.maxAttempts,2)
  assert.match(defaults.definition.design.branches.find((b:any)=>b.id==='repair').action,/Gate→责任角色→Runner/)
  assert.equal(host.sessions.size,0)
  await assert.rejects(creator.prepare({...revision,recipe:{id:'fleet-base-v3',login:'preserve'}},input('weaken'),root),/不能弱化/)
  const plan:any=await creator.prepare(revision,input('upgrade'),root)
  assert.equal(store.tasks.get(task.id)?.workflowRecipe?.id,'fleet-base-v2')
  const approved=await creator.review(plan.id,plan.hash,'approve','same login criteria, stronger complete-node evidence')
  assert.equal(approved.taskId,task.id);assert.equal(approved.batchId,null)
  assert.equal(store.tasks.size,1);assert.equal(store.s.batches.size,0);assert.equal(host.sessions.size,0)
  assert.equal(store.tasks.get(task.id)?.workflowRecipe?.id,'fleet-base-v3')
  assert.equal(store.tasks.get(task.id)?.enabled,false)
  assert.deepEqual(store.tasks.get(task.id)?.trigger,{kind:'once'})
  assert.equal((store.kernel.db.prepare('SELECT COUNT(*) AS n FROM dsh_schedule_bindings').get() as any).n,0)
  await creator.review(plan.id,plan.hash,'approve','duplicate')
  assert.equal(store.all().filter(e=>e.t==='task/revised').length,1)
  runner.stop()
})

test('Fleet full acceptance cannot bypass evidence through a human-review terminator', async () => {
  const {host,store,runner,task} = await setup({participants:[{agentId:'a'}],workflowRecipe:{id:'fleet-base-v3',login:'preserve'}},
    {beforeComplete:async()=>{throw Error('missing business receipt')}})
  const batch=await runner.fire(task.id,'manual'),session=[...host.sessions.keys()][0];host.consumeFirst(session)
  await assert.rejects(host.callTool(session,'task_request_review',{summary:'please approve'}),/不能用人工批准/)
  await assert.rejects(host.callTool(session,'task_complete',{summary:'done'}),/missing business receipt/)
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  await host.callTool(session,'task_block',{reason:'missing business receipt',kind:'capability'});host.endTurn(session);await tick()
  assert.equal([...store.s.cards.values()].find(c=>c.batchId===batch.id)?.status,'blocked')
  runner.stop()
})

test('Fleet final readback creates a real bounded owner-only repair DAG, no early sessions or fake success', async () => {
  let failures = 1
  const recipe = composeRecipe({id:'fleet-base-v3',login:'preserve'})
  const {host,store,runner,task} = await setup({...recipe,workflowRecipe:{id:'fleet-base-v3',login:'preserve'},timeoutSec:300},
    {beforeComplete:async input=>{if(input.profileId==='fleet-runner-operator' && failures-->0)throw new FleetRepairRequired('browser-manager','fixture missing CDP')}})
  const batch = await runner.fire(task.id,'manual')
  const active = async () => {
    for(let n=0;n<100;n++){
      const found = [...host.sessions.entries()].find(([,s])=>!s.disposed && s.tools.length && s.followups.length)
      if(found)return found[0]
      await tick()
    }
    throw Error('no active fixture session')
  }
  const complete = async () => {const sid=await active();host.consumeFirst(sid);await host.callTool(sid,'task_complete',{summary:'checked'});host.endTurn(sid);await tick();return sid}
  await complete();await complete()
  const sid=await active();host.consumeFirst(sid)
  assert.equal(host.sessions.size,3)
  await host.callTool(sid,'task_complete',{summary:'claims success'})
  assert.equal(host.sessions.size,3,'repair sessions are not precreated')
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  const rows=[...store.s.cards.values()].filter(c=>c.id.includes('#fleet-'))
  assert.equal(rows.length,3)
  assert.deepEqual(rows.map(c=>c.agentId),['__gate__','browser-manager','fleet-runner-operator'])
  assert.ok(rows.every(c=>c.status==='todo' && !c.runIds.length))
  host.endTurn(sid);await tick()
  assert.equal(store.s.cards.get(rows[0].id)?.status,'done')
  assert.equal(store.kernel.listRuns(rows[0].id).length,0)
  const previous = [...store.s.runs.values()].find(r=>r.sessionId===sid)!
  assert.equal(previous.metadata?.decision,'rework');assert.match(previous.summary!,/未通过/)
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  await complete();await complete()
  assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'done')
  assert.equal([...store.s.runs.values()].filter(r=>r.profileId==='fleet-installer').length,1,'healthy installer is not repeated')
  const graph=store.graphSnapshot(task.id,batch.id)
  assert.equal(graph.live.tasks.length,6)
  assert.equal(graph.live.links.length,5)
  assert.ok(graph.live.tasks.every(t=>Math.abs(t.created_at-Date.now()/1000)<60),'all kernel timestamps use seconds')
})

test('Fleet repair budget and source CAS reject extra or stale graph mutation atomically', async () => {
  const recipe=composeRecipe({id:'fleet-base-v3',login:'preserve'})
  const {host,store,runner,task}=await setup({...recipe,workflowRecipe:{id:'fleet-base-v3',login:'preserve'},timeoutSec:300})
  const batch=await runner.fire(task.id,'manual')
  for(let i=0;i<2;i++){
    const sid=[...host.sessions.entries()].find(([,s])=>!s.disposed)![0]
    host.consumeFirst(sid);await host.callTool(sid,'task_complete',{summary:'checked'});host.endTurn(sid);await tick()
  }
  const source=[...store.s.cards.values()].find(c=>c.agentId==='fleet-runner-operator')!,core=store.kernel.getTask(source.id)!
  const count=()=>store.kernel.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as {n:number}
  await assert.rejects(store.expandFleetRepair(task,batch,source,core.current_run_id!+1,'browser-manager','stale'),/租约/)
  assert.equal(count().n,3)
  await assert.rejects(store.expandFleetRepair(task,batch,source,core.current_run_id!,'browser-manager','late',Date.parse(batch.firedAt)+900001),/时间预算/)
  assert.equal(count().n,3)
  for(let i=0;i<2;i++)store.kernel.recordEvent(source.id,'fleet_repair_requested',{round:i+1})
  await assert.rejects(store.expandFleetRepair(task,batch,source,core.current_run_id!,'browser-manager','third'),/两轮/)
  assert.equal(count().n,3)
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
  let expectedSessions = 0
  const nextSession = async () => {
    expectedSessions++
    const deadline = Date.now()+5000
    while (Date.now()<deadline) {
      const entries=[...host.sessions.entries()], last=entries.at(-1)
      if (entries.length === expectedSessions && last?.[1].tools.length && last[1].followups.length && !last[1].disposed) return last[0]
      await tick()
    }
    assert.fail(`Expected ready session ${expectedSessions}; got ${host.sessions.size}`)
  }
  let session = await nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'A1' }); host.endTurn(session); await tick()
  session = await nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'B1' }); host.endTurn(session); await tick()
  session = await nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_request_review', { summary: 'R1' }); host.endTurn(session); await tick()
  const reviewer = `${batch.id}#2`; const planner = `${batch.id}#0`
  await runner.reviewCard(reviewer, 'changes', '重新规划交互', planner); await tick()
  session = await nextSession()
  assert.equal(store.s.cards.get(planner)!.status, 'running'); assert.equal(store.s.cards.get(`${batch.id}#1`)!.status, 'todo'); assert.equal(store.s.cards.get(reviewer)!.status, 'todo')
  assert.match(host.sessions.get(session)!.followups[0].content[0].text, /\[REVIEW CHANGES\]\n重新规划交互/)
  host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'A2' }); host.endTurn(session); await tick()
  session = await nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_complete', { summary: 'B2' }); host.endTurn(session); await tick()
  session = await nextSession(); host.consumeFirst(session); await host.callTool(session, 'task_request_review', { summary: 'R2' }); host.endTurn(session); await tick()
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

test('expired Fleet batch cannot unblock, create a session or cancel its waiting successor', async () => {
  let now = Date.now()
  const { host, store, runner } = await setup({workflowRecipe:{id:'fleet-base-v3',login:'preserve'},timeoutSec:60}, {now:()=>now})
  const batch=await runner.fire('T','manual'),session=[...host.sessions.keys()][0]
  host.consumeFirst(session)
  await host.callTool(session,'task_block',{reason:'needs adapter repair',kind:'capability'});host.endTurn(session);await tick()
  const beforeRuns=store.kernel.listRuns(batch.cardIds[0]).length, beforeSessions=host.sessions.size
  const successorStatus=store.s.cards.get(batch.cardIds[1])!.status
  now=Date.parse(batch.firedAt)+180_000
  await assert.rejects(runner.unblockCard(batch.cardIds[0]),/超过总时限.*同一 Task 新建执行/)
  assert.equal(store.s.cards.get(batch.cardIds[0])!.status,'blocked')
  assert.equal(store.kernel.listRuns(batch.cardIds[0]).length,beforeRuns)
  assert.equal(host.sessions.size,beforeSessions)
  assert.equal(store.s.cards.get(batch.cardIds[1])!.status,successorStatus)
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


test('host preflight blocks a durable run before creating any agent or dispatching prompt', async () => {
  const { runner, store, host } = await setup({}, {beforeStart: () => ({kind:'capability',reason:'blocked_quality_capability: actual audio unavailable'})})
  const batch = await runner.fire('T','manual')
  assert.equal(host.sessions.size, 0)
  const cards = [...store.s.cards.values()].filter(c => c.batchId === batch.id)
  assert.ok(cards.some(c => c.status === 'blocked'))
  assert.ok([...store.s.runs.values()].some(r => r.status === 'blocked'))
  assert.ok(!store.all().some(e => e.t === 'run/prompt_dispatched'))
})

test('Studio unblock acknowledges durable ready without waiting for suspended media preflight and claims once', async () => {
  let calls = 0, release!: () => void, entered!: () => void
  const suspended = new Promise<void>(resolve => { release = resolve })
  const preflightEntered = new Promise<void>(resolve => { entered = resolve })
  const {runner,store,host} = await setup({participants:[{agentId:'a'}],design:{evidenceContract:'studio-video-v1'} as any}, {
    beforeStart: async () => {calls++;if(calls===1)return {kind:'capability',reason:'fixture preflight unavailable'};entered();await suspended},
  })
  const batch = await runner.fire('T','manual'), cardId=batch.cardIds[0]
  assert.equal(store.s.cards.get(cardId)!.status,'blocked')
  let acknowledged=false
  const acknowledgement=runner.unblockCard(cardId).then(()=>{acknowledged=true})
  await Promise.race([acknowledgement,new Promise((_,reject)=>setTimeout(()=>reject(Error('unblock waited for preflight')),500))])
  assert.equal(acknowledged,true)
  const audit=new StudioInterventions(store).assessment({taskId:'T',batchId:batch.id})
  assert.equal(audit.status,'assisted');assert.equal(audit.records.length,1);assert.equal(audit.records[0].kind,'operator_unblock');assert.equal(audit.records[0].sourceRunId,`${batch.id}#0#1`)
  assert.ok(store.all().some(e=>e.t==='card/ready'&&e.cardId===cardId))
  await preflightEntered
  assert.equal(host.sessions.size,0,'preflight is actually still suspended')
  await runner.tick();await runner.tick()
  assert.equal(calls,2,'concurrent ticks do not claim a duplicate run')
  release();await tick()
  assert.equal(host.sessions.size,1)
  assert.equal(store.kernel.listRuns(cardId).length,2,'one prior blocked run and exactly one resumed run')
  runner.stop()
})

test('Studio background unblock scheduling failure is durable telemetry, not an unhandled rejection', async () => {
  const {runner,store}=await setup({participants:[{agentId:'a'}],design:{evidenceContract:'studio-video-v1'} as any},{beforeStart:()=>({kind:'capability',reason:'fixture blocked'})})
  const batch=await runner.fire('T','manual'),cardId=batch.cardIds[0]
  runner.tick=async()=>{throw Error('fixture dispatcher failure')}
  await runner.unblockCard(cardId);await tick()
  assert.equal(store.s.cards.get(cardId)!.status,'ready')
  const failure=store.kernel.listEvents(cardId).find(e=>e.kind==='studio_unblock_dispatch_failed')
  assert.ok(failure)
  assert.match(failure.payload??'',/fixture dispatcher failure/)
  runner.stop()
})

test('Studio structured review hands off through the same guarded completion without a second model tool call',async()=>{
 let valid=false
 const {host,store,runner}=await setup({graphMode:'dynamic-rounds',design:{evidenceContract:'studio-video-v1',failurePolicy:{maxAttempts:3}} as any},{
  registerStudioTools:async(ctx,input,isActive,submitReview)=>ctx.tools.register({name:'studio_submit_review',execute:async()=>{assert.equal(isActive(),true);await submitReview();return {qualityApproved:false}}}),
  beforeComplete:input=>{if(input.card.role==='reviewer'){if(!valid)throw Error('host-evidence-invalid');return {summary:'Negative review verified',metadata:{workflowOutcome:'review_needs_changes'}}}},
 })
 const batch=await runner.fire('T','manual'),latest=()=>[...host.sessions.keys()].at(-1)!
 let session=latest();host.consumeFirst(session)
 await assert.rejects(host.callTool(session,'studio_submit_review',{}),/reviewer-required/)
 await host.callTool(session,'task_plan_round',{summary:'plan'});host.endTurn(session);await tick()
 session=latest();host.consumeFirst(session);await host.callTool(session,'task_complete',{summary:'candidate'});host.endTurn(session);await tick()
 session=latest();host.consumeFirst(session)
 await assert.rejects(host.callTool(session,'studio_submit_review',{}),/host-evidence-invalid/)
 assert.equal(store.s.cards.get(`${batch.id}#r1`)?.status,'running')
 valid=true;await host.callTool(session,'studio_submit_review',{});host.endTurn(session);await tick()
 assert.equal(store.s.cards.get(`${batch.id}#r1`)?.status,'done')
 assert.equal(store.s.runs.get(`${batch.id}#r1#1`)?.metadata?.workflowOutcome,'review_needs_changes')
 assert.equal(store.s.cards.get(`${batch.id}#p2`)?.status,'running')
 assert.equal(store.all().some(e=>e.t==='run/nudged'),false)
 runner.stop()
})

test('Studio workers receive real JSON tool-call corrections, not Python-style pseudocode',async()=>{
 const {host,store,runner}=await setup({participants:[{agentId:'a'}],maxTries:1,onFail:'stop',design:{evidenceContract:'studio-video-v1'} as any},{registerStudioTools:async()=>()=>{}})
 const batch=await runner.fire('T','manual'),session=[...host.sessions.keys()][0];host.consumeFirst(session)
 host.endTurn(session);await tick();host.endTurn(session);await tick()
 assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.nudges,2)
 assert.match(host.sessions.get(session)!.followups.at(-1).content[0].text,/JSON.*summary/)
 assert.doesNotMatch(host.sessions.get(session)!.followups.at(-1).content[0].text,/task_complete\(summary/)
 host.endTurn(session);await tick();assert.equal(store.s.runs.get(`${batch.id}#0#1`)!.outcome,'protocol_violation')
 runner.stop()
})

test('Studio planner correction uses planning/finalization tools instead of unavailable worker completion',async()=>{
 const {host,runner}=await setup({graphMode:'dynamic-rounds',design:{evidenceContract:'studio-video-v1',failurePolicy:{maxAttempts:3}} as any},{registerStudioTools:async()=>()=>{}})
 await runner.fire('T','manual');const session=[...host.sessions.keys()][0];host.consumeFirst(session);host.endTurn(session);await tick()
 const correction=host.sessions.get(session)!.followups.at(-1).content[0].text
 assert.match(correction,/task_plan_round/);assert.match(correction,/task_finalize/);assert.doesNotMatch(correction,/task_complete/)
 runner.stop()
})

test('studio preparation Task Links are materialized in the same batch and retained in replay',async()=>{
 const stages=['storyboard','visual','sound'].map(id=>({id,agentId:'a',brief:`Prepare ${id}`}))
 const {runner,store,host}=await setup({graphMode:'dynamic-rounds',design:{studioStages:stages,failurePolicy:{maxAttempts:3}} as any})
 const batch=await runner.fire('T','manual');await tick();const sid=[...host.sessions.keys()][0]
 await host.callTool(sid,'task_plan_round',{summary:'Prepare staged production'})
 const rows=store.kernel.db.prepare('SELECT id,role,tenant FROM tasks WHERE tenant=?').all(batch.id) as any[]
 assert.equal(rows.filter(r=>r.role==='studio-stage').length,3)
 assert.equal(store.s.cards.get(`${batch.id}#s1-visual`)?.role,'studio-stage')
 assert.deepEqual(store.kernel.parentIds(`${batch.id}#g1`),[`${batch.id}#s1-sound`,`${batch.id}#s1-visual`])
 assert.deepEqual(store.kernel.parentIds(`${batch.id}#s1-sound`),[`${batch.id}#s1-storyboard`])
 assert.ok(rows.every(r=>r.tenant===batch.id));runner.stop()
})

test('background fire acknowledges durable batch while host preflight is suspended and stable-ID retries claim once', async () => {
  let release!: () => void, entered!: () => void, calls = 0
  const pending = new Promise<void>(resolve => { release = resolve })
  const didEnter = new Promise<void>(resolve => { entered = resolve })
  const {runner,store,host} = await setup({participants:[{agentId:'a'}]}, {
    beforeStart: async () => { calls++; entered(); await pending },
  })
  const options = {batchId:'b-background-ack',dispatch:'background' as const}
  const [first,retry] = await Promise.all([runner.fire('T','manual',options),runner.fire('T','manual',options)])
  assert.equal(first.id,retry.id)
  assert.equal(store.s.batches.size,1)
  assert.equal(store.kernel.db.prepare('SELECT COUNT(*) AS n FROM dsh_batches').get().n,1)
  assert.equal(host.sessions.size,0)
  await didEnter
  assert.equal(calls,1)
  assert.equal(store.kernel.listRuns(first.cardIds[0]).length,1)
  const again = await runner.fire('T','manual',options)
  assert.equal(again.id,first.id)
  await tick()
  assert.equal(calls,1,'the in-flight claim fences duplicate dispatch')
  release(); await tick()
  assert.equal(host.sessions.size,1)
  assert.equal(store.kernel.listRuns(first.cardIds[0]).length,1)
})

test('Creator approval returns a durable batch before suspended preflight and duplicate approvals dispatch once',async()=>{
 let release!:()=>void,entered!:()=>void,calls=0
 const suspended=new Promise<void>(r=>{release=r}),didEnter=new Promise<void>(r=>{entered=r})
 const {runner,store,host,root}=await setup({}, {beforeStart:async()=>{calls++;entered();await suspended}})
 const creator=new TaskCreator(runner,async()=>[{id:'a',name:'A'} as any])
 const proposal={decision:'create' as const,reason:'fixture latency',title:'Background review',brief:'Read fixture',participants:[{agentId:'a'}],design:{scope:'fixture read',branches:[{id:'read',when:'authorized',action:'read',evidence:'receipt'}],coordination:'serial',failurePolicy:{isolateItems:true,maxAttempts:1,stopConditions:['missing permission']},acceptance:['actual receipt']}}
 const plan=await creator.prepare(proposal,{agent:{session:{id:'background-review',deriveMessages:()=>[{role:'user',content:'Read fixture after independent approval'}]}}},root)
 let timer:ReturnType<typeof setTimeout>|undefined
 try{
  const approved=await Promise.race([creator.review(plan.id,plan.hash,'approve','Independent fixture approval'),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Approval waited for preflight')),3000)})])
  clearTimeout(timer)
  assert.equal(approved.state,'dispatched');assert.ok(store.tasks.has(approved.taskId!));assert.equal(host.sessions.size,0)
  assert.equal(store.kernel.db.prepare('SELECT COUNT(*) AS n FROM dsh_batches').get().n,1)
  assert.equal(store.s.batches.get(approved.batchId!)?.turn?.origin?.reviewPlanId,plan.id)
  await didEnter
  const retries=await Promise.all([creator.review(plan.id,plan.hash,'approve','Replay'),creator.review(plan.id,plan.hash,'approve','Concurrent replay')])
  assert.ok(retries.every(result=>result.batchId===approved.batchId));assert.equal(calls,1);assert.equal(host.sessions.size,0)
  release();await tick()
  assert.equal(host.sessions.size,1);assert.equal(store.kernel.listRuns(store.s.batches.get(approved.batchId!)!.cardIds[0]).length,1)
 }finally{clearTimeout(timer);release();runner.stop()}
})

test('background batch survives stop before callback and restart still performs initial preset preflight', async () => {
  const {runner,store,root,host} = await setup({participants:[{agentId:'a'}]})
  const batch = await runner.fire('T','manual',{batchId:'b-background-restart',dispatch:'background'})
  runner.stop()
  assert.equal(host.sessions.size,0)
  store.kernel.db.close()
  const restartedStore = new EventStore(join(root,'store'))
  const restartedHost = fakeHost(join(root,'presets'))
  let checked = 0
  const get = restartedHost.ctx.get
  restartedHost.ctx.get = (key: string) => key === 'agentPresets' ? {
    ...get(key), resolve: async () => { checked++; throw Error('missing after restart') },
  } : get(key)
  const restartedRunner = new TaskRunner(restartedHost.ctx,restartedStore)
  try {
    await restartedRunner.start()
    assert.equal(checked,1)
    assert.equal(restartedHost.sessions.size,0)
    assert.equal(restartedStore.s.batches.size,1)
    assert.equal(restartedStore.s.batches.get(batch.id)?.settled?.outcome,'failed')
    assert.match(restartedStore.s.cards.get(batch.cardIds[0])?.error ?? '',/preset a 不在名册上/)
  } finally { restartedRunner.stop(); restartedStore.kernel.db.close() }
})

test('background dispatch rejection is durable, leaves queued work intact, and subsequent dispatch resumes once', async () => {
  const {runner,store,host} = await setup({participants:[{agentId:'a'}]})
  const original = runner.tick.bind(runner)
  runner.tick = async () => { throw Error('fixture dispatch unavailable') }
  const batch = await runner.fire('T','manual',{batchId:'b-background-failure',dispatch:'background'})
  await tick()
  const event = store.kernel.listEvents(batch.cardIds[0]).find(e => e.kind === 'dispatch_failed')
  assert.ok(event)
  assert.match(event.payload ?? '',/fixture dispatch unavailable/)
  assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'ready')
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  assert.equal(host.sessions.size,0)
  runner.tick = original
  await runner.fire('T','manual',{batchId:batch.id,dispatch:'background'})
  await tick()
  assert.equal(host.sessions.size,1)
  assert.equal(store.kernel.listRuns(batch.cardIds[0]).length,1)
})

test('accepted background batch starts exactly once after host restart before dispatch', async () => {
  const {runner,store,root} = await setup({participants:[{agentId:'a'}]})
  const batch = await runner.fire('T','manual',{batchId:'b-background-resume',dispatch:'background'})
  runner.stop(); store.kernel.db.close()
  const resumedStore = new EventStore(join(root,'store'))
  const resumedHost = fakeHost(join(root,'presets'))
  const resumedRunner = new TaskRunner(resumedHost.ctx,resumedStore)
  try {
    await resumedRunner.start()
    await resumedRunner.fire('T','manual',{batchId:batch.id,dispatch:'background'})
    await tick()
    assert.equal(resumedStore.s.batches.size,1)
    assert.equal(resumedHost.sessions.size,1)
    assert.equal(resumedStore.kernel.listRuns(batch.cardIds[0]).length,1)
    assert.equal(resumedStore.s.batches.get(batch.id)?.settled,undefined)
  } finally { resumedRunner.stop(); resumedStore.kernel.db.close() }
})


test('extension evidence gates the real runner handoff; model metadata cannot approve it',async()=>{
 const extensions=new WorkflowExtensions();let proof=false
 extensions.register({id:'audit-fixture',version:'1.0.0',hostApi:1,implementationSha256:'a'.repeat(64),validatePolicy:()=>({}),beforeComplete:async()=>{
  if(!proof)throw Error('independent-hash-evidence-required')
  return {summary:'Host verified fixture',metadata:{verifiedFixture:true}}
 }})
 const extension=extensions.bind({id:'audit-fixture',version:'1.0.0',policy:{}})
 const {runner,store,host}=await setup({participants:[{agentId:'a'}],design:{extension} as any},{
  beforeStart:i=>extensions.beforeStart(i),beforeComplete:i=>extensions.beforeComplete(i),beforePlanRound:(i,a,b)=>extensions.beforePlanRound(i,a,b),
 })
 const batch=await runner.fire('T','manual');await tick()
 const session=[...host.sessions.keys()].at(-1)!;host.consumeFirst(session)
 await assert.rejects(host.callTool(session,'task_complete',{summary:'I passed',metadata:{verifiedFixture:true}}),/independent-hash-evidence-required/)
 assert.equal(store.all().filter(e=>e.t==='run/completed').length,0)
 proof=true;await host.callTool(session,'task_complete',{summary:'client text'});host.endTurn(session);await tick()
 const completion=store.all().find(e=>e.t==='run/completed') as any
 assert.equal(completion.summary,'Host verified fixture')
 assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'done')
})

test('restoring an extension task without its exact adapter blocks before model dispatch',async()=>{
 const installed=new WorkflowExtensions()
 installed.register({id:'audit-fixture',version:'1.0.0',hostApi:1,implementationSha256:'a'.repeat(64),validatePolicy:()=>({}),beforeComplete:async()=>({summary:'host',metadata:{}})})
 const binding=installed.bind({id:'audit-fixture',version:'1.0.0',policy:{}}),missing=new WorkflowExtensions()
 const {runner,store,host}=await setup({participants:[{agentId:'a'}],design:{extension:binding} as any},{beforeStart:async i=>{
  try{return await missing.beforeStart(i)}catch(e){return {kind:'capability',reason:String(e)}}
 }})
 await runner.fire('T','manual');await tick()
 assert.equal(host.sessions.size,0)
 assert.ok(store.all().some((e:any)=>e.t==='run/blocked'&&/extension-version-unavailable/.test(e.reason)))
})

test('static extension cannot request human review to evade host validation',async()=>{
 const {runner,store,host}=await setup({participants:[{agentId:'a'}],design:{extension:{id:'fixture'}} as any},{beforeComplete:async()=>{throw Error('evidence absent')}})
 const batch=await runner.fire('T','manual'),sid=[...host.sessions.keys()][0];host.consumeFirst(sid)
 await assert.rejects(host.callTool(sid,'task_request_review',{summary:'approve without proof'}),/human-review-bypass-forbidden/)
 assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
 await assert.rejects(host.callTool(sid,'task_complete',{summary:'done'}),/evidence absent/)
})

test('historical extension review cards cannot be human-approved after template changes',async()=>{
 const {runner,store,host,task}=await setup({participants:[{agentId:'a'}]})
 const batch=await runner.fire('T','manual'),sid=[...host.sessions.keys()][0];host.consumeFirst(sid)
 await host.callTool(sid,'task_request_review',{summary:'historical review'});host.endTurn(sid);await tick()
 // Fixture simulates an old build's review card with an extension in its frozen
 // definition, while the present-day template has no extension.
 const {workflowDefinition}=await import('../src/workflow-plan.js')
 const frozen=workflowDefinition({...task,design:{extension:{id:'fixture'}} as any})
 store.s.batches.get(batch.id)!.turn={workflow:{id:'old-extension-definition',definition:frozen}} as any
 await assert.rejects(runner.reviewCard(batch.cardIds[0],'approve','human override'),/human-review-bypass-forbidden/)
 assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'review')
 assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
})

test('chat Creator freezes binding before review and ready extension batch restores exactly once',async()=>{
 const registry=new WorkflowExtensions()
 const extension={id:'restart-fixture',version:'1.0.0',hostApi:1 as const,implementationSha256:'c'.repeat(64),validatePolicy:(p:any)=>p,beforeComplete:async()=>({summary:'host verified',metadata:{}})}
 registry.register(extension)
 const {store,runner,root,host}=await setup({}, {beforeStart:i=>registry.beforeStart(i)})
 const design={scope:'fixture',branches:[{id:'audit',when:'input exists',action:'read',evidence:'hashes'}],coordination:'serial',failurePolicy:{isolateItems:true,maxAttempts:1,stopConditions:['missing']},acceptance:['host verified'],extension:{id:extension.id,version:extension.version,policy:{file:'input.tgz'}}}
 const creator=new TaskCreator(runner,async()=>[{id:'a',name:'A'} as any],d=>({...d,extension:registry.bind(d.extension)}))
 const plan:any=await creator.prepare({decision:'create',reason:'fixture',title:'Restore extension',brief:'Read fixture',participants:[{agentId:'a'}],design},{agent:{session:{id:'extension-chat',deriveMessages:()=>[{role:'user',content:'Check fixture'}]}}},root)
 const frozen=plan.definition.design.extension
 assert.equal(frozen.implementationSha256,extension.implementationSha256);assert.match(frozen.policySha256,/^[a-f0-9]{64}$/)
 assert.equal(store.s.batches.size,0)
 const approved=await creator.review(plan.id,plan.hash,'approve','Check actual bytes');runner.stop()
 assert.equal(host.sessions.size,0)
 assert.deepEqual(store.tasks.get(approved.taskId!)?.design?.extension,frozen)
 store.kernel.db.close()
 // The startup installer supplies adapters BEFORE start loads and dispatches.
 const restored=new EventStore(join(root,'store')),newHost=fakeHost(join(root,'presets')),newRegistry=new WorkflowExtensions()
 newRegistry.register(extension)
 const resumed=new TaskRunner(newHost.ctx,restored,{beforeStart:i=>newRegistry.beforeStart(i)})
 try{
  await resumed.start();await resumed.tick()
  assert.equal(newHost.sessions.size,1)
  const card=restored.s.batches.get(approved.batchId!)!.cardIds[0]
  assert.equal(restored.kernel.listRuns(card).length,1)
  assert.equal(restored.s.cards.get(card)?.status,'running')
 }finally{resumed.stop();restored.kernel.db.close()}
})

test('chat approval refuses missing or changed extension without changing the reviewed plan',async()=>{
 const registry=new WorkflowExtensions()
 const drop=registry.register({id:'approval-fixture',version:'1.0.0',hostApi:1,implementationSha256:'d'.repeat(64),validatePolicy:(p:any)=>p,beforeComplete:async()=>({summary:'host',metadata:{}})})
 const {store,runner,root,host}=await setup()
 const design={scope:'fixture',branches:[{id:'audit',when:'input',action:'read',evidence:'hash'}],coordination:'serial',failurePolicy:{isolateItems:true,maxAttempts:1,stopConditions:['missing']},acceptance:['host'],extension:{id:'approval-fixture',version:'1.0.0',policy:{}}}
 const proposal={decision:'create' as const,reason:'fixture',title:'Approve extension',brief:'Read fixture',participants:[{agentId:'a'}],design}
 const exec={agent:{session:{id:'extension-approval',deriveMessages:()=>[{role:'user',content:'Check fixture'}]}}}
 await assert.rejects(new TaskCreator(runner,async()=>[{id:'a'} as any]).prepare(proposal,exec,root),/host-binding-unavailable/)
 const creator=new TaskCreator(runner,async()=>[{id:'a'} as any],d=>({...d,extension:registry.bind(d.extension)}))
 const plan:any=await creator.prepare(proposal,exec,root);drop()
 await assert.rejects(creator.review(plan.id,plan.hash,'approve','checked'),/version-unavailable/)
 registry.register({id:'approval-fixture',version:'1.0.0',hostApi:1,implementationSha256:'e'.repeat(64),validatePolicy:(p:any)=>p,beforeComplete:async()=>({summary:'host',metadata:{}})})
 await assert.rejects(creator.review(plan.id,plan.hash,'approve','checked'),/binding-mismatch/)
 assert.equal(creator.plan(plan.id).state,'pending');assert.equal(creator.plan(plan.id).hash,plan.hash)
 assert.equal(store.s.batches.size,0);assert.equal(host.sessions.size,0)
})

test('release audit extension runs planner, independent verifier sessions and exact artifact handoff',async()=>{
 const {default:adapter}=await import('../src/release-audit-extension.js'),{WorkflowEvidence}=await import('../src/workflow-evidence.js'),{releaseArchive}=await import('./fixtures/release-archive.js')
 const fixture=releaseArchive();let ledger:InstanceType<typeof WorkflowEvidence>
 const registry=new WorkflowExtensions(()=>false,(i,active)=>ledger.port(i,active));registry.register(adapter)
 const extension=registry.bind({id:adapter.id,version:adapter.version,policy:fixture.policy})
 const {runner,store,host,root}=await setup({graphMode:'dynamic-rounds',design:{extension,failurePolicy:{maxAttempts:2}} as any},{beforeStart:i=>registry.beforeStart(i),beforeComplete:i=>registry.beforeComplete(i),beforePlanRound:(i,a,b)=>registry.beforePlanRound(i,a,b),registerWorkflowTools:(ctx,i,a)=>registry.registerTools(ctx,i,a)})
 ledger=new WorkflowEvidence(store);await writeFile(join(root,'candidate.tgz'),fixture.bytes)
 const {apply:fence}=await import('../src/agent-tool-fence.js')
 let guard:((exec:any)=>string|undefined)|undefined
 fence({tools:{schemas:()=>[{name:'bash'},{name:'write'}],restrict:()=>{},guard:(g:any)=>{guard=g}}} as any,{selected:['task_plan_round','task_complete','task_finalize'],workflowRunTools:true})
 const call=host.callTool;host.callTool=async(session,name,args)=>{const denied=guard?.({name,agent:{session:{id:session}}});if(denied)throw Error(denied);return call(session,name,args)}

 const batch=await runner.fire('T','manual');await tick();let sid=[...host.sessions.keys()].at(-1)!
 host.consumeFirst(sid);await host.callTool(sid,'task_plan_round',{summary:'Verify frozen bytes in separate sessions'});host.endTurn(sid);await tick()
 sid=[...host.sessions.keys()].at(-1)!;host.consumeFirst(sid)
 await assert.rejects(host.callTool(sid,'task_complete',{summary:'trust me'}),/current-run-report-required/)
 const a:any=await host.callTool(sid,'release_audit_verify',{})
 await assert.rejects(host.callTool(sid,'release_audit_report',{receiptId:a.id,conclusion:'fail',summary:'Wrong fixture conclusion',findings:[]}),/disagrees-with-facts/)
 const reportA:any=await host.callTool(sid,'release_audit_report',{receiptId:a.id,conclusion:'pass',summary:'Verified fixture package byte integrity only.',findings:[]})
 const replay:any=await host.callTool(sid,'release_audit_report',{receiptId:a.id,conclusion:'pass',summary:'Verified fixture package byte integrity only.',findings:[]});assert.equal(replay.report.id,reportA.report.id)
 assert.match(guard?.({name:'bash',agent:{session:{id:sid}}})??'',/not been granted/)
 assert.match(guard?.({name:'release_audit_verify',agent:{session:{id:'another-session'}}})??'',/not been granted/)
 await assert.rejects(host.callTool(sid,'task_complete',{summary:'omit evidence'}),/required-report-artifacts/)
 await host.callTool(sid,'task_complete',{summary:'handoff',artifacts:reportA.artifacts});host.endTurn(sid);await tick()
 sid=[...host.sessions.keys()].at(-1)!;host.consumeFirst(sid)
 await assert.rejects(host.callTool(sid,'release_audit_report',{receiptId:a.id,conclusion:'pass',summary:'Copied other session proof',findings:[],upstreamReportId:reportA.report.id}),/own-verification-required/)
 const b:any=await host.callTool(sid,'release_audit_verify',{});assert.notEqual(a.sessionId,b.sessionId)
 const reportB:any=await host.callTool(sid,'release_audit_report',{receiptId:b.id,conclusion:'pass',summary:'Independently recomputed using the same pinned verifier.',findings:[],upstreamReportId:reportA.report.id})
 await host.callTool(sid,'task_complete',{summary:'independent handoff',artifacts:reportB.artifacts});host.endTurn(sid);await tick()
 sid=[...host.sessions.keys()].at(-1)!;host.consumeFirst(sid)
 await assert.rejects(host.callTool(sid,'task_finalize',{summary:'wrong report',artifact:reportB.artifacts[0]}),/final-artifact-must-be-current-executor-report/)
 await host.callTool(sid,'task_finalize',{summary:'verified',artifact:reportA.artifacts.find((p:string)=>p.endsWith('REPORT.md'))});host.endTurn(sid);await tick()
 assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'done')
 assert.equal(store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_workflow_receipts').get().n,4)
 assert.equal([...store.s.artifacts.values()].filter(a=>a.batchId===batch.id).length,4)
})

test('extension evidence rejects delayed results after tool disposal even if kernel run remains live',async()=>{
 const {WorkflowEvidence}=await import('../src/workflow-evidence.js');let ledger:InstanceType<typeof WorkflowEvidence>,release:()=>void=()=>{},entered:()=>void=()=>{}
 const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const registry=new WorkflowExtensions(()=>false,(i,a)=>ledger.port(i,a))
 registry.register({id:'late-fixture',version:'1.0.0',hostApi:2,implementationSha256:'a'.repeat(64),validatePolicy:()=>({}),beforeComplete:async()=>({summary:'host',metadata:{}}),registerTools:async(ctx,_i,host)=>ctx.tools.register({name:'late_fixture_verify',description:'fixture',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_:any,r:any)=>[{type:'text',text:JSON.stringify(r)}]},execute:async()=>{entered();await waiting;return host.commit('verification',{actual:true})}})})
 const extension=registry.bind({id:'late-fixture',version:'1.0.0',policy:{}})
 const {runner,store,host}=await setup({participants:[{agentId:'a'}],design:{extension} as any},{beforeStart:i=>registry.beforeStart(i),registerWorkflowTools:(ctx,i,a)=>registry.registerTools(ctx,i,a)})
 ledger=new WorkflowEvidence(store);await runner.fire('T','manual');const sid=[...host.sessions.keys()].at(-1)!
 const pending=host.callTool(sid,'late_fixture_verify',{});await started;runner.stop();release()
 await assert.rejects(pending,/stale-run/)
 assert.equal(store.kernel.db.prepare('SELECT COUNT(*) n FROM dsh_workflow_receipts').get().n,0)
})

test('workflow evidence survives storage reload but cannot be reused as proof of a new run',async()=>{
 const {WorkflowEvidence}=await import('../src/workflow-evidence.js')
 const {store,runner,task}=await setup({participants:[{agentId:'a'}],design:{extension:{id:'fixture',version:'1.0.0',policy:{},implementationSha256:'a'.repeat(64),policySha256:'b'.repeat(64)}}} as any)
 // Create and claim through the real EventStore without dispatching a model.
 const batchId='b-evidence-restart',cardId=batchId+'#0'
 await store.createBatch(task,{t:'batch/fired',at:new Date().toISOString(),taskId:task.id,batch:{id:batchId,by:'manual',cards:[{id:cardId,agentId:'a',deps:[]}]}})
 await store.claimCard(cardId,cardId+'#1','evidence-session-1',1)
 const input:any={task,batch:store.s.batches.get(batchId),card:store.s.cards.get(cardId),sessionId:'evidence-session-1',profileId:'a'}
 const evidence=new WorkflowEvidence(store),old=evidence.port(input),receipt=old.commit('verification',{actual:'bytes'})
 assert.equal(new WorkflowEvidence(store).port(input).receipts('run')[0].id,receipt.id)
 const first=store.coreRunId(cardId+'#1')!
 store.kernel.failRun(cardId,{expectedRunId:first,outcome:'crashed',error:'fixture interruption'})
 // Project the restart closure, then claim the ready retry as a distinct run.
 await store.append({t:'run/crashed',at:new Date().toISOString(),taskId:task.id,runId:cardId+'#1',error:'fixture interruption'})
 await store.claimCard(cardId,cardId+'#2','evidence-session-2',2)
 assert.throws(()=>old.commit('verification',{late:true}),/stale-run/)
 const current=new WorkflowEvidence(store).port({...input,card:store.s.cards.get(cardId),sessionId:'evidence-session-2'})
 assert.equal(current.receipts('run').length,0);assert.equal(current.receipts('batch').length,1)
 const fresh=current.commit('verification',{actual:'recomputed bytes'})
 assert.notEqual(fresh.coreRunId,receipt.coreRunId);assert.notEqual(fresh.claimLock,receipt.claimLock)
 runner.stop()
})

test('artifact changed after workflow verdict is rejected before registering or completing',async()=>{
 const {createHash}=await import('node:crypto');let path=''
 const {runner,store,host,root}=await setup({participants:[{agentId:'a'}]},{beforeComplete:async()=>{
  const expected=createHash('sha256').update(await readFile(path)).digest('hex')
  await writeFile(path,'changed after inspection')
  return {summary:'inspected old bytes',metadata:{},artifacts:[{path,sha256:expected}]}
 }})
 path=join(root,'report.txt');await writeFile(path,'verified original')
 const batch=await runner.fire('T','manual'),sid=[...host.sessions.keys()][0]
 await assert.rejects(host.callTool(sid,'task_complete',{summary:'ready',artifacts:[path]}),/artifact-capture-mismatch/)
 assert.equal(store.s.artifacts.size,0);assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
})

for (const operation of ['task_plan_round','task_finalize'] as const) {
 test(`${operation} cannot mutate a stopped runner after an async host hook`,async()=>{
  let release:()=>void=()=>{},entered:()=>void=()=>{}
  const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
  const hook=async()=>{entered();await waiting;return {summary:'host checked',metadata:{}}}
  const {runner,store,host}=await setup({graphMode:'dynamic-rounds'},operation==='task_plan_round'?{beforePlanRound:async()=>{await hook()}}:{beforeComplete:hook})
  const batch=await runner.fire('T','manual'),sid=[...host.sessions.keys()][0]
  const before=store.s.cards.size
  const pending=host.callTool(sid,operation,{summary:'checked'})
  await started;runner.stop();release()
  await assert.rejects(pending,/task-run-no-longer-active/)
  assert.equal(store.s.cards.size,before)
  assert.equal(store.s.batches.get(batch.id)?.settled,undefined)
  assert.equal(store.s.cards.get(batch.cardIds[0])?.status,'running')
 })
}

test('queued planRound rechecks run identity inside the expansion transaction',async()=>{
 const {runner,store,host}=await setup({graphMode:'dynamic-rounds'})
 await runner.fire('T','manual');const sid=[...host.sessions.keys()][0],before=store.s.cards.size
 const expand=store.expandRound.bind(store)
 store.expandRound=async(...args)=>{const pending=expand(...args);runner.stop();return pending}
 await assert.rejects(host.callTool(sid,'task_plan_round',{summary:'planned'}),/task-run-no-longer-active/)
 assert.equal(store.s.cards.size,before)
})

for(const lateAssistance of [false,true])test(`studio finalization preserves delivery with assistance (${lateAssistance?'late race':'preexisting'}) and never labels autonomous`,async()=>{
 const {runner,store,host,root}=await setup({graphMode:'dynamic-rounds',design:{evidenceContract:'studio-video-v1',failurePolicy:{maxAttempts:3}} as any},{registerStudioTools:async()=>()=>{},beforeComplete:input=>input.card.role==='planner'?{summary:'Machine quality check complete',metadata:{workflowOutcome:lateAssistance?'machine_assessed_candidate':'assisted_machine_assessed_candidate',qualityPassed:true}}:undefined})
 await writeFile(join(root,'film.txt'),'fixture delivered artifact')
 const batch=await runner.fire('T','manual'),ledger=new StudioInterventions(store)
 const next=()=>[...host.sessions.keys()].at(-1)!
 let sid=next();host.consumeFirst(sid);await host.callTool(sid,'task_plan_round',{summary:'production'});host.endTurn(sid);await tick()
 sid=next();host.consumeFirst(sid);await host.callTool(sid,'task_complete',{summary:'candidate',artifacts:['film.txt']});host.endTurn(sid);await tick()
 sid=next();host.consumeFirst(sid);await host.callTool(sid,'task_complete',{summary:'quality passed'});host.endTurn(sid);await tick()
 sid=next();host.consumeFirst(sid)
 const record=()=>ledger.record({id:'fixture-assistance',taskId:'T',batchId:batch.id,kind:'operator_repair',reason:'fixture external infrastructure repair'})
 if(!lateAssistance)record()
 await host.callTool(sid,'task_finalize',{summary:'not trusted',artifact:'film.txt'})
 if(lateAssistance)record()
 host.endTurn(sid);await tick()
 const run=[...store.s.runs.values()].at(-1)!
 assert.equal(run.metadata?.decision,'assisted');assert.equal(run.metadata?.workflowOutcome,'assisted_machine_assessed_candidate')
 assert.equal((run.metadata?.autonomy as any).status,'assisted');assert.equal((run.metadata?.autonomy as any).autonomousVerified,false)
 assert.equal(store.s.batches.get(batch.id)?.settled?.outcome,'done');assert.ok([...store.s.artifacts.values()].some(a=>a.final))
 assert.match(run.summary!,/人工协助/);runner.stop()
})

test('studio unblock rolls back kernel transition when intervention write fails',async()=>{
 const {runner,store}=await setup({participants:[{agentId:'a'}],design:{evidenceContract:'studio-video-v1'} as any},{beforeStart:()=>({kind:'capability',reason:'fixture'})})
 const batch=await runner.fire('T','manual'),cardId=batch.cardIds[0],sourceRunId=store.s.cards.get(cardId)!.runIds.at(-1)!
 new StudioInterventions(store).record({id:`unblock:${sourceRunId}`,taskId:'other',batchId:'other',kind:'conflict',reason:'fixture'})
 await assert.rejects(runner.unblockCard(cardId),/intervention-id-conflict/)
 assert.equal(store.s.cards.get(cardId)?.status,'blocked');assert.equal(store.kernel.getTask(cardId)?.status,'blocked')
 assert.equal(store.all().filter(e=>e.t==='card/ready'&&e.cardId===cardId).length,0);runner.stop()
})

const isolatedStudioDesign=()=>({workspaceMode:'studio-batch-v1',evidenceContract:'studio-video-v1',scope:'fixture video',branches:[{id:'prepare',when:'authorized',action:'prepare',evidence:'receipt'}],coordination:'three roles',failurePolicy:{isolateItems:true,maxAttempts:3,stopConditions:['missing permission']},acceptance:['actual evidence'],studio:{characterId:'fixture-character',referenceUrl:'https://cdn.vyibc.com/reference.mp4',referenceSha256:'a'.repeat(64),generationLimits:{imageCalls:0,imageBatches:0,voiceSegments:0},publish:false}} as any)

test('Studio batch fire freezes isolated durable paths, concurrent request IDs coalesce and paid preflight sees the owned directory',async()=>{
 const observed:string[]=[]
 const {runner,store,host,root}=await setup({graphMode:'dynamic-rounds',design:isolatedStudioDesign()},{registerStudioTools:async()=>()=>{},beforeStart:async input=>{assert.equal((await stat(input.task.cwd)).isDirectory(),true);assert.equal(JSON.parse(await readFile(join(input.task.cwd,'.studio-workspace.json'),'utf8')).batchId,input.batch.id);observed.push(input.task.cwd)}})
 const [first,replay]=await Promise.all([runner.fire('T','manual',{batchId:'b-isolated-first',dispatch:'background'}),runner.fire('T','manual',{batchId:'b-isolated-first',dispatch:'background'})])
 assert.equal(first.id,replay.id);assert.equal(store.s.batches.size,1)
 assert.equal(first.turn?.cwd,join(store.root,'studio-workspaces','T','batches',first.id))
 assert.equal(first.turn?.studioWorkspace?.mode,'studio-batch-v1');assert.equal(store.tasks.get('T')!.cwd,root)
 assert.equal(store.kernel.db.prepare('SELECT workspace_path FROM tasks WHERE id=?').get(first.cardIds[0]).workspace_path,first.turn!.cwd)
 await tick();assert.equal(host.sessions.size,1);assert.deepEqual(observed,[first.turn!.cwd])
 await store.expandRound(store.tasks.get('T')!,first,store.s.cards.get(first.cardIds[0])!,'Expand fixture production')
 assert.ok(store.kernel.db.prepare('SELECT workspace_path FROM tasks WHERE tenant=?').all(first.id).every((row:any)=>row.workspace_path===first.turn!.cwd))
 await writeFile(join(first.turn!.cwd!,'output.txt'),'first movie')
 const {TaskConsoleService}=await import('../src/service.ts')
 const reply=JSON.parse(await TaskConsoleService.prototype.fireTask.call({ctx:{get:()=>undefined},runner} as any,JSON.stringify({id:'T',requestId:'manual-workspace-0001'})))
 await tick();const second=store.s.batches.get(reply.batchId)!
 assert.notEqual(first.turn!.cwd,second.turn!.cwd);assert.equal(observed.length,2)
 await assert.rejects(stat(join(second.turn!.cwd!,'output.txt')),{code:'ENOENT'})
 assert.equal(await readFile(join(first.turn!.cwd!,'output.txt'),'utf8'),'first movie')
 await assert.rejects(runner.fire('T','manual',{batchId:'b-forged-workspace',turn:{objective:'x',participants:store.tasks.get('T')!.participants,cwd:root,studioWorkspace:first.turn!.studioWorkspace}}),/host-created-only/)
 await assert.rejects(runner.fire('T','manual',{batchId:'b-forged-path',turn:{objective:'x',participants:store.tasks.get('T')!.participants,cwd:'/invented'}}),/override-forbidden/)
 assert.equal(store.s.batches.size,2)
})

test('Studio suspended batch restores its frozen path after restart; later missing used directory blocks before paid work',async()=>{
 const {runner,store,host,root}=await setup({graphMode:'dynamic-rounds',maxTries:3,design:isolatedStudioDesign()},{registerStudioTools:async()=>()=>{}})
 const batch=await runner.fire('T','manual',{batchId:'b-workspace-restart',dispatch:'background'});runner.stop()
 assert.equal(host.sessions.size,0);await assert.rejects(stat(batch.turn!.cwd!),{code:'ENOENT'})
 store.kernel.db.close()
 const restored=new EventStore(join(root,'store')),newHost=fakeHost(join(root,'presets'));let probes=0
 const resumed=new TaskRunner(newHost.ctx,restored,{registerStudioTools:async()=>()=>{},beforeStart:async()=>{probes++}})
 try{
  await resumed.start();assert.equal(newHost.sessions.size,1);assert.equal(probes,1)
  assert.equal(restored.s.batches.get(batch.id)!.turn!.cwd,batch.turn!.cwd)
  await writeFile(join(batch.turn!.cwd!,'retained.txt'),'retained')
  const sid=[...newHost.sessions.keys()][0];newHost.consumeFirst(sid)
  newHost.emit(sid,{type:'turn/end',data:{reason:{kind:'error',error:{code:'FIXTURE',message:'retry fixture'}}}});await tick()
  await resumed.tick();assert.equal(await readFile(join(batch.turn!.cwd!,'retained.txt'),'utf8'),'retained')
  assert.equal(probes,2);assert.equal(restored.kernel.listRuns(batch.cardIds[0]).length,2)
  await rm(batch.turn!.cwd!,{recursive:true})
  const sid2=[...newHost.sessions.keys()].at(-1)!;newHost.consumeFirst(sid2)
  newHost.emit(sid2,{type:'turn/end',data:{reason:{kind:'error',error:{code:'FIXTURE',message:'another retry'}}}});await tick()
  await resumed.tick()
  assert.equal(probes,2);assert.equal(newHost.sessions.size,2)
  await assert.rejects(stat(batch.turn!.cwd!),{code:'ENOENT'})
  assert.equal(restored.kernel.getTask(batch.cardIds[0])!.status,'blocked')
  assert.match(restored.s.cards.get(batch.cardIds[0])!.lastBlockReason??'',/studio-workspace/)
 }finally{resumed.stop();restored.kernel.db.close()}
})

test('Studio initial directory conflict blocks before host probes without adopting foreign files',async()=>{
 let probes=0
 const {runner,store,host}=await setup({graphMode:'dynamic-rounds',design:isolatedStudioDesign()},{registerStudioTools:async()=>()=>{},beforeStart:async()=>{probes++}})
 const batch=await runner.fire('T','manual',{batchId:'b-workspace-conflict',dispatch:'background'});runner.stop()
 await mkdir(batch.turn!.cwd!,{recursive:true});await writeFile(join(batch.turn!.cwd!,'foreign.txt'),'do not overwrite')
 // start() reloads the durable batch, just like a restart before its first dispatch.
 await runner.start()
 assert.equal(probes,0);assert.equal(host.sessions.size,0);assert.equal(await readFile(join(batch.turn!.cwd!,'foreign.txt'),'utf8'),'do not overwrite')
 assert.match(store.s.cards.get(batch.cardIds[0])!.error??'',/studio-workspace/)
})

test('Creator approval and Actions share runner batch allocation while legacy Studio cwd remains unchanged',async()=>{
 const {runner,store,root}=await setup({graphMode:'dynamic-rounds',design:isolatedStudioDesign()},{registerStudioTools:async()=>()=>{}})
 const creator=new TaskCreator(runner,async()=>['a','b','c'].map(id=>({id,name:id} as any)))
 const proposal={decision:'create' as const,reason:'isolated fixture',title:'Isolated Studio',brief:'Produce fixture',graphMode:'dynamic-rounds' as const,participants:['a','b','c'].map(agentId=>({agentId})),design:isolatedStudioDesign(),actions:[{id:'produce',name:'Produce',template:'Produce {{topic}}',parameters:[{key:'topic',label:'Topic',type:'text' as const,required:true}]}]}
 const plan=await creator.prepare(proposal,{agent:{session:{id:'workspace-creator',deriveMessages:()=>[{role:'user',content:'Create a fixture'}]}}},root)
 const approved=await creator.review(plan.id,plan.hash,'approve','Fixture approval');await tick()
 const first=store.s.batches.get(approved.batchId!)!,actions=creator.actions.read(approved.taskId!)
 const action=await creator.launchAction({taskId:approved.taskId!,actionId:'produce',revision:actions.revision,values:{topic:'next'},requestId:'workspace-action-12345',cwd:root})
 const next=store.s.batches.get(action.batchId)!
 assert.notEqual(first.turn!.cwd,next.turn!.cwd);assert.ok(first.turn!.studioWorkspace);assert.ok(next.turn!.studioWorkspace)
 const legacy=await setup({graphMode:'dynamic-rounds',design:{...isolatedStudioDesign(),workspaceMode:undefined}},{registerStudioTools:async()=>()=>{}})
 const old=await legacy.runner.fire('T','manual')
 assert.equal(old.turn?.studioWorkspace,undefined);assert.equal(legacy.store.tasks.get('T')!.cwd,legacy.root)
 assert.equal(legacy.store.kernel.db.prepare('SELECT workspace_path FROM tasks WHERE id=?').get(old.cardIds[0]).workspace_path,legacy.root)
})

test('Studio scheduler freezes its occurrence path and keeps the existing no-overlap lease',async()=>{
 let now=Date.parse('2026-01-01T00:00:00Z')
 const {runner,store}=await setup({graphMode:'dynamic-rounds',design:isolatedStudioDesign(),trigger:{kind:'cron',expr:'* * * * *'}},{now:()=>now,registerStudioTools:async()=>()=>{}})
 runner.schedule.sync(store.tasks.get('T')!,now);now+=60_000;await runner.tick()
 const [batch]=[...store.s.batches.values()];assert.ok(batch);assert.equal(batch.by,'cron');assert.equal(batch.turn!.studioWorkspace!.batchId,batch.id)
 assert.equal(batch.turn!.cwd,join(store.root,'studio-workspaces','T','batches',batch.id))
 now+=60_000;await runner.tick();assert.equal(store.s.batches.size,1)
})

test('Studio workspace mutation during host preflight blocks session creation and keeps allocation evidence',async()=>{
 const {runner,store,host}=await setup({graphMode:'dynamic-rounds',design:isolatedStudioDesign()},{registerStudioTools:async()=>()=>{},beforeStart:async input=>{await rm(input.task.cwd,{recursive:true})}})
 const batch=await runner.fire('T','manual',{batchId:'b-preflight-workspace-drift'})
 assert.equal(host.sessions.size,0);assert.equal(store.kernel.getTask(batch.cardIds[0]).status,'blocked')
 assert.ok(store.kernel.listEvents(batch.cardIds[0]).some(e=>e.kind==='studio_workspace_ready'))
 assert.match(store.s.cards.get(batch.cardIds[0])!.lastBlockReason??'',/studio-workspace/)
 await assert.rejects(stat(batch.turn!.cwd!),{code:'ENOENT'})
})
