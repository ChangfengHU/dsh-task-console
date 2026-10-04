import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {cardMessage} from '../src/tasks.ts'
import {requiredStudioSkills,studioSkillReadiness,registerStudioSkillGate} from '../src/studio-skill-gate.ts'
import {loadStudioRolePack} from '../src/studio-role-pack.ts'
import {registerStudioTools} from '../src/studio-tools.ts'

const hash='a'.repeat(64)
function inputFor(role:string,stage?:string){
 const batch={id:'B'},stages=['storyboard','visual','sound'].map(id=>({id,agentId:'agent-'+id,brief:'Actual stage '+id}))
 const task:any={id:'T',title:'Fixture only',brief:'Frozen request',participants:[{agentId:'planner'},{agentId:'executor'},{agentId:'reviewer'}],design:{evidenceContract:'studio-video-v1',studio:{},studioStages:stages}}
 const card:any={id:stage?'B#s1-'+stage:'B#'+role,agentId:stage?'agent-'+stage:'agent-'+role,role,round:1,index:0,deps:[],runIds:[],brief:'Preserve the actual role requirements'}
 return {task,batch,card,sessionId:'session-current'}
}
const receipt=(name:string,sessionId='session-current')=>({name,sessionId,sha256:hash,bytes:24,callId:'call-'+name,policyHash:hash})
const cases=[['planner',undefined,'director'],['studio-stage','storyboard','storyboard'],['studio-stage','visual','visual'],['studio-stage','sound','sound'],['executor',undefined,'editor'],['reviewer',undefined,'quality']] as const

test('all six startup messages use the exact runtime mandatory subset supported by the authored role pack',async()=>{
 const pack=await loadStudioRolePack()
 for(const [role,stage,packRole] of cases){
  const input=inputFor(role,stage),required=[...requiredStudioSkills(input)],before=structuredClone(input)
  const message=cardMessage(input.task,input.card,input.batch.id,[])
  const section=message.split('[STUDIO REQUIRED SKILLS]')[1]?.split('[STUDIO GUIDES]')[0]
  assert.ok(section,packRole)
  const named=[...section.matchAll(/skill\((\{"name":"[^"]+"\})\)/g)].map(m=>JSON.parse(m[1]).name)
  assert.deepEqual(named,required,packRole)
  const authored=pack.roles.find(r=>r.role===packRole)!.spec.skills
  for(const name of required)assert.ok(authored.includes(name),packRole+':'+name)
  assert.match(section,/当前会话/);assert.match(section,/每次新会话须重新加载/)
  assert.match(section,/安装清单、技能目录、studio_read_guide或其他会话的加载回执不算/)
  assert.ok(message.indexOf('[STUDIO REQUIRED SKILLS]')<message.indexOf('[STUDIO GUIDES]'))
  assert.deepEqual(input,before)
 }
 // Installed optional skills do not silently become new runtime requirements.
 assert.deepEqual(requiredStudioSkills(inputFor('studio-stage','storyboard')),['studio-director','studio-character-workflow'])
})

test('ordinary Task input stays unchanged and invalid stage identity is never converted into a guessed skill list',()=>{
 const ordinary=inputFor('executor');delete ordinary.task.design.evidenceContract
 assert.equal(studioSkillReadiness(ordinary),undefined)
 assert.doesNotMatch(cardMessage(ordinary.task,ordinary.card,'B',[]),/STUDIO REQUIRED SKILLS/)
 const gate=inputFor('gate');assert.equal(studioSkillReadiness(gate),undefined)
 const invalid=inputFor('studio-stage','storyboard');invalid.card.agentId='wrong-agent'
 assert.throws(()=>cardMessage(invalid.task,invalid.card,'B',[]),/studio-stage-identity-mismatch/)
 assert.throws(()=>studioSkillReadiness(invalid),/studio-stage-identity-mismatch/)
})

test('readiness uses current-session complete host loads only, keeping historical evidence immutable',()=>{
 const input=inputFor('studio-stage','storyboard')
 const loads:any[]=[receipt('studio-director','prior-session'),{name:'studio-character-workflow',sessionId:input.sessionId,installed:true},receipt('studio-quality'),receipt('studio-director'),receipt('studio-director')]
 const before=structuredClone(loads),status=studioSkillReadiness(input,loads)!
 assert.deepEqual(status.required,['studio-director','studio-character-workflow'])
 assert.deepEqual(status.loaded,['studio-director'])
 assert.deepEqual(status.missing,['studio-character-workflow'])
 assert.deepEqual(status.nextCalls,[{tool:'skill',arguments:{name:'studio-character-workflow'}}])
 assert.deepEqual(loads,before);assert.equal(status.sessionId,input.sessionId)
 assert.match(status.notice,/not authorization or quality approval/)
 assert.equal((status as any).qualityApproved,undefined)
})

test('missing identity and malformed receipt metadata never claim loaded skills',()=>{
 const input=inputFor('studio-stage','storyboard'),required=requiredStudioSkills(input)
 for(const defect of [{sha256:'catalog'},{bytes:0},{callId:''},{sessionId:'prior-session'}]){
  const status=studioSkillReadiness(input,required.map(name=>({...receipt(name),...defect})))!
  assert.deepEqual(status.loaded,[]);assert.deepEqual(status.missing,required)
 }
 const noSession={...input,sessionId:undefined}
 assert.deepEqual(studioSkillReadiness(noSession,required.map(name=>receipt(name)))!.loaded,[])
 const loaded=studioSkillReadiness(input,required.map(name=>receipt(name)))!
 assert.deepEqual(loaded.loaded,required);assert.deepEqual(loaded.missing,[]);assert.deepEqual(loaded.nextCalls,[])
})

for(const [role,stage] of cases)test(`${stage??role} compact and full status retain the visible mandatory nextCalls without adding receipts`,async t=>{
 const cwd=await realpath(await mkdtemp(join(tmpdir(),'studio-skill-startup-')));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const input=inputFor(role,stage);input.task.cwd=cwd
 const required=[...requiredStudioSkills(input)],loads=[receipt(required[0],'prior-session')],state={candidate:null,skillLoads:loads,script:{lines:[{id:'line-1',text:'Preserved dialogue'}]},budget:{used:1,limits:2},interventions:[]}
 const before=structuredClone(state),tools:any={},ctx:any={tools:{register:(spec:any)=>{tools[spec.name]=spec;return()=>delete tools[spec.name]}}}
 const stop=await registerStudioTools(ctx,{input,isActive:()=>true,workflow:{preflight:()=>({ok:true}),status:()=>state}});t.after(stop)
 const compact=await tools.studio_status.execute({}),full=await tools.studio_status.execute({view:'full'})
 assert.deepEqual(compact.skillReadiness,full.skillReadiness)
 assert.deepEqual(compact.skillReadiness.required,required);assert.deepEqual(compact.skillReadiness.loaded,[])
 assert.deepEqual(compact.skillReadiness.nextCalls,required.map(name=>({tool:'skill',arguments:{name}})))
 assert.equal(compact.statusProjection.view,'compact');assert.equal(full.statusProjection,undefined)
 assert.deepEqual(compact.state.skillLoads,loads);assert.deepEqual(state,before)
 assert.deepEqual(compact.state.script,state.script);assert.deepEqual(compact.state.budget,state.budget)
})

test('presentation and guide access cannot satisfy the unchanged live skill guard',()=>{
 const input=inputFor('studio-stage','storyboard'),required=[...requiredStudioSkills(input)],records:any[]=[]
 let guard:any,observe:any
 const ctx={tools:{guard:(fn:any)=>{guard=fn;return()=>{}}},on:(_event:string,fn:any)=>{observe=fn;return()=>{}}}
 const stop=registerStudioSkillGate(ctx,{input,isActive:()=>true,record:r=>records.push({...r,sessionId:input.sessionId})})
 const exec=(name:string,args:any={})=>({name,arguments:args,callId:'fixture-call-'+name,agent:{session:{id:input.sessionId}}})
 assert.deepEqual(studioSkillReadiness(input,records)!.missing,required)
 assert.equal(guard(exec('studio_status')),undefined);assert.equal(guard(exec('studio_read_guide',{id:'handoff'})),undefined)
 observe(exec('studio_read_guide',{id:'handoff'}),{isError:false,content:[{type:'text',text:'Useful guide, not skill instructions.'}]})
 observe(exec('skill',{name:required[0]}),{isError:false,content:[{type:'text',text:'Available skill catalog summary.'}]})
 assert.match(guard(exec('write')),/studio-required-skills-not-loaded/);assert.equal(records.length,0)
 for(const name of required)observe(exec('skill',{name}),{isError:false,content:[{type:'text',text:`<skill_content name="${name}"><skill_instructions>Fixture instructions, not a production load.</skill_instructions></skill_content>`}]})
 assert.equal(guard(exec('write')),undefined);assert.equal(records.length,required.length)
 assert.deepEqual(studioSkillReadiness(input,records)!.missing,[])
 const restarted={...input,sessionId:'session-restarted'}
 assert.deepEqual(studioSkillReadiness(restarted,records)!.missing,required)
 stop()
})
