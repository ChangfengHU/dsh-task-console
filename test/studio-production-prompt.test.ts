import test from 'node:test'
import assert from 'node:assert/strict'
import {cardMessage} from '../src/tasks.ts'
import {studioStageRows,validateStudioStages} from '../src/studio-stages.ts'
const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:`video-${id}`,brief:'Prepare actual materials'})))
const task:any={id:'task',title:'Video',brief:'Make the film',participants:[{agentId:'director'},{agentId:'editor'},{agentId:'reviewer'}],graphMode:'dynamic-rounds',design:{evidenceContract:'studio-video-v1',studioStages:stages}}
const message=(role:string)=>cardMessage(task,{id:'card',index:0,round:2,role,agentId:'test',brief:'Use actual materials'} as any,'batch',[])
test('real sound card receives authenticated download, source-card and failure paths with its frozen script rules',()=>{
 const sound=studioStageRows(task,'batch',2,'planner').find(c=>c.agentId==='video-sound')!
 const prompt=cardMessage(task,{...sound,index:0} as any,'batch',[])
 assert.match(prompt,/studio_download_asset\(\{id:实际素材ID,path:新的项目相对路径\}\)/)
 assert.match(prompt,/asset_get\(id\)/);assert.match(prompt,/扩展名必须与归档一致/)
 assert.match(prompt,/source-only.*不能把页面\/来源卡当音频/);assert.match(prompt,/不要循环重试同一个 source-only ID/)
 assert.match(prompt,/不自行拼接 \/api\/media\/assets/);assert.match(prompt,/不读取、替换或输出凭据/)
 assert.match(prompt,/asset-file-auth-failed/);assert.match(prompt,/output-exists-with-other-bytes/);assert.match(prompt,/output-extension-mismatch/)
 assert.match(prompt,/studio_status.state.script/);assert.match(prompt,/stages\/r2\/sound\//);assert.match(prompt,/studio_status.state.stages/)
 assert.doesNotMatch(prompt,/\[STUDIO REAL RENDER\]/)
})
test('executor has actual rendering failure instructions and cannot manufacture placeholder candidates',()=>{
 const prompt=message('executor');assert.match(prompt,/\[STUDIO MEDIA ACQUISITION\]/);assert.match(prompt,/\[STUDIO REAL RENDER\]/)
 assert.match(prompt,/当前会话实际工具 schema/);assert.match(prompt,/不臆造接口、名称或参数/);assert.match(prompt,/渲染缺依赖或命令失败时先 studio_status/)
 assert.match(prompt,/失败命令、退出码、脱敏错误/);assert.match(prompt,/结果未知先对账/)
 assert.match(prompt,/禁止 touch 空 \.mp4/);assert.match(prompt,/黑屏\/单色占位片/)
 assert.match(prompt,/studio_register_candidate\(\{path,manifestPath,revision\}\)/)
})
test('media acquisition instructions do not grant downloads to planner/reviewer or unrelated tasks',()=>{
 for(const role of ['planner','reviewer'])assert.doesNotMatch(message(role),/\[STUDIO MEDIA ACQUISITION\]|\[STUDIO REAL RENDER\]/)
 const other=cardMessage({...task,design:undefined},{id:'x',index:0,role:'executor',round:1,brief:'Inspect'} as any,'B',[])
 assert.doesNotMatch(other,/studio_download_asset|\[STUDIO REAL RENDER\]/)
})


test('new executor handoff carries compiler ownership and actual resource discovery without granting it to other roles',()=>{
 const prompt=message('executor')
 assert.match(prompt,/\[STUDIO EXECUTION BOARD\]/);assert.match(prompt,/studio_status.executionAssets/);assert.match(prompt,/voice音轨逐条含lineId\/text/)
 assert.match(prompt,/studio_compile_storyboard\(\{boardPath:相对JSON路径\}\)/);assert.match(prompt,/pending-generation不是存在的图片/);assert.match(prompt,/不删除旧版规避output-exists/)
 for(const role of ['planner','reviewer','studio-stage'])assert.doesNotMatch(message(role),/\[STUDIO EXECUTION BOARD\]/)
})
