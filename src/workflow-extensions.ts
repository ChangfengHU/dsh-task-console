/** Trusted host plugins only. This registry neither schedules work nor grants tools. */
import {createHash} from 'node:crypto'
import {canonical} from './capability-contract.js'
import {validateWorkflowSelection,workflowJsonObject as jsonObject,type WorkflowSelection,type WorkflowBinding} from './workflow-selection.js'
export {validateWorkflowSelection} from './workflow-selection.js'
export type {WorkflowSelection,WorkflowBinding} from './workflow-selection.js'
import type {CompletionCheck,RunnerOptions,CompletionDecision} from './runner.js'

export const WORKFLOW_HOST_API=1 as const
export interface WorkflowExtension {
 id:string; version:string; hostApi:typeof WORKFLOW_HOST_API
 implementationSha256:string
 validatePolicy:(value:unknown)=>Record<string,unknown>
 beforeStart?:RunnerOptions['beforeStart']
 beforePlanRound?:RunnerOptions['beforePlanRound']
 beforeComplete:NonNullable<RunnerOptions['beforeComplete']>
}
const HASH=/^[a-f0-9]{64}$/
const ID=/^[a-z][a-z0-9-]{0,79}$/
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
/** Exact versions can coexist; disposal/replacement is refused while in use. */
export class WorkflowExtensions {
 private entries=new Map<string,Readonly<WorkflowExtension>>()
 private calls=new Map<string,number>()
 constructor(private readonly inUse:(id:string,version:string)=>boolean=()=>false){}
 register(extension:WorkflowExtension):()=>void {
  if(!extension||!ID.test(extension.id??'')||!VERSION.test(extension.version??'')||extension.hostApi!==WORKFLOW_HOST_API||!HASH.test(extension.implementationSha256??'')||typeof extension.validatePolicy!=='function'||typeof extension.beforeComplete!=='function')throw Error('workflow-extension-definition-invalid')
  for(const name of ['beforeStart','beforePlanRound'] as const)if(extension[name]!==undefined&&typeof extension[name]!=='function')throw Error('workflow-extension-hook-invalid')
  const key=extension.id+'@'+extension.version
  if(this.entries.has(key))throw Error('workflow-extension-already-registered')
  const entry=Object.freeze({...extension});this.entries.set(key,entry)
  return ()=>{
   if(this.entries.get(key)!==entry)return
   if(this.calls.get(key)||this.inUse(entry.id,entry.version))throw Error('workflow-extension-in-use')
   this.entries.delete(key)
  }
 }
 list(){return [...this.entries.values()].map(({id,version,hostApi,implementationSha256})=>({id,version,hostApi,implementationSha256,scope:'installed-definition-only' as const}))}
 private entry(selection:WorkflowSelection){
  const entry=this.entries.get(selection.id+'@'+selection.version)
  if(!entry)throw Error('workflow-extension-version-unavailable: '+selection.id+'@'+selection.version)
  return entry
 }
 bind(value:unknown):WorkflowBinding {
  const selection=validateWorkflowSelection(value),entry=this.entry(selection)
  const policy=jsonObject(entry.validatePolicy(jsonObject(selection.policy))),policySha256=digest(policy)
  if(selection.implementationSha256!==undefined&&(selection.implementationSha256!==entry.implementationSha256||selection.policySha256!==policySha256||digest(selection.policy)!==policySha256))throw Error('workflow-extension-binding-mismatch')
  return {...selection,policy,implementationSha256:entry.implementationSha256,policySha256}
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
 beforeStart(input:CompletionCheck){return this.invoke(input,entry=>entry.beforeStart?.(input))}
 beforePlanRound(input:CompletionCheck,items:unknown,proxyItems?:unknown){return this.invoke(input,entry=>entry.beforePlanRound?.(input,items,proxyItems))}
 beforeComplete(input:CompletionCheck):Promise<CompletionDecision>{
  return this.invoke(input,async entry=>{
   const decision=await entry.beforeComplete(input)
   if(!decision||typeof decision.summary!=='string'||!decision.summary.trim()||decision.summary.length>32000)throw Error('workflow-extension-completion-evidence-required')
   return {summary:decision.summary,metadata:jsonObject(decision.metadata)}
  })
 }
}
