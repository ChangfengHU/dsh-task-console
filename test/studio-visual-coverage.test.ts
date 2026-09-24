import {test} from 'node:test'
import assert from 'node:assert/strict'
import {visualRequirements,bindVisualCoverage} from '../src/studio-visual-coverage.js'
const board={scenes:[{id:'s1'},{id:'s2'}],visualRequirements:[{id:'face',sceneId:'s1',purpose:'react'},{id:'room',sceneId:'s2',purpose:'location'}]}
const files=[{path:'face.png',sha256:'a'},{path:'room.png',sha256:'b'}]
const plan={schema:'visual-plan-v1',storyboardSha256:'boardhash',missing:[],items:[{requirementId:'face',path:'face.png',usage:'eyes reaction'},{requirementId:'room',path:'room.png',usage:'wide room'}]}
test('two registered pictures cannot satisfy an unfinished ten-asset plan',()=>{
 const requirements=[...board.visualRequirements,...Array.from({length:8},(_,i)=>({id:'pose'+i,sceneId:'s1',purpose:'pose'}))]
 assert.throws(()=>bindVisualCoverage({...board,visualRequirements:requirements},plan,files,'boardhash'),/Unfulfilled.*pose0/)
 assert.throws(()=>bindVisualCoverage(board,{...plan,missing:['face']},files,'boardhash'),/missing list/)
 assert.throws(()=>bindVisualCoverage(board,{...plan,items:[plan.items[0],plan.items[0]]},files,'boardhash'),/unique requirement/)
})
test('coverage binds actual file hashes and board; does not assert aesthetic approval',()=>{
 const result=bindVisualCoverage(board,plan,files,'boardhash');assert.equal(result.qualityApproved,false);assert.equal(result.items[0].sha256,'a')
 assert.throws(()=>bindVisualCoverage(board,plan,files,'newboard'),/registered storyboard SHA/)
 assert.throws(()=>bindVisualCoverage(board,plan,files.slice(0,1),'boardhash'),/registered image/)
 assert.throws(()=>visualRequirements({...board,scenes:[...board.scenes,{id:'s3'}]}),/s3 has no/)
})

test('path scope and extra requirements return distinct actionable diagnostics without demanding generation',()=>{
 const wrong={...plan,items:[{...plan.items[0],path:'assets/face.png'},plan.items[1],{requirementId:'extra-prop',path:'room.png',usage:'prop'}]}
 assert.throws(()=>bindVisualCoverage(board,wrong,files,'boardhash'),(e:any)=>{
  const msg=e.message;assert.match(msg,/items\[0\].path/);assert.match(msg,/items\[2\].requirementId/);assert.match(msg,/project-relative/);assert.match(msg,/requiresNewGeneration\":false/);assert.match(msg,/cannot grant extra image calls/);return true
 })
 // Fix only the mismatches; no image generation and no removal of actual files.
 assert.equal(bindVisualCoverage(board,plan,files,'boardhash').items.length,2)
})
