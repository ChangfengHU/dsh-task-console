import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {studioRenderJob} from '../src/studio-render-host.ts'
import {fileSha256,registerStudioTools} from '../src/studio-tools.ts'
const jobId='a'.repeat(64),inputSha256='b'.repeat(64)
async function setup(t:any){const cwd=await mkdtemp(join(tmpdir(),'render-host-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(join(cwd,'composition'));await writeFile(join(cwd,'composition/index.html'),'<html/>');const script=join(cwd,'render.py');await writeFile(script,'# pinned');return {cwd,task:{cwd,design:{studio:{width:1080,height:1920,fps:30}}},config:{renderJobScript:script,renderJobSha256:await fileSha256(script),renderRuntime:'/host/runtime'}}}
const running={ok:true,jobId,inputSha256,state:'running',composition:'composition',output:'output.mp4',reused:false}
test('render submission calls only pinned host helper and preserves original job identity',async t=>{
 const {task,config}=await setup(t);let calls=0
 const r=await studioRenderJob(task,'start',{composition:'composition',output:'output.mp4'},{config,execute:async(script,args)=>{calls++;assert.equal(script,config.renderJobScript);assert.deepEqual(args,['start','--project-root',task.cwd,'--composition','composition','--output','output.mp4','--runtime','/host/runtime','--width','1080','--height','1920','--fps','30']);return {...running,secret:'not returned'}}})
 assert.equal(r.jobId,jobId);assert.equal(r.state,'running');assert.equal(r.qualityApproved,false);assert.doesNotMatch(JSON.stringify(r),/secret/)
 for(const output of ['../x.mp4','/tmp/x.mp4','x.txt','.private/x.mp4'])await assert.rejects(studioRenderJob(task,'start',{composition:'composition',output},{config,execute:async()=>{calls++;return running}}),/path-invalid/)
 assert.equal(calls,1)
 await writeFile(config.renderJobScript,'changed');await assert.rejects(studioRenderJob(task,'start',{composition:'composition',output:'output.mp4'},{config}),/helper-changed/)
})
test('status accepts only original job, verifies completed bytes and never equates output with quality',async t=>{
 const {cwd,task,config}=await setup(t);await writeFile(join(cwd,'output.mp4'),'test bytes');const receipt={...running,state:'completed',outputSha256:await fileSha256(join(cwd,'output.mp4')),bytes:10,width:1080,height:1920,fps:30,durationSeconds:100}
 const execute=async(_:string,args:string[])=>{assert.deepEqual(args,['status','--project-root',cwd,'--job-id',jobId]);return receipt}
 const r=await studioRenderJob(task,'status',{jobId},{config,execute});assert.equal(r.qualityApproved,false);assert.equal(r.bytes,10)
 await writeFile(join(cwd,'output.mp4'),'different');await assert.rejects(studioRenderJob(task,'status',{jobId},{config,execute}),/completed-file-invalid/)
 await assert.rejects(studioRenderJob(task,'status',{jobId:'c'.repeat(64)},{config,execute:async()=>running}),/receipt-invalid/)
 await assert.rejects(studioRenderJob(task,'status',{jobId:'../x'},{config,execute}),/job-id-invalid/)
})
test('helper failure cannot leak exceptions or turn unknown execution into completion',async t=>{
 const {task,config}=await setup(t)
 const failed=await studioRenderJob(task,'status',{jobId},{config,execute:async()=>({ok:false,error:'Bearer SECRET'})});assert.equal(failed.ok,false);assert.doesNotMatch(JSON.stringify(failed),/SECRET/)
 const missing=await studioRenderJob(task,'status',{jobId},{config,execute:async()=>({ok:false,errorCode:'composition_audio_required'})});assert.match(missing.nextAction,/actual narration/);
 const unknown=await studioRenderJob(task,'status',{jobId},{config,execute:async()=>({...running,state:'unknown'})});assert.equal(unknown.state,'unknown');assert.match(unknown.nextAction,/host render capability/)
})
test('render native tools deny non-producer and stale invocations before launching jobs',async()=>{
 const defs=new Map<string,any>();let count=0,active=true
 const ctx={tools:{register:(tool:any)=>{defs.set(tool.name,tool);return()=>defs.delete(tool.name)}}}
 const make=(role:string)=>registerStudioTools(ctx,{input:{task:{cwd:'/unused'},card:{role},sessionId:'s'},workflow:{},isActive:()=>active,renderJob:async()=>{count++;return running}})
 const exec={agent:{session:{id:'s'}}};let stop=await make('reviewer');await assert.rejects(defs.get('studio_render_start').execute({composition:'composition',output:'out.mp4'},exec),/role-denied/);stop()
 stop=await make('executor');await defs.get('studio_render_status').execute({jobId},exec);assert.equal(count,1);active=false;await assert.rejects(defs.get('studio_render_start').execute({composition:'composition',output:'out.mp4'},exec),/stale-run/);assert.equal(count,1);stop()
})
