/** Host-ledger/workflow integration only. Every capability/render/observation
 * fact below is a test fixture, not an actual render, listening or visual QA.
 * No external provider, renderer, media generation or production DB is used.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {createHash} from 'node:crypto'
import {StudioWorkflow} from '../src/studio-workflow.js'
import {DEFAULT_DIMENSIONS} from '../src/studio-evidence.mjs'
import {buildStudioReviewCoveragePlan} from '../src/studio-review-coverage.mjs'
import {readStudioRepairRounds} from '../src/studio-repair-budget.js'

const h=(c:string)=>c.repeat(64),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const doc=(value:any)=>{const bytes=Buffer.from(JSON.stringify(value));return {bytes,sha256:sha(bytes)}}
function setup(t:any){
 const db=new Database(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,tenant TEXT,round INTEGER,role TEXT); CREATE TABLE dsh_card_bindings(card_id TEXT PRIMARY KEY,spec_id TEXT,batch_id TEXT);')
 db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run('e1','B',1,'executor');db.prepare('INSERT INTO dsh_card_bindings VALUES(?,?,?)').run('e1','T','B')
 const store:any={kernel:{db},s:{runs:new Map([['render-run-1',{id:'render-run-1',cardId:'e1',sessionId:'producer',status:'running'}]])}},workflow=new StudioWorkflow(store)
 const task:any={id:'T',cwd:'/fixture/studio-project',design:{evidenceContract:'studio-video-v1',studio:{characterId:'fixture',referenceSha256:h('b'),referenceUrl:'https://cdn.vyibc.com/fixture.mp4',reviewCoverage:'scene-action-v1',structuredRepairs:true,maxRepairRounds:3}}}
 const input:any={task,batch:{id:'B'},card:{id:'p1',role:'planner',round:1},sessionId:'planner'}
 const producer={...input,card:{id:'e1',role:'executor',round:1},sessionId:'producer'},reviewer={...input,card:{id:'r1',role:'reviewer',round:1},sessionId:'reviewer'}
 for(const name of ['frames','audio','audio_calibration','render','character','reference'] as const)workflow.recordCapability(task,{name,status:'passed',proofSha256:h('d'),checkedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),...(['audio','audio_calibration'].includes(name)?{method:'actual_audio'}:{})})
 workflow.preflight(task)
 const lines=[{id:'one',text:'完整原稿台词。'}],scriptSha256=sha(JSON.stringify(lines));workflow.recordScript(input,{sha256:scriptSha256,lines})
 const storyboard={scriptSha256,script:lines,scenes:[{id:'opening'},{id:'middle'},{id:'ending'}]},execution={schema:'studio-board-v1',duration:100,script:lines,scenes:[
  {id:'opening',start:0,duration:30,layers:[{type:'image',motion:[{at:5,duration:4,to:{x:10}}]}]},
  {id:'middle',start:30,duration:40,layers:[{type:'image',motion:[{at:10,duration:5,to:{rotation:10}}]}]},
  {id:'ending',start:70,duration:30,layers:[{type:'image',motion:[{at:25,duration:3,to:{y:10}}]}]},
 ]}
 const plan=buildStudioReviewCoveragePlan({storyboard:doc(storyboard),executionBoard:doc(execution),scriptSha256}),composition='composition-fixture',indexSha256=sha('<html>test-provided compiler output, not a rendered film</html>')
 workflow.recordCompiledCoverage(producer,{composition,indexSha256,plan})
 const candidate={sha256:h('a'),manifestSha256:h('c'),referenceSha256:h('b'),revision:1,durationSeconds:100,width:1080,height:1920,fps:30}
 const reserveBudget=()=>workflow.recordBudget(input,{repairRounds:readStudioRepairRounds(store,input),used:{imageCalls:0,voiceSegments:0},limits:{imageCalls:6,voiceSegments:80},maxRepairRounds:3,exceeded:false});reserveBudget()
 const fakeRender=(current=candidate,output='film.mp4',index=indexSha256)=>{
  const job=workflow.renderLedger.prepare(producer,'start',{composition,output},{renderJobScript:'/fixture/trusted/render.py',renderJobSha256:h('d'),renderRuntime:'/fixture/runtime'})
  workflow.renderLedger.record(producer,job,{ok:true,intentId:job.intentId,jobId:sha(output),inputSha256:h('f'),inputIndexSha256:index,composition,output,state:'completed',outputSha256:current.sha256,width:current.width,height:current.height,fps:current.fps,durationSeconds:current.durationSeconds,helperSha256:h('d'),helperPath:'/fixture/trusted/render.py',runtimePath:'/fixture/runtime'})
  return {path:task.cwd+'/'+output,manifestPath:task.cwd+'/manifest.json',sha256:current.sha256}
 }
 const register=(current=candidate,output='film.mp4')=>workflow.recordRenderedCandidate(producer,current,fakeRender(current,output))
 const observe=(current=candidate,openingOnly=false)=>{
  const frameRanges:number[][]=openingOnly?[[0,1]]:[...new Map(plan.targets.flatMap((target:any)=>target.ranges).map((range:number[])=>[JSON.stringify(range),range])).values()]
  const receipts=frameRanges.map(range=>workflow.recordReceipt(reviewer,{candidateSha256:current.sha256,kind:'frames',ranges:[range],sha256:h('d')}))
  for(let start=0;start<100;start+=8)receipts.push(workflow.recordReceipt(reviewer,{candidateSha256:current.sha256,kind:'audio',ranges:[[start,Math.min(100,start+8)]],sha256:h('d')}))
  for(const kind of ['probe','source'])receipts.push(workflow.recordReceipt(reviewer,{candidateSha256:current.sha256,kind,ranges:[[0,100]],sha256:h('d')}))
  const review:any={candidateSha256:current.sha256,referenceSha256:current.referenceSha256,revision:current.revision,issues:[],checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:'pass',finding:'Test-provided host observations; this is not human aesthetic approval.',ranges:['technical','source_records','intelligibility','performance','mix'].includes(dimension)?[[0,100]]:dimension==='ending'&&!openingOnly?[[98,100]]:frameRanges,evidenceReceiptIds:receipts.map((r:any)=>r.id)}))}
  return {receipts,review}
 }
 const issue=(current=candidate)=>({id:'motion-middle',dimension:'motion',severity:'major',status:'open',ranges:[[40,42]],sceneId:'middle',lineId:'one',responsibleStage:'visual',cause:'The reaction occurs before the triggering pose.',repair:{action:'Insert the trigger pose before the reaction.',target:'middle action poses',fromCandidateSha256:current.sha256},verification:{method:'frames',finding:'Inspect the trigger, contact and later reaction in this interval.',evidenceReceiptIds:[]}})
 return {db,store,workflow,input,producer,reviewer,plan,candidate,storyboard,execution,scriptSha256,composition,indexSha256,fakeRender,register,observe,issue,reserveBudget}
}

test('strict compile plan binds exact host index and actual candidate identity atomically',t=>{
 const f=setup(t),location=f.fakeRender(f.candidate,'wrong-index.mp4',h('e'))
 assert.throws(()=>f.workflow.recordRenderedCandidate(f.producer,f.candidate,location),/render-source-mismatch/)
 assert.equal(f.workflow.status(f.input).candidate,null)
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM dsh_studio_state WHERE kind='candidate_review_coverage'").get().n,0)
 assert.throws(()=>f.workflow.compiledCoverage({...f.producer,card:{...f.producer.card,round:2}},f.composition),/compiled-source-required/)
 const correct=f.fakeRender(f.candidate,'correct-index.mp4')
 assert.ok(f.workflow.recordRenderedCandidate(f.producer,f.candidate,correct))
 const coverage=f.workflow.reviewProgress(f.reviewer)!.reviewCoverage
 assert.equal(coverage.planSha256,f.plan.planSha256);assert.equal(coverage.executionBoardSha256,f.plan.executionBoardSha256)
 assert.equal(f.workflow.status(f.reviewer).candidate.sha256,f.candidate.sha256)
 assert.throws(()=>f.workflow.recordRenderedCandidate(f.producer,{...f.candidate,sha256:h('e'),revision:2},correct),/current-render-required/)
})
test('opening-only evidence cannot be submitted as a passing strict-profile review',t=>{
 const f=setup(t);f.register();const {review}=f.observe(f.candidate,true)
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,review),/review-integrity-failed.*reviewCoverage/)
 assert.equal(f.workflow.status(f.reviewer).review,null)
 assert.equal(f.workflow.reviewProgress(f.reviewer)!.reviewCoverage.observationsComplete,false)
 assert.throws(()=>f.workflow.complete(f.input),/trusted-review-required/)
})
test('direct candidate registration cannot bypass the missing host-bound coverage plan',t=>{
 const f=setup(t)
 // Deliberately call the lower-level API, omitting host render/coverage binding.
 f.workflow.recordCandidate(f.producer,f.candidate)
 const {review}=f.observe()
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,review),/review-integrity-failed.*reviewCoverage.*verified host plan required/)
 assert.equal(f.workflow.status(f.reviewer).review,null)
 assert.equal(f.workflow.reviewProgress(f.reviewer)!.reviewCoverage.status,'blocked')
 assert.throws(()=>f.workflow.complete(f.input),/trusted-review-required/)
})
test('all source-derived targets allow only a machine-assessed candidate, never human approval',t=>{
 const f=setup(t);f.register();const {review}=f.observe();f.workflow.recordValidatedReview(f.reviewer,review)
 const progress=f.workflow.reviewProgress(f.reviewer)!
 assert.equal(progress.reviewCoverage.observationsComplete,true);assert.equal(progress.reviewCoverage.qualityApproved,false);assert.equal(progress.frames.fullFrameCoverage,false)
 assert.equal(f.workflow.complete(f.reviewer).metadata.workflowOutcome,'review_complete')
 const final=f.workflow.complete(f.input)
 assert.equal(final.metadata.workflowOutcome,'machine_assessed_candidate');assert.equal(final.metadata.autonomy.autonomousVerified,false);assert.match(final.summary,/非用户审美认可/)
})
test('metadata-only candidate revision refreshes binding without adding a production repair round',t=>{
 const f=setup(t);f.register();const next={...f.candidate,revision:99,manifestSha256:h('e')}
 const location={path:f.input.task.cwd+'/film.mp4',manifestPath:f.input.task.cwd+'/manifest-r99.json',sha256:next.sha256}
 f.workflow.recordRenderedCandidate(f.producer,next,location);f.reserveBudget()
 assert.equal(f.workflow.status(f.input).candidate.revision,99);assert.equal(f.workflow.status(f.input).budget.repairRounds,0)
 assert.equal(f.workflow.reviewProgress(f.reviewer)!.revision,99)
})
test('grounded negative review can hand off before coverage is complete but cannot finalize',t=>{
 const f=setup(t);f.register()
 const probe=f.workflow.recordReceipt(f.reviewer,{candidateSha256:f.candidate.sha256,kind:'probe',ranges:[[0,100]],sha256:h('d')})
 const report:any={candidateSha256:f.candidate.sha256,referenceSha256:f.candidate.referenceSha256,revision:1,checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:dimension==='technical'?'fail':'pending',finding:dimension==='technical'?'Test-provided probe establishes a technical defect.':'Not observed yet; complete coverage is still pending.',ranges:[[0,100]],evidenceReceiptIds:dimension==='technical'?[probe.id]:[]})),issues:[{...f.issue(),id:'technical-opening',dimension:'technical',sceneId:'opening',ranges:[[0,2]],responsibleStage:'executor',cause:'Actual fixture probe indicates the encode is unsuitable.',repair:{action:'Correct the encoder specification.',target:'encoded output',fromCandidateSha256:f.candidate.sha256},verification:{method:'probe',finding:'Probe the repaired encode for the required format.',evidenceReceiptIds:[]}}]}
 f.workflow.recordValidatedReview(f.reviewer,report)
 assert.equal(f.workflow.complete(f.reviewer).metadata.workflowOutcome,'review_needs_changes')
 assert.equal(f.workflow.reviewProgress(f.reviewer)!.reviewCoverage.observationsComplete,false)
 assert.throws(()=>f.workflow.complete(f.input),/quality-gate-failed/)
})
test('prior unresolved issue cannot vanish and requires a changed candidate with new verification',t=>{
 const f=setup(t);f.register();const first=f.observe().review;first.checks.find((c:any)=>c.dimension==='motion').status='fail';first.issues=[f.issue()]
 f.workflow.recordValidatedReview(f.reviewer,first)
 const next={...f.candidate,revision:2,sha256:h('e')};f.register(next,'repaired-film.mp4');const repaired=f.observe(next)
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,repaired.review),/prior unresolved issue omitted/)
 const old=f.workflow.status(f.input).review;assert.equal(old.candidateSha256,f.candidate.sha256)
 const ids=repaired.receipts.filter((r:any)=>r.kind==='frames'&&r.ranges.some((range:number[])=>range[0]<=40&&range[1]>=42)).map((r:any)=>r.id)
 repaired.review.issues=[{...f.issue(),status:'verified',verification:{method:'frames',finding:'New candidate frames show the trigger before the reaction.',evidenceReceiptIds:ids}}]
 f.workflow.recordValidatedReview(f.reviewer,repaired.review)
 assert.equal(f.workflow.complete(f.reviewer).metadata.workflowOutcome,'review_complete')
 assert.equal(f.workflow.complete(f.input).metadata.workflowOutcome,'machine_assessed_candidate')
})
test('report correction on the same candidate preserves an open finding without forcing a new film',t=>{
 const f=setup(t);f.register();const first=f.observe().review;first.checks.find((c:any)=>c.dimension==='motion').status='fail';first.issues=[f.issue()]
 f.workflow.recordValidatedReview(f.reviewer,first)
 const corrected=structuredClone(first);corrected.checks[0].finding='Corrected technical wording; same host evidence and unresolved motion finding.'
 assert.doesNotThrow(()=>f.workflow.recordValidatedReview(f.reviewer,corrected))
 assert.equal(f.workflow.complete(f.reviewer).metadata.workflowOutcome,'review_needs_changes')
})

function failedOriginal(f:ReturnType<typeof setup>){
 f.register();const first=f.observe().review;first.checks.find((c:any)=>c.dimension==='motion').status='fail';first.issues=[f.issue()]
 f.workflow.recordValidatedReview(f.reviewer,first)
 return structuredClone(first.issues[0])
}
function registerFixtureRevision(f:ReturnType<typeof setup>,storyboard:any,execution:any,durationSeconds=100){
 const plan=buildStudioReviewCoveragePlan({storyboard:doc(storyboard),executionBoard:doc(execution),scriptSha256:f.scriptSha256,sceneMappings:execution.scenes.map((scene:any,sceneIndex:number)=>({sceneIndex,originalSceneId:scene.id}))})
 const indexSha256=sha('<html>in-memory revised compiler receipt, not real rendering</html>')
 f.workflow.recordCompiledCoverage(f.producer,{composition:f.composition,indexSha256,plan})
 const candidate={...f.candidate,sha256:h('e'),revision:2,durationSeconds}
 f.workflow.recordRenderedCandidate(f.producer,candidate,f.fakeRender(candidate,'revised-film.mp4',indexSha256))
 const frameRanges:number[][]=[...new Map(plan.targets.flatMap((target:any)=>target.kind==='ending'?[[Math.max(0,durationSeconds-2),durationSeconds]]:target.ranges.map((range:number[])=>[range[0],Math.min(range[1],durationSeconds)])).map((range:number[])=>[JSON.stringify(range),range])).values()]
 const receipts=frameRanges.map(range=>f.workflow.recordReceipt(f.reviewer,{candidateSha256:candidate.sha256,kind:'frames',ranges:[range],sha256:h('d')}))
 for(let start=0;start<durationSeconds;start+=8)receipts.push(f.workflow.recordReceipt(f.reviewer,{candidateSha256:candidate.sha256,kind:'audio',ranges:[[start,Math.min(durationSeconds,start+8)]],sha256:h('d')}))
 for(const kind of ['probe','source'])receipts.push(f.workflow.recordReceipt(f.reviewer,{candidateSha256:candidate.sha256,kind,ranges:[[0,durationSeconds]],sha256:h('d')}))
 const review:any={candidateSha256:candidate.sha256,referenceSha256:candidate.referenceSha256,revision:candidate.revision,issues:[],checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:'pass',finding:'Test-provided current host observations, not actual media QA.',ranges:['technical','source_records','intelligibility','performance','mix'].includes(dimension)?[[0,durationSeconds]]:dimension==='ending'?[[Math.max(0,durationSeconds-2),durationSeconds]]:frameRanges.map(range=>[...range]),evidenceReceiptIds:receipts.map((r:any)=>r.id)}))}
 return {candidate,receipts,review}
}
function mappedIssue(original:any,sceneId:string,ranges:number[][],receipts:any[]){
 return {...structuredClone(original),status:'verified',verification:{method:'frames',finding:'The replacement progression is shown in current-candidate evidence.',evidenceReceiptIds:receipts.filter(r=>r.kind==='frames').map(r=>r.id),location:{sceneId,ranges}}}
}
test('host workflow preserves deleted-scene history and verifies only a current correctly timed replacement',t=>{
 const f=setup(t),original=failedOriginal(f),story=structuredClone(f.storyboard),execution=structuredClone(f.execution)
 story.scenes[1].id='replacement';execution.scenes[1].id='replacement'
 const revised=registerFixtureRevision(f,story,execution);revised.review.issues=[mappedIssue(original,'replacement',[[40,42]],revised.receipts)]
 const wrong=structuredClone(revised.review);wrong.issues[0].verification.location.sceneId='opening'
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,wrong),/verification ranges outside current sceneId/)
 assert.equal(f.workflow.status(f.input).review.candidateSha256,f.candidate.sha256,'rejected mapping must not replace history')
 f.workflow.recordValidatedReview(f.reviewer,revised.review)
 assert.equal(f.workflow.complete(f.input).metadata.workflowOutcome,'machine_assessed_candidate')
 const stored=f.workflow.status(f.input).review.issues[0]
 assert.equal(stored.sceneId,'middle');assert.deepEqual(stored.ranges,[[40,42]]);assert.equal(stored.repair.fromCandidateSha256,f.candidate.sha256)
 assert.deepEqual(stored.verification.location,{sceneId:'replacement',ranges:[[40,42]]})
})
test('host workflow keeps split-scene spans separate and binds line verification to the current speech plan',t=>{
 const f=setup(t),original=failedOriginal(f),story=structuredClone(f.storyboard)
 story.scenes.push({id:'interruption'})
 const execution={...structuredClone(f.execution),scenes:[
  {id:'opening',start:0,duration:30,layers:[{}]},
  {id:'middle',start:30,duration:15,layers:[{}]},
  {id:'interruption',start:45,duration:10,layers:[{}]},
  {id:'middle',start:55,duration:15,layers:[{}]},
  {id:'ending',start:70,duration:30,layers:[{}]},
 ]}
 const revised=registerFixtureRevision(f,story,execution)
 revised.review.issues=[mappedIssue(original,'middle',[[44,56]],revised.receipts)]
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,revised.review),/verification ranges outside current sceneId/)
 revised.review.issues[0].verification.location.ranges=[[40,42]];revised.review.issues[0].verification.location.lineId='one'
 const local=f.workflow.recordReceipt(f.reviewer,{candidateSha256:revised.candidate.sha256,kind:'frames',ranges:[[40,42]],sha256:h('d')})
 revised.review.issues[0].verification.evidenceReceiptIds.push(local.id);const motion=revised.review.checks.find((c:any)=>c.dimension==='motion');motion.ranges.push([40,42]);motion.evidenceReceiptIds.push(local.id)
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,revised.review),/host verification lineId ranges required/)
 f.workflow.recordSpeechPlan(f.producer,{candidateSha256:revised.candidate.sha256,scriptSha256:f.scriptSha256,planSha256:h('d'),lines:[{id:'one',text:f.execution.script[0].text,start:10,end:12}]})
 assert.throws(()=>f.workflow.recordValidatedReview(f.reviewer,revised.review),/verification ranges outside current lineId/)
 f.workflow.recordSpeechPlan(f.producer,{candidateSha256:revised.candidate.sha256,scriptSha256:f.scriptSha256,planSha256:h('f'),lines:[{id:'one',text:f.execution.script[0].text,start:40,end:42}]})
 f.workflow.recordValidatedReview(f.reviewer,revised.review)
 assert.equal(f.workflow.complete(f.input).metadata.workflowOutcome,'machine_assessed_candidate')
})
test('host verification scene tail follows the actual candidate duration within the existing frame tolerance',t=>{
 for(const duration of [99.98,100.03]){
  const f=setup(t),original=failedOriginal(f),revised=registerFixtureRevision(f,f.storyboard,f.execution,duration)
  revised.review.issues=[mappedIssue(original,'ending',[[98,duration]],revised.receipts)]
  // Existing <=2-second nominal/live-ending frame windows jointly cover this
  // range; do not mint an impossible >2-second native inspection fixture.
  f.workflow.recordValidatedReview(f.reviewer,revised.review)
  assert.equal(f.workflow.complete(f.input).metadata.workflowOutcome,'machine_assessed_candidate')
 }
})
