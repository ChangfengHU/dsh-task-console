import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat,mkdir,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventStore} from '../src/tasks.ts'
import {TaskCreator} from '../src/task-create.ts'
import {apply as registerCreateTools} from '../src/task-create-tools.ts'
import {STUDIO_TASK_REQUEST_CONTRACT} from '../src/studio-task-draft.ts'
import {loadStudioRolePack} from '../src/studio-role-pack.ts'
import {NATIVE_TOOLS,renderComposition,validateSpec} from '../src/presets.ts'

async function fixture(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'studio-request-')),store=new EventStore(join(cwd,'store'));await store.load()
 t.after(async()=>{store.kernel.db.close();await rm(cwd,{recursive:true,force:true})})
 const pack=await loadStudioRolePack(),roster=pack.roles.map(r=>({id:r.spec.id,name:r.spec.name,description:r.spec.description,tools:r.spec.tools,mcpTools:r.spec.mcpTools,skills:r.spec.skills}))
 const creator=new TaskCreator({store,fire:()=>assert.fail('submission must never execute')} as any,async()=>roster)
 const roles=Object.fromEntries(pack.roles.map(r=>[r.role,r.spec.id]))
 const proposal={decision:'create' as const,reason:'The user requested a character video preview.',studioRequest:{characterId:'fixture-character',referenceUrl:'https://cdn.vyibc.com/fixture/reference.mp4',referenceSha256:'a'.repeat(64),roles,generationLimits:{imageCalls:2,imageBatches:1,voiceSegments:20}}}
 const exec=(id='chat')=>({agent:{session:{id,header:{cwd},deriveMessages:()=>[{id:'user-message',role:'user',source:{kind:'user'},content:'制作一部角色喜剧候选，先审查计划，不发布。'}]}}})
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous})
 const sourceCalls:any[]=[],sourceResult={status:'missing_reference',character:{characterId:'fixture-character'},references:[],metadataVerified:false},studioSourceDiscovery=async(args:any,execution:any)=>{sourceCalls.push({args,execution});return sourceResult}
 const tools=new Map<string,any>(),ctx={get:()=>({creator,studioSourceDiscovery}),tools:{register:(tool:any)=>{tools.set(tool.name,tool);return()=>{}}},effect:(run:any)=>run()}
 await registerCreateTools(ctx)
 return {cwd,store,creator,proposal,exec,roster,tools,sourceCalls,sourceResult}
}
test('ordinary create tool composes the short Studio request into a complete pending plan and actions',async t=>{
 const s=await fixture(t),context=await s.tools.get('task_create_context').execute()
 assert.equal(context.studioCreationContract.request.id,STUDIO_TASK_REQUEST_CONTRACT.id)
 assert.deepEqual(context.studioCreationContract.request.defaults,STUDIO_TASK_REQUEST_CONTRACT.defaults)
 assert.deepEqual(context.studioCreationContract.request.execution,STUDIO_TASK_REQUEST_CONTRACT.execution)
 assert.ok(context.studioCreationContract.request.shape.roles.sound);assert.equal(context.studioCreationContract.request.actions.length,1)
 const plan=await s.tools.get('task_create_submit').execute({plan:JSON.stringify(s.proposal)},s.exec())
 assert.equal(plan.state,'pending');assert.equal(plan.sourceSessionId,'chat');assert.match(plan.request,/先审查计划/)
 assert.equal(plan.definition.graphMode,'dynamic-rounds');assert.equal(plan.definition.design.evidenceContract,'studio-video-v1');assert.equal(plan.definition.design.executionBinding,'agent-runtime-v1')
 assert.deepEqual({timeoutSec:plan.definition.timeoutSec,onFail:plan.definition.onFail,maxTries:plan.definition.maxTries},STUDIO_TASK_REQUEST_CONTRACT.execution)
 assert.deepEqual(plan.definition.design.studio.generationLimits,s.proposal.studioRequest.generationLimits)
 assert.equal(plan.definition.design.studio.publish,false);assert.equal(plan.definition.design.studioStages.length,3)
 assert.equal(plan.actions.length,1);assert.deepEqual(plan.actions[0].parameters.map((p:any)=>p.key),['topic'])
 assert.equal(plan.studioResolution.verifiedByComposer,false);assert.equal(plan.studioResolution.characterProfileVersionPinned,false)
 const row:any=s.store.kernel.db.prepare('SELECT payload FROM dsh_task_plans WHERE id=?').get(plan.id),saved=JSON.parse(row.payload)
 assert.equal(saved.task.cwd,join(s.store.root,'studio-workspaces',saved.task.id));assert.equal(saved.cwd,saved.task.cwd);assert.deepEqual(plan.workspace,saved.studioWorkspace);assert.match(saved.task.brief,/主题留空/)
 await assert.rejects(stat(join(s.store.root,'studio-workspaces')),{code:'ENOENT'})
 assert.equal(s.store.tasks.size,0);assert.equal(s.store.s.batches.size,0);assert.equal(s.store.all().length,0)
 // Replaying the same input yields the existing pending plan, never a second execution.
 const replay=await s.tools.get('task_create_submit').execute({plan:JSON.stringify(s.proposal)},s.exec());assert.equal(replay.id,plan.id)
})
test('Studio source discovery is a discoverable scoped tool and delegates only to the host reader',async t=>{
 const s=await fixture(t),context=await s.creator.context(),tool=s.tools.get('task_create_studio_sources')
 assert.equal(context.studioCreationContract.sourceDiscovery.tool,tool.name)
 assert.deepEqual(Object.keys(tool.parameters),['query','characterId'])
 const exec=s.exec(),args={query:'fixture character'},result=await tool.execute(args,exec)
 assert.deepEqual(s.sourceCalls,[{args,execution:exec}]);assert.equal(result,s.sourceResult);assert.equal(result.status,'missing_reference');assert.deepEqual(result.references,[])
 assert.equal(s.creator.plans().total,0);assert.equal(s.store.tasks.size,0);assert.equal(s.store.s.batches.size,0)
 const native=NATIVE_TOOLS.find(t=>t.id==='task-create-runtime')!
 assert.ok(native.schemaNames.includes(tool.name));assert.ok(!native.schemaNames.includes('character_create'));assert.ok(!native.schemaNames.includes('asset_upload'))
 const spec=validateSpec({id:'fixture-creator',name:'Fixture creator',tools:['task-create-runtime']})
 assert.match(renderComposition(spec,[]).yml,/task_create_studio_sources/)
 assert.doesNotMatch(renderComposition(spec,[]).yml,/character_create|asset_upload/)
})
test('new Studio requests retain the real-user provenance gate and derive workspace without chat cwd',async t=>{
 const s=await fixture(t),submit=s.tools.get('task_create_submit')
 for(const message of [{role:'assistant',content:'create video'},{role:'user',source:{kind:'plugin'},content:'create video'}])await assert.rejects(submit.execute({plan:JSON.stringify(s.proposal)},{agent:{session:{id:'untrusted',header:{cwd:s.cwd},deriveMessages:()=>[message]}}}),/真实用户消息/)
 const exec=s.exec('no-workspace');delete (exec.agent.session.header as any).cwd
 await assert.rejects(s.creator.submit(s.proposal as any,s.exec(),s.cwd),/studio-request-independent-review-required/)
 assert.equal(s.creator.plans().total,0);assert.equal(s.store.tasks.size,0)
 const plan=await submit.execute({plan:JSON.stringify(s.proposal)},exec)
 assert.equal(plan.workspace.root,s.store.root);assert.equal(plan.state,'pending');assert.equal(s.store.tasks.size,0)
})
test('Studio approval allocates a distinct owned directory per Task and reuse cannot replace it',async t=>{
 const s=await fixture(t),first=await s.creator.prepare(s.proposal as any,s.exec('first'),s.cwd),second=await s.creator.prepare(s.proposal as any,s.exec('second'),s.cwd)
 assert.notEqual(first.workspace.path,second.workspace.path)
 await assert.rejects(stat(join(s.store.root,'studio-workspaces')),{code:'ENOENT'})
 const fired:any[]=[];(s.creator.runner as any).fire=async(...args:any[])=>{fired.push(args);return {id:args[2].batchId}}
 const approved=await s.creator.review(first.id,first.hash,'approve','Independent fixture approval')
 assert.equal(approved.state,'dispatched');assert.equal(fired.length,1)
 assert.equal(fired[0][2].turn.cwd,first.workspace.path)
 assert.equal((await stat(first.workspace.path)).mode&0o777,0o700)
 assert.deepEqual(await readdir(first.workspace.path),['.studio-workspace.json'])
 assert.deepEqual(JSON.parse(await readFile(join(first.workspace.path,'.studio-workspace.json'),'utf8')),first.workspace)
 await s.creator.review(first.id,first.hash,'approve','Replay approved decision');assert.equal(fired.length,1)
 await assert.rejects(s.creator.launch(approved.taskId,'Make another candidate','request-another-12345',s.cwd),/studio-workspace-override-forbidden/)
 await assert.rejects(stat(second.workspace.path),{code:'ENOENT'})
})
test('Studio approval preserves an existing unowned directory and remains pending',async t=>{
 const s=await fixture(t),plan=await s.creator.prepare(s.proposal as any,s.exec(),s.cwd)
 await mkdir(plan.workspace.path,{recursive:true})
 await assert.rejects(s.creator.review(plan.id,plan.hash,'approve','Independent fixture approval'),/studio-workspace-ownership-conflict/)
 assert.equal(s.creator.plan(plan.id).state,'pending');assert.equal(s.store.tasks.size,0)
 assert.deepEqual(await readdir(plan.workspace.path),[])
})
test('short requests reject mixed Task fields, machine paths, fake locks, unsupported decisions and missing resolution',async t=>{
 const s=await fixture(t),submit=s.tools.get('task_create_submit')
 for(const extra of [{cwd:'/invented'},{design:{}},{actions:[]},{recipe:{id:'fleet-base-v3',login:'preserve'}},{trigger:{kind:'cron'}},{timeoutSec:21600},{executionBinding:{sha256:'fake'}}])await assert.rejects(submit.execute({plan:JSON.stringify({...s.proposal,...extra})},s.exec()),/studio-request-create-only/)
 for(const decision of ['reuse','revise'])await assert.rejects(submit.execute({plan:JSON.stringify({...s.proposal,decision})},s.exec()),/studio-request-create-only/)
 for(const request of [{...s.proposal.studioRequest,cwd:'/invented'},{...s.proposal.studioRequest,executionBinding:{}},{...s.proposal.studioRequest,characterId:undefined},{...s.proposal.studioRequest,referenceSha256:undefined},{...s.proposal.studioRequest,roles:{...s.proposal.studioRequest.roles,sound:'not-installed'}}])await assert.rejects(submit.execute({plan:JSON.stringify({...s.proposal,studioRequest:request})},s.exec()),/studio-task-draft-invalid/)
 assert.equal(s.creator.plans().total,0);assert.equal(s.store.tasks.size,0);assert.equal(s.store.s.batches.size,0)
})
test('Studio plan still needs independent review and rejects changed real roster at approval',async t=>{
 const s=await fixture(t),plan=await s.tools.get('task_create_submit').execute({plan:JSON.stringify(s.proposal)},s.exec())
 s.roster[0]={...s.roster[0],tools:[...s.roster[0].tools,'unexpected']}
 await assert.rejects(s.creator.review(plan.id,plan.hash,'approve','review fixture'),/能力或配置已变化/)
 assert.equal(s.creator.plan(plan.id).state,'pending');assert.equal(s.store.tasks.size,0);assert.equal(s.store.s.batches.size,0)
 const rejected=await s.creator.review(plan.id,plan.hash,'reject','Needs resolved reference evidence');assert.equal(rejected.state,'rejected')
})
test('ordinary complete proposals still require actions at the tool boundary',async t=>{
 const s=await fixture(t)
 assert.throws(()=>s.tools.get('task_create_submit').execute({plan:JSON.stringify({decision:'create',reason:'ordinary'})},s.exec()),/必须同时提供 actions/)
 assert.equal(s.creator.plans().total,0)
})
