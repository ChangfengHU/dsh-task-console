import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {assertScriptLanguage} from '../src/studio-script-language.js'
import {StudioWorkflow} from '../src/studio-workflow.js'
import {validateStudioPolicy} from '../src/studio-policy.js'
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
