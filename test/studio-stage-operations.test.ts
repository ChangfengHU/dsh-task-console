import test from 'node:test'
import assert from 'node:assert/strict'
import {requireSettledStudioOperations} from '../src/studio-stage-operations.ts'
const stage=(id:string)=>({task:{design:{studioStages:[{id,agentId:id}]}},batch:{id:'b'},card:{id:`b#s1-${id}`,round:1,role:'studio-stage',agentId:id}})
const image={tool:'vyibc-image_generate_image',kind:'imageCalls',state:'submitted',job_id:'image-1'}
const voice={tool:'vyibc-voice_synthesize',kind:'voiceSegments',state:'submitted',job_id:'voice-1'}
test('visual and sound handoff wait for owned work while siblings can progress',()=>{
 assert.throws(()=>requireSettledStudioOperations(stage('visual'),{operations:[image,voice]}),/image-1/)
 assert.doesNotThrow(()=>requireSettledStudioOperations(stage('visual'),{operations:[{...image,state:'completed'},voice]}))
 assert.throws(()=>requireSettledStudioOperations(stage('sound'),{operations:[{...image,state:'completed'},voice]}),/voice-1/)
 assert.doesNotThrow(()=>requireSettledStudioOperations(stage('sound'),{operations:[image,{...voice,state:'failed'}]}))
})
test('unknown and dispatching jobs cannot be handed off; executor waits for all media',()=>{
 for(const state of ['unknown','dispatching']){
  assert.throws(()=>requireSettledStudioOperations(stage('sound'),{operations:[{...voice,state,job_id:null}]}),/reconcile-required/)
  assert.throws(()=>requireSettledStudioOperations({card:{role:'executor'}},{operations:[{...image,state}]}),/reconcile-required/)
 }
 assert.doesNotThrow(()=>requireSettledStudioOperations(stage('storyboard'),{operations:[voice]}))
 assert.doesNotThrow(()=>requireSettledStudioOperations({card:{role:'executor'}},{operations:[{...image,state:'completed'},{...voice,state:'failed'}]}))
})
