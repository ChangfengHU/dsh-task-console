/** Shared JSON syntax only; safe for browser-side task validation. */
export interface WorkflowSelection {
 id:string; version:string; policy:Record<string,unknown>
 implementationSha256?:string; policySha256?:string
}
export interface WorkflowBinding extends WorkflowSelection {
 implementationSha256:string; policySha256:string
}
const HASH=/^[a-f0-9]{64}$/
const ID=/^[a-z][a-z0-9-]{0,79}$/
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/
export function workflowJsonObject(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('workflow-policy-object-required')
 const walk=(v:any,depth:number):void=>{
  if(depth>24)throw Error('workflow-policy-too-deep')
  if(v===null||typeof v==='string'||typeof v==='boolean')return
  if(typeof v==='number'&&Number.isFinite(v))return
  if(Array.isArray(v)){for(const item of v)walk(item,depth+1);return}
  if(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))){
   for(const [key,item] of Object.entries(v)){
    if(['__proto__','constructor','prototype'].includes(key))throw Error('workflow-policy-key-invalid')
    walk(item,depth+1)
   }
   return
  }
  throw Error('workflow-policy-json-required')
 }
 walk(value,0)
 const raw=JSON.stringify(value)
 if(new TextEncoder().encode(raw).length>65536)throw Error('workflow-policy-too-large')
 return JSON.parse(raw)
}
/** Syntax only. Availability and implementation binding are checked by the host. */
export function validateWorkflowSelection(value:unknown):WorkflowSelection {
 const v=value as WorkflowSelection
 if(!v||Object.keys(v).some(k=>!['id','version','policy','implementationSha256','policySha256'].includes(k))||!ID.test(v.id??'')||!VERSION.test(v.version??''))throw Error('workflow-extension-selection-invalid')
 if((v.implementationSha256===undefined)!==(v.policySha256===undefined))throw Error('workflow-extension-binding-incomplete')
 for(const h of [v.implementationSha256,v.policySha256])if(h!==undefined&&!HASH.test(h))throw Error('workflow-extension-hash-invalid')
 return {id:v.id,version:v.version,policy:workflowJsonObject(v.policy),...(v.implementationSha256?{implementationSha256:v.implementationSha256,policySha256:v.policySha256}:{})}
}
