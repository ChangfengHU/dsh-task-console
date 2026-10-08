import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskConsoleService } from '../src/service.ts'

test('Task submission resolves a manually typed account on the host before freezing intent', async () => {
  const account = {label:'owner@example.test',value:'owner@example.test · accountId=gemini_aaaaaaaa · #aaaaaaaa'}
  let queries = 0, launched: any
  const service: any = {
    ready: Promise.resolve(),
    creator: {
      actions: {read: () => ({revision:'r1', actions:[{id:'install',parameters:[{key:'account',source:'fleet.gemini-accounts',visibleWhen:{key:'mode',equals:'explicit'}}]}]})},
      launchAction: async (q: any, normalize: any) => { launched = await normalize(q); return {ok:true} },
    },
    agentActionOptions: async (input: string) => { queries++; assert.equal(JSON.parse(input).parameter,'account'); return JSON.stringify({items:[account],pages:1}) },
  }
  const input = {taskId:'task',actionId:'install',revision:'r1',values:{ip:'192.0.2.1',mode:'explicit',account:account.label}}
  const launch = (q: any) => TaskConsoleService.prototype.launchTaskAction.call(service,JSON.stringify(q))
  await launch(input)
  assert.equal(launched.values.account,account.value)
  assert.equal(input.values.account,account.label)
  await assert.rejects(launch({...input,values:{...input.values,account:'【金库账号】'}}),/请填写/)
  await assert.rejects(launch({...input,revision:'old'}),/已更新/)
  assert.equal(queries,1)
  await launch({...input,values:{mode:'automatic'}})
  assert.equal(queries,1,'automatic mode has no forced account lookup')
  service.agentActionOptions = async () => JSON.stringify({items:[{...account,disabled:true}],pages:1})
  await assert.rejects(launch(input),/不可用/)
})
