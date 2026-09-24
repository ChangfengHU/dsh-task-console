/** Administrator-installed, single-file ESM bundles; never a model-facing loader. */
import {readFile} from 'node:fs/promises'
import {isAbsolute,resolve,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {WorkflowExtensions,type WorkflowExtension} from './workflow-extensions.js'

export interface WorkflowModule {path:string;sha256:string}
/** The same manifest is consumed by the deployment guard and actual startup. */
export async function loadBundledWorkflowModules(rootUrl:URL):Promise<WorkflowExtension[]> {
 const root=fileURLToPath(rootUrl),compat=JSON.parse(await readFile(resolve(root,'lib/workflow-compat.json'),'utf8'))
 if(compat?.schemaVersion!==1||![1,2].includes(compat.hostApi)||!Array.isArray(compat.extensions))throw Error('workflow-compat-invalid')
 const modules:WorkflowModule[]=compat.extensions.map((entry:any)=>{
  if(!entry||typeof entry.bundle!=='string'||!entry.bundle.startsWith('lib/')||isAbsolute(entry.bundle))throw Error('workflow-bundle-path-invalid')
  const path=resolve(root,entry.bundle),rel=relative(root,path)
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('workflow-bundle-path-invalid')
  return {path,sha256:entry.implementationSha256}
 })
 const loaded=await loadWorkflowModules(modules)
 for(let i=0;i<loaded.length;i++)if(loaded[i].id!==compat.extensions[i].id||loaded[i].version!==compat.extensions[i].version||loaded[i].hostApi!==(compat.extensions[i].hostApi??1))throw Error('workflow-bundle-identity-mismatch')
 return loaded
}
export async function loadWorkflowModules(modules:WorkflowModule[]):Promise<WorkflowExtension[]> {
 if(!Array.isArray(modules)||modules.length>32)throw Error('workflow-module-config-invalid')
 const result:WorkflowExtension[]=[],checked=new WorkflowExtensions()
 for(const item of modules){
  if(!item||Object.keys(item).some(k=>!['path','sha256'].includes(k))||typeof item.path!=='string'||!isAbsolute(item.path)||!item.path.endsWith('.mjs')||!/^[a-f0-9]{64}$/.test(item.sha256??''))throw Error('workflow-module-config-invalid')
  const bytes=await readFile(item.path)
  if(bytes.length>2_000_000||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('workflow-module-digest-mismatch')
  // Import the exact verified bytes, not a mutable path. Bundles may use Node
  // builtins; relative/npm imports must have been bundled by their publisher.
  const imported=await import('data:text/javascript;base64,'+bytes.toString('base64'))
  const extension={...imported.default,implementationSha256:item.sha256} as WorkflowExtension
  checked.register(extension)
  result.push(extension)
 }
 return result
}
