import assert from 'node:assert/strict'
import {test} from 'node:test'
import Database from 'better-sqlite3'
import {ImageJobs} from '../src/image-jobs.ts'
import {imagePolicy} from '../src/image-policy.ts'
import {TaskConsoleService} from '../src/service.ts'
import {METHODS} from '../src/wire.ts'
test('UI reads completed host assets without model image blocks and enforces job owner/index',async()=>{
 const db=new Database(':memory:'),image={attachmentId:'asset',mediaType:'image/png',width:1,height:1,bytes:3}
 const jobs=new ImageJobs(db,{codex:{prepare:async()=>({generate:async()=>({images:[image],model:'fixed'})})}})
 const target:any={imageGeneration:jobs,ctx:{get:(name:string)=>name==='attachments'?{readImage:async(ref:any)=>{assert.deepEqual(ref,image);return{data:new Uint8Array([1,2,3])}}}:undefined}}
 try{
  const receipt=jobs.start('owner',{requestId:'ui',prompt:'circle',references:[]},imagePolicy(undefined))
  await jobs.waitStatus('owner',receipt.jobId,1000,new AbortController().signal)
  const listing=JSON.parse(await TaskConsoleService.prototype.nativeImageJobs.call(target,JSON.stringify({sessionId:'owner'})));assert.equal(listing.jobs[0].state,'completed')
  const asset=JSON.parse(await TaskConsoleService.prototype.nativeImageAsset.call(target,JSON.stringify({sessionId:'owner',jobId:receipt.jobId})));assert.equal(asset.data,'AQID');assert.deepEqual(asset.image,image)
  await assert.rejects(TaskConsoleService.prototype.nativeImageAsset.call(target,JSON.stringify({sessionId:'intruder',jobId:receipt.jobId})),/不属于/)
  await assert.rejects(TaskConsoleService.prototype.nativeImageAsset.call(target,JSON.stringify({sessionId:'owner',jobId:receipt.jobId,index:1})),/没有/)
  await assert.rejects(TaskConsoleService.prototype.nativeImageAsset.call(target,JSON.stringify({sessionId:'owner',jobId:receipt.jobId,index:-1})),/无效/)
  assert.equal(JSON.parse(await TaskConsoleService.prototype.nativeImageJobs.call(target,JSON.stringify({sessionId:'intruder'}))).jobs.length,0)
  assert.ok(METHODS.some(([name])=>name==='nativeImageAsset'));assert.ok(METHODS.some(([name])=>name==='nativeImageJobs'))
 }finally{await jobs.dispose();db.close()}
})
