import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {readStudioHostConfiguration} from '../src/studio-config.ts'
import {refreshStudioCapabilities,observeStudioAudio} from '../src/studio-host.ts'
import {studioRenderConfiguration,studioRenderJob} from '../src/studio-render-host.ts'
import {fileSha256} from '../src/studio-tools.ts'
import {Config,apply} from '../src/index.ts'
import {TaskConsoleService} from '../src/service.ts'
import {TaskRunner} from '../src/runner.ts'
import {EventStore} from '../src/tasks.ts'

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'studio 用户 home '));t.after(()=>rm(root,{recursive:true,force:true}))
 const configPath=join(root,'private config.json'),legacy=join(root,'legacy.json')
 await writeFile(legacy,JSON.stringify({renderRuntime:'/legacy/runtime'}))
 return {root,configPath,legacy:pathToFileURL(legacy)}
}
test('explicit configuration never falls back; legacy is used only when no path is set',async t=>{
 const s=await fixture(t);assert.equal((await readStudioHostConfiguration(undefined,s.legacy)).renderRuntime,'/legacy/runtime')
 for(const body of ['{SECRET', 'null','[]','42',JSON.stringify({dshProfilePath:'relative SECRET'})]){
  await writeFile(s.configPath,body)
  await assert.rejects(readStudioHostConfiguration(s.configPath,s.legacy),(e:any)=>/^studio-host-config-/.test(e.message)&&!e.message.includes('SECRET'))
 }
 await rm(s.configPath)
 await assert.rejects(readStudioHostConfiguration(s.configPath,s.legacy),/config-unavailable/)
 for(const path of ['', 'relative.json'])await assert.rejects(readStudioHostConfiguration(path,s.legacy),/path-invalid/)
 assert.deepEqual(await readStudioHostConfiguration(undefined,pathToFileURL(join(s.root,'missing'))),{})
})
test('explicit host config reaches actual Python preflight/audio and render arguments outside original home',async t=>{
 const s=await fixture(t),profile=join(s.root,'other-user','web profile.yml'),runtime=join(s.root,'render 运行'),marker=join(s.root,'environment.json'),helper=join(s.root,'probe helper.py'),audio=join(s.root,'audio.wav')
 await writeFile(audio,'fixture');const sha=await fileSha256(audio)
 await writeFile(helper,`import os,json\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text(json.dumps({k:os.environ.get(k) for k in ['STUDIO_DSH_PROFILE','STUDIO_RENDER_RUNTIME']}))\nprint(json.dumps({'ok':True,'capabilities':{},'input_modality':'input_audio','finish_reason':'stop','audio_sha256':'${sha}'}))\n`)
 const config={dshProfilePath:profile,renderRuntime:runtime,preflightScript:helper,audioScript:helper,vaultTokenFile:join(s.root,'fake token reference'),renderJobScript:helper,renderJobSha256:await fileSha256(helper)}
 await writeFile(s.configPath,JSON.stringify(config))
 const task={id:'fixture',cwd:s.root,design:{studio:{characterId:'fixture',referenceSha256:sha,width:1080,height:1920,fps:30}}},deps={configPath:s.configPath}
 await refreshStudioCapabilities({recordCapability:()=>{},recordPreflight:()=>{}} as any,task,deps)
 assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),{STUDIO_DSH_PROFILE:profile,STUDIO_RENDER_RUNTIME:runtime})
 await rm(marker);await observeStudioAudio(task,{wavPath:audio,start:0,end:1},deps)
 assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),{STUDIO_DSH_PROFILE:profile,STUDIO_RENDER_RUNTIME:runtime})
 assert.deepEqual(await studioRenderConfiguration(s.configPath),config)
 await mkdir(join(s.root,'composition'));await writeFile(join(s.root,'composition/index.html'),'fixture')
 let called=false
 await studioRenderJob(task,'start',{composition:'composition',output:'out.mp4'},{...deps,execute:async(script,args)=>{
  called=true;assert.equal(script,helper);assert.equal(args[args.indexOf('--runtime')+1],runtime)
  return {ok:false,errorCode:'render_host_failed'}
 }})
 assert.ok(called)
 // Paths are reread for each invocation; a broken explicit file cannot select legacy.
 await writeFile(s.configPath,'{SECRET')
 await assert.rejects(observeStudioAudio(task,{wavPath:audio,start:0,end:1},deps),/config-unavailable/)
 await assert.rejects(studioRenderJob(task,'status',{jobId:'a'.repeat(64)},deps),/config-unavailable/)
})
test('DSH startup validates and forwards explicit binding before creating the service',async t=>{
 const s=await fixture(t),service={ready:Promise.resolve(),runner:{},capabilities:{}},calls:any[]=[]
 const ctx:any={plugin:async(type:any,config:any)=>{calls.push({type,config})},get:()=>service,effect:()=>{}}
 await assert.rejects(apply(ctx,{studioConfigPath:s.configPath}),/config-unavailable/);assert.equal(calls.length,0)
 await writeFile(s.configPath,'{}')
 const normalized=Config({studioConfigPath:s.configPath})
 await apply(ctx,normalized)
 assert.equal(calls.length,1);assert.equal(calls[0].type,TaskConsoleService);assert.equal(calls[0].config.studioConfigPath,s.configPath)
 assert.equal(Config({}).studioConfigPath,undefined)
})
test('service instances retain independent bindings in their actual runner host callbacks',async t=>{
 const s=await fixture(t);await writeFile(s.configPath,'{SECRET')
 const other=join(s.root,'other.json');await writeFile(other,'[]')
 const loading:Promise<void>[]=[]
 t.mock.method(TaskRunner.prototype,'start',async function(this:TaskRunner){
  ;(this as any).store=new EventStore(join(s.root,'store-'+loading.length));loading.push(this.store.load());return new Promise<void>(()=>{})
 })
 const ctx=new Context(),service=new TaskConsoleService(ctx,{studioConfigPath:s.configPath})
 const second=new TaskConsoleService(new Context(),{studioConfigPath:other})
 await Promise.all(loading);t.after(()=>{service.runner.store.kernel.db.close();second.runner.store.kernel.db.close()})
 await assert.rejects((service.runner as any).registerStudioTools({}, {task:{id:'fixture',cwd:s.root},card:{role:'planner'}},()=>true,async()=>{}),{message:'studio-host-config-unavailable'})
 await assert.rejects((second.runner as any).registerStudioTools({}, {task:{id:'fixture',cwd:s.root},card:{role:'planner'}},()=>true,async()=>{}),{message:'studio-host-config-invalid'})
})
