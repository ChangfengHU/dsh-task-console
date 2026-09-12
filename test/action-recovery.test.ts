import test from 'node:test'
import assert from 'node:assert/strict'
import { agentMentionSource } from '../src/client/agent-mentions.ts'
import { makeActionSnippet, snippetProgress } from '../src/action-snippet.ts'
import { validateActions } from '../src/agent-actions.ts'
import { installActionSnippet } from '../src/client/action-snippet.ts'

test('draft hydration and edits supersede pending recovery without dropping the latest revision', async t => {
  const names = ['window', 'document', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame'] as const
  const globals = new Map(names.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const storage = new Map<string, string>(), cleanups: (() => void)[] = []
  const document = new EventTarget() as any; document.querySelectorAll = () => []
  const install = (k: string, value: any) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value })
  install('window', new EventTarget()); install('document', document)
  install('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  install('requestAnimationFrame', () => 1); install('cancelAnimationFrame', () => {})
  t.after(() => { cleanups.forEach(f => f()); for (const [k, d] of globals) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k] } })
  const action = validateActions([{ id: 'echo', name: '回声', description: '', template: '{{ip}} {{count}}', parameters: [
    { key: 'ip', label: 'IP', type: 'text', required: true }, { key: 'count', label: '数量', type: 'number', required: true },
  ] }])[0]
  const native = { current: 's', byId: { s: { agentPreset: 'browser', blank: false } } }
  let state = { draft: '', draftRev: 0, phase: 'plain' }, calls = 0
  const listeners = new Set<() => void>(), claims: any[] = []
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const f of listeners) f() }
  const input = { state: { getSnapshot: () => state, subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } } }, notify: () => {}, setDraft: (draft: string) => publish({ draft, draftRev: state.draftRev + 1 }) }
  const scope: any = { bail: (_scope: any, _event: string, request: any) => { claims.push(request); publish({ phase: 'claimed', draftRev: state.draftRev + 1 }); return true } }
  const ctx: any = {
    get: () => ({ input: { for: () => input } }), effect: (fn: () => () => void) => cleanups.push(fn()),
    sessions: { list: { getSnapshot: () => native, subscribe: () => () => {} }, scope: () => scope },
  }
  let release!: () => void
  const pending = new Promise<void>(r => { release = r })
  const api: any = {
    agents: async () => [{ id: 'browser', name: 'Browser', actionCount: 1 }], workflowCatalog: async () => [],
    agentActions: async () => { if (++calls === 1) await pending; return { agentId: 'browser', name: 'Browser', actions: [action], revision: 'r1' } },
  }
  const source = agentMentionSource(ctx, async () => api, () => {})
  const tick = () => new Promise(r => setTimeout(r, 0))
  source.warm({ sessionId: 's' }); await tick()
  assert.equal(calls, 0, 'An empty shell before native hydration must not start a lookup')
  const original = makeActionSnippet(action, '@回声 ').text
  input.setDraft(original); await tick(); assert.equal(calls, 1)
  input.setDraft(original.replace('【IP】', '192.0.2.1')); await tick()
  release(); await tick(); await tick()
  assert.equal(calls, 2, 'The revision that arrived during the old lookup needs a new recovery')
  assert.equal(claims.length, 1); assert.equal(claims[0].span.draftRev, 2)
  assert.equal(state.phase, 'claimed'); assert.equal(state.draft, '@回声 192.0.2.1 【数量】')
  assert.ok(!storage.get('dtc:action-draft:s')?.includes('192.0.2.1'), 'Recovery metadata copied prompt values')
})

test('placeholder focus waits for the native matching DOM revision and cancels stale focus on typing', t => {
  const names = ['window','document','requestAnimationFrame','cancelAnimationFrame'] as const
  const saved = new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]))
  let nextFrame=0
  const frames=new Map<number,FrameRequestCallback>()
  const frame=()=>{const callbacks=[...frames.values()];frames.clear();for(const f of callbacks)f(0)}
  const set=(k:string,v:any)=>Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v})
  const doc=new EventTarget() as any
  const action=validateActions([{id:'simple',name:'Simple',template:'{{ip}} {{count}}',parameters:[{key:'ip',label:'IP',type:'text',required:true},{key:'count',label:'Count',type:'number',required:true,default:1}]}])[0]
  let state={draft:makeActionSnippet(action,'@Simple ').text},selected:any[]=[]
  const el={disabled:false,value:'old render',getClientRects:()=>[{}],focus:()=>{},setSelectionRange:(...v:any[])=>selected.push(v)}
  doc.querySelectorAll=()=>[el]
  set('document',doc);set('window',new EventTarget())
  set('requestAnimationFrame',(f:FrameRequestCallback)=>{frames.set(++nextFrame,f);return nextFrame})
  set('cancelAnimationFrame',(n:number)=>frames.delete(n))
  const listeners=new Set<()=>void>()
  const input={state:{getSnapshot:()=>state,subscribe:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)}},notify:()=>{},setDraft:(draft:string)=>{state={draft};for(const f of listeners)f()}}
  const ctx={sessions:{list:{getSnapshot:()=>({current:'s'}),subscribe:()=>()=>{}}}}
  const controller=installActionSnippet(ctx,'s',action,'@Simple ',input)
  t.after(()=>{controller.dispose();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete(globalThis as any)[k]}})
  frame();frame();frame();frame()
  assert.equal(selected.length,0)
  el.value=state.draft;frame()
  assert.deepEqual(selected,[[8,12]])
  controller.dispose();selected=[];el.value='old render'
  const second=installActionSnippet(ctx,'s',action,'@Simple ',input)
  frame();frame();frame()
  input.setDraft(state.draft.replace('【IP】','192.0.2.1'));el.value=state.draft
  frame();frame();assert.equal(selected.length,0,'Late focus must not select over newly typed text')
  second.dispose()
})

test('a fully filled Action edited before catalog recovery keeps coordinates and invalidates the dependent field', async t => {
  const names=['window','document','sessionStorage','requestAnimationFrame','cancelAnimationFrame'] as const
  const globals=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])), storage=new Map<string,string>(), cleanup:(()=>void)[]=[]
  const install=(k:string,v:any)=>Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v})
  const doc=new EventTarget() as any;doc.querySelectorAll=()=>[]
  install('window',new EventTarget());install('document',doc);install('sessionStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)})
  install('requestAnimationFrame',()=>1);install('cancelAnimationFrame',()=>{})
  t.after(()=>{cleanup.forEach(f=>f());for(const[k,d]of globals){if(d)Object.defineProperty(globalThis,k,d);else delete(globalThis as any)[k]}})
  const action=validateActions([{id:'linked',name:'Linked',template:'{{ip}} | {{source}}',parameters:[{key:'ip',label:'IP',type:'text',required:true},{key:'source',label:'Source',type:'text',required:true,dependsOn:['ip']}]}])[0]
  const text='@Linked 192.0.2.1 | chosen-source'
  const slots=makeActionSnippet(action,'@Linked ').slots.map((s,i)=>({...s,start:i===0?8:20,end:i===0?17:33}))
  // Use exact native positions, not arbitrary text searches during recovery.
  slots[1].start=text.indexOf('chosen-source');slots[1].end=text.length
  storage.set('dtc:action-draft:s',JSON.stringify({agentId:'worker',actionId:'linked',revision:'r',prefix:'@Linked ',newSession:false,progress:snippetProgress(text,slots,1,false)}))
  let state={draft:text,draftRev:1,phase:'plain'},calls=0,release!:()=>void
  const pending=new Promise<void>(r=>{release=r}),listeners=new Set<()=>void>()
  const publish=(patch:any)=>{state={...state,...patch};for(const f of listeners)f()}
  const input={state:{getSnapshot:()=>state,subscribe:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)}},notify:()=>{},setDraft:(draft:string)=>publish({draft,draftRev:state.draftRev+1})}
  const scope={bail:()=>{publish({phase:'claimed',draftRev:state.draftRev+1});return true}}
  const ctx:any={get:()=>({input:{for:()=>input}}),effect:(f:()=>()=>void)=>cleanup.push(f()),sessions:{list:{getSnapshot:()=>({current:'s',byId:{s:{agentPreset:'worker',blank:false}}}),subscribe:()=>()=>{}},scope:()=>scope}}
  const api:any={agentActions:async()=>{if(++calls===1)await pending;return {agentId:'worker',name:'Worker',actions:[action],revision:'r'}}}
  const source=agentMentionSource(ctx,async()=>api,()=>{})
  const tick=()=>new Promise(r=>setTimeout(r,0))
  source.warm({sessionId:'s'});await tick()
  input.setDraft(text.replace('192.0.2.1','192.0.2.100'));await tick()
  assert.match(storage.get('dtc:action-draft:s')!,/edited/)
  release();await tick();await tick();await tick()
  assert.equal(state.phase,'claimed');assert.equal(state.draft,'@Linked 192.0.2.100 | 【Source】',storage.get('dtc:action-draft:s'))
  const saved=JSON.parse(storage.get('dtc:action-draft:s')!).progress
  assert.ok(saved.ranges.every((r:any)=>!r.removed));assert.equal(saved.edited,undefined)
  assert.doesNotMatch(JSON.stringify(saved),/192\.0|chosen-source/)
})
