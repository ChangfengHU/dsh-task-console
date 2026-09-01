import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cronHuman, cronMatches, nextFire, parseCron } from '../src/cron.ts'
import { EventStore, cardMessage, validateTask, type Card, type TaskSpec } from '../src/tasks.ts'

test('cron parses the common shapes and rejects junk', () => {
  assert.ok(parseCron('*/10 * * * *')); assert.ok(parseCron('0 3 * * *')); assert.ok(parseCron('0 9 * * 1-5'))
  assert.equal(parseCron('* * * *'), null); assert.equal(parseCron('61 * * * *'), null)
  const c = parseCron('*/10 * * * *')!
  assert.equal(cronMatches(c, new Date(2026, 7, 30, 3, 10)), true); assert.equal(cronMatches(c, new Date(2026, 7, 30, 3, 11)), false)
  const n = nextFire(parseCron('0 3 * * *')!, new Date(2026, 7, 30, 12, 0))!; assert.equal(n.getDate(), 31); assert.equal(n.getHours(), 3)
  assert.equal(cronHuman('*/10 * * * *'), '每 10 分钟'); assert.equal(cronHuman('0 9 * * 1-5'), '工作日 09:00'); assert.equal(cronHuman('0 3 * * *'), '每天 03:00')
})

const task: TaskSpec = { id: 'T-1', title: '接机', brief: '装 clash + VNC', trigger: { kind: 'once' }, participants: [{ agentId: 'installer' }, { agentId: 'inspector', brief: '验一遍' }], cwd: '/tmp', timeoutSec: 600, onFail: 'retry', maxTries: 2, enabled: true, createdAt: 'x' }

test('cardMessage carries the brief, the part, upstream summaries, and the contract', () => {
  const card: Card = { id: 'b#1', batchId: 'b', taskId: 'T-1', index: 1, agentId: 'inspector', brief: '验一遍', deps: ['b#0'], status: 'ready', runIds: [], consecutiveFailures: 0, blockRecurrences: 0 }
  const m = cardMessage(task, card, 'b', [{ agentName: '装机员', summary: '产物:/etc/clash' }])
  assert.match(m, /^# 任务:接机 · b · 第 2\/2 张卡/)
  assert.match(m, /\[TASK\]\n装 clash \+ VNC/); assert.match(m, /\[YOUR PART\]\n验一遍/)
  assert.match(m, /\[UPSTREAM HANDOFF from 装机员\]\n产物:\/etc\/clash/)
  assert.match(m, /\[CONTRACT\]/); assert.match(m, /task_complete\(summary, artifacts, metadata\)/); assert.match(m, /task_block\(reason, kind="needs_input"\)/)
  assert.match(m, /保存不可变副本/); assert.match(m, /验收通过前不会启动下游/)
  assert.doesNotMatch(cardMessage(task, { ...card, index: 0, deps: [], brief: undefined }, 'b', []), /UPSTREAM|YOUR PART/)
})

test('validateTask fills defaults and rejects unknown agents', () => {
  const ids = new Set(['installer'])
  assert.throws(() => validateTask({ brief: '短' }, ids), /任务书/)
  assert.throws(() => validateTask({ brief: '装 clash 并注册', participants: [{ agentId: 'ghost' }] }, ids), /没有这个 Agent/)
  assert.throws(() => validateTask({ brief: '装 clash 并注册', participants: [{ agentId: 'installer' }], trigger: { kind: 'cron', expr: 'nope' } }, ids), /cron/)
  const t = validateTask({ brief: '给 84.8.217.46 装 clash,注册进控制面', participants: [{ agentId: 'installer' }], onFail: 'retry', maxTries: 9 }, ids)
  assert.equal(t.title, '给 84.8.217.46 装 clash'); assert.equal(t.maxTries, 5); assert.equal(t.timeoutSec, 1800); assert.equal(t.trigger.kind, 'once')
})

test('EventStore imports old JSONL into SQLite once and appends there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-store-'))
  const old = [
    { t: 'task/created', at: '1', task },
    { t: 'run/fired', at: '2', run: { id: 'r-9', taskId: 'T-1', by: 'manual', legs: ['installer', 'inspector'] } },
    { t: 'leg/spawned', at: '3', runId: 'r-9', leg: 0, sessionId: 's-1', tries: 1 },
    { t: 'leg/done', at: '6', runId: 'r-9', leg: 0, handoff: '产物:x' },
  ]
  await writeFile(join(dir, 'events.jsonl'), old.map(e => JSON.stringify(e)).join('\n') + '\n')
  const store = new EventStore(dir)
  await store.load()
  assert.equal(store.s.batches.get('r-9')!.cardIds.length, 2); assert.equal(store.s.cards.get('r-9#0')!.status, 'done')
  await store.append({ t: 'card/ready', at: '7', taskId: 'T-1', cardId: 'r-9#1' })
  assert.equal(store.s.cards.get('r-9#1')!.status, 'ready')
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 4); assert.match(lines[0], /leg|task/)   // old log stays untouched
  assert.equal((await readFile(join(dir, 'task.db'))).subarray(0, 16).toString(), 'SQLite format 3\u0000')
  const reloaded = new EventStore(dir); await reloaded.load()
  assert.equal(reloaded.all().length, 5); assert.equal(reloaded.s.cards.get('r-9#1')!.status, 'ready')
})
