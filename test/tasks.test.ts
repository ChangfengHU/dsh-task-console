import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cronHuman, cronMatches, nextFire, parseCron } from '../src/cron.ts'
import { fold, legMessage, runStatus, validateTask, type Event, type Run, type TaskSpec } from '../src/tasks.ts'

test('cron parses the common shapes and rejects junk', () => {
  assert.ok(parseCron('*/10 * * * *'))
  assert.ok(parseCron('0 3 * * *'))
  assert.ok(parseCron('0 9 * * 1-5'))
  assert.equal(parseCron('* * * *'), null)
  assert.equal(parseCron('61 * * * *'), null)
  const c = parseCron('*/10 * * * *')!
  assert.equal(cronMatches(c, new Date(2026, 7, 30, 3, 10)), true)
  assert.equal(cronMatches(c, new Date(2026, 7, 30, 3, 11)), false)
  const n = nextFire(parseCron('0 3 * * *')!, new Date(2026, 7, 30, 12, 0))!
  assert.equal(n.getDate(), 31); assert.equal(n.getHours(), 3)
  assert.equal(cronHuman('*/10 * * * *'), '每 10 分钟')
  assert.equal(cronHuman('0 9 * * 1-5'), '工作日 09:00')
  assert.equal(cronHuman('0 3 * * *'), '每天 03:00')
})

const task: TaskSpec = { id: 'T-1', title: '接机', brief: '装 clash + VNC', trigger: { kind: 'once' }, participants: [{ agentId: 'installer' }, { agentId: 'inspector', brief: '验一遍' }], cwd: '/tmp', timeoutSec: 600, onFail: 'retry', maxTries: 2, enabled: true, createdAt: 'x' }

test('fold replays a run through blocked, done, and settled', () => {
  const ev: Event[] = [
    { t: 'task/created', at: '1', task },
    { t: 'run/fired', at: '2', run: { id: 'r-1', taskId: 'T-1', by: 'manual', legs: ['installer', 'inspector'] } },
    { t: 'leg/spawned', at: '3', runId: 'r-1', leg: 0, sessionId: 's-1', tries: 1 },
    { t: 'leg/blocked', at: '4', runId: 'r-1', leg: 0, question: '改 5901?' },
  ]
  let s = fold(ev)
  let r = s.runs.get('r-1')!
  assert.equal(runStatus(r), 'park'); assert.equal(r.legs[0].question, '改 5901?')
  ev.push({ t: 'leg/resumed', at: '5', runId: 'r-1', leg: 0 }, { t: 'leg/done', at: '6', runId: 'r-1', leg: 0, handoff: '产物:x' }, { t: 'leg/spawned', at: '7', runId: 'r-1', leg: 1, sessionId: 's-2', tries: 1 })
  s = fold(ev); r = s.runs.get('r-1')!
  assert.equal(runStatus(r), 'run'); assert.equal(r.legs[0].status, 'done'); assert.equal(r.legs[1].sessionId, 's-2')
  ev.push({ t: 'leg/timed_out', at: '8', runId: 'r-1', leg: 1, error: 'slow' }, { t: 'leg/spawned', at: '9', runId: 'r-1', leg: 1, sessionId: 's-3', tries: 2 }, { t: 'leg/done', at: '10', runId: 'r-1', leg: 1, handoff: 'ok' }, { t: 'run/settled', at: '11', runId: 'r-1', outcome: 'done' })
  s = fold(ev); r = s.runs.get('r-1')!
  assert.equal(runStatus(r), 'done'); assert.equal(r.legs[1].tries, 2); assert.equal(r.legs[1].error, undefined)
  ev.push({ t: 'task/deleted', at: '12', taskId: 'T-1' })
  s = fold(ev); assert.equal(s.tasks.size, 0); assert.equal(s.runs.size, 0)
})

test('legMessage carries only the brief, the part, and the upstream handoff', () => {
  const run: Run = { id: 'r-9', taskId: 'T-1', firedAt: 'x', by: 'manual', legs: [{ agentId: 'installer', status: 'done', tries: 1, handoff: '产物:/etc/clash' }, { agentId: 'inspector', status: 'queued', tries: 0 }] }
  const m = legMessage(task, run, 1, { agentName: '装机员', handoff: run.legs[0].handoff! })
  assert.match(m, /^# 任务:接机 · r-9 · 第 2\/2 段/)
  assert.match(m, /\[TASK\]\n装 clash \+ VNC/)
  assert.match(m, /\[YOUR PART\]\n验一遍/)
  assert.match(m, /\[UPSTREAM HANDOFF from 装机员\]\n产物:\/etc\/clash/)
  assert.doesNotMatch(legMessage(task, run, 0), /UPSTREAM/)
})

test('validateTask fills defaults and rejects unknown agents', () => {
  const ids = new Set(['installer'])
  assert.throws(() => validateTask({ brief: '短' }, ids), /任务书/)
  assert.throws(() => validateTask({ brief: '装 clash 并注册', participants: [{ agentId: 'ghost' }] }, ids), /没有这个 Agent/)
  assert.throws(() => validateTask({ brief: '装 clash 并注册', participants: [{ agentId: 'installer' }], trigger: { kind: 'cron', expr: 'nope' } }, ids), /cron/)
  const t = validateTask({ brief: '给 84.8.217.46 装 clash,注册进控制面', participants: [{ agentId: 'installer' }], onFail: 'retry', maxTries: 9 }, ids)
  assert.equal(t.title, '给 84.8.217.46 装 clash'); assert.equal(t.maxTries, 5); assert.equal(t.timeoutSec, 1800); assert.equal(t.trigger.kind, 'once')
})
