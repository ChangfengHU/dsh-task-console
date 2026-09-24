import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TaskRunner} from '../src/runner.ts'
import {EventStore} from '../src/tasks.ts'
import {StudioProgress,studioProgressPending} from '../src/studio-progress.ts'

async function fixture(t:any,options:{disposeFails?:boolean,legacy?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'studio-progress-')),preset=join(root,'a');await mkdir(preset)
 await writeFile(join(preset,'task-console.json'),JSON.stringify({id:'a',name:'A',description:'',persona:'',model:'p/m',effort:'',tools:[],mcpTools:{},skills:[]}))
 const listeners:any[]=[],sessions:any[]=[]
 const ctx:any={on:(name:string,fn:any)=>{listeners.push(fn);return()=>{}},effect:()=>{},get:(key:string)=>key==='agentPresets'?{resolve:async()=>({id:'a',path:join(preset,'agent.cordis.yml')}),mount:async()=>{}}:key==='permissionPresets'?{set:()=>{}}:key==='agentDefaultModel'?{currentSelection:()=>({provider:'p',model:'m'})}:undefined,agents:{create:async(opts:any)=>{
  const hooks=new Map(),guards:any[]=[],rec:any={hooks,guards,disposed:false,messages:[],cwd:opts.meta.cwd}
  const agentCtx={on:(name:string,fn:any)=>{hooks.set(name,fn);return()=>hooks.delete(name)},tools:{register:()=>()=>{},guard:(fn:any)=>{guards.push(fn);return()=>guards.splice(guards.indexOf(fn),1)}}}
  rec.agent={ctx:agentCtx,session:{id:opts.sessionId},followup:(m:any)=>rec.messages.push(m)};sessions.push(rec);await opts.setup({})
  return{agent:rec.agent,dispose:async()=>{if(options.disposeFails)throw Error('fixture stop failed');await rec.beforeDispose?.();rec.disposed=true}}
 }}}
 const store=new EventStore(join(root,'store')),runner=new TaskRunner(ctx,store,{registerStudioTools:async()=>()=>{}})
 await runner.start();t.after(async()=>{runner.stop();store.kernel.db.close();await rm(root,{recursive:true,force:true})})
 const task:any={id:'T',title:'fixture',brief:'fixture',trigger:{kind:'once'},participants:[{agentId:'a'}],cwd:root,timeoutSec:7200,onFail:'retry',maxTries:3,enabled:true,createdAt:'x',design:{evidenceContract:'studio-video-v1',...(!options.legacy?{progressPolicy:'studio-bounded-v1'}:{})}}
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
