import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {validateStoryboardScript} from '../src/studio-storyboard-script.ts'
import {registerStageFiles,requireStudioStages,verifyStageReceipt} from '../src/studio-stage-files.ts'
import {validateStudioStages,studioStageCardId} from '../src/studio-stages.ts'
const script={sha256:'a'.repeat(64),lines:[{id:'line-1',text:'我想试试看。'},{id:'answer',text:'一起吧！'}]}
const board=()=>({scriptSha256:script.sha256,scenes:[{frames:[{sound:'洗衣机运转声'},{sound:"line-1: '我想试试看。'"},{sound:'answer'}]},{speech:null}]})
test('planning storyboard text references and silent shots preserve frozen dialogue',()=>{
 assert.equal(validateStoryboardScript(board(),script).lineCount,2)
 assert.doesNotThrow(()=>validateStoryboardScript({script:{sha256:script.sha256,lines:script.lines},scenes:[{speech:[]},{speech:'一起吧！'}]},script))
 assert.throws(()=>validateStoryboardScript({...board(),scriptSha256:undefined},script),/scriptSha256.*studio_status/)
 assert.throws(()=>validateStoryboardScript({...board(),scriptSha256:'b'.repeat(64)},script),/stale/)
 const wrong=board();wrong.scenes[0].frames![1].sound="line-1: '我改了台词。'";assert.throws(()=>validateStoryboardScript(wrong,script),/dialogue_text/)
 const unknown=board();unknown.scenes[0].frames![1].sound="line-9: '新台词'";assert.throws(()=>validateStoryboardScript(unknown,script),/Unknown dialogue id/)
 assert.throws(()=>validateStoryboardScript({scriptSha256:script.sha256,scenes:[{sound:'纯环境音'}]},script),/dialogue_coverage/)
})
test('compiler board script and voice clip references cannot disagree or omit frozen lines',()=>{
 const value:any={schema:'studio-board-v1',scriptSha256:script.sha256,script:script.lines,scenes:[{layers:[{type:'text',text:'无对白的标题'}]}],audio:[{role:'music',src:'music.mp3'},{role:'voice',lineId:'line-1',text:script.lines[0].text},{role:'voice',lineId:'answer',text:script.lines[1].text}]}
 assert.doesNotThrow(()=>validateStoryboardScript(value,script))
 value.audio[1].text='假台词';assert.throws(()=>validateStoryboardScript(value,script),/dialogue_text/)
 value.audio[1].text=script.lines[0].text;delete value.audio[1].lineId;assert.throws(()=>validateStoryboardScript(value,script),/Voice clip has no lineId/)
 value.audio=[];value.script=[script.lines[0],script.lines[0]];assert.throws(()=>validateStoryboardScript(value,script),/Canonical dialogue/)
 value.script=[...script.lines].reverse();assert.throws(()=>validateStoryboardScript(value,script),/Canonical dialogue/)
})
test('speech accepts explicit ID objects but ambiguous plain text requires an ID',()=>{
 const repeated={sha256:script.sha256,lines:[{id:'a',text:'好。'},{id:'b',text:'好。'}]}
 assert.doesNotThrow(()=>validateStoryboardScript({scriptSha256:script.sha256,scenes:[{speech:[{lineId:'a',text:'好。'},{id:'b'}]}]},repeated))
 assert.throws(()=>validateStoryboardScript({scriptSha256:script.sha256,scenes:[{speech:'好。'}]},repeated),/ambiguous/)
})
test('real stage file registration validates content before receipt and rechecks script before downstream',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'studio-script-stage-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:`video-${id}`,brief:'prepare'}))),receipts=new Map<string,any>()
 let frozen:any=structuredClone(script),writes=0
 const workflow={script:()=>frozen,stageReceipt:(_:any,id:string)=>receipts.get(id),recordStageReceipt:(_:any,r:any)=>{writes++;receipts.set(r.stage,r)}}
 const input=(id:string)=>({task:{cwd,design:{studioStages:stages}},batch:{id:'B'},card:{id:studioStageCardId('B',1,id as any),agentId:`video-${id}`,role:'studio-stage',round:1},sessionId:id})
 const db={prepare:()=>({get:()=>({status:'done',tenant:'B',assignee:'video-storyboard'})})},base='stages/r1/storyboard',file=`${base}/arbitrary-name.json`,manifest=`${base}/manifest.json`
 await mkdir(join(cwd,base),{recursive:true});await writeFile(join(cwd,manifest),JSON.stringify({stage:'storyboard',round:1,outputs:[file],summary:'draft'}))
 await writeFile(join(cwd,file),JSON.stringify({unrelated:'json'}));await assert.rejects(registerStageFiles(input('storyboard'),manifest,workflow,db),/document-required/);assert.equal(writes,0)
 const bad=board();bad.scenes[0].frames![1].sound="line-1: '不一致。'";await writeFile(join(cwd,file),JSON.stringify(bad));await assert.rejects(registerStageFiles(input('storyboard'),manifest,workflow,db),/dialogue_text/);assert.equal(writes,0)
 await writeFile(join(cwd,file),JSON.stringify(board()));const receipt=await registerStageFiles(input('storyboard'),manifest,workflow,db)
 assert.deepEqual(receipt.scriptBinding,{scriptSha256:script.sha256,boards:[file]});await requireStudioStages(input('sound'),workflow,db)
 const legacy={...receipt};delete legacy.scriptBinding;await assert.rejects(verifyStageReceipt(input('storyboard'),legacy,workflow),/binding-required/)
 await assert.rejects(verifyStageReceipt(input('storyboard'),receipt),/script-required/)
 frozen={...frozen,sha256:'b'.repeat(64)};await assert.rejects(requireStudioStages(input('sound'),workflow,db),/stale/)
 frozen={...frozen,sha256:script.sha256,lines:[{id:'line-1',text:'变更文本'},{id:'answer',text:'一起吧！'}]};await assert.rejects(requireStudioStages(input('visual'),workflow,db),/dialogue_text/)
 assert.equal(writes,1)
})
