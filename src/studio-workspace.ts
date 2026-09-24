import {constants} from 'node:fs'
import {lstat,mkdir,open,realpath,stat,writeFile} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'

export interface StudioWorkspace {schema:'studio-task-workspace-v1';taskId:string;root:string;path:string}
export interface StudioBatchWorkspace {schemaVersion:1;mode:'studio-batch-v1';taskId:string;batchId:string;root:string;path:string}
const marker='.studio-workspace.json'
const fail=(reason:string):never=>{throw Error(`studio-workspace-${reason}`)}

async function directory(path:string,allowCreate:boolean){
 if(allowCreate)try{await mkdir(path,{mode:0o700});return true}catch(error:any){if(error.code!=='EEXIST')fail('allocation-failed')}
 try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)fail('directory-conflict')}catch{fail('directory-conflict')}
 return false
}
async function owned(path:string,value:StudioWorkspace|StudioBatchWorkspace,create:boolean){
 const created=await directory(path,create)
 if(created){
  // A failed marker write leaves an unowned directory, never one we later adopt.
  try{await writeFile(join(path,marker),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600})}catch{fail('ownership-write-failed')}
 }
 let handle
 try{
  handle=await open(join(path,marker),constants.O_RDONLY|constants.O_NOFOLLOW)
  const info=await handle.stat();if(!info.isFile()||info.size>4096)fail('ownership-invalid')
  const owner=JSON.parse(await handle.readFile('utf8'))
  if(JSON.stringify(owner)!==JSON.stringify(value))fail('ownership-invalid')
 }catch{fail('ownership-conflict')}finally{await handle?.close()}
 await directory(path,false)
}

/** Plan a directory under the actual host workspace without creating anything. */
export async function planStudioWorkspace(root:unknown,taskId:string):Promise<StudioWorkspace>{
 if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0'))fail('host-root-required')
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(taskId))fail('task-id-invalid')
 let canonical:string
 try{canonical=await realpath(root);if(!(await stat(canonical)).isDirectory())fail('host-root-unavailable')}catch{fail('host-root-unavailable')}
 return {schema:'studio-task-workspace-v1',taskId,root:canonical!,path:join(canonical!,'studio-workspaces',taskId)}
}

/** Only independent approval may allocate; later reuse verifies existing ownership. */
export async function ensureStudioWorkspace(value:StudioWorkspace,taskId:string,cwd:string,create=false){
 if(!value||value.schema!=='studio-task-workspace-v1'||value.taskId!==taskId)fail('binding-invalid')
 const expected=await planStudioWorkspace(value.root,taskId)
 if(expected.root!==value.root||expected.path!==value.path||cwd!==value.path)fail('binding-changed')
 const parent=join(value.root,'studio-workspaces')
 await directory(parent,create)
 await owned(value.path,expected,create)
 await directory(parent,false);await directory(value.path,false)
 return value.path
}

export async function planStudioBatchWorkspace(root:unknown,taskId:string,batchId:string):Promise<StudioBatchWorkspace>{
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(batchId))fail('batch-id-invalid')
 const task=await planStudioWorkspace(root,taskId)
 return {schemaVersion:1,mode:'studio-batch-v1',taskId,batchId,root:task.root,path:join(task.path,'batches',batchId)}
}

/** Verify against the actual host store root, not a root supplied in the turn. */
export async function ensureStudioBatchWorkspace(root:string,value:StudioBatchWorkspace|undefined,taskId:string,batchId:string,cwd:string,create=false){
 const expected=await planStudioBatchWorkspace(root,taskId,batchId)
 if(!value||JSON.stringify(value)!==JSON.stringify(expected)||cwd!==expected.path)fail('batch-binding-invalid')
 const task=await planStudioWorkspace(root,taskId)
 await ensureStudioWorkspace(task,taskId,task.path,create)
 const parent=join(task.path,'batches');await directory(parent,create)
 await owned(expected.path,expected,create)
 await directory(parent,false)
 return expected.path
}
