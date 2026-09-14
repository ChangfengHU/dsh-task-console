import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateActions, renderAction } from '../src/agent-actions.ts'
import { makeActionSnippet, reconcileSnippet, trackSnippetEdit, snippetValues, snippetError, snippetProgress, restoreSnippet, resolveSnippetDefaults } from '../src/action-snippet.ts'
import { optionPage, sourceTool } from '../src/action-options.ts'
import { fleetActionOptions } from '../src/fleet-action-options.ts'

const seed = JSON.parse(await readFile(new URL('../presets/browser-manager-actions.json', import.meta.url), 'utf8'))
const action = validateActions(seed.actions)[0]
function edit(state: ReturnType<typeof makeActionSnippet>, key: string, value: string) {
  const i = state.slots.findIndex(s => s.key === key), slot = state.slots[i]
  const text = state.text.slice(0, slot.start) + value + state.text.slice(slot.end)
  return reconcileSnippet(trackSnippetEdit(state.slots, state.text, text, i), text, snippetValues(state.slots, state.text))
}
test('config persists defaults, enum, source and bounded dependencies without expressions', () => {
  assert.equal(action.parameters[1].integer, true)
  assert.equal(action.parameters[3].source, 'fleet.gemini-accounts')
  const bad = (i: number, patch: any) => [{ ...action, parameters: action.parameters.map((p,j) => j === i ? {...p, ...patch} : p) }]
  for (const patch of [{ source: 'http://arbitrary' }, { source: 'fleet.nodes', choices: ['x'] }, { dependsOn: ['account'] }, { visibleWhen: { key: 'ip', equals: {} } }, { default: 'secret' }]) assert.throws(() => validateActions(bad(3, patch)))
  assert.throws(() => validateActions(bad(1, { default: 0 })), /最小/)
  assert.throws(() => validateActions(bad(1, { default: 1.5 })), /整数/)
  assert.throws(() => validateActions(bad(2, { default: 'unknown' })), /选项/)
  assert.throws(() => validateActions(bad(1, { acceptDefaultOnEnter: 'yes' })), /开关/)
})
test('defaults are explicit opt-in; count validates positive integers; conditional account not asked in automatic mode', () => {
  let state = makeActionSnippet(action, '@新增浏览器 ')
  assert.ok(!state.text.includes('【指定账号来源】'))
  assert.equal(state.slots[3].inactive, true)
  state = edit(state, 'ip', '192.0.2.1')
  for (const value of ['0', '-1', '1.3']) { const bad = edit(state, 'count', value); assert.match(snippetError(bad.slots[1], bad.text)!, /最小|整数/) }
  const strict = { ...action, parameters: action.parameters.map(p => p.key === 'count' ? {...p,acceptDefaultOnEnter:false} : p) }
  const required = makeActionSnippet(strict)
  assert.match(snippetError(required.slots[1], required.text)!, /请填写/)
  assert.ok(resolveSnippetDefaults(strict, required.text).includes('【新增数量】'))
  const rendered = renderAction(action, { ip:'192.0.2.1' })
  assert.match(rendered, /新增 1 个/); assert.match(rendered, /按账号分配策略/); assert.match(rendered, /无需指定/)
})
test('explicit mode reveals account; IP/mode edits invalidate it; reload preserves ranges without storing values', () => {
  let state = edit(makeActionSnippet(action), 'ip', '192.0.2.1')
  state = edit(state, 'login_mode', '指定账号')
  assert.ok(state.text.includes('【指定账号来源】')); assert.equal(state.slots[3].inactive, false)
  state = edit(state, 'account', 'alice@example.test · 192.0.2.2 / browser-2 · #aaaaaaaa')
  const saved = snippetProgress(state.text,state.slots,3,true)
  assert.doesNotMatch(JSON.stringify(saved), /alice|192\.0/)
  const recovered = restoreSnippet(action, '',state.text,saved)
  assert.equal(recovered.slots[3].inactive, undefined)
  assert.equal(state.text.slice(recovered.slots[3].start,recovered.slots[3].end),'alice@example.test · 192.0.2.2 / browser-2 · #aaaaaaaa')
  state = edit(state, 'ip', '192.0.2.3')
  assert.ok(state.text.includes('【指定账号来源】')); assert.doesNotMatch(state.text,/alice/)
  state = edit(state, 'login_mode', '按账号分配策略')
  assert.equal(state.slots[3].inactive,true); assert.ok(!state.text.includes('【指定账号来源】'))
  state = edit(state, 'login_mode', '指定账号')
  assert.ok(state.text.includes('【指定账号来源】'))
})
test('candidate pagination and search have stable bounds, plain data and allowlisted source names', () => {
  const items = Array.from({length:45},(_,i)=>({value:String(i),label:`node-${i}`,detail:'machine'}))
  assert.equal(optionPage(items,'',2).items[0].value,'20')
  assert.equal(optionPage(items,'',3).items.length,5)
  assert.equal(optionPage(items,'machine',1).pages,3)
  assert.equal(optionPage(items,'node-44',1).total,1)
  assert.throws(()=>optionPage(items,'',0)); assert.throws(()=>optionPage(items,'x'.repeat(501)))
  assert.throws(()=>sourceTool({...action.parameters[0],source:'exec' as any}))
})
test('Fleet adapter only reads metadata; reuses policy/ranker, excludes denied accounts; stale evidence is labelled intent', async () => {
  const calls:any[]=[]; let args:any
  const modules:any = {
    transport:{request:async(...a:any[])=>{calls.push(a);return {ok:true,pages:1,rows:[{identity:'metadata'}]}}},
    runtime:{policy:async()=>({nodes:{'192.0.2.1':{read:true}}})},
    login:{rankLoginSources:(accounts:any,policy:any,target:any)=>{
      assert.equal(accounts.length,1);assert.equal(policy.nodes['192.0.2.1'].read,true);args=target
      return [
        {authorized:true,label:'a@example.test',sourceIp:'192.0.2.2',sourceInstance:1,fingerprint:'aaaaaaaa',eligible:true,reasons:[]},
        {authorized:true,label:'b@example.test',sourceIp:'192.0.2.2',sourceInstance:2,fingerprint:'bbbbbbbb',eligible:false,reasons:['source-not-currently-verified']},
        {authorized:true,label:'excluded@example.test',sourceIp:'192.0.2.2',sourceInstance:3,reasons:['account-excluded']},
        {authorized:false,label:'denied@example.test',sourceIp:'192.0.2.2',sourceInstance:4,reasons:['source-not-authorized']},
        {authorized:true,label:'busy@example.test',sourceIp:'192.0.2.2',sourceInstance:5,eligible:false,reasons:['source-busy']},
      ]
    }},
    inventory:{browserInventory:()=>({nodes:[{ip:'192.0.2.1',nodeId:'target',readAuthorized:true,reachable:true,browsers:[]},{ip:'192.0.2.2',readAuthorized:false,browsers:[]}]})},
  }
  const cfg={args:['/trusted/browser-manager/server.mjs']},load=async(n:string)=>modules[n]
  const nodes=await fleetActionOptions(cfg,action.parameters[0],{},load)
  assert.equal(nodes.items.length,1)
  const result=await fleetActionOptions(cfg,action.parameters[3],{ip:'192.0.2.1'},load)
  assert.equal(result.items.length,3);assert.equal(result.items[0].disabled,false)
  assert.match(result.items[1].detail!,/待执行前复验/);assert.equal(result.items[1].disabled,false)
  assert.equal(result.items[2].disabled,true)
  assert.deepEqual(args,{ip:'192.0.2.1'},'No invented target browser instance')
  assert.ok(calls.every(c=>c[1]===null && !c[0].includes('refresh') && !c[0].includes('copy')))
  await assert.rejects(fleetActionOptions(cfg,action.parameters[3],{ip:'192.0.2.9'},load),/尚无/)
  await assert.rejects(fleetActionOptions({args:['relative/server.mjs']},action.parameters[0],{},load),/适配器/)
  modules.runtime.policy=async()=>({scope:'registered-fleet',nodes:{'192.0.2.1':{read:true}}})
  assert.match((await fleetActionOptions(cfg,action.parameters[0],{},load)).notice,/无需逐机授权/)
  await assert.rejects(fleetActionOptions(cfg,action.parameters[3],{ip:'192.0.2.9'},load),/未在启用的 Fleet 名册/)
})
test('Vault account Actions deduplicate by stored ID and work without a live source browser', async () => {
  const candidate = { kind:'vault', accountId:'gemini_aaaaaaaa', version:7, fingerprint:'aaaaaaaa', label:'owner@example.test', authorized:true, eligible:true, reasons:[], currentHolders:0 }
  const calls: any[] = []
  const modules: any = {
    runtime: {policy:async()=>({nodes:{'192.0.2.1':{read:true}}})},
    transport: {request:async(...args:any[])=>{calls.push(args);return {ok:true,pages:1,contract:'login-vault-v2',deliveryEnabled:true,rows:[{credential:{accountId:candidate.accountId},holders:[]}]}}},
    login: {rankLoginSources:()=>[candidate,candidate,{...candidate,kind:'live',sourceIp:'192.0.2.2',sourceInstance:1},{...candidate,accountId:'gemini_bbbbbbbb',reasons:['account-excluded']}]},
  }
  const result=await fleetActionOptions({args:['/trusted/browser-manager/server.mjs']},action.parameters[3],{ip:'192.0.2.1'},async n=>modules[n])
  assert.equal(result.items.length,1);assert.equal(result.items[0].disabled,false)
  assert.match(result.items[0].value,/accountId=gemini_aaaaaaaa/)
  assert.match(result.items[0].detail!,/金库 v7/);assert.match(result.items[0].detail!,/无在线来源/)
  assert.ok(calls.every(c=>c[1]===null&&!c[0].includes('refresh')))
})
