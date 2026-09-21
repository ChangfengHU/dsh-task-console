import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decideTaskSignalWithAgent } from '../src/task-intake-agent.ts'
import { validateTaskSignal } from '../src/task-intake.ts'

test('summary uses the real task-intake preset and records its actual input before the decision', async () => {
  const root=await mkdtemp(join(tmpdir(),'intake-agent-contract-'))
  await writeFile(join(root,'task-console.json'),await readFile(new URL('../presets/task-intake/task-console.json',import.meta.url)))
  const signal=validateTaskSignal({schemaVersion:1,id:'summary-session',source:'test',kind:'inspection.completed',observedAt:new Date().toISOString(),
    goal:{title:'Inspection summary',objective:'Read the complete inspection report without doing any machine operation.'},items:[]})
  const events:string[]=[], tools=new Map<string,any>()
  let listener:any, session:any, input:any
  const presets={resolve:async()=>({id:'task-intake',path:join(root,'agent.cordis.yml')}),mount:async(_ctx:any,id:string)=>{assert.equal(id,'task-intake');events.push('preset-mounted')}}
  const ctx:any={
    on:(_kind:string,fn:any)=>{listener=fn;return()=>undefined},
    get:(key:string)=>key==='agentPresets'?presets:key==='permissionPresets'?{set:()=>events.push('permission-set')}:undefined,
    agents:{create:async(args:any)=>{
      assert.equal(args.meta.agentPreset,'task-intake');session={id:args.sessionId};await args.setup({})
      return {dispose:async()=>events.push('disposed'),agent:{session,ctx:{tools:{register:(tool:any)=>{tools.set(tool.name,tool);return()=>undefined}}},
        followup:(message:any)=>{input=message;queueMicrotask(async()=>{
          listener(session,{type:'user/message',data:message})
          const context=await tools.get('task_intake_context').execute();assert.deepEqual(context.items,[])
          const result=await tools.get('task_intake_decide').execute({action:'batch',reason:'No actionable incidents were present in the report.',confidence:1,decisions:[]})
          assert.equal(result.ok,true);events.push('decision')
          listener(session,{type:'turn/end',data:{reason:{kind:'completed'}}})
        })},
      }}
    }},
  }
  const result=await decideTaskSignalWithAgent(ctx,signal,{agents:[],candidateTasks:[],policy:[],items:[]},{
    onSessionReady:id=>{assert.equal(id,session.id);events.push('session-ready')},
    onInputDelivered:id=>{assert.equal(id,input.id);events.push('input-delivered')},
    timeoutMs:1000,
  })
  assert.equal(result.sessionId,session.id)
  assert.match(input.content[0].text,/summary-session/)
  assert.deepEqual([...tools.keys()],['task_intake_context','task_intake_decide'])
  assert.ok(events.indexOf('input-delivered')<events.indexOf('decision'))
  assert.ok(events.indexOf('permission-set')<events.indexOf('input-delivered'))
})
