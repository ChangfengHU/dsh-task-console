import test from 'node:test'
import assert from 'node:assert/strict'
import {studioReviewProgress} from '../src/studio-review-progress.ts'
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
