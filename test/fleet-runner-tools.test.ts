import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, runnerIp, inject } from '../src/fleet-runner-tools.ts'

test('Runner plugin declares the Cordis tools dependency before mounting', () => {
  assert.deepEqual(inject, ['tools'])
})

test('Runner reviewer gets no deployment or cancellation capability', async () => {
  const tools = new Map<string, any>()
  const ctx = { tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }, effect: () => undefined }
  await apply(ctx, { readOnly: true })
  assert.deepEqual([...tools.keys()], ['fleet_runner_inspect','fleet_runner_status'])
  const inspect=tools.get('fleet_runner_inspect')
  await assert.rejects(inspect.execute({ip:'203.0.113.10',command:'touch /tmp/bad'},{}),/只允许 ip/)
  const result=await inspect.execute({ip:'203.0.113.10'}, {})
  assert.equal(result.phase,'blocked')
  assert.match(result.reason,/identity/)
})
test('Runner tool rejects malformed input before spawning anything', () => {
  for (const ip of ['256.1.1.1','1.2.3.4 && true','1.2.3','01.2.3.4']) assert.throws(()=>runnerIp(ip))
})
