import test from 'node:test'
import assert from 'node:assert/strict'
import {composeStudioTaskDraft,STUDIO_TASK_ROLE_KEYS,STUDIO_TASK_REQUEST_CONTRACT as contract} from '../src/studio-task-draft.ts'
import {validateTask} from '../src/tasks.ts'
const roles=Object.fromEntries(STUDIO_TASK_ROLE_KEYS.map(role=>[role,'installed-'+role]))
const request=()=>({characterId:'authorized-fixture-character',referenceUrl:'https://cdn.vyibc.com/approved-fixture.mp4',referenceSha256:'a'.repeat(64),roles:{...roles},generationLimits:{imageCalls:6,imageBatches:2,voiceSegments:40}})
const context={taskId:'fixture-new-task',cwd:'/workspace/new-isolated-video',createdAt:'2026-01-01T00:00:00.000Z',installedAgentIds:Object.values(roles),executionBindingSupported:true}
test('ordinary request composes deterministic validated six-role save-only draft with no claimed source verification',()=>{
 const r=request(),copy=structuredClone(r),first=composeStudioTaskDraft(r,context),next=composeStudioTaskDraft(r,context)
 assert.deepEqual(first,next);assert.deepEqual(r,copy);assert.equal(first.draft.id,context.taskId);assert.equal(first.draft.createdAt,context.createdAt);assert.equal(first.draft.saveOnly,true)
 assert.equal(first.createdTask,false);assert.equal(first.startedTask,false);assert.equal(first.qualityApproved,false);assert.equal(first.resolution.verifiedByComposer,false);assert.equal(first.resolution.characterProfileVersionPinned,false)
 const task=first.draft;assert.equal(task.design?.evidenceContract,'studio-video-v1');assert.equal(task.design?.executionBinding,'agent-runtime-v1');assert.equal(task.design?.studio?.publish,false);assert.equal(task.design?.studio?.visualCoverage,'requirements-v1');assert.equal(task.design?.studio?.dialogueLanguage,'zh-CN')
 assert.deepEqual(task.participants.map(p=>p.agentId),[roles.director,roles.editor,roles.quality]);assert.deepEqual(task.design?.studioStages?.map(s=>s.agentId),[roles.storyboard,roles.visual,roles.sound]);assert.equal(task.design?.failurePolicy.maxAttempts,3)
 assert.equal(task.timeoutSec,contract.execution.timeoutSec);assert.equal(task.onFail,contract.execution.onFail);assert.equal(task.maxTries,contract.execution.maxTries)
 assert.equal(task.design?.studio?.durationMin,contract.defaults.durationMin);assert.equal(task.design?.studio?.durationMax,contract.defaults.durationMax)
 assert.equal(validateTask(task,new Set(context.installedAgentIds)).design?.studioStages?.length,3)
 assert.match(task.brief,/主题留空/);assert.match(task.brief,/来源卡不是音频/);assert.match(task.brief,/major\/blocker/);assert.match(task.brief,/不发布社交平台/)
 assert.doesNotMatch(JSON.stringify(task),/许小满|xuman-campus|甜美桃子|\/home\/claude|qwen-plus|0\.8\.51/)
})
test('specified topic, bounded duration and zero paid budget are preserved rather than defaulted away',()=>{
 const draft=composeStudioTaskDraft({...request(),topic:'  网购凑单的代价  ',durationMin:95,durationMax:105,maxRepairRounds:0,generationLimits:{imageCalls:0,imageBatches:0,voiceSegments:0}},context).draft
 assert.match(draft.title,/网购凑单的代价/);assert.doesNotMatch(draft.brief,/主题留空/);assert.equal(draft.design?.studio?.durationMin,95);assert.equal(draft.design?.studio?.durationMax,105);assert.equal(draft.design?.studio?.maxRepairRounds,0);assert.equal(draft.design?.failurePolicy.maxAttempts,1);assert.deepEqual(draft.design?.studio?.generationLimits,{imageCalls:0,imageBatches:0,voiceSegments:0})
 assert.match(composeStudioTaskDraft({...request(),topic:'   '},context).draft.brief,/主题留空/)
})
test('missing actual resolution inputs, uninstalled or overlapping roles and unsupported hosts reject',()=>{
 for(const field of ['characterId','referenceUrl','referenceSha256','roles','generationLimits']){const r:any=request();delete r[field];assert.throws(()=>composeStudioTaskDraft(r,context))}
 const noBatches:any=request();delete noBatches.generationLimits.imageBatches;assert.throws(()=>composeStudioTaskDraft(noBatches,context),/imageBatches/)
 assert.throws(()=>composeStudioTaskDraft({...request(),generationLimits:{imageCalls:1,imageBatches:undefined,voiceSegments:1}},context),/imageBatches/)
 assert.throws(()=>composeStudioTaskDraft({...request(),roles:{...roles,sound:roles.director}},context),/different Agent IDs/)
 assert.throws(()=>composeStudioTaskDraft(request(),{...context,installedAgentIds:context.installedAgentIds.slice(1)}),/installed roster/)
 assert.throws(()=>composeStudioTaskDraft(request(),{...context,executionBindingSupported:false}),/agent-runtime-v1/)
 assert.throws(()=>composeStudioTaskDraft(request(),{...context,cwd:'relative'}),/absolute workspace/)
})
test('publication, injected task state, private paths, role extras and unsupported request fields cannot alter draft',()=>{
 for(const extra of [{publish:true},{cwd:'/another-project'},{design:{}},{executionBinding:{}},{createdAt:'anything'},{apiKey:'NOT-A-REAL-SECRET'},{profileSha256:'b'.repeat(64)}])assert.throws(()=>composeStudioTaskDraft({...request(),...extra},context),(e:any)=>{assert.match(e.message,/Only the Studio request fields/);assert.ok(!e.message.includes('NOT-A-REAL-SECRET'));return true})
 assert.throws(()=>composeStudioTaskDraft({...request(),roles:{...roles,publisher:'publish-agent'}},context),/six exact/)
})
test('existing Studio policy validates reference, budgets and duration bounds without invented defaults',()=>{
 for(const extra of [{referenceSha256:'not-a-hash'},{referenceUrl:'https://other.invalid/movie.mp4'},{referenceUrl:'https://cdn.vyibc.com/movie.mp4?token=private'},{durationMin:110,durationMax:90},{durationMin:0},{durationMin:null},{maxRepairRounds:4},{generationLimits:{imageCalls:7,imageBatches:2,voiceSegments:40}},{generationLimits:{imageCalls:1,imageBatches:1,voiceSegments:81}},{generationLimits:{imageCalls:1,imageBatches:7,voiceSegments:1}},{topic:'a'.repeat(contract.topic.maxCharacters+1)}])assert.throws(()=>composeStudioTaskDraft({...request(),...extra},context))
 assert.deepEqual(contract.required,['characterId','referenceUrl','referenceSha256','roles','generationLimits']);assert.equal(contract.generationLimits.default,null)
})

test('composer repair limits support 0..2 and explicitly refuse a fourth production round',()=>{
 assert.equal(contract.defaults.maxRepairRounds,2);assert.deepEqual([contract.maxRepairRounds.minimum,contract.maxRepairRounds.maximum],[0,2])
 for(const maxRepairRounds of [0,1,2]){const result=composeStudioTaskDraft({...request(),maxRepairRounds},context);assert.equal(result.draft.design?.studio?.maxRepairRounds,maxRepairRounds);assert.equal(result.draft.design?.failurePolicy.maxAttempts,maxRepairRounds+1)}
 for(const maxRepairRounds of [3,4,-1,0.5])assert.throws(()=>composeStudioTaskDraft({...request(),maxRepairRounds},context),(error:any)=>{assert.match(error.message,/maxRepairRounds/);assert.match(error.message,/supports 0 to 2 repair rounds/);assert.match(error.message,/not silently reduced/);return true})
})
