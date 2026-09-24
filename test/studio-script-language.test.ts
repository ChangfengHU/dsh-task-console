import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {assertScriptLanguage,assertSpokenDialogue} from '../src/studio-script-language.js'
import {StudioWorkflow} from '../src/studio-workflow.js'
import {validateStudioPolicy} from '../src/studio-policy.js'
import {registerStudioSpeechTools} from '../src/studio-speech-tools.js'
const policy={characterId:'test',referenceSha256:'b'.repeat(64),referenceUrl:'https://cdn.vyibc.com/reference.mp4'}
const drift=[
 {id:'1',text:"Group chat: Where's everyone eating today?"},
 {id:'2',text:"Hi! I'm许小满! I noticed you're studying for Bio 101 too! I have some great notes if you'd like..."},
 {id:'3',text:"Hey guys! What's so funny? Mind if I join you? I love bad puns!"},
 {id:'4',text:'Here, let me help!'}, {id:'5',text:"Thanks! I'm Lily."}, {id:'6',text:"I'm许小满."},
]
test('explicit Chinese policy refuses observed drift before recording and permits corrected retry',t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const w=new StudioWorkflow({kernel:{db}}),input:any={task:{id:'t',design:{evidenceContract:'studio-video-v1',studio:{...policy,dialogueLanguage:'zh-CN'}}},batch:{id:'b'},card:{role:'planner'},sessionId:'p'}
 assert.throws(()=>w.recordScript(input,{sha256:'a'.repeat(64),lines:drift}),/studio-script-language-mismatch/)
 assert.equal(w.script(input),null)
 const corrected={sha256:'c'.repeat(64),lines:[{id:'1',text:'今天食堂里好多人，我该怎么开口才能和她们坐一起呢？'}]}
 w.recordScript(input,corrected);assert.deepEqual(w.script(input),corrected)
 assert.throws(()=>w.recordScript(input,{sha256:'a'.repeat(64),lines:drift}),/studio-script-language-mismatch/)
 assert.deepEqual(w.script(input),corrected)
})
test('Chinese dialogue allows names, acronyms, digits and short foreign replies',()=>{
 assert.doesNotThrow(()=>assertScriptLanguage({dialogueLanguage:'zh-CN'},[
  {id:'1',text:'Lily说食堂有WiFi，我抱着iPhone和iPad过去，结果只敢问她这里有人坐吗。她说没有，我还以为她不想理我。'},
  {id:'2',text:'OK! Thank you!'},
 ]))
})
test('legacy tasks are not retroactively changed; unsupported contracts fail validation',()=>{
 const legacy=validateStudioPolicy(policy)
 assert.equal(Object.hasOwn(legacy,'dialogueLanguage'),false)
 assert.doesNotThrow(()=>assertScriptLanguage(legacy,drift))
 assert.equal(validateStudioPolicy({...policy,dialogueLanguage:'zh-CN'}).dialogueLanguage,'zh-CN')
 for(const value of ['en','',null,42])assert.throws(()=>validateStudioPolicy({...policy,dialogueLanguage:value}),/dialogueLanguage/)
})

test('new freezes refuse ambiguous leading direction blocks without deleting spoken text',t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const workflow=new StudioWorkflow({kernel:{db}}),input:any={task:{id:'spoken',design:{evidenceContract:'studio-video-v1',studio:{...policy,dialogueLanguage:'zh-CN'}}},batch:{id:'b'},card:{role:'planner'},sessionId:'p'}
 for(const text of ['（远处传来声音）我听见了。','(moves toward the window)我听见了。','[breathes in]现在开始。','【停顿】现在开始。','（独立舞台说明）']){
  const value={sha256:'d'.repeat(64),lines:[{id:'opening',text}]},before=structuredClone(value)
  assert.throws(()=>workflow.recordScript(input,value),(error:any)=>{
   assert.match(error.message,/studio-script-spoken-text-required/)
   const detail=JSON.parse(error.message.slice(error.message.indexOf(': ')+2))
   assert.equal(detail.field,'lines[0].text');assert.equal(detail.lineId,'opening');assert.equal(detail.recorded,false);assert.equal(detail.retryAfterRepair,true)
   assert.match(detail.action,/Return to the director\/planner/);assert.match(detail.action,/existing revision rules/)
   assert.ok(!error.message.includes(text));return true
  })
  assert.deepEqual(value,before);assert.equal(workflow.script(input),null)
 }
 const repaired={sha256:'e'.repeat(64),lines:[{id:'opening',text:'啊……再等一下，我马上就来！'}]}
 workflow.recordScript(input,repaired);assert.deepEqual(workflow.script(input),repaired)
 assert.throws(()=>workflow.recordScript(input,{sha256:'f'.repeat(64),lines:[{id:'opening',text:'（另一条导演说明）我来了。'}]}),/spoken-text-required/)
 assert.deepEqual(workflow.script(input),repaired)
})
test('spoken punctuation, inline asides, quotes and numeric expressions are preserved',()=>{
 const lines=['啊……等、等一下！我——我来了。','我（真的）没有迟到！','她说：“（真的）我没迟到。”','“闹钟响了”，她这样说。','(1+1)等于二。','（2026）这个数字我记住了。'].map((text,i)=>({id:String(i),text}))
 const before=structuredClone(lines);assert.doesNotThrow(()=>assertSpokenDialogue(lines));assert.deepEqual(lines,before)
})
test('reading an old frozen script does not rewrite or retroactively reject annotations',t=>{
 const db=new Database(':memory:');t.after(()=>db.close())
 const workflow=new StudioWorkflow({kernel:{db}}),input:any={task:{id:'legacy',design:{evidenceContract:'studio-video-v1',studio:policy}},batch:{id:'b'},card:{role:'planner'},sessionId:'p'}
 const old={sha256:'a'.repeat(64),lines:[{id:'old',text:'（旧导演说明）我来了。'}]}
 // Persisted fixture predates the new-freeze guard; public readback must remain usable.
 ;(workflow as any).write(input,'script',old)
 assert.deepEqual(workflow.script(input),old);assert.deepEqual(workflow.script(input),old)
})

test('actual freeze tool returns actionable direction error and accepts a director-corrected new freeze',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const workflow=new StudioWorkflow({kernel:{db}})
 const input:any={task:{id:'freeze-tool',design:{evidenceContract:'studio-video-v1',studio:policy}},batch:{id:'b'},card:{role:'planner'},sessionId:'p'},tools:any={}
 await registerStudioSpeechTools({tools:{register:(tool:any)=>{tools[tool.name]=tool;return()=>{}}}},{input,workflow,isActive:()=>true,speechCheck:async()=>{throw Error('freeze does not invoke speech observation')}})
 await assert.rejects(tools.studio_freeze_script.execute({lines:[{id:'line-1',text:'（闹钟响）啊……再睡五分钟。'}]}),/studio-script-spoken-text-required/)
 assert.equal(workflow.script(input),null)
 const result=await tools.studio_freeze_script.execute({lines:[{id:'line-1',text:'啊……再睡五分钟。'}]})
 assert.deepEqual(result.lines,[{id:'line-1',text:'啊……再睡五分钟。'}]);assert.deepEqual(workflow.script(input),result)
 assert.match(tools.studio_freeze_script.description,/not an emotion API/)
})
