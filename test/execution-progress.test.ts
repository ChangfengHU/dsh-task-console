import test from 'node:test'
import assert from 'node:assert/strict'
import {executionProgress} from '../src/execution-progress.ts'
import {replayGraph,type GraphEventRow} from '../src/graph-data.ts'

const event=(id:number,task_id:string,kind:string,payload:any={},run_id:number|null=null):GraphEventRow=>({id,task_id,kind,payload,run_id,created_at:id,graph_id:'batch'})
const events=[event(1,'base','created',{assignee:'installer',status:'ready'}),event(2,'browser','created',{assignee:'browser',status:'todo'}),event(3,'runner','created',{assignee:'runner',status:'todo'}),event(4,'base','claimed',{},1),event(5,'base','completed',{summary:'基础接入完成，仅检查复用'},1),event(6,'browser','claimed',{},2),event(7,'browser','failed',{outcome:'failed',error:JSON.stringify({kind:'error',error:{code:'TIMEOUT',message:'secret-fixture-never-show'}})},2),event(8,'browser','gave_up'),event(9,'runner','cancelled',{error:'upstream failed'})]

test('failed non-artifact workflow reports completed, failed and unstarted roles without claiming acceptance',()=>{
  const report=executionProgress(replayGraph(events),'failed',id=>id??'unknown')!
  assert.match(report,/本次执行未通过/);assert.match(report,/installer：完成/)
  assert.match(report,/基础接入完成，仅检查复用/);assert.match(report,/browser：执行失败 · Run #2/)
  assert.match(report,/模型请求超时/);assert.match(report,/runner：已归档 · 尚未生成执行会话/)
  assert.doesNotMatch(report,/secret-fixture-never-show/)
})
test('historical report exposes only materialized roles and the supplied frame, not future failure',()=>{
  const report=executionProgress(replayGraph(events,4),null,id=>id??'unknown')!
  assert.match(report,/本次执行尚未完成/);assert.match(report,/installer：运行中/)
  assert.doesNotMatch(report,/模型请求超时|基础接入完成|执行失败|Run #2/)
  assert.equal(executionProgress(replayGraph(events,0),null,id=>id??''),undefined)
})
test('unknown error details remain in Trace instead of leaking provider payloads',()=>{
  const frame=replayGraph(events);frame.runs[1].error='Authorization: Bearer secret-fixture-never-show'
  const report=executionProgress(frame,'failed',id=>id??'')!
  assert.match(report,/Session Trace/);assert.doesNotMatch(report,/secret-fixture/)
})
