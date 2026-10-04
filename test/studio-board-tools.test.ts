import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink,lstat,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {registerStudioBoardTools,STUDIO_BOARD_TOOL_NAMES} from '../src/studio-board-tools.ts'
import {boardFieldDiagnostics,boardTimelineDiagnostics} from '../src/studio-board-diagnostics.ts'
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const board=()=>({schema:'studio-board-v1',duration:20,script:[{id:'L1',text:'原来的话'}],scenes:[],audio:[],font:'font.ttf',gsap:'gsap.min.js'})
test('timeline diagnostics explain all observed gaps without mutating the board or revealing source metadata',()=>{
 const b={duration:98.6,scenes:[{start:0,duration:12},{start:12,duration:2.789292},{start:22,duration:1.79375},{start:81,duration:1.963417},{start:96,duration:2.6}],audio:[{src:'secret-token-no-echo'}]}
 const before=JSON.stringify(b),d=boardTimelineDiagnostics(b)
 assert.equal(d.total,3);assert.deepEqual(d.issues.map(x=>x.kind),['gap','gap','gap']);assert.ok(Math.abs(d.issues[1].differenceSeconds-57.20625)<.000001)
 assert.match(d.action,/not the length of one spoken sentence/);assert.match(d.action,/Do not remove scenes/);assert.equal(d.qualityApproved,false);assert.equal(JSON.stringify(b),before);assert.doesNotMatch(JSON.stringify(d),/secret-token/)
})
test('timeline diagnostics respect compiler tolerance and report bounds without auto-filling',()=>{
 assert.equal(boardTimelineDiagnostics({duration:20,scenes:[{start:0,duration:12},{start:12,duration:8}]}).total,0)
 assert.equal(boardTimelineDiagnostics({duration:20,scenes:[{start:0,duration:12},{start:12.0005,duration:7.9995}]}).total,0)
 assert.equal(boardTimelineDiagnostics({duration:20,scenes:[{start:0,duration:12}]}).issues[0].kind,'incomplete-coverage')
 assert.ok(boardTimelineDiagnostics({duration:20,scenes:[{start:0,duration:12},{start:11,duration:10}]}).issues.some(i=>i.kind==='overlap'))
 const d=boardTimelineDiagnostics({duration:20,scenes:Array.from({length:60},()=>({start:30,duration:5}))});assert.equal(d.issues.length,32);assert.ok(d.total>32);assert.equal(d.truncated,true)
})
test('real tool returns aggregated timeline diagnosis only on the corresponding compiler failure',async t=>{
 const s=await setup(t,{compile:async()=>({ok:false,reason:'scene-coverage-incomplete: finalEnd=12, board.duration=20'})})
 const b={...board(),scenes:[{start:0,duration:12,layers:[{type:'image',role:'subject',src:'image.png',width:100,height:100}]}]}
 const r=await s.execute({board:b});assert.equal(r.ok,false);assert.equal(r.timingDiagnostics.issues[0].finalEnd,12);assert.equal(r.timingDiagnostics.issues[0].compositionDuration,20);assert.equal(s.calls(),1)
 assert.equal(await readFile(r.boardPath,'utf8'),JSON.stringify(b));assert.equal(r.qualityApproved,false)
 const other=await setup(t,{compile:async()=>({ok:false,reason:'unrelated-source-error'})});assert.equal((await other.execute()).timingDiagnostics,undefined)
})
test('reported production field mistakes arrive together before writes, without changing the submitted board',async t=>{
 const s=await setup(t)
 const malformed={...board(),gsap:['assets/gsap.min.js'],font:['assets/font.ttf'],
  scenes:[{id:'shot',title:'intent to preserve',start:0,duration:20,layers:[{type:'image',role:'character',src:'assets/person.png',width:300,height:500,anchorX:150,positionX:540,scale:1.2}]}],
  audio:[{type:'voice',src:'voice.wav',role:'dialogue',start:0,lineId:'L1',text:'原来的话'},{type:'sfx',src:'effect.wav',start:2}]}
 const original=JSON.stringify(malformed)
 await writeFile(join(s.cwd,'draft.json'),original)
 await assert.rejects(s.tool.execute({boardPath:'draft.json'}),(e:any)=>{
  const d=JSON.parse(e.message.slice(e.message.indexOf(': ')+2));assert.equal(d.error_code,'studio-board-field-errors');assert.equal(d.dispatched,false)
  for(const field of ['board.gsap','board.font','board.scenes[0].layers[0]','board.audio[0].role','board.audio[1].role'])assert.ok(d.issues.some((i:any)=>i.field===field),field)
  assert.match(d.action,/Preserve/);return true
 })
 assert.equal(s.calls(),0);assert.equal(await readFile(join(s.cwd,'draft.json'),'utf8'),original);assert.deepEqual(await readdir(s.cwd),['draft.json'])
})
test('diagnostics bound output, omit unknown input strings and accept documented nested motion',()=>{
 const valid={...board(),scenes:[{start:0,duration:20,layers:[{type:'image',role:'subject',src:'image.png',width:100,height:100,initial:{scale:1},motion:[{at:0,duration:2,to:{x:20},ease:'none'}]}]}],audio:[{src:'voice.wav',role:'voice',start:0,lineId:'L1',text:'原来的话'}]}
 assert.equal(boardFieldDiagnostics(valid).total,0)
 const d=boardFieldDiagnostics({...valid,scenes:Array.from({length:60},()=>({start:0,duration:1,layers:[{type:'image',width:100,height:100,'secret-value-no-echo':true,initial:{scale:'bad'}}]}))})
 assert.equal(d.issues.length,32);assert.ok(d.total>32);assert.equal(d.truncated,true);assert.doesNotMatch(JSON.stringify(d),/secret-value-no-echo/)
})
async function setup(t:any,options:any={}){
 const root=await mkdtemp(join(tmpdir(),'studio-board-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd)
 let active=true,tool:any,calls=0,disposed=false,script={lines:board().script};const policy={width:1080,height:1920,fps:30,durationMin:18,durationMax:25,...options.policy}
 const compile=async(value:any)=>{calls++;assert.equal(value.outputDirectory,options.outputDirectory??'composition-r1');assert.equal(JSON.parse(await readFile(value.boardPath,'utf8')).duration,20);if(options.compile)return options.compile({root,cwd,value,stop:()=>active=false,changeScript:()=>script={lines:[{id:'L1',text:'改变'}]}});const composition=join(cwd,value.outputDirectory);await mkdir(composition);const html='<html>compiled fixture</html>';await writeFile(join(composition,'index.html'),html);return {ok:true,composition,indexSha256:sha(html),qualityApproved:false}}
 const dispose=await registerStudioBoardTools({tools:{register:(v:any)=>{tool=v;return()=>{disposed=true}}}},{input:{task:{cwd,design:{studio:policy}},card:{role:options.role??'executor'},sessionId:'s'},workflow:{script:()=>options.noScript?null:script},isActive:()=>active,compile})
 return {root,cwd,tool,dispose,disposed:()=>disposed,calls:()=>calls,stop:()=>active=false,execute:(args:any={},exec:any=undefined)=>tool.execute({board:board(),outputDirectory:'composition-r1',...args},exec)}
}

test('actual SDK compiles object DSL and validates arguments, appends immutable JSON and verifies actual HTML',async t=>{
 const s=await setup(t);assert.deepEqual(STUDIO_BOARD_TOOL_NAMES,['studio_compile_storyboard']);assert.equal(s.tool.parameters.type,'object');assert.equal(s.tool.parameters.properties.board.type,'object');assert.equal(s.tool.parameters.properties.board.additionalProperties,true);assert.equal(s.tool.parameters.required?.length??0,0)
 await assert.rejects(s.execute({board:'serialized JSON'}),/invalid arguments/);await assert.rejects(s.tool.execute({}),/input-required/);await assert.rejects(s.execute({extra:'ignored-by-DSL'}),/unknown-argument/)
 const r=await s.execute();assert.equal(r.ok,true);assert.equal(r.qualityApproved,false);assert.equal(r.composition,join(s.cwd,'composition-r1'));assert.equal(r.boardSha256,sha(JSON.stringify(board())));assert.equal(await readFile(r.boardPath,'utf8'),JSON.stringify(board()));assert.equal(r.indexSha256,sha(await readFile(r.indexPath)));assert.equal(r.inputReused,false);assert.equal(s.calls(),1);s.dispose();assert.equal(s.disposed(),true)
})
test('bindingPath is schema-required only for components-v2 Tasks',async t=>{
 const modern=await setup(t,{policy:{visualCoverage:'components-v2'}})
 assert.ok(modern.tool.parameters.required.includes('bindingPath'))
 const legacy=await setup(t,{policy:{visualCoverage:'requirements-v1'}})
 assert.ok(!legacy.tool.parameters.required?.includes('bindingPath'))
 await assert.rejects(legacy.tool.execute({board:board(),outputDirectory:'composition-r1',bindingPath:'binding.json'}),/components-contract-required/)
})
test('role, session and inactive checks precede all compiler work',async t=>{
 for(const role of ['planner','reviewer','notifier']){const s=await setup(t,{role});await assert.rejects(s.execute(),/role-denied/);assert.equal(s.calls(),0)}
 const s=await setup(t);await assert.rejects(s.execute({}, {agent:{session:{id:'other'}}}),/session-mismatch/);s.stop();await assert.rejects(s.execute(),/stale/);assert.equal(s.calls(),0)
})
test('strict script, dimensions, duration and 1MiB input gate',async t=>{
 for(const b of [{...board(),script:[{id:'L1',text:'改词'}]},{...board(),script:[{id:'L1',text:'原来的话',extra:true}]}]){const s=await setup(t);await assert.rejects(s.execute({board:b}),/script-mismatch/);assert.equal(s.calls(),0)}
 for(const change of [{duration:17},{duration:26},{duration:'20'},{width:720},{height:1080},{fps:60},{notes:'大'.repeat(400000)}]){const s=await setup(t);await assert.rejects(s.execute({board:{...board(),...change}}),/duration-outside-policy|dimensions-mismatch|input-too-large/);assert.equal(s.calls(),0)}
 const s=await setup(t,{policy:{width:720}});await assert.rejects(s.execute(),/dimensions-mismatch/)
})
test('output directory must be new and single ASCII component, including dangling symlinks',async t=>{
 const s=await setup(t)
 for(const name of ['.','..','../escape','/tmp/out','nested/out','中文','a'.repeat(81),'bad name'])await assert.rejects(s.execute({outputDirectory:name}),/output-name-invalid/)
 await mkdir(join(s.cwd,'composition-r1'));await assert.rejects(s.execute(),/output-exists/);await rm(join(s.cwd,'composition-r1'),{recursive:true});await symlink(join(s.root,'missing'),join(s.cwd,'composition-r1'));await assert.rejects(s.execute(),/output-exists/);assert.equal(s.calls(),0)
})
test('input directory symlinks and preexisting input symlinks/content mismatches are refused',async t=>{
 const first=await setup(t);await symlink(first.root,join(first.cwd,'.studio-boards'));await assert.rejects(first.execute(),/directory-symlink/);assert.equal(first.calls(),0)
 for(const mode of ['symlink','content']){const s=await setup(t),base=join(s.cwd,'.studio-boards'),path=join(base,sha(JSON.stringify(board()))+'.json');await mkdir(base);if(mode==='symlink'){await writeFile(join(s.root,'external.json'),JSON.stringify(board()));await symlink(join(s.root,'external.json'),path)}else await writeFile(path,'different');await assert.rejects(s.execute(),/input-changed/);assert.equal(s.calls(),0)}
})
test('structured and thrown compiler failures retain input, allow exact-hash reuse and sanitize reason',async t=>{
 for(const thrown of [false,true]){const s=await setup(t,{compile:async()=>{if(thrown)throw Error('invalid-scene duration token=secretvalue');return {ok:false,reason:'invalid-scene duration token=secretvalue'}}});const r=await s.execute();assert.equal(r.ok,false);assert.equal(r.qualityApproved,false);assert.match(r.reason,/invalid-scene duration/);assert.doesNotMatch(r.reason,/secretvalue/);assert.equal(await readFile(r.boardPath,'utf8'),JSON.stringify(board()));const again=await s.execute();assert.equal(again.inputReused,true);assert.equal((await readdir(join(s.cwd,'.studio-boards'))).length,1)}
})
test('post-callback stale, input mutation and script change cannot return success',async t=>{
 for(const mode of ['stale','input','script']){const s=await setup(t,{compile:async({cwd,value,stop,changeScript}:any)=>{const composition=join(cwd,value.outputDirectory);await mkdir(composition);await writeFile(join(composition,'index.html'),'html');if(mode==='stale')stop();if(mode==='input')await writeFile(value.boardPath,'tampered');if(mode==='script')changeScript();return {ok:true,composition,indexSha256:sha('html'),qualityApproved:false}}});await assert.rejects(s.execute(),/stale|input-changed|script-changed/)}
})
test('successful callback claims are verified against paths, symlinks and HTML hash',async t=>{
 for(const mode of ['wrong-path','directory-symlink','index-symlink','wrong-hash','quality-claim']){const s=await setup(t,{compile:async({root,cwd,value}:any)=>{const composition=join(cwd,value.outputDirectory);if(mode==='directory-symlink'){await mkdir(join(root,'outside'));await symlink(join(root,'outside'),composition)}else await mkdir(composition);if(mode==='index-symlink'){await writeFile(join(root,'outside.html'),'html');await symlink(join(root,'outside.html'),join(composition,'index.html'))}else await writeFile(join(composition,'index.html'),'html');return {ok:true,composition:mode==='wrong-path'?root:composition,indexSha256:mode==='wrong-hash'?'0'.repeat(64):sha('html'),qualityApproved:mode==='quality-claim'}}});await assert.rejects(s.execute(),/receipt-invalid|directory-symlink|output-symlink|hash-mismatch/);assert.equal((await lstat(join(s.cwd,'.studio-boards'))).isDirectory(),true)}
})


test('planning document and missing root duration receive actionable errors before writing or compiling',async t=>{
 const s=await setup(t),planning={version:'studio-board-v1',dimensions:{durationMin:18,durationMax:25},script:board().script}
 await assert.rejects(s.execute({board:planning}),(e:any)=>{
  assert.match(e.message,/execution-schema-required/);const d=JSON.parse(e.message.slice(e.message.indexOf(': ')+2))
  assert.ok(d.requiredRootFields.includes('duration'));assert.match(d.action,/Keep the planned scenes/);return true
 })
 const withoutDuration={...board()};delete (withoutDuration as any).duration
 await assert.rejects(s.execute({board:withoutDuration}),(e:any)=>{
  const d=JSON.parse(e.message.slice(e.message.indexOf(': ')+2));assert.equal(d.reason,'root-duration-required');assert.equal(d.received,null);assert.equal(d.minimum,18);assert.equal(d.maximum,25);return true
 })
 assert.equal(s.calls(),0);assert.deepEqual(await readdir(s.cwd),[])
})


test('precreated source directory is preserved and the error tells the caller not to create output',async t=>{
 const s=await setup(t),dir=join(s.cwd,'composition-r1');await mkdir(dir);await writeFile(join(dir,'board.json'),'source to preserve')
 await assert.rejects(s.execute(),(e:any)=>{
  const d=JSON.parse(e.message.slice(e.message.indexOf(': ')+2));assert.equal(d.dispatched,false);assert.match(d.action,/without creating it first/);return true
 })
 assert.equal(await readFile(join(dir,'board.json'),'utf8'),'source to preserve');assert.equal(s.calls(),0)
})


test('file-backed execution freezes the actual board and derives a fresh output directory',async t=>{
 const expected='composition-'+sha(JSON.stringify(board())).slice(0,16),s=await setup(t,{outputDirectory:expected})
 const source=join(s.cwd,'source-board.json');await writeFile(source,JSON.stringify(board(),null,2))
 const result=await s.tool.execute({boardPath:'source-board.json'})
 assert.equal(result.ok,true);assert.equal(result.composition,join(s.cwd,expected));assert.equal(s.calls(),1)
 assert.deepEqual(JSON.parse(await readFile(result.boardPath,'utf8')),board());assert.equal(await readFile(source,'utf8'),JSON.stringify(board(),null,2))
})
test('file-backed compile rejects ambiguous inputs, escaping sources and malformed or oversized files before compiler work',async t=>{
 const s=await setup(t);await writeFile(join(s.root,'outside.json'),JSON.stringify(board()));await symlink(join(s.root,'outside.json'),join(s.cwd,'escape.json'))
 for(const args of [{board:board(),boardPath:'source.json'},{boardPath:'../outside.json'},{boardPath:'escape.json'},{boardPath:'/tmp/file.json'}])await assert.rejects(s.tool.execute(args),/input-required|outside-project|source-path-invalid/)
 await writeFile(join(s.cwd,'bad.json'),'{broken');await assert.rejects(s.tool.execute({boardPath:'bad.json'}),/invalid-json/)
 await writeFile(join(s.cwd,'bad.json'),'[]');await assert.rejects(s.tool.execute({boardPath:'bad.json'}),/object-required/)
 await writeFile(join(s.cwd,'big.json'),' '.repeat(1024*1024+1));await assert.rejects(s.tool.execute({boardPath:'big.json'}),/input-too-large/)
 assert.equal(s.calls(),0)
})


test('compiler errors preserve safe project-relative filenames but redact external paths and credentials',async t=>{
 for(const suffix of ['assets/missing.wav','stages/r1/visual/许小满.png']){
  const s=await setup(t,{compile:async({cwd}:any)=>({ok:false,reason:`[Errno 2] No such file or directory: '${cwd}/${suffix}'`})})
  const result=await s.execute();assert.ok(result.reason.includes('[project]/'+suffix));assert.ok(!result.reason.includes(s.cwd))
 }
 for(const path of ['/etc/private/config','/home/other/private.json','../outside/file.wav','.boss/token','.env.production','assets/credentials.json']){
  const s=await setup(t,{compile:async({cwd}:any)=>({ok:false,reason:`failed '${path.startsWith('/')?path:cwd+'/'+path}' token=secretvalue Bearer hiddenvalue https://example.com/private?key=value`})})
  const result=await s.execute();assert.match(result.reason,/\[path\]/);assert.doesNotMatch(result.reason,/outside|private|credentials|secretvalue|hiddenvalue|example|\.env|\.boss/)
 }
})


test('script mismatch exposes the exact frozen lines without dispatching or changing either source',async t=>{
 const s=await setup(t),wrong={...board(),script:[{id:'L1',text:'原来的话',speaker:'character'}]}
 await writeFile(join(s.cwd,'execution.json'),JSON.stringify(wrong))
 await assert.rejects(s.tool.execute({boardPath:'execution.json'}),(error:any)=>{
  const info=JSON.parse(error.message.slice(error.message.indexOf(': ')+2))
  assert.equal(info.dispatched,false);assert.equal(info.field,'board.script');assert.deepEqual(info.expectedLines,board().script);assert.match(info.action,/not the frozen script/);return true
 })
 assert.equal(s.calls(),0);assert.deepEqual(JSON.parse(await readFile(join(s.cwd,'execution.json'),'utf8')),wrong)
 assert.deepEqual(await readdir(s.cwd),['execution.json'])
})


test('planning schema is diagnosed before dependent frozen-script checks; grouped audio is not a track list',async t=>{
 const s=await setup(t)
 await assert.rejects(s.execute({board:{version:'studio-board-v1',scriptSha256:'a'.repeat(64),audio:{dialogue:board().script},scenes:[]}}),/execution-schema-required/)
 await assert.rejects(s.execute({board:{...board(),audio:{voice:[],music:[],sfx:[]}}}),(error:any)=>{
  const info=JSON.parse(error.message.slice(error.message.indexOf(': ')+2));assert.equal(info.field,'board.audio');assert.equal(info.dispatched,false);assert.match(info.action,/flat array/);return true
 })
 assert.equal(s.calls(),0);assert.deepEqual(await readdir(s.cwd),[])
})

test('documented planning metadata is validated and retained without changing rendering inputs',async t=>{
 const b={...board(),width:1080,height:1920,scriptSha256:sha(JSON.stringify(board().script)),
  scenes:[{id:'scene-1',title:'镜头名称',purpose:'保留原来的动作意图',start:0,duration:20,layers:[{type:'image',role:'character',src:'person.png',width:300,height:500}]}],
  visualRequirements:[{id:'req-1',sceneId:'scene-1',purpose:'角色的动作素材'}]}
 const original=JSON.stringify(b);assert.equal(boardFieldDiagnostics(b).total,0)
 const s=await setup(t);const result=await s.execute({board:b})
 assert.equal(result.ok,true);assert.equal(s.calls(),1);assert.equal(await readFile(result.boardPath,'utf8'),original);assert.equal(JSON.stringify(b),original);assert.equal(result.qualityApproved,false)
})
test('metadata rejects stale script digests, bad dimensions, ids and unbound requirements',()=>{
 const valid=()=>({...board(),width:1080,height:1920,scriptSha256:sha(JSON.stringify(board().script)),scenes:[{id:'s1',start:0,duration:20,layers:[{type:'image',src:'person.png',role:'character',width:300,height:500}]}],visualRequirements:[{id:'r1',sceneId:'s1',purpose:'action'}]})
 for(const mutate of [(b:any)=>b.width=720,(b:any)=>b.height='1920',(b:any)=>b.scriptSha256='a'.repeat(64),(b:any)=>b.scenes[0].title={},(b:any)=>b.scenes[0].purpose='',(b:any)=>b.scenes.push({...b.scenes[0]}),(b:any)=>b.visualRequirements[0].sceneId='missing',(b:any)=>b.visualRequirements.push({...b.visualRequirements[0]}),(b:any)=>b.visualRequirements[0].renderScale=2,(b:any)=>delete b.scenes[0].id]){
  const b=valid();mutate(b);assert.ok(boardFieldDiagnostics(b).total>0,JSON.stringify(b))
 }
})
test('exact unexpected ordinary field names aid repair without accepting audio or motion guesses',()=>{
 const b={...board(),audio:[{src:'x.wav',role:'voice',start:0,lineId:'L1',text:'原来的话',loop:true,type:'voice',position:{x:3}}],scenes:[{start:0,duration:20,layers:[{type:'image',src:'x.png',width:300,height:500,position:{x:1},motion:[{at:0,duration:1,to:{x:2},loop:true}]}]}]}
 const d=boardFieldDiagnostics(b)
 assert.deepEqual(d.issues.find(i=>i.field==='board.audio[0]')?.unexpectedFields,['loop','type','position'])
 assert.deepEqual(d.issues.find(i=>i.field==='board.scenes[0].layers[0]')?.unexpectedFields,['position'])
 assert.deepEqual(d.issues.find(i=>i.field==='board.scenes[0].layers[0].motion[0]')?.unexpectedFields,['loop'])
 const secret=boardFieldDiagnostics({...board(),audio:[{src:'SECRET_FILE',role:'music',start:0,'secret-token-no-echo':'SECRET_VALUE'}]})
 assert.doesNotMatch(JSON.stringify(secret),/SECRET_FILE|SECRET_VALUE|secret-token-no-echo/);assert.match(JSON.stringify(secret),/non-schema-key/)
})
