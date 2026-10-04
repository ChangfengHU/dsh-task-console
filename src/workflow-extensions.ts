import {grantWorkflowTool} from './workflow-tool-grants.js'
/** Trusted host plugins only. This registry does not schedule work or grant ambient tools. */
import {createHash} from 'node:crypto'
import {canonical} from './capability-contract.js'
import {validateWorkflowSelection,workflowJsonObject as jsonObject,type WorkflowSelection,type WorkflowBinding} from './workflow-selection.js'
export {validateWorkflowSelection} from './workflow-selection.js'
export type {WorkflowSelection,WorkflowBinding} from './workflow-selection.js'
import type {CompletionCheck,RunnerOptions,CompletionDecision} from './runner.js'

import type {WorkflowEvidencePort} from './workflow-evidence.js'
export type {WorkflowEvidencePort,WorkflowReceipt} from './workflow-evidence.js'

export const WORKFLOW_HOST_API=2 as const
export interface WorkflowExtension {
 id:string; version:string; hostApi:1|2
 implementationSha256:string
 toolAccess?:'scoped-only'
 validatePolicy:(value:unknown)=>Record<string,unknown>
 beforeStart?:(input:CompletionCheck,host?:WorkflowEvidencePort)=>ReturnType<NonNullable<RunnerOptions['beforeStart']>>
 beforePlanRound?:(input:CompletionCheck,items:unknown,proxyItems?:unknown,host?:WorkflowEvidencePort)=>ReturnType<NonNullable<RunnerOptions['beforePlanRound']>>
 beforeComplete:(input:CompletionCheck,host?:WorkflowEvidencePort)=>ReturnType<NonNullable<RunnerOptions['beforeComplete']>>
 registerTools?:(ctx:any,input:CompletionCheck,host:WorkflowEvidencePort)=>Promise<()=>void>
}
const HASH=/^[a-f0-9]{64}$/
const ID=/^[a-z][a-z0-9-]{0,79}$/
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
/** Exact versions can coexist; disposal/replacement is refused while in use. */
export class WorkflowExtensions {
 private entries=new Map<string,Readonly<WorkflowExtension>>()
 private calls=new Map<string,number>()
 constructor(private readonly inUse:(id:string,version:string)=>boolean=()=>false,private readonly evidence?:(input:CompletionCheck,isActive?:()=>boolean)=>WorkflowEvidencePort){}
 register(extension:WorkflowExtension):()=>void {
  if(!extension||!ID.test(extension.id??'')||!VERSION.test(extension.version??'')||![1,WORKFLOW_HOST_API].includes(extension.hostApi)||!HASH.test(extension.implementationSha256??'')||typeof extension.validatePolicy!=='function'||typeof extension.beforeComplete!=='function')throw Error('workflow-extension-definition-invalid')
  for(const name of ['beforeStart','beforePlanRound','registerTools'] as const)if(extension[name]!==undefined&&typeof extension[name]!=='function')throw Error('workflow-extension-hook-invalid')
  if(extension.toolAccess!==undefined&&extension.toolAccess!=='scoped-only')throw Error('workflow-extension-tool-access-invalid')
  if((extension.registerTools||extension.toolAccess)&&extension.hostApi<2)throw Error('workflow-extension-tools-require-host-api-2')
  const key=extension.id+'@'+extension.version
  if(this.entries.has(key))throw Error('workflow-extension-already-registered')
  const entry=Object.freeze({...extension});this.entries.set(key,entry)
  return ()=>{
   if(this.entries.get(key)!==entry)return
   if(this.calls.get(key)||this.inUse(entry.id,entry.version))throw Error('workflow-extension-in-use')
   this.entries.delete(key)
  }
 }
 list(){return [...this.entries.values()].map(({id,version,hostApi,implementationSha256,toolAccess})=>({id,version,hostApi,implementationSha256,...(toolAccess?{toolAccess}:{}),scope:'installed-definition-only' as const}))}
 private entry(selection:WorkflowSelection){
  const entry=this.entries.get(selection.id+'@'+selection.version)
  if(!entry)throw Error('workflow-extension-version-unavailable: '+selection.id+'@'+selection.version)
  return entry
 }
 bind(value:unknown):WorkflowBinding {
  const selection=validateWorkflowSelection(value),entry=this.entry(selection)
  const policy=jsonObject(entry.validatePolicy(jsonObject(selection.policy))),policySha256=digest(policy)
  if(selection.hostApi!==undefined&&selection.hostApi!==entry.hostApi)throw Error('workflow-extension-host-api-mismatch')
  if(selection.implementationSha256!==undefined&&(selection.implementationSha256!==entry.implementationSha256||selection.policySha256!==policySha256||digest(selection.policy)!==policySha256))throw Error('workflow-extension-binding-mismatch')
  return {...selection,policy,implementationSha256:entry.implementationSha256,policySha256,...(entry.hostApi===2?{hostApi:2 as const}:{})}
 }
 private bound(input:CompletionCheck){
  const selection=validateWorkflowSelection(input.task.design?.extension)
  if(!selection.implementationSha256||!selection.policySha256)throw Error('workflow-extension-host-binding-required')
  return {binding:this.bind(selection),entry:this.entry(selection)}
 }
 private async invoke<T>(input:CompletionCheck,run:(entry:Readonly<WorkflowExtension>)=>Promise<T>|T):Promise<T>{
  const {binding,entry}=this.bound(input),key=binding.id+'@'+binding.version
  this.calls.set(key,(this.calls.get(key)??0)+1)
  try{return await run(entry)}finally{const n=(this.calls.get(key)??1)-1;if(n)this.calls.set(key,n);else this.calls.delete(key)}
 }
 requiresScopedTools(input:CompletionCheck){return this.bound(input).entry.toolAccess==='scoped-only'}
 beforeStart(input:CompletionCheck){return this.invoke(input,entry=>entry.beforeStart?.(input,this.evidence?.(input)))}
 beforePlanRound(input:CompletionCheck,items:unknown,proxyItems?:unknown){return this.invoke(input,entry=>entry.beforePlanRound?.(input,items,proxyItems,this.evidence?.(input)))}
 async registerTools(ctx:any,input:CompletionCheck,isActive:()=>boolean):Promise<()=>void>{
  return this.invoke(input,async entry=>{
   if(!entry.registerTools)return ()=>{}
   let disposed=false
   const host=this.evidence?.(input,()=>!disposed&&isActive())
   if(!host)throw Error('workflow-extension-evidence-port-required')
   const defineTool=process.env.NODE_ENV==='test'?(v:any)=>v:(await import('@deepseek-ai/dsh-tools')).defineTool
   const disposers:(()=>void)[]=[]
   const facade={tools:{register:(definition:any)=>{
    if(typeof definition?.name!=='string'||!definition.name.startsWith(entry.id.replace(/-/g,'_')+'_')||typeof definition.execute!=='function')throw Error('workflow-extension-tool-definition-invalid')
    const execute=definition.execute
    const ungrant=grantWorkflowTool(input.sessionId,definition.name,()=>{host.assertActive();return true})
    let unregister:()=>void
    try{unregister=ctx.tools.register(defineTool({...definition,execute:async(args:any,exec:any)=>{
      host.assertActive();if(exec?.agent?.session?.id&&exec.agent.session.id!==input.sessionId)throw Error('workflow-extension-session-mismatch')
      const result=await execute(args,exec);host.assertActive();return result
    }}))}catch(error){ungrant();throw error}
    let released=false;const drop=()=>{if(released)return;released=true;ungrant();unregister()};disposers.push(drop);return drop
   }}}
   let dispose:()=>void
   try{dispose=await entry.registerTools(facade,input,host)}catch(error){disposed=true;for(const drop of disposers)drop();throw error}
   if(typeof dispose!=='function'){disposed=true;for(const drop of disposers)drop();throw Error('workflow-extension-disposer-required')}
   try{host.assertActive()}catch(e){disposed=true;try{dispose()}finally{for(const drop of disposers)drop()}throw e}
   return ()=>{if(disposed)return;disposed=true;try{dispose()}finally{for(const drop of disposers)drop()}}
  })
 }
 beforeComplete(input:CompletionCheck):Promise<CompletionDecision>{
  return this.invoke(input,async entry=>{
   const decision=await entry.beforeComplete(input,this.evidence?.(input))
   if(!decision||typeof decision.summary!=='string'||!decision.summary.trim()||decision.summary.length>32000)throw Error('workflow-extension-completion-evidence-required')
   if(decision.artifacts!==undefined&&(!Array.isArray(decision.artifacts)||decision.artifacts.some(a=>!a||typeof a.path!=='string'||!HASH.test(a.sha256))))throw Error('workflow-extension-artifact-evidence-invalid')
   return {summary:decision.summary,metadata:jsonObject(decision.metadata),...(decision.artifacts?{artifacts:decision.artifacts.map(a=>({...a}))}:{})}
  })
 }
}
