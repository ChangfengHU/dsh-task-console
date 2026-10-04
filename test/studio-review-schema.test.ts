import test from 'node:test'
import assert from 'node:assert/strict'
import {defineTool,ToolRuntime} from '@deepseek-ai/dsh-tools'
import {STUDIO_REVIEW_PARAMETERS,studioReviewParameters,validateReviewShape,validateStructuredRepairEvidence} from '../src/studio-review-schema.ts'
test('actual SDK accepts nested review schema and publishes required fields and status enums',()=>{
 const tool=defineTool({name:'review_fixture',description:'fixture',parameters:STUDIO_REVIEW_PARAMETERS,output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({})})
 const schema:any=tool.parameters
 assert.ok(schema);const text=JSON.stringify(schema)
 for(const field of ['finding','ranges','evidenceReceiptIds','severity','pending'])assert.ok(text.includes(field))
})
test('actual failed report shape produces aggregated actionable errors without rewriting it',()=>{
 const input={checks:[{dimension:'motion',status:'blocker',evidence:'static frames'}],issues:[{severity:'major',time:'0-2',fix:'repair motion'}]},before=JSON.stringify(input)
 assert.throws(()=>validateReviewShape(input),(e:any)=>{const info=JSON.parse(e.message.split(': ').slice(1).join(': '));assert.equal(info.stored,false);assert.deepEqual(info.issues.map((v:any)=>v.path),['checks[0].status','checks[0].finding','checks[0].ranges','checks[0].evidenceReceiptIds','issues[0].id','issues[0].status']);return true})
 assert.equal(JSON.stringify(input),before)
})
test('well-shaped rejection can reach integrity gate without fabricated evidence for pending dimensions',()=>{
 const input={checks:[{dimension:'motion',status:'fail',finding:'No change in this sampled window.',ranges:[[0,2]],evidenceReceiptIds:['host-receipt']},{dimension:'mix',status:'pending',finding:'Not checked.',ranges:[[0,98.6]],evidenceReceiptIds:[]}],issues:[{id:'motion-1',severity:'major',status:'open',time:'0-2'}]}
 assert.doesNotThrow(()=>validateReviewShape(input))
})

const hash=(letter:string)=>letter.repeat(64)
function structured(status='open'){
 const issue={id:'motion-1',severity:'major',status,dimension:'motion',ranges:[[1,3]],sceneId:'wave',responsibleStage:'visual',cause:'The passenger is absent before the protagonist reacts.',repair:{action:'Add the boarding pose before the head-scratch reaction.',target:'wave action poses',fromCandidateSha256:hash('a')},verification:{method:'frames',finding:'Inspect the passenger entering the taxi before the reaction.',evidenceReceiptIds:status==='open'?[]:['new-frames']}}
 return {checks:[{dimension:'motion',status:status==='open'?'fail':'pass',finding:'Actual interval inspected.',ranges:[[1,3]],evidenceReceiptIds:status==='open'?['old-frames']:['new-frames']}],issues:[issue]}
}
function repairContext(){
 return {review:structured('verified'),candidate:{sha256:hash('b'),durationSeconds:10},reviewerSessionId:'new-reviewer',receipts:[{id:'new-frames',sessionId:'new-reviewer',candidateSha256:hash('b'),sha256:hash('c'),kind:'frames',ranges:[[1,3]]}],previousReview:{...structured(),candidateSha256:hash('a')},sceneIds:['wave'],lineIds:[]}
}
test('structured repairs are opt-in and concrete plans do not claim completed repair',()=>{
 assert.equal(studioReviewParameters(),STUDIO_REVIEW_PARAMETERS)
 const schema=studioReviewParameters(true),serialized=JSON.stringify(defineTool({name:'strict_review_fixture',description:'fixture',parameters:schema,output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({})}).parameters)
 for(const field of ['responsibleStage','fromCandidateSha256','verification','sceneId','location'])assert.ok(serialized.includes(field))
 assert.doesNotThrow(()=>validateReviewShape(structured(),{structuredRepairs:true}))
 assert.doesNotThrow(()=>validateStructuredRepairEvidence({review:structured(),candidate:{sha256:hash('a'),durationSeconds:10},reviewerSessionId:'old-reviewer',receipts:[]}))
 assert.doesNotThrow(()=>validateReviewShape({checks:[],issues:[{id:'legacy',severity:'major',status:'open'}]}))
 assert.throws(()=>validateReviewShape({checks:[],issues:[{id:'legacy',severity:'major',status:'open'}]},{structuredRepairs:true}),/shape-invalid/)
})
test('structured repair shape rejects empty/placeholder plans, location and falsely resolved receipt fields',()=>{
 for(const mutate of [
  (r:any)=>r.issues[0].cause=' ',(r:any)=>r.issues[0].repair.action='TBD',(r:any)=>r.issues[0].repair.target='',
  (r:any)=>delete r.issues[0].sceneId,(r:any)=>r.issues[0].ranges=[],(r:any)=>r.issues[0].responsibleStage='reviewer',
  (r:any)=>r.issues[0].verification.finding='pending',(r:any)=>r.issues[0].verification.evidenceReceiptIds=[],
 ]){const report=structured('verified');mutate(report);assert.throws(()=>validateReviewShape(report,{structuredRepairs:true}),/shape-invalid/)}
 const lineOnly:any=structured();delete lineOnly.issues[0].sceneId;lineOnly.issues[0].lineId='dialogue-1';assert.doesNotThrow(()=>validateReviewShape(lineOnly,{structuredRepairs:true}))
})
test('verified repair requires a changed candidate and fresh bound evidence over the affected interval',()=>{
 assert.doesNotThrow(()=>validateStructuredRepairEvidence(repairContext()))
 for(const mutate of [
  (c:any)=>c.candidate.sha256=hash('a'),(c:any)=>c.receipts[0].candidateSha256=hash('a'),
  (c:any)=>c.receipts[0].sessionId='old-reviewer',(c:any)=>c.receipts[0].ranges=[[1,2]],
  (c:any)=>c.receipts[0].kind='probe',(c:any)=>c.review.checks[0].status='fail',
  (c:any)=>c.review.checks[0].evidenceReceiptIds=['other'],(c:any)=>delete c.previousReview,
  (c:any)=>c.review.checks[0].ranges=[[0,1]],
  (c:any)=>c.review.issues[0].repair.fromCandidateSha256=hash('d'),
  (c:any)=>c.review.issues[0].dimension='technical',(c:any)=>c.sceneIds=[],
  (c:any)=>c.review.issues[0].ranges=[[1,11]],
 ]){const context=repairContext();mutate(context);assert.throws(()=>validateStructuredRepairEvidence(context),/structured-repair-evidence-invalid/)}
})
test('prior unresolved findings cannot disappear or change identity during a new report',()=>{
 const omitted=repairContext();omitted.review.issues=[];assert.throws(()=>validateStructuredRepairEvidence(omitted),/prior unresolved issue omitted/)
 const rebound=repairContext();rebound.review.issues[0].sceneId='other';assert.throws(()=>validateStructuredRepairEvidence(rebound),/original sceneId changed/)
 const carried=repairContext();carried.review=structured();assert.doesNotThrow(()=>validateStructuredRepairEvidence(carried))
 const sameCandidate=repairContext();sameCandidate.candidate.sha256=hash('a');sameCandidate.review=structured();sameCandidate.review.checks[0].status='pass';assert.doesNotThrow(()=>validateStructuredRepairEvidence(sameCandidate))
})
test('audio repair cannot use visual evidence and ending repair must verify both media over the same range',()=>{
 const audio:any=repairContext();audio.review.issues[0].dimension='performance';audio.previousReview.issues[0].dimension='performance';audio.review.checks[0].dimension='performance'
 assert.throws(()=>validateStructuredRepairEvidence(audio),/verification method does not cover dimension/)
 audio.review.issues[0].verification.method='audio';audio.receipts[0].kind='audio';assert.doesNotThrow(()=>validateStructuredRepairEvidence(audio))
 const ending:any=repairContext();ending.review.issues[0].dimension='ending';ending.previousReview.issues[0].dimension='ending';ending.review.checks[0].dimension='ending';ending.review.issues[0].verification.method='frames+audio'
 assert.throws(()=>validateStructuredRepairEvidence(ending),/exceed audio verification coverage/)
 ending.receipts.push({...ending.receipts[0],id:'new-audio',kind:'audio'});ending.review.checks[0].evidenceReceiptIds.push('new-audio');ending.review.issues[0].verification.evidenceReceiptIds.push('new-audio');assert.doesNotThrow(()=>validateStructuredRepairEvidence(ending))
})

function replacementContext(kind:'scene'|'line'='scene'){
 const context:any=repairContext(),previous=context.previousReview.issues[0]
 // Only in-memory host-record fixtures. No actual MP4 or observation is minted.
 previous.ranges=[[12,14]];previous.sceneId='deleted-scene'
 if(kind==='line'){delete previous.sceneId;previous.lineId='deleted-line'}
 context.review.issues[0]={...structuredClone(previous),status:'verified',verification:{method:'frames',finding:'Replacement progression observed in the current film.',evidenceReceiptIds:['new-frames'],location:{...(kind==='scene'?{sceneId:'replacement-scene'}:{lineId:'replacement-line'}),ranges:[[5,7]]}}}
 context.review.checks[0].ranges=[[5,7]];context.receipts[0].ranges=[[5,7]]
 context.sceneIds=kind==='scene'?['replacement-scene']:[];context.lineIds=kind==='line'?['replacement-line']:[]
 context.sceneRanges=kind==='scene'?{'replacement-scene':[[5,7]]}:{};context.lineRanges=kind==='line'?{'replacement-line':[[5,7]]}:{}
 return context
}
test('removed original scene or speech line retains immutable history and verifies an explicit current location',()=>{
 for(const kind of ['scene','line'] as const){
  const context=replacementContext(kind),before=JSON.stringify(context)
  assert.doesNotThrow(()=>validateStructuredRepairEvidence(context))
  assert.equal(JSON.stringify(context),before,'validation must not rewrite original or current locations')
  // An unresolved carry-forward records a limitation, not a verified repair.
  context.review.issues[0].status='open';context.review.issues[0].verification.evidenceReceiptIds=[];delete context.review.issues[0].verification.location
  assert.doesNotThrow(()=>validateStructuredRepairEvidence(context))
 }
})
test('replacement verification cannot invent, erase, downgrade or retime the host-recorded original issue',()=>{
 for(const mutate of [
  (c:any)=>c.review.issues[0].sceneId='fabricated-history',
  (c:any)=>c.review.issues[0].ranges=[[5,7]],
  (c:any)=>c.review.issues[0].repair.fromCandidateSha256=hash('d'),
  (c:any)=>c.review.issues[0].severity='minor',
  (c:any)=>c.review.issues[0].dimension='editorial',
  (c:any)=>c.review.issues=[],
  (c:any)=>delete c.previousReview,
  (c:any)=>{delete c.previousReview;c.review.issues[0].status='open';c.review.issues[0].repair.fromCandidateSha256=hash('b')},
  (c:any)=>delete c.review.issues[0].verification.location,
 ]){const context=replacementContext();mutate(context);assert.throws(()=>validateStructuredRepairEvidence(context),/structured-repair-evidence-invalid/)}
 const line=replacementContext('line');line.review.issues[0].lineId='fabricated-history';assert.throws(()=>validateStructuredRepairEvidence(line),/original lineId changed/)
 const added=replacementContext();added.review.issues[0].lineId='replacement-line';added.lineIds=['replacement-line'];assert.throws(()=>validateStructuredRepairEvidence(added),/original lineId changed/)
})
test('current replacement location still needs known IDs, correct ranges and fresh independent evidence',()=>{
 for(const mutate of [
  (c:any)=>c.review.issues[0].verification.location.sceneId='unknown-current-scene',
  (c:any)=>delete c.sceneIds,
  (c:any)=>delete c.sceneRanges,
  (c:any)=>c.sceneRanges['replacement-scene']=[[7,9]],
  (c:any)=>c.review.issues[0].verification.location.ranges=[[5,11]],
  (c:any)=>c.review.issues[0].verification.location.ranges=[[1,3]],
  (c:any)=>c.review.checks[0].ranges=[[5,6]],
  (c:any)=>c.review.checks[0].status='fail',
  (c:any)=>c.receipts[0].ranges=[[5,6]],
  (c:any)=>c.receipts[0].candidateSha256=hash('a'),
  (c:any)=>c.receipts[0].sessionId='old-reviewer',
  (c:any)=>c.receipts[0].sha256='not-a-hash',
  (c:any)=>c.receipts[0].kind='probe',
  (c:any)=>c.receipts=[],
  (c:any)=>c.candidate.sha256=hash('a'),
  (c:any)=>c.review.checks[0].evidenceReceiptIds=[],
 ]){const context=replacementContext();mutate(context);assert.throws(()=>validateStructuredRepairEvidence(context),/structured-repair-evidence-invalid/)}
 const line=replacementContext('line');line.review.issues[0].verification.location.lineId='unknown-current-line';assert.throws(()=>validateStructuredRepairEvidence(line),/unknown verification line ID/)
})
test('verification range belongs to every supplied current location without joining gaps or another scene',()=>{
 const both=replacementContext();both.lineIds=['replacement-line'];both.lineRanges={'replacement-line':[[5,7]]};both.review.issues[0].verification.location.lineId='replacement-line'
 assert.doesNotThrow(()=>validateStructuredRepairEvidence(both))
 both.lineRanges['replacement-line']=[[0,2]];assert.throws(()=>validateStructuredRepairEvidence(both),/verification ranges outside current lineId/)
 const other=replacementContext();other.sceneIds.push('other-current-scene');other.sceneRanges['other-current-scene']=[[0,2]];other.review.issues[0].verification.location.sceneId='other-current-scene'
 assert.throws(()=>validateStructuredRepairEvidence(other),/verification ranges outside current sceneId/)
 const split=replacementContext();split.sceneRanges['replacement-scene']=[[5,5.5],[6.5,7]]
 assert.throws(()=>validateStructuredRepairEvidence(split),/verification ranges outside current sceneId/)
 split.review.issues[0].verification.location.ranges=[[5,5.5],[6.5,7]];assert.doesNotThrow(()=>validateStructuredRepairEvidence(split))
})
test('sub-millisecond replacement range cannot use an unrelated earlier host location or receipt',()=>{
 const current=replacementContext();current.candidate.durationSeconds=20;current.review.issues[0].verification.location.ranges=[[10,10.0005]];current.review.checks[0].ranges=[[10,10.0005]];current.receipts[0].ranges=[[10,10.0005]]
 current.sceneRanges['replacement-scene']=[[0,2]]
 assert.throws(()=>validateStructuredRepairEvidence(current),/verification ranges outside current sceneId/)
 current.sceneRanges['replacement-scene']=[[10,10.0005]];assert.doesNotThrow(()=>validateStructuredRepairEvidence(current))
 current.receipts[0].ranges=[[0,2]];assert.throws(()=>validateStructuredRepairEvidence(current),/exceed frames verification coverage/)
 current.receipts[0].ranges=[[10,10.0005]];current.review.checks[0].ranges=[[0,2]];assert.throws(()=>validateStructuredRepairEvidence(current),/exceed matching passed check/)
})
test('explicit verification location has a bounded documented shape and is accepted by the actual SDK',()=>{
 const tool=defineTool({name:'located_review_fixture',description:'fixture',parameters:studioReviewParameters(true),output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({})})
 assert.ok(JSON.stringify(tool.parameters).includes('location'))
 for(const location of [null,{}, {sceneId:'replacement-scene',ranges:[]},{sceneId:'TBD',ranges:[[5,7]]},{sceneId:'replacement-scene',ranges:[[7,5]]},{sceneId:'replacement-scene',ranges:[[5,7]],fromCandidateSha256:hash('d')}]){
  const context=replacementContext();context.review.issues[0].verification.location=location
  assert.throws(()=>validateStructuredRepairEvidence(context),/shape-invalid/)
 }
})


test('actual native runtime rejects malformed report before executing and accepts explicit pending shape',async()=>{
 const {createRequire}=await import('node:module'),{pathToFileURL}=await import('node:url'),{dirname}=await import('node:path'),require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),agent={ctx,session:{id:'review-schema-test'}};let calls=0
 const dispose=runtime.register(defineTool({name:'review_fixture',description:'fixture',parameters:STUDIO_REVIEW_PARAMETERS,output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(a:any)=>{validateReviewShape(a);calls++;return {qualityApproved:false}}}))
 const invoke=(args:any)=>runtime.execute({name:'review_fixture',arguments:args,agent,callId:'shape-test',signal:new AbortController().signal} as any)
 try{
  const bad=await invoke({checks:[{dimension:'motion',status:'blocker',evidence:'static'}],issues:[{severity:'major'}]});assert.equal(bad.isError,true);assert.equal(calls,0)
  const good=await invoke({checks:[{dimension:'motion',status:'pending',finding:'Not inspected.',ranges:[[0,2]],evidenceReceiptIds:[]}],issues:[]});assert.equal(good.isError,false);assert.equal(calls,1)
 }finally{dispose()}
})

test('actual native runtime admits explicit replacement verification without rewriting historical fields',async()=>{
 const {createRequire}=await import('node:module'),{pathToFileURL}=await import('node:url'),{dirname}=await import('node:path'),require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),agent={ctx,session:{id:'located-review-schema-test'}},fixture=replacementContext();let calls=0
 const dispose=runtime.register(defineTool({name:'located_review_fixture',description:'fixture',parameters:studioReviewParameters(true),output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(review:any)=>{validateStructuredRepairEvidence({...fixture,review});calls++;return {qualityApproved:false}}}))
 const invoke=(args:any,callId:string)=>runtime.execute({name:'located_review_fixture',arguments:args,agent,callId,signal:new AbortController().signal} as any)
 try{
  const malformed=structuredClone(fixture.review);delete malformed.issues[0].verification.location.ranges
  const bad=await invoke(malformed,'invalid-location');assert.equal(bad.isError,true);assert.equal(calls,0)
  const before=JSON.stringify(fixture.review),good=await invoke(fixture.review,'verified-location')
  assert.equal(good.isError,false);assert.equal(calls,1);assert.equal(JSON.stringify(fixture.review),before)
 }finally{dispose()}
})
