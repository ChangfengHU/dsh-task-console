import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod,open,copyFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {registerStageFiles} from '../src/studio-stage-files.ts'
import {validateStudioStages,studioStageCardId,studioStageRows} from '../src/studio-stages.ts'
const run=promisify(execFile)
async function setup(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'stage-errors-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const receipts=new Map(),script={sha256:'a'.repeat(64),lines:[{id:'a',text:'你好'}]}
 const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:`video-${id}`,brief:'prepare'})))
 const input=(id:string)=>({task:{cwd,design:{studioStages:stages}},batch:{id:'B'},card:{id:studioStageCardId('B',1,id as any),agentId:`video-${id}`,role:'studio-stage',round:1},sessionId:id})
 const workflow={script:()=>script,stageReceipt:(_:any,id:string)=>receipts.get(id),recordStageReceipt:(_:any,r:any)=>receipts.set(r.stage,r)},db={prepare:()=>({get:()=>({status:'done',tenant:'B',assignee:'video-storyboard'})})}
 const manifest=async(id:string,outputs:string[])=>{const base=`stages/r1/${id}`,p=`${base}/manifest.json`;await mkdir(join(cwd,base),{recursive:true});await writeFile(join(cwd,p),JSON.stringify({stage:id,round:1,outputs,summary:'test'}));return p}
 const path=await manifest('storyboard',['stages/r1/storyboard/board.json']);await writeFile(join(cwd,'stages/r1/storyboard/board.json'),JSON.stringify({scriptSha256:script.sha256,script:script.lines,scenes:[]}));await registerStageFiles(input('storyboard'),path,workflow,db)
 return {cwd,receipts,input,workflow,db,manifest}
}
async function details(fn:()=>Promise<unknown>){try{await fn();assert.fail('expected failure')}catch(e:any){assert.match(e.message,/^studio-stage-/);return JSON.parse(e.message.slice(e.message.indexOf(': ')+2))}}
test('JSON-only visual manifest gets explicit schema and verified own-stage candidates, without implicit writes',async t=>{
 const s=await setup(t),base='stages/r1/visual/',p=await s.manifest('visual',[base+'plan.json']);await writeFile(join(s.cwd,base+'plan.json'),'{}')
 await mkdir(join(s.cwd,base+'poses'));await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=16x16','-frames:v','1','-threads','1','-y',join(s.cwd,base+'poses/real.png')])
 await writeFile(join(s.cwd,base+'bad.png'),'{}');await symlink('/etc/hosts',join(s.cwd,base+'outside.png'));await mkdir(join(s.cwd,'stages/r2/visual'),{recursive:true});await symlink(join(s.cwd,base+'poses/real.png'),join(s.cwd,base+'alias.png'))
 const before=await readFile(join(s.cwd,p),'utf8'),d=await details(()=>registerStageFiles(s.input('visual'),p,s.workflow,s.db))
 assert.equal(d.error_code,'studio-stage-media-required');assert.equal(d.field,'outputs');assert.deepEqual(d.arguments,{path:p});assert.equal(d.manifestSchema.stage,'visual');assert.equal(d.manifestSchema.round,1)
 assert.deepEqual(d.eligibleExistingMedia.map((c:any)=>c.path),[base+'poses/real.png']);assert.equal(d.eligibleExistingMedia[0].media.width,16)
 assert.equal(d.qualityApproved,false);assert.match(d.action,/explicitly list/);assert.match(d.action,/not selected poses/);assert.equal(s.receipts.has('visual'),false);assert.equal(await readFile(join(s.cwd,p),'utf8'),before)
 assert.ok(!JSON.stringify(d).includes(s.cwd));assert.ok(!JSON.stringify(d).includes('/etc/hosts'))
 await s.manifest('visual',[base+'plan.json',base+'poses/real.png']);assert.equal((await registerStageFiles(s.input('visual'),p,s.workflow,s.db)).outputs.length,2)
})
test('missing manifest argument/path and missing output report exact repair field without guessed registration',async t=>{
 const s=await setup(t),base='stages/r1/sound/',p=await s.manifest('sound',[base+'not-ready.wav'])
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','0.1','-y',join(s.cwd,base+'real.wav')])
 for(const requested of [undefined,base+'absent.json']){
  const d=await details(()=>registerStageFiles(s.input('sound'),requested as any,s.workflow,s.db));assert.equal(d.field,'path');assert.equal(d.arguments.path,p);assert.deepEqual(d.eligibleExistingMedia.map((c:any)=>c.path),[base+'real.wav'])
 }
 const d=await details(()=>registerStageFiles(s.input('sound'),p,s.workflow,s.db));assert.equal(d.error_code,'studio-stage-output-missing');assert.equal(d.field,'outputs[0]');assert.match(d.reason,/Do not remove required dialogue/);assert.equal(s.receipts.has('sound'),false)
 await s.manifest('sound',[]);assert.equal((await details(()=>registerStageFiles(s.input('sound'),p,s.workflow,s.db))).field,'outputs')
})
test('suggestions do not follow a stage directory symlink into another round',async t=>{
 const s=await setup(t);await mkdir(join(s.cwd,'stages/r2/visual'),{recursive:true});await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=16x16','-frames:v','1','-threads','1','-y',join(s.cwd,'stages/r2/visual/other.png')]);await symlink(join(s.cwd,'stages/r2/visual'),join(s.cwd,'stages/r1/visual'))
 const d=await details(()=>registerStageFiles(s.input('visual'),'stages/r1/visual/missing.json',s.workflow,s.db));assert.deepEqual(d.eligibleExistingMedia,[])
})
test('diagnostic probe hangs are killed within a five-second total scan budget',async t=>{
 const s=await setup(t),base='stages/r1/visual/',p=await s.manifest('visual',[base+'plan.json']);await writeFile(join(s.cwd,base+'plan.json'),'{}')
 for(let i=0;i<8;i++)await writeFile(join(s.cwd,base+`candidate-${i}.png`),'unverified image')
 const executable=join(s.cwd,'hanging-ffprobe'),pids=join(s.cwd,'probe-pids')
 await writeFile(executable,`#!/usr/bin/python3\nimport os,signal,time\nwith open(${JSON.stringify(pids)},'a') as out: out.write(str(os.getpid())+'\\n')\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(60)\n`);await chmod(executable,0o700)
 const previous=process.env.FFPROBE_PATH;let d:any,elapsed=0
 try{process.env.FFPROBE_PATH=executable;const start=performance.now();d=await details(()=>registerStageFiles(s.input('visual'),p,s.workflow,s.db));elapsed=performance.now()-start}finally{if(previous===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=previous}
 assert.ok(elapsed<6500,`diagnostic took ${elapsed}ms`);assert.ok(elapsed>=4000);assert.equal(d.scan.truncated,true);assert.equal(d.scan.complete,false);assert.equal(d.scan.deadlineMs,5000);assert.deepEqual(d.eligibleExistingMedia,[])
 const spawned=(await readFile(pids,'utf8')).trim().split('\n').map(Number);assert.ok(spawned.length>=4&&spawned.length<=5)
 for(const pid of spawned)assert.throws(()=>process.kill(pid,0),(error:any)=>error.code==='ESRCH',`probe ${pid} still exists`)
 assert.equal(s.receipts.has('visual'),false)
})
test('oversized diagnostic candidates are skipped without hashing or pretending the scan is complete',async t=>{
 const s=await setup(t),base='stages/r1/visual/',p=await s.manifest('visual',[base+'plan.json']);await writeFile(join(s.cwd,base+'plan.json'),'{}')
 const file=await open(join(s.cwd,base+'large.png'),'w');try{await file.truncate(5*1024*1024)}finally{await file.close()}
 const d=await details(()=>registerStageFiles(s.input('visual'),p,s.workflow,s.db));assert.equal(d.scan.bytesRead,0);assert.equal(d.scan.probed,0);assert.equal(d.scan.truncated,true);assert.equal(d.scan.complete,false);assert.deepEqual(d.eligibleExistingMedia,[])
})

test('outside-stage asset and stage-relative basename identify the exact output; explicit copy and full paths succeed',async t=>{
 const s=await setup(t),base='stages/r1/visual/',source='assets/pose.png',p=await s.manifest('visual',[source,base+'visual-plan.json'])
 await mkdir(join(s.cwd,'assets'));await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=16x16','-frames:v','1','-threads','1','-y',join(s.cwd,source)])
 await writeFile(join(s.cwd,base+'visual-plan.json'),'{}')
 const original=await readFile(join(s.cwd,source)),manifestBefore=await readFile(join(s.cwd,p),'utf8')
 const outside=await details(()=>registerStageFiles(s.input('visual'),p,s.workflow,s.db))
 assert.equal(outside.error_code,'studio-stage-output-invalid');assert.equal(outside.field,'outputs[0]');assert.equal(outside.outputIndex,0)
 assert.equal(outside.pathContract.basis,'task-workspace-relative');assert.equal(outside.pathContract.requiredPrefix,base)
 assert.deepEqual(outside.pathContract.exampleOutputs,[base+'visual-plan.json',base+'pose.png']);assert.equal(outside.pathContract.examplesArePlaceholders,true)
 assert.match(outside.reason,/outside the current stage/);assert.match(outside.reason,/preserve the original/)
 assert.equal(s.receipts.has('visual'),false);assert.equal(await readFile(join(s.cwd,p),'utf8'),manifestBefore)
 assert.deepEqual(await readFile(join(s.cwd,source)),original);await assert.rejects(readFile(join(s.cwd,base+'pose.png')),{code:'ENOENT'})
 assert.ok(!JSON.stringify(outside).includes(s.cwd))
 // The caller explicitly performs the repair; registration must never copy assets.
 await copyFile(join(s.cwd,source),join(s.cwd,base+'pose.png'))
 await s.manifest('visual',[base+'pose.png','visual-plan.json'])
 const basenameBefore=await readFile(join(s.cwd,p),'utf8'),missing=await details(()=>registerStageFiles(s.input('visual'),p,s.workflow,s.db))
 assert.equal(missing.error_code,'studio-stage-output-missing');assert.equal(missing.field,'outputs[1]');assert.equal(missing.outputIndex,1)
 assert.match(missing.reason,/Task workspace root/);assert.match(missing.reason,/not a stage-relative basename/)
 assert.equal(missing.pathContract.requiredPrefix,base);assert.equal(s.receipts.has('visual'),false)
 assert.equal(await readFile(join(s.cwd,p),'utf8'),basenameBefore)
 await s.manifest('visual',[base+'pose.png',base+'visual-plan.json'])
 const receipt=await registerStageFiles(s.input('visual'),p,s.workflow,s.db)
 assert.deepEqual(receipt.outputs.map((row:any)=>row.path),[base+'pose.png',base+'visual-plan.json'])
 assert.equal(receipt.outputs[0].media.kind,'image');assert.equal(receipt.qualityApproved,false)
 assert.deepEqual(await readFile(join(s.cwd,source)),original)
 const brief=studioStageRows(s.input('visual').task,'B',1,'planner').find(row=>row.id==='B#s1-visual')!.brief
 assert.match(brief,/相对 Task 工作区根目录/);assert.match(brief,/stages\/r1\/visual\/ 前缀/)
})
