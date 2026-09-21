import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

test('shared design view renders delegated notifications without a review-page plan variable', async()=>{
  // Exercise the actual component, without mounting the DSH host or installing React.
  const result=await build({entryPoints:[fileURLToPath(new URL('../src/client/TaskPlanReview.tsx',import.meta.url))],bundle:true,write:false,format:'esm',jsx:'automatic',plugins:[{name:'view-fixture',setup(b){
    b.onResolve({filter:/^(react(?:\/jsx-runtime)?|\.\/Console\.tsx)$/},a=>({path:a.path,namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment'; export const useEffect=()=>{}; export const useState=value=>[value,()=>{}]; export const go=()=>{};"}))
  }}]})
  const {TaskDesignView}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
  assert.equal(TaskDesignView({}),null)
  const design:any={scope:'fixture scope',branches:[{id:'verify',when:'unknown',action:'read',evidence:'fresh'}],coordination:'three roles',failurePolicy:{isolateItems:true,maxAttempts:2,stopConditions:['no grant']},acceptance:['real evidence']}
  assert.match(JSON.stringify(TaskDesignView({design})),/fixture scope/)
  design.notifications={channel:'wecom',chatIds:['fixture-group'],agentId:'wecom-notifier'}
  const tree=JSON.stringify(TaskDesignView({design}))
  assert.match(tree,/wecom-notifier/);assert.match(tree,/通知失败不重跑浏览器/)
})
