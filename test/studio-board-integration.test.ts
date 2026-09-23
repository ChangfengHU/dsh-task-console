import test from 'node:test'
import assert from 'node:assert/strict'
import {lstat,mkdtemp,mkdir,readFile,readdir,readlink,rename,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {registerStudioBoardTools} from '../src/studio-board-tools.ts'
import {compileStudioStoryboard} from '../src/studio-host.ts'

// This suite deliberately uses the deployed Python source and real ffprobe.
// No injected execute function or replacement compiler may hide CLI incompatibility.
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const compiler=resolve(packageRoot,'../autonomous-studio/compile_storyboard.py')
const workspace=resolve(packageRoot,'../..')
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64')

function wave(){
 const rate=8000,samples=rate,dataBytes=samples*2,result=Buffer.alloc(44+dataBytes)
 result.write('RIFF');result.writeUInt32LE(36+dataBytes,4);result.write('WAVEfmt ',8)
 result.writeUInt32LE(16,16);result.writeUInt16LE(1,20);result.writeUInt16LE(1,22)
 result.writeUInt32LE(rate,24);result.writeUInt32LE(rate*2,28);result.writeUInt16LE(2,32)
 result.writeUInt16LE(16,34);result.write('data',36);result.writeUInt32LE(dataBytes,40)
 for(let i=0;i<samples;i++)result.writeInt16LE(Math.round(1500*Math.sin(2*Math.PI*440*i/rate)),44+i*2)
 return result
}

async function localAsset(candidates:(string|undefined)[],fallback:Buffer){
 for(const path of candidates){
  if(!path)continue
  try{return await readFile(path)}catch(error:any){if(error.code!=='ENOENT')throw error}
 }
 // The compiler copies these opaque assets; this suite never renders or executes
 // GSAP. Keep the transport regression runnable on machines without visual assets.
 return fallback
}

function storyboard(){
 return {
  schema:'studio-board-v1',duration:2,fps:30,background:'#ffffff',
  gsap:'assets/gsap.min.js',font:'assets/font.ttf',
  script:[{id:'L1',text:'A short integration test.'}],
  scenes:[{start:0,duration:2,layers:[
   {type:'image',role:'subject',src:'assets/subject.png',width:400,height:600,x:100,y:200,
    motion:[{at:0,duration:1,to:{x:40},ease:'power2.out'}]},
   {type:'text',text:'Safe <title> & caption',width:800,height:100,x:80,y:80},
  ]}],
  audio:[{src:'assets/voice.wav',role:'voice',start:0,lineId:'L1',text:'A short integration test.'}],
 }
}

async function fixture(t:any,options:{loseResponse?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'studio-real-board-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const cwd=join(root,'project');await mkdir(join(cwd,'assets'),{recursive:true})
 const gsap=await localAsset([
  process.env.STUDIO_TEST_GSAP,
  join(workspace,'xiaoman-duvet-v5-20260919/assets/gsap.min.js'),
  join(packageRoot,'node_modules/gsap/dist/gsap.min.js'),
 ],Buffer.from('// compile-only asset fixture; no JavaScript execution\n'))
 const font=await localAsset([
  process.env.STUDIO_TEST_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  join(workspace,'xiaoman-duvet-v5-20260919/assets/Chinese.ttf'),
 ],Buffer.from('compile-only font asset fixture'))
 await Promise.all([
  writeFile(join(cwd,'assets/gsap.min.js'),gsap),
  writeFile(join(cwd,'assets/font.ttf'),font),
  writeFile(join(cwd,'assets/subject.png'),png),
  writeFile(join(cwd,'assets/voice.wav'),wave()),
 ])
 const config={storyboardCompilerScript:compiler,storyboardCompilerSha256:sha(await readFile(compiler))}
 const task={cwd,design:{studio:{width:1080,height:1920,fps:30,durationMin:1,durationMax:3}}}
 let tool:any,calls=0,active=true,lines=storyboard().script
 const input={task,card:{role:'executor'},sessionId:'real-compiler-integration'}
 const dispose=await registerStudioBoardTools({tools:{register:(value:any)=>{tool=value;return()=>{}}}},{
  input,workflow:{script:()=>({lines})},isActive:()=>active,
  compile:async value=>{calls++;const result=await compileStudioStoryboard(task,value,{config});if(options.loseResponse)throw Error('lost compiler response');return result},
 })
 t.after(dispose)
 return {root,cwd,task,config,input,calls:()=>calls,stop:()=>{active=false},changeScript:()=>{lines=[{id:'L1',text:'changed script'}]},execute:(board:any=storyboard(),outputDirectory='composition-r1',exec?:any)=>tool.execute({board,outputDirectory},exec)}
}

test('SDK → host → real Python compiler produces verifiable assets, speech and immutable revisions',async t=>{
 const f=await fixture(t),board=storyboard(),result=await f.execute(board)
 assert.equal(result.ok,true,result.reason);assert.equal(result.qualityApproved,false)
 assert.equal(result.composition,join(f.cwd,'composition-r1'));assert.equal(result.inputReused,false)
 assert.equal(result.boardPath,join(f.cwd,'.studio-boards',sha(JSON.stringify(board))+'.json'))
 assert.equal(await readFile(result.boardPath,'utf8'),JSON.stringify(board))
 assert.equal(result.boardSha256,sha(await readFile(result.boardPath)))
 const html=await readFile(result.indexPath,'utf8')
 assert.equal(result.indexSha256,sha(html));assert.match(html,/data-composition-id="main"/)
 assert.match(html,/data-duration="2"/);assert.match(html,/Safe &lt;title&gt; &amp; caption/)
 assert.match(html,/window\.__timelines\["main"\]=tl/)
 const receipt=JSON.parse(await readFile(join(result.composition,'compile-receipt.json'),'utf8'))
 assert.equal(receipt.schema,'studio-board-v1');assert.equal(receipt.qualityApproved,false)
 assert.equal(receipt.indexSha256,result.indexSha256);assert.equal(receipt.duration,2);assert.equal(receipt.fps,30)
 assert.deepEqual(Object.keys(receipt.assets).sort(),['assets/font.ttf','assets/gsap.min.js','assets/subject.png','assets/voice.wav'])
 for(const [source,asset] of Object.entries(receipt.assets) as [string,any][]){
  const original=await readFile(join(f.cwd,source)),copied=await readFile(join(result.composition,asset.file))
  assert.deepEqual(copied,original);assert.equal(asset.sha256,sha(original));assert.equal(asset.bytes,original.length)
 }
 assert.deepEqual(JSON.parse(await readFile(join(result.composition,'board.json'),'utf8')),board)
 assert.deepEqual(JSON.parse(await readFile(join(result.composition,'speech-plan.json'),'utf8')),[{
  id:'L1',text:'A short integration test.',start:0,end:1,sourcePath:'assets/voice.wav',
 }])
 const second=await f.execute(board,'composition-r2')
 assert.equal(second.ok,true,second.reason);assert.equal(second.inputReused,true)
 assert.equal(second.boardPath,result.boardPath);assert.equal(second.indexSha256,result.indexSha256)
 assert.equal(await readFile(result.indexPath,'utf8'),html)
 assert.deepEqual(await readdir(join(f.cwd,'.studio-boards')),[sha(JSON.stringify(board))+'.json'])
 const replay=await f.execute(board)
 assert.deepEqual(replay,{...result,inputReused:true,outputReused:true})
 assert.equal(f.calls(),2,'replaying the first revision must not call the compiler again')
})

test('real missing-media rejection leaves no output and can retry the same immutable board',async t=>{
 const f=await fixture(t),board=storyboard();board.audio[0].src='assets/missing.wav'
 const failed=await f.execute(board)
 assert.equal(failed.ok,false);assert.equal(failed.qualityApproved,false)
 assert.equal(failed.error,'studio-board-compile-failed');assert.match(failed.reason,/No such file or directory/)
 assert.equal(await readFile(failed.boardPath,'utf8'),JSON.stringify(board))
 assert.deepEqual((await readdir(f.cwd)).sort(),['.studio-boards','assets'])
 await writeFile(join(f.cwd,'assets/missing.wav'),wave())
 const retried=await f.execute(board)
 assert.equal(retried.ok,true,retried.reason);assert.equal(retried.inputReused,true)
 assert.equal(retried.boardPath,failed.boardPath);assert.equal(retried.boardSha256,failed.boardSha256)
})

test('real compiler refuses absolute, traversal and symlink media paths outside the project',async t=>{
 for(const mode of ['absolute','traversal','symlink'])await t.test(mode,async t=>{
  const f=await fixture(t),board=storyboard(),outside=join(f.root,'outside.png')
  await writeFile(outside,png)
  if(mode==='symlink')await symlink(outside,join(f.cwd,'assets/escape.png'))
  board.scenes[0].layers[0].src=mode==='absolute'?outside:mode==='traversal'?'../outside.png':'assets/escape.png'
  const result=await f.execute(board)
  assert.equal(result.ok,false);assert.equal(result.qualityApproved,false)
  assert.match(result.reason,mode==='absolute'?/relative-source-required/:/source-outside-project/)
  assert.doesNotMatch(result.reason,new RegExp(f.root))
  assert.deepEqual((await readdir(f.cwd)).sort(),['.studio-boards','assets'])
  assert.deepEqual(await readFile(outside),png)
 })
})

test('real audio probing enforces duration and script coverage without publishing partial output',async t=>{
 for(const mode of ['overrun','script-coverage'])await t.test(mode,async t=>{
  const f=await fixture(t),board=storyboard()
  if(mode==='overrun')board.audio[0].start=1.5
  else board.audio[0].text='The recorded line does not match the script.'
  const result=await f.execute(board)
  assert.equal(result.ok,false);assert.equal(result.qualityApproved,false)
  assert.match(result.reason,mode==='overrun'?/audio-overrun/:/script-voice-coverage-mismatch/)
  assert.deepEqual((await readdir(f.cwd)).sort(),['.studio-boards','assets'])
 })
})

test('host refuses a board outside the project, including a project-local symlink',async t=>{
 const f=await fixture(t),outside=join(f.root,'outside.json')
 await writeFile(outside,JSON.stringify(storyboard()))
 await symlink(outside,join(f.cwd,'escaped-board.json'))
 for(const boardPath of [outside,'../outside.json',join(f.cwd,'escaped-board.json')]){
  await assert.rejects(compileStudioStoryboard(f.task,{boardPath,outputDirectory:'composition-r1'},{config:f.config}),/source-outside-project/)
 }
 assert.deepEqual((await readdir(f.cwd)).sort(),['assets','escaped-board.json'])
})

async function snapshot(path:string):Promise<any>{
 const info=await lstat(path)
 if(info.isSymbolicLink())return {symlink:await readlink(path)}
 if(!info.isDirectory())return {sha256:sha(await readFile(path))}
 const result:Record<string,any>={}
 for(const name of (await readdir(path)).sort())result[name]=await snapshot(join(path,name))
 return result
}

test('a lost successful compiler response is recovered by verified replay without recompiling',async t=>{
 const f=await fixture(t,{loseResponse:true}),first=await f.execute()
 assert.equal(first.ok,false);assert.match(first.reason,/lost compiler response/)
 const before=await snapshot(f.root),replay=await f.execute()
 assert.equal(replay.ok,true);assert.equal(replay.qualityApproved,false);assert.equal(replay.outputReused,true)
 assert.equal(replay.inputReused,true);assert.equal(replay.boardPath,first.boardPath)
 assert.equal(f.calls(),1);assert.deepEqual(await snapshot(f.root),before)
})

test('replay refuses altered, incomplete or symlinked compiler artifacts without repairing them',async t=>{
 for(const mode of ['input','missing-input','source','source-escape','html','copy','board','receipt-asset','quality','speech','missing-speech','directory-symlink','assets-symlink','index-symlink'])await t.test(mode,async t=>{
  const f=await fixture(t),first=await f.execute();assert.equal(first.ok,true,first.reason)
  const output=first.composition,receiptPath=join(output,'compile-receipt.json')
  const receipt=JSON.parse(await readFile(receiptPath,'utf8')),copied=join(output,receipt.assets['assets/subject.png'].file)
  if(mode==='input')await writeFile(first.boardPath,'{}')
  if(mode==='missing-input')await rm(first.boardPath)
  if(mode==='source')await writeFile(join(f.cwd,'assets/subject.png'),'changed source')
  if(mode==='source-escape'){
   const source=join(f.cwd,'assets/subject.png'),outside=join(f.root,'outside.png')
   await rename(source,outside);await symlink(outside,source)
  }
  if(mode==='html')await writeFile(first.indexPath,'changed HTML')
  if(mode==='copy')await writeFile(copied,'changed copied asset')
  if(mode==='board')await writeFile(join(output,'board.json'),JSON.stringify({...storyboard(),background:'#000000'}))
  if(mode==='receipt-asset'){delete receipt.assets['assets/subject.png'];await writeFile(receiptPath,JSON.stringify(receipt))}
  if(mode==='quality'){receipt.qualityApproved=true;await writeFile(receiptPath,JSON.stringify(receipt))}
  if(mode==='speech'){
   const path=join(output,'speech-plan.json'),speech=JSON.parse(await readFile(path,'utf8'))
   speech[0].end=.5;await writeFile(path,JSON.stringify(speech))
  }
  if(mode==='missing-speech')await rm(join(output,'speech-plan.json'))
  if(mode==='directory-symlink'){
   const outside=join(f.root,'outside-composition');await rename(output,outside);await symlink(outside,output)
  }
  if(mode==='assets-symlink'){
   const assets=join(output,'assets'),outside=join(f.root,'outside-assets');await rename(assets,outside);await symlink(outside,assets)
  }
  if(mode==='index-symlink'){
   const outside=join(f.root,'outside.html');await rename(first.indexPath,outside);await symlink(outside,first.indexPath)
  }
  const before=await snapshot(f.root)
  await assert.rejects(f.execute(),/output-exists|input-changed/)
  assert.equal(f.calls(),1);assert.deepEqual(await snapshot(f.root),before)
 })
})

test('replay preserves frozen board, role, session, active-run and script gates',async t=>{
 const f=await fixture(t),first=await f.execute();assert.equal(first.ok,true,first.reason)
 const changed=storyboard();changed.background='#000000'
 await assert.rejects(f.execute(changed),/output-exists/)
 assert.equal((await readdir(join(f.cwd,'.studio-boards'))).length,1,'conflicting replay must not create a new frozen input')
 f.input.card.role='reviewer';await assert.rejects(f.execute(),/role-denied/)
 f.input.card.role='executor'
 await assert.rejects(f.execute(storyboard(),'composition-r1',{agent:{session:{id:'other'}}}),/session-mismatch/)
 f.changeScript();await assert.rejects(f.execute(),/script-mismatch/)
 f.stop();await assert.rejects(f.execute(),/stale/)
 assert.equal(f.calls(),1)
})
