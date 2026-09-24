import test from 'node:test'
import assert from 'node:assert/strict'
import {registerStudioSkillGate,REQUIRED_PRODUCTION_SKILLS,REQUIRED_STAGE_SKILLS,requiredStudioSkills} from '../src/studio-skill-gate.ts'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'

const stageInput=(id:string)=>({task:{design:{evidenceContract:'studio-video-v1',studioStages:[{id,agentId:id}]}},batch:{id:'batch'},card:{role:'studio-stage',id:`batch#s1-${id}`,round:1,agentId:id},sessionId:'s'})
function fixture(role='executor',stage?:string){
 let guard:any,observe:any,active=true,disposed=0
 const records:any[]=[]
 const ctx={tools:{guard:(g:any)=>{guard=g;return()=>{disposed++}}},on:(_n:string,f:any)=>{observe=f;return()=>{disposed++}}}
 const input=stage?stageInput(stage):{task:{design:{evidenceContract:'studio-video-v1'}},card:{role},sessionId:'s'}
 const stop=registerStudioSkillGate(ctx,{input,isActive:()=>active,record:r=>records.push(r)})
 const exec=(name:string,args:any={},sessionId='s')=>({name,arguments:args,agent:{session:{id:sessionId}},callId:'call-'+name})
 const content=(name:string)=>({content:[{type:'text',text:`<skill_content name="${name}"><skill_instructions>Actual rules for ${name}</skill_instructions></skill_content>`}],isError:false})
 return {guard:(name:string,args?:any,sid?:string)=>guard?.(exec(name,args,sid)),load:(name:string,result=content(name),sid='s')=>observe?.(exec('skill',{name},sid),result),records,stop,get disposed(){return disposed},setInactive:()=>active=false}
}

test('blocks shell/write/generation/unknown tools until real required loads; reads and diagnosis remain available',()=>{
 const f=fixture()
 for(const name of ['bash','write','edit','run_code','studio_register_candidate','vyibc-image_generate_image','vyibc-voice_synthesize','future_writer'])assert.match(f.guard(name),/required-skills-not-loaded.*hyperframes-core/)
 for(const name of ['skill','read','studio_status','task_block','character_get','mcp__vyibc-cartoon-assets__asset_get'])assert.equal(f.guard(name),undefined)
 for(const name of REQUIRED_PRODUCTION_SKILLS)f.load(name)
 assert.equal(f.guard('bash'),undefined);assert.equal(f.guard('write'),undefined);assert.equal(f.records.length,3)
 assert.match(f.records[0].sha256,/^[a-f0-9]{64}$/);assert.ok(f.records[0].bytes>0)
})
test('failed, catalog-only, wrong-name and other-session loads never unlock writes',()=>{
 const f=fixture()
 f.load('hyperframes',{isError:true,content:[{type:'text',text:'Error'}]})
 f.load('hyperframes',{isError:false,content:[{type:'text',text:'Available skill hyperframes'}]})
 f.load('hyperframes-core',undefined,'other')
 f.load('not-required')
 assert.equal(f.records.length,0);assert.match(f.guard('write'),/not-loaded/)
})
test('parallel write remains blocked until successful skill result; a new session must reload',()=>{
 const f=fixture();f.load('hyperframes');f.load('hyperframes-core')
 assert.match(f.guard('write'),/studio-character-workflow/)
 f.load('studio-character-workflow');assert.equal(f.guard('write'),undefined)
 assert.match(fixture().guard('write'),/not-loaded/)
 assert.match(f.guard('write',{},'other'),/session-mismatch/)
 f.setInactive();assert.match(f.guard('write'),/stale-run/)
})
test('reviewer not gated; disposal owns both listeners',()=>{
 assert.equal(fixture('reviewer').guard('studio_submit_review'),undefined)
 const f=fixture();f.stop();assert.equal(f.disposed,2)
})
test('unavailable guard fails closed for producer',()=>{
 assert.throws(()=>registerStudioSkillGate({},{input:{task:{design:{evidenceContract:'studio-video-v1'}},card:{role:'executor'}},isActive:()=>true,record:()=>{}}),/capability-required/)
})

for(const id of ['storyboard','visual','sound'] as const)test(`${id} blocks production until its own authored skills are really loaded`,()=>{
 const f=fixture('studio-stage',id),required=REQUIRED_STAGE_SKILLS[id]
 for(const name of ['bash','write','studio_register_stage','task_complete','vyibc-image_generate_image','vyibc-voice_synthesize'])assert.match(f.guard(name),/required-skills-not-loaded/)
 for(const name of ['skill','read','studio_status','studio_character_image','task_block'])assert.equal(f.guard(name),undefined)
 for(const name of REQUIRED_PRODUCTION_SKILLS)if(!required.includes(name))f.load(name)
 assert.match(f.guard('write'),/required-skills-not-loaded/)
 required.slice(0,-1).forEach(name=>f.load(name))
 f.load(required.at(-1)!,{isError:false,content:[{type:'text',text:'Catalog entry only'}]})
 assert.match(f.guard('write'),/required-skills-not-loaded/)
 f.load(required.at(-1)!)
 assert.equal(f.guard('write'),undefined);assert.equal(f.guard('studio_register_stage'),undefined)
 assert.deepEqual(f.records.map(r=>r.name),required)
 assert.equal(f.records.some(r=>'qualityApproved' in r),false)
 assert.match(fixture('studio-stage',id).guard('write'),/required-skills-not-loaded/)
 assert.match(f.guard('write',{},'other'),/session-mismatch/)
 f.setInactive();assert.match(f.guard('write'),/stale-run/)
})
test('stage identity cannot be omitted or impersonated to bypass instruction gate',()=>{
 const input=stageInput('visual')
 assert.throws(()=>requiredStudioSkills({...input,card:{...input.card,agentId:'sound'}}),/identity-mismatch/)
 assert.throws(()=>requiredStudioSkills({...input,task:{design:{evidenceContract:'studio-video-v1'}}}),/identity-required/)
 assert.throws(()=>registerStudioSkillGate({},{input,isActive:()=>true,record:()=>{}}),/capability-required/)
})

for(const id of ['executor','storyboard','visual','sound'] as const)test(`real native ToolRuntime ${id} unlocks writes only after successful instruction results`,async()=>{
 const require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),agent={ctx,session:{id:'native-skill-test'}},records:any[]=[]
 const input=id==='executor'?{task:{design:{evidenceContract:'studio-video-v1'}},card:{role:'executor'},sessionId:agent.session.id}:{...stageInput(id),sessionId:agent.session.id}
 const required=requiredStudioSkills(input)
 const stop=registerStudioSkillGate({tools:runtime,on:ctx.on.bind(ctx)},{input,isActive:()=>true,record:r=>records.push(r)})
 let writes=0
 const d1=runtime.register(defineTool({name:'write',description:'fixture',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>{writes++;return {}}}))
 const d2=runtime.register(defineTool({name:'skill',description:'fixture',parameters:{name:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a:any,text:string)=>[{type:'text',text}]},execute:(a:any)=>{if(a.name==='missing')throw Error('not found');return `<skill_content name="${a.name}"><skill_instructions>Actual installed instructions.</skill_instructions></skill_content>`}}))
 const run=(name:string,args={})=>runtime.execute({name,arguments:args,agent,callId:'native-'+name,signal:new AbortController().signal} as any)
 try{
  assert.equal((await run('write')).isError,true);assert.equal(writes,0)
  assert.equal((await run('skill',{name:'missing'})).isError,true);assert.equal(records.length,0)
  for(const name of required)assert.equal((await run('skill',{name})).isError,false)
  assert.equal(records.length,required.length);assert.equal((await run('write')).isError,false);assert.equal(writes,1)
 }finally{stop();d1();d2()}
})
