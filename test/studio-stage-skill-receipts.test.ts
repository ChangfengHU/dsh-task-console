import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioWorkflow} from '../src/studio-workflow.ts'
import {registerStudioSkillGate,REQUIRED_STAGE_SKILLS} from '../src/studio-skill-gate.ts'

for(const id of ['storyboard','visual','sound'] as const)test(`${id} instruction gate records real stage-scoped receipts without approving quality`,t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const workflow=new StudioWorkflow({kernel:{db}})
 const input={task:{id:'task',design:{evidenceContract:'studio-video-v1',studio:{characterId:'xuman',referenceSha256:'b'.repeat(64),referenceUrl:'https://cdn.vyibc.com/reference.mp4'},studioStages:[{id,agentId:id}]}},batch:{id:'batch'},card:{role:'studio-stage',id:`batch#s1-${id}`,round:1,agentId:id},sessionId:`session-${id}`}
 let observe:any,guard:any
 const ctx={tools:{guard:(f:any)=>{guard=f;return()=>{}}},on:(_event:string,f:any)=>{observe=f;return()=>{}}}
 const stop=registerStudioSkillGate(ctx,{input,isActive:()=>true,record:r=>workflow.recordSkillLoad(input,r)})
 t.after(stop)
 const exec=(name:string,args:any={})=>({name,arguments:args,callId:`call-${name}`,agent:{session:{id:input.sessionId}}})
 assert.match(guard(exec('studio_register_stage')),/required-skills-not-loaded/)
 for(const name of REQUIRED_STAGE_SKILLS[id])observe(exec('skill',{name}),{content:[{type:'text',text:`<skill_content name="${name}"><skill_instructions>Installed instructions</skill_instructions></skill_content>`}]})
 assert.equal(guard(exec('studio_register_stage')),undefined)
 const status=workflow.status(input)
 assert.deepEqual(status.skillLoads.map((r:any)=>r.name),REQUIRED_STAGE_SKILLS[id])
 for(const r of status.skillLoads){assert.equal(r.sessionId,input.sessionId);assert.equal(r.policyHash.length,64)}
 assert.equal(status.candidate,null);assert.equal(status.review,null)
 const receipt={name:REQUIRED_STAGE_SKILLS[id][0],sha256:'c'.repeat(64),bytes:32,callId:'other'}
 assert.throws(()=>workflow.recordSkillLoad({...input,card:{...input.card,agentId:'other'}},receipt),/identity-mismatch/)
 assert.throws(()=>workflow.recordSkillLoad({...input,card:{...input.card,role:'reviewer'}},receipt),/skill-load-invalid/)
 assert.throws(()=>workflow.recordSkillLoad({...input,task:{...input.task,design:{...input.task.design,studioStages:undefined}}},receipt),/skill-load-invalid/)
})
