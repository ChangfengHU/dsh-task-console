import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {bindAudioRequirements,soundReceiptRequirementEvidence} from '../src/studio-audio-requirements.ts'
import {registerStageFiles,verifyStageReceipt} from '../src/studio-stage-files.ts'
import {studioStageCardId,validateStudioStages} from '../src/studio-stages.ts'
import {bindSoundPlan} from '../src/studio-sound-plan.ts'
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex')
const script={sha256:'a'.repeat(64),lines:[{id:'L1',text:'fixture dialogue'}]}
const required=()=>({bgm:[{id:'bgm1',purpose:'music intent'}],sfx:[{id:'sfx1',purpose:'effect intent'}]})
const plainPlan=()=>({bgm:[{id:'bgm1'}],sfx:[{id:'sfx1'}]})
test('original IDs and kinds bind, while purpose changes and unrelated cues cannot satisfy missing requirements',()=>{
 const board={audioRequirements:required()},p:any=plainPlan();p.bgm=[]
 assert.throws(()=>bindAudioRequirements(board,script.sha256,p),/missingRequirementIds.*bgm1/)
 p.bgm=[{id:'other',purpose:'music intent'}];assert.throws(()=>bindAudioRequirements(board,script.sha256,p),/bgm1/)
 p.bgm=[{id:'edited-cue',requirementId:'bgm1'}];p.sfx=[{id:'sfx1'},{id:'repeated',requirementId:'sfx1'}]
 const r=bindAudioRequirements(board,script.sha256,p);assert.equal(r.status,'verified');assert.deepEqual(r.requiredIds,{bgm:['bgm1'],sfx:['sfx1']});assert.deepEqual(r.matches[1].cueIndexes,[0,1]);assert.equal(r.semanticSuitability,'unverified')
 p.bgm[0].requirementId='sfx1';assert.throws(()=>bindAudioRequirements(board,script.sha256,p),/exact audio kind/)
})
test('absent requirements are explicitly unverified, declared empty arrays allow silence, malformed declarations fail',()=>{
 const absent=bindAudioRequirements({brief:'music is requested'},script.sha256,{bgm:[],sfx:[]});assert.equal(absent.status,'unverified');assert.equal(absent.requiredIds,null)
 assert.equal(bindAudioRequirements({audioRequirements:{bgm:[],sfx:[]}},script.sha256,{bgm:[],sfx:[]}).status,'verified')
 for(const r of [undefined,null,[],{}, {bgm:[],sfx:'none'}, {bgm:[{purpose:'music'}],sfx:[]},{bgm:[{id:'x'},{id:'x'}],sfx:[]},{bgm:[{id:'x',purpose:42}],sfx:[]}])assert.throws(()=>bindAudioRequirements({audioRequirements:r},script.sha256,plainPlan()),/studio-audio-requirements-invalid/)
})
function wav(){const count=3200,b=Buffer.alloc(44+count*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)b.writeInt16LE(Math.round(2000*Math.sin(i*.2)),44+i*2);return b}
async function fixture(t:any,requirements:any=required()){
 const cwd=await mkdtemp(join(tmpdir(),'sound-required-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const stages=validateStudioStages(['storyboard','visual','sound'].map(id=>({id,agentId:'agent-'+id,brief:id}))),receipts=new Map(),states=new Map()
 const workflow={script:()=>script,stageReceipt:(i:any,id:string)=>receipts.get(`${i.card.round}:${id}`),recordStageReceipt:(i:any,r:any)=>receipts.set(`${i.card.round}:${r.stage}`,r)}
 const db={prepare:()=>({get:(id:string)=>states.get(id)})}
 const input=(id:string,round=1)=>({task:{id:'T',cwd,design:{studioStages:stages}},batch:{id:'B'},card:{id:studioStageCardId('B',round,id as any),agentId:'agent-'+id,role:'studio-stage',round},sessionId:'session-'+id+'-'+round})
 const prepare=async(round=1,req:any=requirements)=>{
  const storyDir=`stages/r${round}/storyboard`,soundDir=`stages/r${round}/sound`;await mkdir(join(cwd,storyDir),{recursive:true});await mkdir(join(cwd,soundDir),{recursive:true})
  const board:any={scenes:[{id:'S1',sound:'L1'}],scriptSha256:script.sha256,script:script.lines,...(req==='absent'?{}:{audioRequirements:req})}
  const boardPath=storyDir+'/storyboard.json';await writeFile(join(cwd,boardPath),JSON.stringify(board));await writeFile(join(cwd,storyDir,'manifest.json'),JSON.stringify({stage:'storyboard',round,outputs:[boardPath],summary:'fixture'}))
  const story=await registerStageFiles(input('storyboard',round),storyDir+'/manifest.json',workflow,db);states.set(studioStageCardId('B',round,'storyboard'),{status:'done',tenant:'B',assignee:'agent-storyboard'})
  const source=soundDir+'/audio.wav',planPath=soundDir+'/sound-plan.json';await writeFile(join(cwd,source),wav())
  const plan:any={schema:'sound-plan-v1',scriptSha256:script.sha256,lines:[{...script.lines[0],sourcePath:source,start:0,end:.2}],bgm:[{id:'bgm1',path:source,start:0,end:.2}],sfx:[{id:'sfx1',path:source,start:.2,end:.4}]}
  await writeFile(join(cwd,soundDir,'manifest.json'),JSON.stringify({stage:'sound',round,outputs:[planPath,source],summary:'fixture'}))
  const register=async()=>{await writeFile(join(cwd,planPath),JSON.stringify(plan));return registerStageFiles(input('sound',round),soundDir+'/manifest.json',workflow,db)}
  return {story,board,boardPath,plan,planPath,source,register}
 }
 return {cwd,input,workflow,receipts,states,db,prepare,...await prepare()}
}
test('actual stage registration rejects deleted BGM/SFX and binds v3 to the original registered storyboard hash',async t=>{
 const f=await fixture(t),bgm=f.plan.bgm,sfx=f.plan.sfx
 f.plan.bgm=[];await assert.rejects(f.register(),/missingRequirementIds.*bgm1/);assert.equal(f.receipts.has('1:sound'),false)
 f.plan.bgm=bgm;f.plan.sfx=[];await assert.rejects(f.register(),/missingRequirementIds.*sfx1/)
 f.plan.sfx=sfx;f.plan.bgm[0]={...bgm[0],id:'selected-track',requirementId:'bgm1'}
 const receipt=await f.register();assert.equal(receipt.stageContractVersion,3);assert.equal(receipt.soundBinding.audioRequirements.storyboardSha256,f.story.outputs[0].sha256)
 assert.deepEqual(receipt.soundBinding.audioRequirements.requiredIds,{bgm:['bgm1'],sfx:['sfx1']});assert.equal(receipt.soundBinding.tracks.length,3)
 assert.equal(await verifyStageReceipt(f.input('sound'),receipt,f.workflow),undefined);assert.equal(soundReceiptRequirementEvidence(receipt).status,'verified')
})
test('new registration permits explicit no-music or missing metadata without inventing coverage',async t=>{
 for(const requirements of [{bgm:[],sfx:[]},'absent']){
  const f=await fixture(t,requirements);f.plan.bgm=[];f.plan.sfx=[];const r=await f.register()
  assert.equal(r.soundBinding.audioRequirements.status,requirements==='absent'?'unverified':'verified');assert.deepEqual(r.soundBinding.audioRequirements.requiredIds,requirements==='absent'?null:{bgm:[],sfx:[]})
 }
})
test('malformed original requirements fail at sound handoff instead of becoming no requirements',async t=>{
 const f=await fixture(t,{bgm:'music',sfx:[]});await assert.rejects(f.register(),/audioRequirements.bgm/);assert.equal(f.receipts.has('1:sound'),false)
})
test('deleting original requirements or modifying delivered cues invalidates existing hash-bound receipts',async t=>{
 const f=await fixture(t),r=await f.register(),old=await readFile(join(f.cwd,f.boardPath));delete f.board.audioRequirements;await writeFile(join(f.cwd,f.boardPath),JSON.stringify(f.board))
 await assert.rejects(verifyStageReceipt(f.input('sound'),r,f.workflow),/file-changed/)
 await assert.rejects(f.register(),/file-changed/)
 await writeFile(join(f.cwd,f.boardPath),old);f.plan.bgm=[];await writeFile(join(f.cwd,f.planPath),JSON.stringify(f.plan));await assert.rejects(verifyStageReceipt(f.input('sound'),r,f.workflow),/file-changed/)
 // Even a newly registered upstream revision cannot silently rebind an existing sound receipt.
 await writeFile(join(f.cwd,f.planPath),JSON.stringify({...f.plan,bgm:[{id:'bgm1',path:f.source,start:0,end:.2}]}))
 f.board.audioRequirements=required();f.board.audioRequirements.bgm[0].purpose='revised intent';await writeFile(join(f.cwd,f.boardPath),JSON.stringify(f.board));await registerStageFiles(f.input('storyboard'),'stages/r1/storyboard/manifest.json',f.workflow,f.db)
 await assert.rejects(verifyStageReceipt(f.input('sound'),r,f.workflow),/Sound binding changed/)
})
test('each round binds its own requirements and rejects borrowing an earlier round receipt',async t=>{
 const f=await fixture(t),first=await f.register(),second=await f.prepare(2,{bgm:[{id:'bgm2'}],sfx:[]})
 second.plan.sfx=[];await assert.rejects(second.register(),/bgm2/);second.plan.bgm[0].requirementId='bgm2';const next=await second.register()
 assert.notEqual(next.soundBinding.audioRequirements.storyboardSha256,first.soundBinding.audioRequirements.storyboardSha256)
 f.receipts.set('2:storyboard',f.story);await assert.rejects(verifyStageReceipt(f.input('sound',2),next,f.workflow),/canonical storyboard|receipt-required/)
 await assert.rejects(verifyStageReceipt({...f.input('sound'),batch:{id:'OTHER'}},first,f.workflow),/receipt-required/)
})
test('legacy v2 receipt replays its original binding without rewriting or claiming original-demand verification',async t=>{
 const f=await fixture(t),r=await f.register();const legacy=structuredClone(r);legacy.stageContractVersion=2;delete legacy.soundBinding.audioRequirements
 const bytes=JSON.stringify(legacy),workflow={...f.workflow,stageReceipt:()=>{throw Error('legacy must not read a new requirement contract')}}
 assert.deepEqual(legacy.soundBinding,bindSoundPlan(f.plan,script,legacy.outputs,legacy.outputs.find((o:any)=>o.path===f.planPath)))
 assert.equal(await verifyStageReceipt(f.input('sound'),legacy,workflow),undefined);const evidence=soundReceiptRequirementEvidence(legacy);assert.equal(evidence.status,'unverified');assert.match(evidence.reason??'',/legacy/);assert.equal(JSON.stringify(legacy),bytes)
})
