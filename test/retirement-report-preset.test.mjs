import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('retirement report includes deferred observations without authorizing extra operations', () => {
  const spec=JSON.parse(readFileSync(new URL('../presets/fleet-node-retirer/task-console.json',import.meta.url),'utf8'))
  for(const text of ['每轮仅调用一次','deferred 不是候选','同时完整报告','在线/不可达/未知','不猜 IP','fresh=false','不新增查询','不直接发送企微']) assert.ok(spec.persona.includes(text),text)
  for(const text of ['summary 本身必须是完整中文报告','逐台明细必须写入该字符串','每台单独一行']) assert.ok(spec.persona.includes(text),text)
  assert.ok(spec.persona.includes('禁止心算或编造格式化日期'))
  assert.ok(spec.persona.includes('lastObservedAt 原始 Unix 毫秒'))
  assert.deepEqual(spec.tools,[])
  assert.deepEqual(spec.skills,[])
  assert.deepEqual(spec.mcpTools['vyibc-fleet'],['vyibc-fleet_status','vyibc-fleet_retirement_candidates','vyibc-fleet_retirement_status','vyibc-fleet_retire_due_node','vyibc-fleet_node_audit'])
})
