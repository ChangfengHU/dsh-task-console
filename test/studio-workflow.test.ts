import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioWorkflow} from '../src/studio-workflow.js'
import {DEFAULT_DIMENSIONS} from '../src/studio-evidence.mjs'
const h=(c:string)=>c.repeat(64)
function setup(t:any){const db=new Database(':memory:');t.after(()=>db.close());const workflow=new StudioWorkflow({kernel:{db}});const task:any={id:'studio-task',design:{evidenceContract:'studio-video-v1',studio:{characterId:'character-any',referenceSha256:h('b'),referenceUrl:'https://cdn.vyibc.com/approved.mp4'}}};const input:any={task,batch:{id:'batch1'},card:{role:'planner'},sessionId:'planner'};return {workflow,task,input}}
function capabilities(w:StudioWorkflow,task:any){for(const name of ['frames','audio','audio_calibration','render','character','reference'] as const)w.recordCapability(task,{name,status:'passed',proofSha256:h('d'),checkedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),...(['audio','audio_calibration'].includes(name)?{method:'actual_audio'}:{})})}
function proof(w:StudioWorkflow,input:any){capabilities(w,input.task);w.preflight(input.task);const candidate={sha256:h('a'),manifestSha256:h('c'),referenceSha256:h('b'),revision:1,durationSeconds:100,width:1080,height:1920,fps:30};w.recordCandidate({...input,card:{role:'executor'},sessionId:'producer'},candidate);const reviewer={...input,card:{role:'reviewer'},sessionId:'reviewer'};const receipts=['frames','audio','probe','source'].map(kind=>w.recordReceipt(reviewer,{candidateSha256:h('a'),kind,ranges:[[0,100]],sha256:h('d')}));w.recordReview(reviewer,{candidateSha256:h('a'),referenceSha256:h('b'),revision:1,checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:'pass',finding:'Actual candidate inspected.',ranges:[[0,100]],evidenceReceiptIds:receipts.map(r=>r.id)})),issues:[]});w.recordBudget(input,{repairRounds:0});return {reviewer,candidate}}
test('unconfigured host fails preflight with every missing capability',t=>{const {workflow,task}=setup(t);const r=workflow.preflight(task);assert.equal(r.ok,false);assert.equal(r.status,'blocked_quality_capability');for(const name of ['frames','audio','audio_calibration','render','character','reference'])assert.ok(r.reason?.includes(name))})
test('plan requires recorded passing preflight',t=>{const {workflow,task,input}=setup(t);assert.throws(()=>workflow.plan(input),/preflight-required/);capabilities(workflow,task);assert.throws(()=>workflow.plan(input),/preflight-required/);workflow.preflight(task);assert.deepEqual(workflow.plan(input),{ok:true,status:'ready'})})
test('model metadata cannot supply capabilities or review',t=>{const {workflow,input}=setup(t);input.metadata={ok:true,review:{status:'pass'},audio_calibration:true};assert.throws(()=>workflow.complete(input),/blocked_quality_capability/);capabilities(workflow,input.task);workflow.preflight(input.task);assert.throws(()=>workflow.complete(input),/trusted-review-required/)})
test('access denied is never success, including disguised successful reason',t=>{const {workflow,task}=setup(t);const value:any={name:'audio',status:'passed',method:'actual_audio',proofSha256:h('d'),checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),reason:'HTTP 403 access_denied'};assert.throws(()=>workflow.recordCapability(task,value),/invalid-pass/);value.status='access_denied';workflow.recordCapability(task,value);assert.equal(workflow.preflight(task).checks.find(c=>c.name==='audio')?.ok,false)})
test('ASR text does not prove listening or calibrated assessment',t=>{const {workflow,task}=setup(t);assert.throws(()=>workflow.recordCapability(task,{name:'audio_calibration',status:'passed',method:'asr',proofSha256:h('d'),checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}),/actual-audio/)})
test('strict capability schema rejects model overrides',t=>{const {workflow,task}=setup(t);assert.throws(()=>workflow.recordCapability(task,{name:'audio',status:'passed',ok:true} as any),/schema/)})
test('passing trusted host records permit only machine-assessed candidate',t=>{const {workflow,input}=setup(t);proof(workflow,input);assert.equal(workflow.complete(input).metadata.workflowOutcome,'machine_assessed_candidate')})
test('receipts bind generated ID and actual reviewer, caller cannot supply identity',t=>{const {workflow,input}=setup(t);proof(workflow,input);assert.throws(()=>workflow.recordReceipt({...input,card:{role:'reviewer'}},{id:'fake',sessionId:'reviewer'}),/schema/);assert.throws(()=>workflow.recordReceipt({...input,card:{role:'executor'}},{}),/reviewer-required/)})
test('old batch and changed policy cannot pass',t=>{const {workflow,input}=setup(t);proof(workflow,input);assert.throws(()=>workflow.complete({...input,batch:{id:'batch2'}}),/trusted-review-required/);input.task.design.studio.characterId='changed';assert.throws(()=>workflow.complete(input),/preflight-required/)})
test('new candidate invalidates prior version review',t=>{const {workflow,input}=setup(t);const {candidate}=proof(workflow,input);workflow.recordCandidate({...input,card:{role:'executor'},sessionId:'producer'}, {...candidate,revision:2,sha256:h('e')});assert.throws(()=>workflow.complete(input),/quality-gate-failed/)})
test('manual rescue blocks autonomous success',t=>{const {workflow,input}=setup(t);proof(workflow,input);workflow.recordIntervention(input,'Human repaired scene');assert.throws(()=>workflow.complete(input),/manual interventions/)})
test('new access denial invalidates prior capability result',t=>{const {workflow,input}=setup(t);proof(workflow,input);workflow.recordCapability(input.task,{name:'audio',status:'access_denied',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});assert.throws(()=>workflow.complete(input),/preflight-required/)})
test('missing budget does not default to zero',t=>{const {workflow,input}=setup(t);capabilities(workflow,input.task);workflow.preflight(input.task);assert.throws(()=>workflow.complete(input),/trusted-review-required/)})
test('executor hands off candidate without pretending review passed',t=>{const {workflow,input}=setup(t);const {candidate}=proof(workflow,input);const producer={...input,card:{role:'executor'},sessionId:'producer'};(workflow as any).db.prepare("DELETE FROM dsh_studio_state WHERE kind='review'").run();assert.equal(workflow.complete(producer).metadata.workflowOutcome,'candidate_handoff');assert.throws(()=>workflow.complete({...producer,sessionId:'other'}),/producer-session-mismatch/)})
test('negative real review completes handoff but planner acceptance stays blocked',t=>{const {workflow,input}=setup(t);const {reviewer}=proof(workflow,input);const db=(workflow as any).db;const row=db.prepare("SELECT payload FROM dsh_studio_state WHERE kind='review'").get();const review=JSON.parse(row.payload);delete review.reviewerSessionId;review.checks.find((c:any)=>c.dimension==='motion').status='fail';review.issues=[{id:'motion-poor',severity:'major',status:'open'}];workflow.recordReview(reviewer,review);assert.equal(workflow.complete(reviewer).metadata.workflowOutcome,'review_needs_changes');assert.throws(()=>workflow.complete(input),/quality-gate-failed/)})
test('negative review still requires genuine audio evidence',t=>{const {workflow,input}=setup(t);const {reviewer}=proof(workflow,input);const db=(workflow as any).db;db.prepare("DELETE FROM dsh_studio_receipts WHERE json_extract(payload,'$.kind')='audio'").run();assert.throws(()=>workflow.complete(reviewer),/review-integrity-failed/)})

test('grounded rejection survives dependency outage but production and approval remain blocked',t=>{
 const {workflow,input}=setup(t),{reviewer}=proof(workflow,input),review=workflow.status(input).review
 delete review.reviewerSessionId
 review.checks.find((c:any)=>c.dimension==='technical').status='fail';review.issues=[{id:'empty-film',severity:'blocker',status:'open'}];workflow.recordReview(reviewer,review)
 workflow.recordCapability(input.task,{name:'character',status:'failed',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),reason:'temporary transport failure'});workflow.preflight(input.task)
 assert.equal(workflow.hasRejection(reviewer),true)
 assert.equal(workflow.complete(reviewer).metadata.workflowOutcome,'review_needs_changes')
 assert.throws(()=>workflow.complete(input),/character=failed/)
 assert.throws(()=>workflow.complete({...input,card:{role:'executor'},sessionId:'producer'}),/character=failed/)
 review.checks.find((c:any)=>c.dimension==='technical').status='pass';review.issues=[];workflow.recordReview(reviewer,review)
 assert.equal(workflow.hasRejection(reviewer),false);assert.throws(()=>workflow.complete(reviewer),/character=failed/)
})

test('missing audio can be pending on grounded technical rejection, never final acceptance',t=>{
 const {workflow,input}=setup(t),{reviewer}=proof(workflow,input),review=workflow.status(input).review
 delete review.reviewerSessionId
 review.checks.find((c:any)=>c.dimension==='technical').status='fail'
 review.issues=[{id:'no-audio-stream',severity:'blocker',status:'open'}]
 for(const c of review.checks.filter((c:any)=>['intelligibility','performance','mix','ending'].includes(c.dimension))){c.status='pending';c.finding='Cannot inspect nonexistent audio; technical probe proves missing stream.';c.evidenceReceiptIds=[]}
 workflow.recordReview(reviewer,review)
 assert.equal(workflow.complete(reviewer).metadata.workflowOutcome,'review_needs_changes')
 assert.throws(()=>workflow.complete(input),/quality-gate-failed/)
 review.checks.find((c:any)=>c.dimension==='performance').status='pass';workflow.recordReview(reviewer,review);assert.throws(()=>workflow.complete(reviewer),/review-integrity-failed/)
 review.checks.find((c:any)=>c.dimension==='performance').status='pending'
 review.checks.find((c:any)=>c.dimension==='technical').status='pending';workflow.recordReview(reviewer,review);assert.throws(()=>workflow.complete(reviewer),/review-integrity-failed/)
 review.checks.find((c:any)=>c.dimension==='technical').status='fail'
 review.checks.find((c:any)=>c.dimension==='performance').evidenceReceiptIds=['invented'];workflow.recordReview(reviewer,review);assert.throws(()=>workflow.complete(reviewer),/unknown receipt/)
})
test('passing reviewer cannot directly declare final film acceptance',t=>{const {workflow,input}=setup(t);const {reviewer}=proof(workflow,input);assert.equal(workflow.complete(reviewer).metadata.workflowOutcome,'review_complete');assert.equal(workflow.complete(input).metadata.workflowOutcome,'machine_assessed_candidate')})
test('preflight denial shows sanitized details and actual status',t=>{const {workflow,task}=setup(t);workflow.recordCapability(task,{name:'audio',status:'access_denied',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),reason:'HTTP 403 token=private123 https://service.example/?key=secret'});const r=workflow.preflight(task);assert.match(r.reason??'',/blocked_quality_capability.*audio=access_denied/);assert.ok(!r.reason?.includes('private123'));assert.ok(!r.reason?.includes('service.example'))})
test('negative issue ID may contain a colon',t=>{const {workflow,input}=setup(t);const {reviewer}=proof(workflow,input);const r=workflow.status(input).review;delete r.reviewerSessionId;r.issues=[{id:'audio:quiet',severity:'major',status:'open'}];workflow.recordReview(reviewer,r);assert.equal(workflow.complete(reviewer).metadata.workflowOutcome,'review_needs_changes')})
test('public status exposes only specified task data without location or raw capabilities',t=>{const {workflow,input}=setup(t);proof(workflow,input);assert.deepEqual(Object.keys(workflow.status(input)).sort(),['budget','candidate','interventions','preflight','referenceReceipts','review','script','skillLoads','speechChecks','speechPlan']);assert.equal(workflow.status({...input,batch:{id:'other'}}).candidate,null)})
test('candidate location binds batch, policy and current candidate hash',t=>{const {workflow,input}=setup(t);const {candidate}=proof(workflow,input);const producer={...input,card:{role:'executor'},sessionId:'producer'};const location={path:'/project/final.mp4',manifestPath:'/project/manifest.json',sha256:candidate.sha256};workflow.recordCandidateLocation(producer,location);assert.deepEqual(workflow.candidateLocation(input),location);assert.throws(()=>workflow.candidateLocation({...input,batch:{id:'other'}}),/location-mismatch/);workflow.recordCandidate(producer,{...candidate,revision:2,sha256:h('e')});assert.throws(()=>workflow.candidateLocation(input),/location-mismatch/)})
test('location rejects model identity fields, mismatch, reviewer write and relative paths',t=>{const {workflow,input}=setup(t);const {candidate}=proof(workflow,input);const producer={...input,card:{role:'executor'},sessionId:'producer'},location={path:'/project/final.mp4',manifestPath:'/project/manifest.json',sha256:candidate.sha256};assert.throws(()=>workflow.recordCandidateLocation(input,location),/producer-required/);assert.throws(()=>workflow.recordCandidateLocation(producer,{...location,sha256:h('e')}),/location-mismatch/);assert.throws(()=>workflow.recordCandidateLocation(producer,{...location,path:'relative.mp4'}),/location-path/);assert.throws(()=>workflow.recordCandidateLocation(producer,{...location,sessionId:'fake'} as any),/schema/)})

test('enforced runtime cannot plan without frozen script and actual reference samples',t=>{const {workflow,input}=setup(t);capabilities(workflow,input.task);workflow.preflight(input.task);workflow.enforceRuntime(input);assert.throws(()=>workflow.plan(input),/script-and-direct-reference/);workflow.recordScript(input,{sha256:h('c'),lines:[{id:'1',text:'完整台词。'}]});for(const kind of ['frames','audio'])workflow.recordReferenceReceipt(input,{referenceSha256:h('b'),sha256:h('d'),kind,ranges:[[0,8]]});assert.equal(workflow.plan(input).ok,true)})
test('runtime requires complete speech plan and forbids arbitrary script replacement',t=>{const {workflow,input}=setup(t);proof(workflow,input);workflow.enforceRuntime(input);workflow.recordScript(input,{sha256:h('c'),lines:[{id:'1',text:'完整台词。'}]});assert.throws(()=>workflow.recordScript(input,{sha256:h('d'),lines:[{id:'1',text:'删去台词。'}]}),/independent-review/);assert.throws(()=>workflow.complete({...input,card:{role:'executor'},sessionId:'producer'}),/speech-plan-required/)})

test('capability refresh invalidates snapshot; rebuild before planning gate',t=>{const {workflow,input}=setup(t);capabilities(workflow,input.task);workflow.preflight(input.task);capabilities(workflow,input.task);assert.throws(()=>workflow.plan(input),/preflight-required/);workflow.preflight(input.task);assert.equal(workflow.plan(input).ok,true)})

test('producer reference observations are role stamped and cannot substitute independent candidate receipts',t=>{
 const {workflow,input}=setup(t),{reviewer,candidate}=proof(workflow,input),producer={...input,card:{role:'executor'},sessionId:'producer'}
 const ref=workflow.recordReferenceReceipt(producer,{referenceSha256:h('b'),sha256:h('d'),kind:'audio',ranges:[[0,8]],sessionId:'reviewer',role:'reviewer'})
 assert.equal(ref.sessionId,'producer');assert.equal(ref.role,'executor')
 assert.throws(()=>workflow.recordReceipt(producer,{candidateSha256:candidate.sha256,sha256:h('d'),kind:'audio',ranges:[[0,8]]}),/reviewer-required/)
 workflow.recordReview(reviewer,{candidateSha256:candidate.sha256,referenceSha256:h('b'),revision:1,checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:'pass',finding:'Cannot borrow producer reference.',ranges:[[0,100]],evidenceReceiptIds:[ref.id]})),issues:[]})
 assert.throws(()=>workflow.complete(input),/quality-gate-failed/)
})

test('planning error names only missing prerequisites and matching repair tools; summaries cannot repair audio',t=>{
 const {workflow,input}=setup(t);capabilities(workflow,input.task);workflow.preflight(input.task);workflow.enforceRuntime(input)
 const details=()=>{try{workflow.plan(input);assert.fail('expected planning gate')}catch(error){assert.match((error as Error).message,/^studio-plan-requires-script-and-direct-reference: /);return JSON.parse((error as Error).message.split(': ').slice(1).join(': '))}}
 const initial=details();assert.deepEqual(initial.missing.map((v:any)=>v.tool),['studio_freeze_script','studio_reference_frames','studio_reference_audio']);assert.equal(initial.retryable,false);assert.equal(initial.retryAfterRepair,true)
 workflow.recordScript(input,{sha256:h('c'),lines:[{id:'1',text:'完整台词。'}]})
 workflow.recordReferenceReceipt(input,{referenceSha256:h('b'),sha256:h('d'),kind:'frames',ranges:[[0,2]]})
 input.metadata={audioSha256:h('d'),referenceSummary:'I heard the reference.',referenceAudioReviewed:true}
 const missing=details();assert.deepEqual(missing.missing.map((v:any)=>v.id),['current_session_reference_audio']);assert.equal(missing.missing[0].tool,'studio_reference_audio');assert.match(missing.instruction,/another session/)
 const before=workflow.status(input).planning;assert.equal(before?.ready,false);assert.equal(before?.preflightReady,true);assert.deepEqual(before?.missing,missing.missing)
 workflow.recordReferenceReceipt(input,{referenceSha256:h('b'),sha256:h('d'),kind:'audio',ranges:[[0,8]]})
 assert.deepEqual(workflow.plan(input),{ok:true,status:'ready'});assert.equal(workflow.status(input).planning?.ready,true)
})

test('planning readiness cannot borrow another session, batch or changed policy reference observations',t=>{
 const {workflow,input}=setup(t);capabilities(workflow,input.task);workflow.preflight(input.task);workflow.enforceRuntime(input)
 workflow.recordScript(input,{sha256:h('c'),lines:[{id:'1',text:'完整台词。'}]})
 for(const kind of ['frames','audio'])workflow.recordReferenceReceipt({...input,sessionId:'old-planner'},{referenceSha256:h('b'),sha256:h('d'),kind,ranges:[[0,2]]})
 assert.deepEqual(workflow.status(input).planning?.missing.map((v:any)=>v.id),['current_session_reference_frames','current_session_reference_audio'])
 for(const kind of ['frames','audio'])workflow.recordReferenceReceipt({...input,batch:{id:'other-batch'}},{referenceSha256:h('b'),sha256:h('d'),kind,ranges:[[0,2]]})
 assert.equal(workflow.status(input).planning?.prerequisitesReady,false)
 for(const kind of ['frames','audio'])workflow.recordReferenceReceipt(input,{referenceSha256:h('b'),sha256:h('d'),kind,ranges:[[0,2]]})
 assert.equal(workflow.status(input).planning?.ready,true)
 input.task.design.studio.referenceSha256=h('e');capabilities(workflow,input.task);workflow.preflight(input.task)
 assert.equal(workflow.status(input).planning?.prerequisitesReady,false);assert.throws(()=>workflow.plan(input),/current_session_reference_audio/)
})

test('planning readiness distinguishes repaired prerequisites from unavailable preflight and stays planner-scoped',t=>{
 const {workflow,input}=setup(t);workflow.enforceRuntime(input);workflow.recordScript(input,{sha256:h('c'),lines:[{id:'1',text:'完整台词。'}]})
 for(const kind of ['frames','audio'])workflow.recordReferenceReceipt(input,{referenceSha256:h('b'),sha256:h('d'),kind,ranges:[[0,2]]})
 const p=workflow.status(input).planning;assert.equal(p?.prerequisitesReady,true);assert.equal(p?.preflightReady,false);assert.equal(p?.ready,false)
 assert.throws(()=>workflow.plan(input),/blocked_quality_capability/)
 assert.equal(workflow.status({...input,card:{role:'executor'}}).planning,undefined)
})

test('identical candidate registration retries preserve review, speech plan and receipts',t=>{
 const {workflow,input}=setup(t),{candidate}=proof(workflow,input),producer={...input,card:{role:'executor'},sessionId:'producer'}
 workflow.recordScript(input,{sha256:h('c'),lines:[{id:'1',text:'完整台词。'}]})
 workflow.recordSpeechPlan(producer,{candidateSha256:candidate.sha256,scriptSha256:h('c'),planSha256:h('f'),lines:[{id:'1',text:'完整台词。'}]})
 const before=workflow.status(input),stored=workflow.recordCandidate(producer,{...candidate})
 assert.deepEqual(stored.candidate,candidate);assert.deepEqual(workflow.status(input),before)
 const reversed=Object.fromEntries(Object.entries(candidate).reverse());assert.deepEqual(workflow.recordCandidate(producer,reversed),stored)
 assert.equal(workflow.complete(input).metadata.workflowOutcome,'machine_assessed_candidate')
 for(const field of ['sha256','manifestSha256','referenceSha256','durationSeconds','width','height','fps'])assert.throws(()=>workflow.recordCandidate(producer,{...candidate,[field]:typeof (candidate as any)[field]==='number'?1:h('e')}),/revision-must-increase/)
 assert.deepEqual(workflow.status(input),before)
})

test('candidate retry cannot transfer to a restored session or another round, card or policy',t=>{
 const {workflow,input}=setup(t),producer={...input,card:{id:'producer-r1',round:1,role:'executor'},sessionId:'producer'}
 const candidate={sha256:h('a'),manifestSha256:h('c'),referenceSha256:h('b'),revision:1,durationSeconds:100,width:1080,height:1920,fps:30}
 workflow.recordCandidate(producer,candidate)
 for(const changed of [{...producer,sessionId:'restored-producer'},{...producer,card:{...producer.card,round:2}},{...producer,card:{...producer.card,id:'different-card'}}])assert.throws(()=>workflow.recordCandidate(changed,{...candidate}),/revision-must-increase/)
 assert.equal(workflow.status({...producer,batch:{id:'other-batch'}}).candidate,null)
 input.task.design.studio.characterId='different-character';assert.throws(()=>workflow.recordCandidate(producer,{...candidate}),/revision-must-increase/)
})
