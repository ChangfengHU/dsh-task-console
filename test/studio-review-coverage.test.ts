import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {buildStudioReviewCoveragePlan,bindStudioReviewCoveragePlan,evaluateStudioReviewCoverage,studioReviewCoverageProgress,studioReviewCoverageSha256} from '../src/studio-review-coverage.mjs'
import {DEFAULT_DIMENSIONS,evaluateStudioReview,validateStudioPolicy} from '../src/studio-evidence.mjs'

const h=(c:string)=>c.repeat(64),sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
const doc=(value:any)=>{const bytes=Buffer.from(JSON.stringify(value));return {bytes,sha256:sha(bytes)}}
test('portable synchronous SHA256 matches standard vectors, native padding boundaries and UTF8 bytes',()=>{
 assert.equal(studioReviewCoverageSha256(''),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
 assert.equal(studioReviewCoverageSha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
 for(const value of ['中文完整台词😀','\ud800',...Array.from({length:130},(_,i)=>'a'.repeat(i)),'a'.repeat(1_000_000)])assert.equal(studioReviewCoverageSha256(value),sha(value))
 const bytes=Uint8Array.from({length:1024*1024+65},(_,i)=>i%256)
 assert.equal(studioReviewCoverageSha256(bytes),sha(bytes))
 assert.equal(studioReviewCoverageSha256(bytes.subarray(13,1031)),sha(bytes.subarray(13,1031)))
 assert.throws(()=>studioReviewCoverageSha256({} as any),/bytes-required/)
})
test('shared evidence/coverage module bundles for browsers with the same synchronous checks',async()=>{
 const {build}=await import('esbuild')
 const result=await build({entryPoints:['src/studio-evidence.mjs'],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',logLevel:'silent'})
 const output=result.outputFiles[0].text
 assert.ok(output.includes('reviewCoverage:'))
 assert.ok(!output.includes('node:crypto'))
})
function fixture(){
 const lines=[{id:'one',text:'完整原稿台词。'}],scriptSha256=sha(JSON.stringify(lines))
 const storyboard={scriptSha256,script:lines,scenes:[{id:'opening'},{id:'middle'},{id:'ending'}]}
 const execution={schema:'studio-board-v1',duration:100,script:lines,scenes:[
  {id:'opening',start:0,duration:30,layers:[{type:'image',motion:[{at:5,duration:4,to:{x:10}}]}]},
  {id:'middle',start:30,duration:40,layers:[{type:'image',motion:[{at:10,duration:5,to:{rotation:10}}]}]},
  {id:'ending',start:70,duration:30,layers:[{type:'image',motion:[{at:25,duration:3,to:{y:10}}]}]},
 ]}
 const sources={storyboard:doc(storyboard),executionBoard:doc(execution),scriptSha256}
 const candidate={sha256:h('a'),manifestSha256:h('c'),referenceSha256:h('b'),revision:1,durationSeconds:100,width:1080,height:1920,fps:30}
 const policy={characterId:'fixture',referenceSha256:h('b'),reviewCoverage:'scene-action-v1',maxRepairRounds:3}
 const plan=buildStudioReviewCoveragePlan(sources),bound=bindStudioReviewCoveragePlan(plan,candidate)
 const receipt=(id:string,kind:string,ranges:number[][],extra:any={})=>({id,kind,ranges,sessionId:'reviewer',candidateSha256:candidate.sha256,sha256:h('d'),...extra})
 const windows:number[][]=[...new Map(plan.targets.flatMap((t:any)=>t.ranges).map((r:number[])=>[JSON.stringify(r),r])).values()]
 const receipts=[...windows.map((r,i)=>receipt('frame-'+i,'frames',[r])),receipt('audio','audio',[[0,100]]),receipt('probe','probe',[[0,100]]),receipt('source','source',[[0,100]])]
 const review={candidateSha256:candidate.sha256,referenceSha256:candidate.referenceSha256,revision:1,reviewerSessionId:'reviewer',issues:[],checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:'pass',finding:'Actual fixture observations; no aesthetic approval.',ranges:
  dimension==='technical'||dimension==='source_records'||['performance','mix','intelligibility'].includes(dimension)?[[0,100]]:
  dimension==='ending'?[[98,100]]:windows,
  evidenceReceiptIds:receipts.map(r=>r.id)
 }))}
 const args={policy,candidate,review,producerSessionId:'producer',reviewerSessionId:'reviewer',receipts,budget:{repairRounds:0,maxRepairRounds:3},reviewCoveragePlan:bound}
 return {lines,storyboard,execution,sources,plan,bound,policy,candidate,receipts,review,args,receipt}
}
function actionFixture(actions:Array<{at:number;duration:number}>){
 const lines=[{id:'line-1',text:'fixture only'}],scriptSha256=sha(JSON.stringify(lines))
 const storyboard={scriptSha256,scenes:[{id:'scene-1'}]},execution={schema:'studio-board-v1',duration:60,script:lines,scenes:[{id:'scene-1',start:0,duration:60,layers:actions.map(motion=>({type:'image',width:100,height:100,src:'assets/subject.png',role:'subject',motion:[{...motion,to:{x:100}}]}))}]}
 const plan=buildStudioReviewCoveragePlan({scriptSha256,storyboard:doc(storyboard),executionBoard:doc(execution)})
 const candidate={sha256:h('a'),manifestSha256:h('c'),referenceSha256:h('b'),revision:1,durationSeconds:60,width:1080,height:1920,fps:30}
 const policy={characterId:'fixture',referenceSha256:h('b'),reviewCoverage:'scene-action-v1',maxRepairRounds:3,durationMin:60,durationMax:60}
 const receipt=(id:string,kind:string,ranges:number[][],extra:any={})=>({id,kind,ranges,sessionId:'reviewer',candidateSha256:candidate.sha256,sha256:h('d'),...extra})
 const args={policy,candidate,reviewerSessionId:'reviewer',reviewCoveragePlan:bindStudioReviewCoveragePlan(plan,candidate)}
 return {plan,candidate,policy,receipt,args}
}
// This models request scheduling with synthetic in-memory receipts only. It
// does not generate media, call a provider, or claim actual visual/audio QA.
function simulateObservations(f:any,initial:any[]=[]){
 const receipts=[...initial],calls:any[]=[]
 for(let i=0;i<100;i++){
  const progress=studioReviewCoverageProgress({...f.args,receipts})!,next=progress.nextWindow
  if(!next){assert.equal(progress.observationsComplete,true);assert.equal(progress.qualityApproved,false);return {receipts,calls,progress}}
  assert.ok(next.start>=0&&next.start<next.end&&next.end<=f.candidate.durationSeconds&&next.end-next.start<=2,'every proposed request fits the actual strict inspection limit')
  calls.push(next);receipts.push(f.receipt('simulated-'+i,next.kind,[[next.start,next.end]]))
 }
 assert.fail('observation scheduling did not converge')
}
test('policy is explicit opt-in and legacy reports are not retrospectively reinterpreted',()=>{
 const f=fixture(),policy={...f.policy};delete (policy as any).reviewCoverage
 const receipts=['frames','audio','probe','source'].map((kind,i)=>f.receipt(String(i),kind,[[0,1]]))
 const review={...f.review,checks:f.review.checks.map((c:any)=>({...c,ranges:[[0,1]],evidenceReceiptIds:receipts.map(r=>r.id)}))}
 assert.equal(evaluateStudioReview({...f.args,policy,review,receipts,reviewCoveragePlan:undefined}).ok,true)
 assert.equal(studioReviewCoverageProgress({...f.args,policy}),null)
 assert.equal(validateStudioPolicy(f.policy).ok,true)
 assert.equal(validateStudioPolicy({...f.policy,reviewCoverage:'automatic-aesthetic-approval'}).ok,false)
})
test('targets are deterministically derived from real source bytes, stable original scenes and motion timing',()=>{
 const f=fixture()
 assert.deepEqual(buildStudioReviewCoveragePlan(f.sources),f.plan)
 assert.equal(f.plan.storyboardSha256,f.sources.storyboard.sha256)
 assert.equal(f.plan.executionBoardSha256,f.sources.executionBoard.sha256)
 assert.equal(f.plan.scriptSha256,f.sources.scriptSha256)
 assert.deepEqual(f.plan.targets.find((t:any)=>t.id==='action:1:0:0').ranges,[[40,42],[42,44],[44,45]])
 assert.equal(f.plan.targets.find((t:any)=>t.id==='action:1:0:0').originalSceneId,'middle')
 assert.equal(f.plan.targets.find((t:any)=>t.id==='action:1:0:0').sourcePath,'scenes[1].layers[0].motion[0]')
 assert.deepEqual(f.plan.targets.find((t:any)=>t.kind==='ending').ranges,[[98,100]])
 assert.deepEqual(f.plan.targets.find((t:any)=>t.id==='transition:0:1').ranges,[[29,31]])
 assert.ok(f.plan.targets.filter((t:any)=>t.kind==='scene').length===9)
 assert.equal(f.plan.fullFrameCoverage,false);assert.equal(f.plan.qualityApproved,false)
})
test('host source SHA cannot be replaced with reviewer supplied or reserialized documents',()=>{
 const f=fixture()
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,storyboard:{...f.sources.storyboard,bytes:Buffer.from('{}')}}),/document hash mismatch/)
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,executionBoard:{...f.sources.executionBoard,bytes:Buffer.from(JSON.stringify(f.execution,null,2))}}),/document hash mismatch/)
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,storyboard:doc({...f.storyboard,scriptSha256:h('e')})}),/current frozen dialogue/)
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,executionBoard:doc({...f.execution,script:[{id:'one',text:'改写台词'}]})}),/current frozen dialogue/)
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,scriptSha256:'not-a-hash'}),/host frozen script SHA256/)
})
test('split execution scenes need complete bindings and cannot omit an original storyboard scene',()=>{
 const f=fixture(),execution=structuredClone(f.execution)
 delete (execution.scenes[0] as any).id
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,executionBoard:doc(execution)}),/original scene binding/)
 const sceneMappings=[{sceneIndex:0,originalSceneId:'opening'},{sceneIndex:1,originalSceneId:'middle'},{sceneIndex:2,originalSceneId:'ending'}]
 assert.deepEqual(buildStudioReviewCoveragePlan({...f.sources,executionBoard:doc(execution),sceneMappings}).originalSceneIds,['opening','middle','ending'])
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,sceneMappings:sceneMappings.slice(1)}),/every execution scene/)
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,sceneMappings:[sceneMappings[0],sceneMappings[0],sceneMappings[2]]}),/duplicate/)
 assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,sceneMappings:sceneMappings.map(m=>({...m,originalSceneId:'opening'}))}),/original storyboard scene was omitted/)
})
test('gaps, overlaps, missing final scene and malformed motion cannot silently remove targets',()=>{
 const f=fixture()
 for(const mutate of [
  (e:any)=>{e.scenes[1].start=31},
  (e:any)=>{e.scenes.pop()},
  (e:any)=>{e.scenes[1].layers[0].motion[0].duration=50},
  (e:any)=>{e.scenes[1].layers[0].motion[0].at=-1},
  (e:any)=>{e.scenes[1].layers[0].motion[0].at=40;e.scenes[1].layers[0].motion[0].duration=.001},
 ]) {
  const execution=structuredClone(f.execution);mutate(execution)
  assert.throws(()=>buildStudioReviewCoveragePlan({...f.sources,executionBoard:doc(execution)}),/studio-review-coverage-invalid/)
 }
})
test('every source-derived scene/action/transition and real ending passes only with matching observations',()=>{
 const f=fixture(),result=evaluateStudioReview(f.args)
 assert.deepEqual(result.issues,[]);assert.equal(result.ok,true)
 const progress=studioReviewCoverageProgress(f.args)!
 assert.equal(progress.observationsComplete,true);assert.equal(progress.status,'observed')
 assert.equal(progress.qualityApproved,false);assert.equal(progress.fullFrameCoverage,false)
 assert.equal(progress.nextWindow,null)
})
test('100-second candidate with opening-only checks cannot pass opt-in gate even with entire-film audio',()=>{
 const f=fixture(),receipts=[f.receipt('opening','frames',[[0,1]]),...f.receipts.filter(r=>r.kind!=='frames')]
 const review={...f.review,checks:f.review.checks.map((c:any)=>({...c,ranges:['technical','source_records','performance','mix','intelligibility'].includes(c.dimension)?[[0,100]]:[[0,1]],evidenceReceiptIds:receipts.map(r=>r.id)}))}
 const result=evaluateStudioReview({...f.args,review,receipts})
 assert.equal(result.ok,false);assert.ok(result.issues.some((s:string)=>s.includes('target ending lacks frames observations at [98,100]')))
 assert.ok(result.issues.some((s:string)=>s.includes('target action:1:0:0')))
})
test('having observations in the ledger does not certify a report that skips ending or omits linked evidence',()=>{
 const f=fixture(),review=structuredClone(f.review)
 review.checks.find((c:any)=>c.dimension==='ending')!.ranges=[[0,1]]
 assert.ok(evaluateStudioReview({...f.args,review}).issues.some((s:string)=>s.includes('check.ending does not cover target ending')))
 review.checks.find((c:any)=>c.dimension==='ending')!.ranges=[[98,100]]
 review.checks.find((c:any)=>c.dimension==='motion')!.evidenceReceiptIds=['audio','probe','source']
 assert.ok(evaluateStudioReview({...f.args,review}).issues.some((s:string)=>s.includes('check.motion lacks linked frames evidence')))
})
test('old reviewer, changed candidate, forged receipt hashes and duplicate IDs do not fill targets',()=>{
 const f=fixture()
 for(const extra of [{sessionId:'old-reviewer'},{candidateSha256:h('e')},{sha256:'forged'}]) {
  const receipts=f.receipts.map(r=>r.kind==='frames'?{...r,...extra}:r)
  assert.equal(studioReviewCoverageProgress({...f.args,receipts})!.observationsComplete,false)
  assert.equal(evaluateStudioReview({...f.args,receipts}).ok,false)
 }
 const duplicate=[...f.receipts,...f.receipts.filter(r=>r.kind==='frames')]
 assert.equal(studioReviewCoverageProgress({...f.args,receipts:duplicate})!.observationsComplete,false)
})
test('missing, tampered, wrong-revision and wrong-candidate host plans explicitly block new policy',()=>{
 const f=fixture()
 for(const reviewCoveragePlan of [undefined,{...f.bound,revision:2},{...f.bound,candidateSha256:h('e')},{...f.bound,targets:f.bound.targets.slice(1)}]) {
  const result=evaluateStudioReview({...f.args,reviewCoveragePlan})
  assert.equal(result.ok,false);assert.ok(result.issues.some((s:string)=>s.startsWith('reviewCoverage:')))
  const progress=studioReviewCoverageProgress({...f.args,reviewCoveragePlan})!
  assert.equal(progress.status,'blocked');assert.equal(progress.observationsComplete,false)
  assert.equal(progress.nextWindow,null)
 }
})
test('next missing target names the original source scene/action, not a guessed unrelated task',()=>{
 const f=fixture(),progress=studioReviewCoverageProgress({...f.args,receipts:[]})!
 assert.equal(progress.status,'pending');assert.equal(progress.observationsComplete,false)
 assert.deepEqual(progress.nextWindow,{targetId:'scene:0:sample:0',kind:'frames',start:0,end:2,originalSceneId:'opening',sourcePath:'scenes[0]'})
 assert.equal(progress.storyboardSha256,f.sources.storyboard.sha256)
 assert.equal(progress.executionBoardSha256,f.sources.executionBoard.sha256)
})
test('40 overlapping fractional actions retain all 44 targets but need only 5 frame requests and one distinct ending audio request',()=>{
 const f=actionFixture(Array.from({length:40},(_,i)=>({at:10+i*.05,duration:2})))
 assert.equal(f.plan.targets.length,44)
 const {receipts,calls,progress}=simulateObservations(f),frames=calls.filter(n=>n.kind==='frames'),audio=calls.filter(n=>n.kind==='audio')
 assert.equal(frames.length,5,'previous whole-target scheduling required 43 frame requests')
 assert.deepEqual(frames.filter(n=>n.targetId.startsWith('action:')).map(n=>[n.start,n.end]),[[10,12],[12,13.95]])
 assert.deepEqual(audio.map(n=>[n.start,n.end]),[[58,60]])
 assert.equal(progress.targets.length,44);assert.equal(progress.targets.filter((t:any)=>t.kind==='action'&&t.observed).length,40)
 const evidence=[...receipts,f.receipt('probe','probe',[[0,60]]),f.receipt('source','source',[[0,60]])]
 const frameRanges=receipts.filter(r=>r.kind==='frames').flatMap(r=>r.ranges)
 const review={candidateSha256:f.candidate.sha256,referenceSha256:f.candidate.referenceSha256,revision:1,reviewerSessionId:'reviewer',issues:[],checks:DEFAULT_DIMENSIONS.map((dimension:string)=>({dimension,status:'pass',finding:'Synthetic scheduling fixture only, not aesthetic approval.',ranges:['technical','source_records'].includes(dimension)?[[0,60]]:['ending','performance','mix','intelligibility'].includes(dimension)?[[58,60]]:frameRanges,evidenceReceiptIds:evidence.map(r=>r.id)}))}
 const args={...f.args,review,receipts:evidence,producerSessionId:'producer',budget:{repairRounds:0,maxRepairRounds:3}}
 const result=evaluateStudioReview(args);assert.equal(result.ok,true,JSON.stringify(result.issues))
 const skipped=structuredClone(review);skipped.checks.find((c:any)=>c.dimension==='motion')!.ranges=[[10,12]]
 assert.ok(evaluateStudioReview({...args,review:skipped}).issues.some((s:string)=>s.includes('check.motion does not cover target')))
 const unlinked=structuredClone(review);unlinked.checks.find((c:any)=>c.dimension==='motion')!.evidenceReceiptIds=[receipts.find(r=>r.kind==='audio')!.id]
 assert.ok(evaluateStudioReview({...args,review:unlinked}).issues.some((s:string)=>s.includes('check.motion lacks linked frames evidence')))
 assert.equal(evaluateStudioReview({...args,receipts:evidence.filter(r=>r.kind!=='audio')}).ok,false,'a merged frame window cannot replace ending audio')
})
test('partially observed targets request only their interior gaps, never the entire unchanged target again',()=>{
 const f=fixture(),receipts=f.receipts.filter(r=>r.kind!=='frames'||!r.ranges.some(([a,b])=>a>=40&&b<=45))
 receipts.push(f.receipt('partial','frames',[[40,41],[41.5,43],[43.25,45]]))
 const progress=studioReviewCoverageProgress({...f.args,receipts})!
 assert.deepEqual(progress.targets.find((t:any)=>t.id==='action:1:0:0').missing,[{kind:'frames',range:[41,41.5]},{kind:'frames',range:[43,43.25]}])
 assert.deepEqual([progress.nextWindow.start,progress.nextWindow.end],[41,41.5])
 const {calls}=simulateObservations(f,receipts)
 assert.deepEqual(calls.map(n=>[n.start,n.end]),[[41,41.5],[43,43.25]])
})
test('nested and adjacent action windows merge across targets while nonadjacent gaps are not requested',()=>{
 const f=actionFixture([{at:10,duration:2},{at:10.5,duration:.5},{at:11,duration:2},{at:20,duration:1}])
 const {calls}=simulateObservations(f)
 assert.deepEqual(calls.filter(n=>n.targetId.startsWith('action:')).map(n=>[n.start,n.end]),[[10,12],[12,13],[20,21]])
 for(const n of calls){const target=f.plan.targets.find((t:any)=>t.id===n.targetId);assert.ok(target.ranges.some(([a,b])=>a<n.end&&b>n.start),'nextWindow provenance names an actually intersecting source target')}
})
test('gap scheduling preserves existing boundary tolerance without erasing a completely unobserved short action',()=>{
 const f=actionFixture([{at:10,duration:2}]),base=[f.receipt('scene','frames',[[0,2],[29,31],[58,60]]),f.receipt('tail','audio',[[58,60]])]
 const tolerated=studioReviewCoverageProgress({...f.args,receipts:[...base,f.receipt('observed-boundaries','frames',[[10,11],[11.0005,12]])]})!
 assert.equal(tolerated.observationsComplete,true)
 const gap=studioReviewCoverageProgress({...f.args,receipts:[...base,f.receipt('real-gap','frames',[[10,11],[11.0011,12]])]})!
 assert.deepEqual([gap.nextWindow.start,gap.nextWindow.end],[11,11.0011]);assert.equal(gap.observationsComplete,false)
 const tiny=actionFixture([{at:10,duration:.0005}]),pending=studioReviewCoverageProgress({...tiny.args,receipts:base})!
 assert.equal(pending.observationsComplete,false);assert.deepEqual([pending.nextWindow.start,pending.nextWindow.end],[10,10.0005])
 for(const range of [[9,10],[10.0005,10.0008],[10.0006,10.0008]]){
  const unrelated=studioReviewCoverageProgress({...tiny.args,receipts:[...base,tiny.receipt('no-intersection','frames',[range])]})!
  assert.equal(unrelated.targets.find((t:any)=>t.kind==='action').observed,false,'touching or nearby evidence has no actual intersection with the short source action')
 }
 const intersecting=studioReviewCoverageProgress({...tiny.args,receipts:[...base,tiny.receipt('observed-overlap','frames',[[10.0001,10.0004]])]})!
 assert.equal(intersecting.targets.find((t:any)=>t.kind==='action').observed,true,'existing legitimate intersecting boundary tolerance is preserved')
 const finished=simulateObservations(tiny,base)
 assert.deepEqual(finished.calls.map(n=>[n.start,n.end]),[[10,10.0005]])
 const ranges=finished.receipts.filter(r=>r.kind==='frames').flatMap(r=>r.ranges)
 const checks=DEFAULT_DIMENSIONS.map(dimension=>({dimension,ranges:dimension==='ending'?[[58,60]]:ranges,evidenceReceiptIds:finished.receipts.map(r=>r.id)}))
 assert.equal(evaluateStudioReviewCoverage({...tiny.args,receipts:finished.receipts,review:{checks}}).ok,true)
 const skipped=structuredClone(checks);skipped.find(c=>c.dimension==='motion')!.ranges=[[0,2]]
 assert.ok(evaluateStudioReviewCoverage({...tiny.args,receipts:finished.receipts,review:{checks:skipped}}).issues.some((s:string)=>s.includes('check.motion does not cover target action:')),'unrelated positive-check ranges also cannot certify the short action')
})
test('merged scheduling ignores wrong-kind, foreign, stale, forged and duplicate receipt coverage',()=>{
 const f=actionFixture([{at:10,duration:4}]),base=[f.receipt('scene','frames',[[0,2],[29,31],[58,60]]),f.receipt('tail','audio',[[58,60]])]
 for(const extra of [{kind:'audio'},{sessionId:'foreign'},{candidateSha256:h('e')},{sha256:'forged'}]){
  const progress=studioReviewCoverageProgress({...f.args,receipts:[...base,f.receipt('untrusted','frames',[[10,14]],extra)]})!
  assert.equal(progress.observationsComplete,false);assert.deepEqual([progress.nextWindow.start,progress.nextWindow.end],[10,12])
 }
 const duplicate=f.receipt('duplicated','frames',[[10,14]])
 const progress=studioReviewCoverageProgress({...f.args,receipts:[...base,duplicate,{...duplicate}]})!
 assert.deepEqual([progress.nextWindow.start,progress.nextWindow.end],[10,12]);assert.equal(progress.observationsComplete,false)
})
test('fractional merged window ends stay within the native strict two-second limit',()=>{
 for(const at of [8.013,8.026,8.039,8.052,10.1,10.15,12.3,14.045,14.097,14.292]){
  const f=actionFixture([{at,duration:4}]),base=[f.receipt('scene','frames',[[0,2],[29,31],[58,60]]),f.receipt('tail','audio',[[58,60]])]
  const {calls}=simulateObservations(f,base)
  assert.equal(calls.length,2)
  for(const n of calls)assert.ok(n.end-n.start<=2)
 }
})
test('ending uses actual probe duration within one output frame and rejects truly different renders',()=>{
 const f=fixture(),candidate={...f.candidate,durationSeconds:100.033}
 const bound=bindStudioReviewCoveragePlan(f.plan,candidate)
 const progress=studioReviewCoverageProgress({...f.args,candidate,reviewCoveragePlan:bound})!
 assert.deepEqual(progress.targets.find((t:any)=>t.kind==='ending').ranges,[[98.033,100.033]])
 assert.equal(progress.observationsComplete,false)
 assert.throws(()=>bindStudioReviewCoveragePlan(f.plan,{...candidate,durationSeconds:100.2}),/render duration differs/)
})
test('coverage does not convert failed quality dimensions or unresolved issues into approval',()=>{
 const f=fixture(),review=structuredClone(f.review)
 review.checks.find((c:any)=>c.dimension==='motion')!.status='fail'
 review.issues=[{id:'poor-motion',severity:'major',status:'open'}] as any
 const result=evaluateStudioReview({...f.args,review})
 assert.equal(result.ok,false);assert.ok(result.issues.includes('check.motion: not passed'))
 assert.ok(result.issues.includes('issue.poor-motion: unresolved major'))
 assert.equal(evaluateStudioReviewCoverage({...f.args,review}).ok,true,'observations are not quality approval')
})
test('malformed review/checks is diagnosed without throwing past the existing evidence gate',()=>{
 const f=fixture()
 assert.equal(evaluateStudioReview({...f.args,review:{checks:{}}}).ok,false)
})
