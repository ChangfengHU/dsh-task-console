import test from 'node:test'
import assert from 'node:assert/strict'
import {validateDesign} from '../src/task-design.js'
import {validateStudioPolicy} from '../src/studio-policy.js'
const STUDIO_REFERENCE_URL='https://cdn.vyibc.com/studio/reference.mp4'
const STUDIO_REFERENCE_SHA256='a'.repeat(64)
const policy=()=>({characterId:'xuman-campus-v1',referenceUrl:STUDIO_REFERENCE_URL,referenceSha256:STUDIO_REFERENCE_SHA256})
const design = (): any => ({evidenceContract:'studio-video-v1',studio:policy(),scope:'指定角色自主制作',branches:[{id:'create',when:'准备完成',action:'制作',evidence:'真实成片'}],coordination:'独立质检',failurePolicy:{isolateItems:true,maxAttempts:8,stopConditions:['预算耗尽']},acceptance:['证据审查通过']})
test('studio validates defaults and fixed reference without granting publication',()=>{const d=validateDesign(design());assert.equal(d.studio?.publish,false);assert.equal(d.studio?.width,1080);assert.equal(d.studio?.referenceUrl,STUDIO_REFERENCE_URL);assert.equal(d.studio?.referenceSha256,STUDIO_REFERENCE_SHA256);assert.equal(d.failurePolicy.maxAttempts,8)})
test('studio repair cap remains three while orchestration attempts allow eight',()=>{const d=design();d.studio.maxRepairRounds=4;assert.throws(()=>validateDesign(d),/0\.\.3/)})
test('eight is the studio maximum',()=>{const d=design();d.failurePolicy.maxAttempts=9;assert.throws(()=>validateDesign(d),/1至8/)})
test('non-studio retains max three',()=>{const d=design();delete d.evidenceContract;delete d.studio;assert.throws(()=>validateDesign(d),/1至3/);d.failurePolicy.maxAttempts=3;assert.equal(validateDesign(d).failurePolicy.maxAttempts,3)})
test('studio cannot be attached to another contract',()=>{const d=design();d.evidenceContract='browser-patrol-v1';assert.throws(()=>validateDesign(d),/仅适用/)})
test('studio contract requires policy',()=>{const d=design();delete d.studio;assert.throws(()=>validateDesign(d),/策略对象/)})
for (const patch of [{publish:true},{publish:'false'},{referenceUrl:'https://example.com/a.mp4'},{referenceSha256:'not-sha'},{width:720},{fps:24},{extra:'hidden'},{requiredDimensions:['technical']}]) test(`policy rejects ${JSON.stringify(patch)}`,()=>assert.throws(()=>validateStudioPolicy({...policy(),...patch})))
for (const place of ['root','studio','branch','failurePolicy']) test(`strict unknown field at ${place}`,()=>{const d=design();const target=place==='root'?d:place==='branch'?d.branches[0]:d[place];target.unknown=true;assert.throws(()=>validateDesign(d))})
test('studio excludes patrol and notification side effects',()=>{for(const field of ['browserPatrol','notifications','proxy']){const d=design();d[field]={};assert.throws(()=>validateDesign(d),/不支持/)}})
test('explicit frozen policy validates idempotently',()=>{const p=validateStudioPolicy(policy());assert.deepEqual(validateStudioPolicy(p),p)})

test('reference belongs to task configuration, not a hardcoded character',()=>{const p=validateStudioPolicy({...policy(),characterId:'another-character',referenceUrl:'https://cdn.vyibc.com/another/reference.mp4',referenceSha256:'b'.repeat(64)});assert.equal(p.characterId,'another-character');assert.equal(p.referenceSha256,'b'.repeat(64))})
for(const referenceUrl of ['http://cdn.vyibc.com/a.mp4','https://user:pass@cdn.vyibc.com/a.mp4','https://cdn.vyibc.com/a.mp4?token=secret','https://cdn.vyibc.com/a.mp4#fragment','https://cdn.vyibc.com:8443/a.mp4','https://cdn.vyibc.com.evil.test/a.mp4']) test(`unsafe reference URL ${referenceUrl}`,()=>assert.throws(()=>validateStudioPolicy({...policy(),referenceUrl})))

import {validateTask} from '../src/tasks.ts'
test('createTask preserves and validates studio contract instead of silently dropping it',()=>{const d=design();const task=validateTask({brief:'test studio task',participants:[{agentId:'p'},{agentId:'e'},{agentId:'r'}],graphMode:'dynamic-rounds',design:d},new Set(['p','e','r']));assert.equal(task.design?.evidenceContract,'studio-video-v1');assert.equal(task.design?.studio?.characterId,'xuman-campus-v1')})
test('studio rejects static or duplicate-role setup',()=>{for(const change of [{graphMode:'static-chain'},{participants:[{agentId:'p'},{agentId:'p'},{agentId:'r'}]}])assert.throws(()=>validateTask({brief:'test studio task',participants:[{agentId:'p'},{agentId:'e'},{agentId:'r'}],graphMode:'dynamic-rounds',design:design(),...change},new Set(['p','e','r'])),/三个不同/)})

test('studio recovery can freeze zero additional generation without increasing default ceilings',()=>{
 const base=design().studio
 assert.deepEqual(validateStudioPolicy({...base,generationLimits:{imageCalls:0,voiceSegments:0}}).generationLimits,{imageCalls:0,voiceSegments:0})
 for(const limits of [{imageCalls:7,voiceSegments:80},{imageCalls:0,voiceSegments:81},{imageCalls:-1,voiceSegments:0},{imageCalls:0},{imageCalls:0,voiceSegments:0,extra:1}])
  assert.throws(()=>validateStudioPolicy({...base,generationLimits:limits}),/generationLimits/)
 assert.equal(validateStudioPolicy(base).generationLimits,undefined)
})
