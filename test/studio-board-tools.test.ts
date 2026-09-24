import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink,lstat,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {registerStudioBoardTools,STUDIO_BOARD_TOOL_NAMES} from '../src/studio-board-tools.ts'
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const board=()=>({schema:'studio-board-v1',duration:20,script:[{id:'L1',text:'原来的话'}],scenes:[],audio:[],font:'font.ttf',gsap:'gsap.min.js'})
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
