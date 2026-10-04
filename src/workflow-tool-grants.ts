/** Process-local exact run grants, shared by separately bundled host/fence modules.
 * Not RPC and not an OS sandbox. Only the trusted workflow loader calls grant. */
const KEY=Symbol.for('dsh-task-console.workflow-tool-grants.v1')
type Grant={sessionId:string;name:string;active:()=>boolean}
const grants: Set<Grant>=(globalThis as any)[KEY]??=((globalThis as any)[KEY]=new Set())
export function grantWorkflowTool(sessionId:string,name:string,active:()=>boolean):()=>void{
 if(!sessionId||!name||typeof active!=='function')throw Error('workflow-tool-grant-invalid')
 const grant={sessionId,name,active};grants.add(grant);return ()=>{grants.delete(grant)}
}
export function hasWorkflowToolGrant(exec:any):boolean{
 const id=exec?.agent?.session?.id
 if(!id)return false
 for(const grant of grants)if(grant.sessionId===id&&grant.name===exec.name){try{if(grant.active())return true}catch{}}
 return false
}
