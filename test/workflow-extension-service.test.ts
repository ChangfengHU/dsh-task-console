import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {TaskConsoleService} from '../src/service.js'
import {EventStore} from '../src/tasks.js'
import {WorkflowExtensions} from '../src/workflow-extensions.js'
import {METHODS} from '../src/wire.js'

test('trusted registration is not an RPC; task creation persists exact host binding before firing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'extension-service-')),store=new EventStore(root);await store.load()
 t.after(async()=>{store.kernel.db.close();await rm(root,{recursive:true,force:true})})
 const service:any=Object.create(TaskConsoleService.prototype)
 service.ready=Promise.resolve();service.workflowExtensions=new WorkflowExtensions()
 Object.defineProperty(service,'ctx',{value:{get:(name:string)=>name==='agentPresets'?{list:async()=>[{id:'worker',trust:'system'}]}:undefined}})
 service.runner={store,rememberName:()=>{},fire:()=>assert.fail('saveOnly must not fire')}
 const request={id:'T-extension',title:'Audit',brief:'Verify bytes',participants:[{agentId:'worker'}],cwd:root,trigger:{kind:'once'},timeoutSec:60,onFail:'stop',maxTries:1,saveOnly:true,
  design:{extension:{id:'audit-fixture',version:'1.0.0',policy:{archive:'input.tgz'}},scope:'isolated fixture',branches:[{id:'verify',when:'input available',action:'verify bytes',evidence:'actual hashes'}],coordination:'serial',failurePolicy:{isolateItems:false,maxAttempts:1,stopConditions:['bad input']},acceptance:['host evidence']}}
 await assert.rejects(service.createTask(JSON.stringify(request)),/version-unavailable/)
 assert.equal(store.tasks.size,0)
 await service.registerWorkflowExtension({id:'audit-fixture',version:'1.0.0',hostApi:1,implementationSha256:'b'.repeat(64),validatePolicy:(p:any)=>p,beforeComplete:async()=>({summary:'test fixture',metadata:{}})})
 await service.createTask(JSON.stringify(request))
 const binding=store.tasks.get(request.id)?.design?.extension
 assert.equal(binding?.implementationSha256,'b'.repeat(64));assert.match(binding?.policySha256??'',/^[a-f0-9]{64}$/)
 assert.equal(JSON.stringify(METHODS).includes('registerWorkflowExtension'),false)
})
