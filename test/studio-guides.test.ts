import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {studioGuide,studioGuideList} from '../src/studio-guides.ts'
import {registerStudioTools,STUDIO_TOOL_NAMES} from '../src/studio-tools.ts'
import {registerStudioSkillGate} from '../src/studio-skill-gate.ts'

async function fixture(t:any,role='executor'){
 const cwd=await mkdtemp(join(tmpdir(),'guide-no-documents-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const require=createRequire(import.meta.url)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-tools'))]})).href)
 const ctx:any=new Context();ctx.provide('systemPrompt',{tools:()=>{}})
 const runtime=new ToolRuntime(ctx),register=runtime.register.bind(runtime)
 runtime.register=(spec:any)=>register(process.env.NODE_ENV==='test'&&spec.parameters?.type!=='object'?defineTool(spec):spec)
 let active=true,hostCalls=0;const records:any[]=[]
 const input={task:{cwd,design:{evidenceContract:'studio-video-v1'}},card:{role},sessionId:'s'}
 const workflow={preflight:()=>({ok:true}),status:()=>({}),candidateLocation:()=>null}
 const dispose=await registerStudioTools(ctx,{input,workflow,isActive:()=>active,runCommand:async()=>{hostCalls++;throw Error('guide must not run a command')}})
 const stop=registerStudioSkillGate(ctx,{input,isActive:()=>active,record:r=>records.push(r)});t.after(()=>{stop();dispose()})
 const call=(name:string,args:any,sid='s')=>runtime.execute({name,arguments:args,agent:{ctx,session:{id:sid}},callId:'fixture-'+name,signal:new AbortController().signal} as any)
 return {cwd,call,records,deactivate:()=>active=false,hostCalls:()=>hostCalls}
}

test('packaged full guide snapshots have exact UTF-8 hashes and cannot be changed through returned objects',()=>{
 for(const id of ['execution','handoff'] as const){
  const g=studioGuide(id);assert.equal(g.sha256,createHash('sha256').update(g.text,'utf8').digest('hex'));assert.ok(g.text.length>4000);assert.equal(g.qualityApproved,false)
  ;(g as any).text='modified';assert.notEqual(studioGuide(id).text,'modified')
 }
 assert.throws(()=>studioGuide('../../private' as any),/guide-id-invalid/)
 assert.ok(STUDIO_TOOL_NAMES.includes('studio_read_guide'))
 assert.deepEqual(studioGuideList().map(x=>x.next),['execution','handoff'].map(id=>({tool:'studio_read_guide',arguments:{id}})))
 assert.ok(studioGuideList().every(g=>!('text' in g)))
})

test('actual SDK reads both full guides without project documents, command calls or skill receipts',async t=>{
 const f=await fixture(t)
 for(const id of ['execution','handoff'] as const){
  const r:any=await f.call('studio_read_guide',{id});assert.equal(r.isError,false,JSON.stringify(r));assert.deepEqual(r.value,studioGuide(id))
  assert.ok(r.content.some((x:any)=>x.type==='text'&&x.text.includes(studioGuide(id).sha256)))
 }
 assert.equal(f.hostCalls(),0);assert.deepEqual(f.records,[]);assert.deepEqual(await readdir(f.cwd),[])
 const status:any=await f.call('studio_status',{});assert.equal(status.isError,false,JSON.stringify(status));assert.deepEqual(status.value.guides,studioGuideList());assert.ok(JSON.stringify(status.value.guides).length<1500)
})

test('actual SDK rejects arbitrary IDs/paths, missing IDs, cross-session and stale guide reads',async t=>{
 const f=await fixture(t)
 for(const args of [{},{id:'../../private'},{id:'execution',path:'/etc/passwd'}]){
  const r:any=await f.call('studio_read_guide',args);assert.equal(r.isError,true,JSON.stringify(r));assert.equal(r.value,undefined)
 }
 assert.equal((await f.call('studio_read_guide',{id:'execution'},'other')).isError,true)
 f.deactivate();assert.equal((await f.call('studio_read_guide',{id:'handoff'})).isError,true);assert.equal(f.hostCalls(),0)
})

test('unrelated role cannot read Studio guides even when registered in native fixture',async t=>{
 const f=await fixture(t,'notifier');const r:any=await f.call('studio_read_guide',{id:'execution'});assert.equal(r.isError,true);assert.match(JSON.stringify(r),/studio-role-denied/)
})
