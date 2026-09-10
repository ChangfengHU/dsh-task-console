import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { validateSpec } from '../src/presets.ts'

test('notifier ships only the independent WeCom capability; creator delegates it',async()=>{
  const spec=validateSpec(JSON.parse(await readFile(new URL('../presets/wecom-notifier/task-console.json',import.meta.url),'utf8')))
  assert.deepEqual(spec.tools,[]);assert.deepEqual(spec.skills,[])
  assert.deepEqual(spec.mcpTools,{'vyibc-wecom':['vyibc-wecom_list_groups','vyibc-wecom_status','vyibc-wecom_send_message']})
  assert.match(spec.persona,/unknown 不得重发/)
  const creator=JSON.parse(await readFile(new URL('../presets/task-create-agent/task-console.json',import.meta.url),'utf8'))
  assert.match(creator.persona,/design.notifications.agentId/)
})

test('creator ships reusable onboarding/login rules but no business execution grants', async () => {
  const spec = validateSpec(JSON.parse(await readFile(new URL('../presets/task-create-agent/task-console.json', import.meta.url), 'utf8')))
  assert.deepEqual(spec.tools, ['ask-user', 'task-create-runtime'])
  assert.deepEqual(spec.mcpTools, { 'vyibc-wecom': ['vyibc-wecom_list_groups'] })
  assert.match(spec.persona, /只有一个/)
  assert.match(spec.persona, /先手动/)
  assert.match(spec.persona, /没有新建浏览器也执行登录验收/)
  assert.match(spec.persona, /browser_login_provision/)
  assert.match(spec.persona, /仅要求只读验收或保持登录时不得自动复制/)
  assert.match(spec.persona, /不承诺其他平台/)
  assert.doesNotMatch(spec.persona, /152\.70\.155\.63/)
})
