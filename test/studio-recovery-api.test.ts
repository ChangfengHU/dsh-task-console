import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as addon from '../src/studio-recovery-api.js'
test('maintenance module shares and preserves a running host across mount and disposal',async()=>{
 const require=createRequire(import.meta.url)
 const path=require.resolve('@deepseek-ai/cordis',{paths:[dirname(require.resolve('@deepseek-ai/dsh-typert-protocol'))]})
 const {Context}=await import(pathToFileURL(path).href),ctx=new Context()
 const running={id:'existing',status:'running'},store={kernel:{db:{}},transition:()=>assert.fail('status must not mutate'),s:{runs:new Map([['existing',running]])}}
 const owner={runner:{store,start:()=>assert.fail('no new start'),stop:()=>assert.fail('no stop')},ready:Promise.resolve()}
 const manifests:any[]=[]
 ctx.provide('taskConsole',owner);ctx.provide('sessionPersistence',{inspect:()=>assert.fail('status must not inspect sessions')});ctx.provide('typert',{register:(manifest:any)=>manifests.push(manifest)})
 const fiber=ctx.plugin(addon);await fiber
 assert.equal(ctx.get('taskConsole').runner.store,store)
 const service=ctx.get('studioRecovery'),status=JSON.parse(await service.status())
 assert.equal(status.activeRuns,1);assert.equal(status.startsRunner,false)
 assert.equal(manifests.length,1);assert.deepEqual(manifests[0].invocations.map((i:any)=>i.namespace+':'+i.method),['studioRecovery:status','studioRecovery:reconcileImage'])
 await assert.rejects(service.reconcileImage('{}'),/invalid-input/)
 await fiber.dispose()
 assert.equal(ctx.get('studioRecovery'),undefined)
 assert.equal(ctx.get('taskConsole').runner.store,store)
 assert.equal(store.s.runs.get('existing'),running)
})
