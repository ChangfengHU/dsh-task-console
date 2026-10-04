import test from 'node:test'
import assert from 'node:assert/strict'
import {studioReviewProgress} from '../src/studio-review-progress.ts'
import {buildStudioReviewCoveragePlan,bindStudioReviewCoveragePlan} from '../src/studio-review-coverage.mjs'
import {createHash} from 'node:crypto'
const hash='a'.repeat(64),candidate={sha256:hash,revision:1,durationSeconds:98.6}
const receipt=(id:string,kind:string,ranges:any,extra:any={})=>({id,kind,ranges,sessionId:'reviewer',candidateSha256:hash,sha256:'b'.repeat(64),...extra})
test('overlapping repeated listens merge without hiding unobserved intervals',()=>{
 const r=studioReviewProgress(candidate,'reviewer',[receipt('a','audio',[[0,3]]),receipt('b','audio',[[0,8]]),receipt('c','audio',[[20,28]]),receipt('d','audio',[[90.6,98.6]])],null,[])!
 assert.deepEqual(r.audio.observedRanges,[[0,8],[20,28],[90.6,98.6]])
 assert.deepEqual(r.audio.remainingRanges,[[8,20],[28,90.6]]);assert.deepEqual(r.audio.nextWindow,[8,16]);assert.equal(r.audio.complete,false);assert.equal(r.qualityApproved,false)
})
test('a new reviewer or candidate cannot inherit old evidence; reference, malformed and forged hash cannot fill coverage',()=>{
 const rows=[receipt('old','audio',[[0,98.6]],{sessionId:'other'}),receipt('stale','audio',[[0,98.6]],{candidateSha256:'c'.repeat(64)}),receipt('ref','reference',[[0,98.6]]),receipt('invalid','audio',[[0,Infinity],[-1,98.6],[0,99]]),receipt('bad','audio',[[0,98.6]],{sha256:'not-hash'})]
 const r=studioReviewProgress(candidate,'reviewer',rows,null,[])!
 assert.deepEqual(r.audio.remainingRanges,[[0,98.6]]);assert.equal(r.speech.planAvailable,false)
})
test('complete audio observation and sampled visual windows never become quality or full-frame approval',()=>{
 const r=studioReviewProgress(candidate,'reviewer',[receipt('a','audio',[[0,50],[50,98.6]]),receipt('f','frames',[[0,2],[2,4]])],null,[])!
 assert.equal(r.audio.complete,true);assert.equal(r.audio.nextWindow,null);assert.equal(r.qualityApproved,false)
 assert.deepEqual(r.frames.sampledWindows,[[0,4]]);assert.equal(r.frames.fullFrameCoverage,false)
})
test('speech pending is scoped to current plan, candidate, reviewer and source/final stages',()=>{
 const plan={candidateSha256:hash,planSha256:'c'.repeat(64),lines:[{id:'one'},{id:'two'}]}
 const valid={sessionId:'reviewer',candidateSha256:hash,planSha256:plan.planSha256,lineId:'one',stage:'source',result:{content_gate:'pass'}}
 const r=studioReviewProgress(candidate,'reviewer',[],plan,[valid,{...valid,stage:'final',planSha256:'d'.repeat(64)},{...valid,lineId:'two',result:{content_gate:'blocked'}}])!
 assert.deepEqual(r.speech.pending,[{lineId:'one',stage:'final',status:'pending'},{lineId:'two',stage:'source',status:'blocked'},{lineId:'two',stage:'final',status:'pending'}])
})
test('opt-in progress exposes host-derived scene/action/ending targets without changing legacy progress',()=>{
 const lines=[{id:'one',text:'完整冻结台词'}],sha=(bytes:any)=>createHash('sha256').update(bytes).digest('hex')
 const doc=(v:any)=>{const bytes=Buffer.from(JSON.stringify(v));return {bytes,sha256:sha(bytes)}}
 const scriptSha256=sha(JSON.stringify(lines))
 const plan=buildStudioReviewCoveragePlan({scriptSha256,
  storyboard:doc({scriptSha256,script:lines,scenes:[{id:'one-scene'}]}),
  executionBoard:doc({schema:'studio-board-v1',duration:98.6,script:lines,scenes:[{id:'one-scene',start:0,duration:98.6,layers:[{motion:[{at:40,duration:4,to:{x:5}}]}]}]})})
 const reviewCoveragePlan=bindStudioReviewCoveragePlan(plan,candidate),policy={reviewCoverage:'scene-action-v1'}
 const progress=studioReviewProgress(candidate,'reviewer',[receipt('f','frames',[[0,2]]),receipt('a','audio',[[0,98.6]])],null,[],{policy,reviewCoveragePlan})!
 assert.equal(progress.audio.complete,true);assert.equal(progress.frames.fullFrameCoverage,false)
 assert.equal(progress.reviewCoverage?.observationsComplete,false)
 assert.ok(progress.reviewCoverage?.pendingTargets.some((t:any)=>t.id==='action:0:0:0'))
 assert.deepEqual(progress.reviewCoverage?.targets.find((t:any)=>t.id==='ending').ranges,[[96.6,98.6]])
 assert.equal(progress.reviewCoverage?.qualityApproved,false)
 assert.equal(studioReviewProgress(candidate,'reviewer',[],null,[])!.reviewCoverage,undefined)
})
test('new coverage policy with no current source plan is explicitly blocked, never an empty successful checklist',()=>{
 const progress=studioReviewProgress(candidate,'reviewer',[],null,[],{policy:{reviewCoverage:'scene-action-v1'},reviewCoveragePlan:null})!
 assert.equal(progress.reviewCoverage?.status,'blocked')
 assert.equal(progress.reviewCoverage?.observationsComplete,false)
})
