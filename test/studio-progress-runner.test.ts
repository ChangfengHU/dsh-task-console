import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {TaskRunner} from '../src/runner.ts'
import {EventStore} from '../src/tasks.ts'
import {StudioProgress,studioProgressPending} from '../src/studio-progress.ts'

async function fixture(t:any,options:{disposeFails?:boolean,legacy?:boolean,native?:boolean,taskPatch?:any}={}){
 const root=await mkdtemp(join(tmpdir(),'studio-progress-')),preset=join(root,'a');await mkdir(preset)
 await writeFile(join(preset,'task-console.json'),JSON.stringify({id:'a',name:'A',description:'',persona:'',model:'p/m',effort:'',tools:[],mcpTools:{},skills:[]}))
 const require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const listeners:any[]=[],sessions:any[]=[]
 const ctx:any={on:(name:string,fn:any)=>{listeners.push(fn);return()=>{}},effect:()=>{},get:(key:string)=>key==='agentPresets'?{resolve:async(id:string)=>({id,path:join(preset,'agent.cordis.yml')}),mount:async()=>{}}:key==='permissionPresets'?{set:()=>{}}:key==='agentDefaultModel'?{currentSelection:()=>({provider:'p',model:'m'})}:undefined,agents:{create:async(opts:any)=>{
  const hooks=new Map(),guards:any[]=[],rec:any={hooks,guards,disposed:false,messages:[],cwd:opts.meta.cwd}
  let agentCtx:any={on:(name:string,fn:any)=>{hooks.set(name,fn);return()=>hooks.delete(name)},tools:{register:()=>()=>{},guard:(fn:any)=>{guards.push(fn);return()=>guards.splice(guards.indexOf(fn),1)}}}
  if(options.native){
   agentCtx=new Context();agentCtx.provide('systemPrompt',{tools:()=>{}});rec.runtime=new ToolRuntime(agentCtx)
   // worker-tools intentionally leaves descriptors uncompiled in unit-test
   // mode. This fixture exercises the real registry in BOTH modes; do not
   // compile an already-defined native fixture tool a second time.
   const register=rec.runtime.register.bind(rec.runtime)
   rec.runtime.register=(spec:any)=>register(process.env.NODE_ENV==='test'&&spec.parameters?.type!=='object'?defineTool(spec):spec)
  }
  rec.agent={ctx:agentCtx,session:{id:opts.sessionId},followup:(m:any)=>rec.messages.push(m)};sessions.push(rec);await opts.setup({})
  return{agent:rec.agent,dispose:async()=>{if(options.disposeFails)throw Error('fixture stop failed');await rec.beforeDispose?.();rec.disposed=true}}
 }}}
 const store=new EventStore(join(root,'store')),runner=new TaskRunner(ctx,store,{registerStudioTools:async()=>()=>{}})
 await runner.start();t.after(async()=>{runner.stop();store.kernel.db.close();await rm(root,{recursive:true,force:true})})
 const task:any={id:'T',title:'fixture',brief:'fixture',trigger:{kind:'once'},participants:[{agentId:'a'}],cwd:root,timeoutSec:7200,onFail:'retry',maxTries:3,enabled:true,createdAt:'x',design:{evidenceContract:'studio-video-v1',failurePolicy:{maxAttempts:3},...(!options.legacy?{progressPolicy:'studio-bounded-v1'}:{})},...options.taskPatch}
 await store.append({t:'task/created',at:'x',taskId:'T',task});const batch=await runner.fire('T','manual')
 const end=async(rec:any)=>{const f=[...(runner as any).flights.values()].find((x:any)=>x.sessionId===rec.agent.session.id);await (runner as any).onTurnEnd(f,{kind:'error',error:{code:'STUDIO_PROGRESS_GUARD'}})}
 const steps=async(rec:any)=>{for(let i=1;i<=80;i++)await rec.hooks.get('agent/pre-step')({agent:rec.agent,turn:0,step:i},async()=>({kind:'enter'}));await assert.rejects(()=>rec.hooks.get('agent/pre-step')({agent:rec.agent,turn:0,step:81},async()=>({kind:'enter'})),/STUDIO_PROGRESS_GUARD/)}
 return{root,store,runner,sessions,batch,task,end,steps}
}

test('80-step native boundary fails a run, confirmed disposal precedes bounded fresh-session retry and truthful resume',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'existing.txt'),'keep')
 for(let attempt=0;attempt<3;attempt++){
  const rec=f.sessions[attempt];assert.ok(rec);await f.steps(rec);await f.end(rec);assert.equal(rec.disposed,true)
 }
 assert.equal(f.sessions.length,3);assert.equal(f.store.s.cards.get(f.batch.cardIds[0])?.status,'failed')
 assert.match(f.sessions[1].messages[0].content[0].text,/model-step-limit/)
 assert.match(f.sessions[1].messages[0].content[0].text,/previousStop/)
 assert.equal(f.sessions[1].cwd,f.sessions[0].cwd)
 assert.equal(await (await import('node:fs/promises')).readFile(join(f.root,'existing.txt'),'utf8'),'keep')
})

test('pending or unknown original paid job blocks with original calls and no ledger mutation or retry',async t=>{
 for(const state of ['submitted','unknown']){
  const f=await fixture(t)
  f.store.kernel.db.exec('CREATE TABLE dsh_studio_operations(task_id TEXT,batch_id TEXT,intent TEXT,tool TEXT,state TEXT,job_id TEXT)')
  f.store.kernel.db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?)').run('T',f.batch.id,'one','vyibc-voice_synthesize',state,'original-job')
  const before=f.store.kernel.db.prepare('SELECT * FROM dsh_studio_operations').all()
  await f.steps(f.sessions[0]);await f.end(f.sessions[0])
  assert.equal(f.sessions.length,1);assert.equal(f.sessions[0].disposed,true)
  assert.equal(f.store.s.cards.get(f.batch.cardIds[0])?.status,'blocked')
  const reason=f.store.s.runs.values().next().value?.question??'';assert.match(reason,/original-job/);assert.match(reason,/vyibc-voice_status/)
  assert.deepEqual(f.store.kernel.db.prepare('SELECT * FROM dsh_studio_operations').all(),before)
  await f.runner.unblockCard(f.batch.cardIds[0]);await new Promise(r=>setTimeout(r,50));assert.equal(f.sessions.length,1);assert.equal(f.store.s.cards.get(f.batch.cardIds[0])?.status,'blocked')
 }
})

test('dispose failure retains tool fence and durable block even after explicit unblock',async t=>{
 const f=await fixture(t,{disposeFails:true}),rec=f.sessions[0]
 await f.steps(rec);await f.end(rec)
 assert.equal(f.sessions.length,1);assert.equal(f.store.s.cards.get(f.batch.cardIds[0])?.status,'blocked')
 assert.ok(rec.guards.length);assert.match(rec.guards[0]({agent:rec.agent,callId:'late',name:'write',arguments:{}}),/stale-run/)
 await f.runner.unblockCard(f.batch.cardIds[0]);await new Promise(r=>setTimeout(r,50));assert.equal(f.sessions.length,1);assert.equal(f.store.s.cards.get(f.batch.cardIds[0])?.status,'blocked')
 const row=f.store.kernel.db.prepare("SELECT payload FROM task_events WHERE kind='studio_progress_stopped' ORDER BY id DESC LIMIT 1").get() as any
 assert.equal(JSON.parse(row.payload).stopConfirmed,false)
})

test('legacy Task has no progress hooks or events',async t=>{
 const f=await fixture(t,{legacy:true});assert.equal(f.sessions[0].hooks.has('agent/pre-step'),false)
 assert.equal(f.store.kernel.db.prepare("SELECT count(*) n FROM task_events WHERE kind='studio_progress'").get().n,0)
})

test('per-run counters survive reinstantiation, duplicate boundaries do not count, new turn cannot reset',async t=>{
 const f=await fixture(t),cardId=f.batch.cardIds[0],runId=f.store.kernel.getTask(cardId)!.current_run_id!
 const p=new StudioProgress(f.store.kernel,cardId,runId)
 p.step(0,1);p.step(0,1);p.step(1,1)
 const restored=new StudioProgress(f.store.kernel,cardId,runId);assert.equal(restored.state.steps.length,2)
 for(let i=0;i<160;i++)assert.equal(restored.dispatch({callId:'call-'+i}),undefined)
 assert.equal(restored.dispatch({callId:'overflow'}),'tool-call-limit')
 assert.equal(new StudioProgress(f.store.kernel,cardId,runId).state.reason,'tool-call-limit')
 assert.equal(studioProgressPending(f.store.kernel.db,{task:f.task,batch:f.batch}),undefined)
})


test('an in-flight paid job becoming unknown during session disposal is reconciled after stop, never retried',async t=>{
 const f=await fixture(t),rec=f.sessions[0]
 f.store.kernel.db.exec('CREATE TABLE dsh_studio_operations(task_id TEXT,batch_id TEXT,intent TEXT,tool TEXT,state TEXT,job_id TEXT)')
 rec.beforeDispose=async()=>{f.store.kernel.db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?)').run('T',f.batch.id,'late','vyibc-image_generate_image','unknown','original-image')}
 await f.steps(rec);await f.end(rec)
 assert.equal(f.sessions.length,1);assert.equal(f.store.s.cards.get(f.batch.cardIds[0])?.status,'blocked')
 assert.match(f.store.s.runs.values().next().value!.question!,/original-image/)
})


async function nativeCall(rec:any,name:string,args:any,id=name){return rec.runtime.execute({name,arguments:args,agent:rec.agent,callId:id,signal:new AbortController().signal})}
async function nativeBoundary(rec:any){return rec.agent.ctx.waterfall('agent/pre-step',{agent:rec.agent,turn:0,step:14,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))}

for(const action of ['task_plan_round','task_complete','task_request_review','task_block','task_wait'])test(`native SDK ${action} accepted terminal rejects the next step without failure/retry and keeps paid tools fenced`,async t=>{
 const dynamic=action==='task_plan_round'
 const f=await fixture(t,{native:true,taskPatch:{...(dynamic?{graphMode:'dynamic-rounds',participants:[{agentId:'a'},{agentId:'b'},{agentId:'c'}]}:{}),...(action==='task_wait'?{trigger:{kind:'cron',expr:'0 0 * * *'}}:{})}})
 const rec=f.sessions[0],cardId=f.batch.cardIds[0],cardCount=f.store.s.cards.size
 let paid=0
 const disposePaid=rec.runtime.register(defineTool({name:'fixture_paid',description:'must not run after accepted terminal',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>{paid++;return {ok:true}}}))
 t.after(disposePaid)
 const args=action==='task_block'?{reason:'actual fixture blocker',kind:'capability'}:action==='task_wait'?{until:new Date(Date.now()+120000).toISOString(),reason:'fixture durable wait'}:{summary:'verified fixture handoff'}
 const result=await nativeCall(rec,action,args);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.ok,true)
 if(dynamic)assert.ok(f.store.s.cards.size>cardCount)
 assert.deepEqual(await nativeBoundary(rec),{kind:'reject'})
 assert.equal((await nativeCall(rec,'fixture_paid',{})).isError,true);assert.equal(paid,0)
 // Drivers may label a rejected boundary as interrupted. The exact accepted
 // terminal is authoritative; the fake driver only supplies its final event.
 await f.end(rec)
 const run=f.store.s.runs.values().next().value!
 assert.notEqual(run.status,'failed');assert.equal(f.store.s.cards.get(cardId)?.consecutiveFailures,0)
 assert.equal(f.store.kernel.listRuns(cardId).length,1);assert.equal(rec.disposed,true)
 if(dynamic){assert.equal(f.store.s.cards.size,cardCount+4);assert.equal(run.status,'done');assert.equal(run.outcome,'completed')}
 if(action==='task_complete'){assert.equal(run.status,'done');assert.equal(run.outcome,'completed')}
 if(action==='task_request_review'){assert.equal(run.status,'done');assert.equal(run.outcome,'review')}
 if(action==='task_block')assert.equal(run.status,'blocked')
 if(action==='task_wait'){assert.equal(run.status,'blocked');assert.equal(f.store.kernel.getTask(cardId)?.status,'scheduled')}
})

test('native SDK rejected terminator does not gain a successful terminal boundary',async t=>{
 const f=await fixture(t,{native:true}),rec=f.sessions[0]
 const result=await nativeCall(rec,'task_complete',{summary:''});assert.equal(result.value.ok,false)
 assert.equal((await nativeBoundary(rec)).kind,'enter')
 await f.end(rec)
 assert.equal(f.store.s.runs.values().next().value!.status,'failed')
 assert.equal(f.store.kernel.listRuns(f.batch.cardIds[0]).length,2)
})

test('accepted terminal cannot mask a superseded kernel claim',async t=>{
 const f=await fixture(t,{native:true}),rec=f.sessions[0],cardId=f.batch.cardIds[0]
 await nativeCall(rec,'task_complete',{summary:'accepted'})
 const old=f.store.kernel.getTask(cardId)!.current_run_id!
 f.store.kernel.db.prepare('UPDATE tasks SET current_run_id=? WHERE id=?').run(old+100,cardId)
 await assert.rejects(()=>nativeBoundary(rec),/STUDIO_PROGRESS_GUARD: stale-run/)
 assert.equal((await nativeCall(rec,'task_complete',{summary:'again'},'late')).isError,true)
})
