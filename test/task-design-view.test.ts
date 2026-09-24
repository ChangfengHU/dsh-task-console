import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

test('shared design view renders delegated notifications without a review-page plan variable', async()=>{
  // Exercise the actual component, without mounting the DSH host or installing React.
  const result=await build({entryPoints:[fileURLToPath(new URL('../src/client/TaskPlanReview.tsx',import.meta.url))],bundle:true,write:false,format:'esm',jsx:'automatic',plugins:[{name:'view-fixture',setup(b){
    b.onResolve({filter:/^(react(?:\/jsx-runtime)?|\.\/Console\.tsx)$/},a=>({path:a.path,namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment'; export const useEffect=()=>{}; export const useState=value=>[value===null?(globalThis.__reviewFixturePlan??value):value,()=>{}]; export const go=()=>{};"}))
  }}]})
  const {TaskDesignView,TaskPlanReview}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
  assert.equal(TaskDesignView({}),null)
  const design:any={scope:'fixture scope',branches:[{id:'verify',when:'unknown',action:'read',evidence:'fresh'}],coordination:'three roles',failurePolicy:{isolateItems:true,maxAttempts:2,stopConditions:['no grant']},acceptance:['real evidence']}
  assert.match(JSON.stringify(TaskDesignView({design})),/fixture scope/)
  design.notifications={channel:'wecom',chatIds:['fixture-group'],agentId:'wecom-notifier'}
  const tree=JSON.stringify(TaskDesignView({design}))
  assert.match(tree,/wecom-notifier/);assert.match(tree,/通知失败不重跑上游业务/)
  const fleet=JSON.stringify(TaskDesignView({design,recipe:{id:'fleet-base-v3',login:'provision-gemini'}}))
  assert.match(fleet,/三角色原始证据与 Fleet 独立回读/)
  assert.doesNotMatch(fleet,/未选择专用宿主证据闸门/)
  assert.match(JSON.stringify(TaskDesignView({design,recipe:{id:'fleet-base-v2',login:'provision-gemini'}})),/双浏览器20分钟独立登录验收/)
  assert.match(JSON.stringify(TaskDesignView({design,recipe:{id:'fleet-base-v2',login:'preserve'}})),/未选择专用宿主证据闸门/)
  const plan:any={id:'plan',hash:'fixture-hash',state:'pending',decision:'revise',revisionTaskId:'task',definition:{title:'Fixture',participants:[],design},actions:[]}
  try{
    ;(globalThis as any).__reviewFixturePlan=plan
    let view=JSON.stringify(TaskPlanReview({api:{},id:plan.id}))
    assert.match(view,/批准更新，保持暂停/)
    assert.doesNotMatch(view,/批准并执行/)
    plan.state='awaiting_trial';plan.taskId='task'
    view=JSON.stringify(TaskPlanReview({api:{},id:plan.id}))
    assert.match(view,/已更新 · 仍暂停 · 待手动验收/)
    assert.match(view,/查看任务与执行记录/)
    assert.doesNotMatch(view,/定时未启用|查看时间表与触发记录/)
    plan.definition.trigger={kind:'cron',expr:'0 * * * *'}
    assert.match(JSON.stringify(TaskPlanReview({api:{},id:plan.id})),/待手动验收 · 定时未启用/)
    plan.state='pending';plan.decision='create';delete plan.definition.trigger
    assert.match(JSON.stringify(TaskPlanReview({api:{},id:plan.id})),/批准并执行/)
  }finally{delete (globalThis as any).__reviewFixturePlan}
})
