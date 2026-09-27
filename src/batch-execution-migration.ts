import {readFileSync,realpathSync,lstatSync} from 'node:fs'
import {withPresetLock} from './preset-lock.ts'
/** Operator-only, one-step migration. Original batch bytes remain immutable. */
import {createHash} from 'node:crypto'
import {readFile,lstat,realpath} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {canonical} from './capability-contract.ts'
import {captureExecutionBinding,verifyExecutionBinding,executionRuntimeIdentity,assertBinding,ExecutionBindingError,type BatchExecutionBinding} from './batch-execution-binding.ts'
import {StudioInterventions} from './studio-interventions.js'
import {taskForBatch} from './tasks.js'
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex')
const digest=(x:unknown)=>sha(canonical(x))
const fail=(s:string):never=>{throw new ExecutionBindingError('migration-'+s)}
const runtimeRoot=dirname(dirname(fileURLToPath(import.meta.url)))
export function migrationTable(db:any){
 db.exec('CREATE TABLE IF NOT EXISTS dsh_execution_binding_migrations (batch_id TEXT PRIMARY KEY, original_sha TEXT NOT NULL, preview_sha TEXT NOT NULL, payload TEXT NOT NULL)')
 db.exec('CREATE TABLE IF NOT EXISTS dsh_execution_binding_runtime_refreshes (batch_id TEXT NOT NULL, sequence INTEGER NOT NULL, previous_sha TEXT NOT NULL, preview_sha TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(batch_id,sequence))')
}
function readInitialOverlay(row:any,original:BatchExecutionBinding){
 let p:any;try{p=JSON.parse(row.payload)}catch{return fail('invalid-overlay')}
 const {previewSha256,...body}=p
 if(row.original_sha!==original.sha256||p.originalSha256!==original.sha256||p.taskId!==original.taskId||p.batchId!==original.batchId||previewSha256!==row.preview_sha||digest(body)!==previewSha256)fail('invalid-overlay')
 assertBinding(p.binding,original.taskId,original.batchId)
 return p.binding as BatchExecutionBinding
}
export function effectiveExecutionBinding(db:any,original:BatchExecutionBinding):BatchExecutionBinding{
 assertBinding(original,original.taskId,original.batchId)
 let current=original
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_execution_binding_migrations'").get()){
  const row=db.prepare('SELECT * FROM dsh_execution_binding_migrations WHERE batch_id=?').get(original.batchId)
  if(row)current=readInitialOverlay(row,original)
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_execution_binding_runtime_refreshes'").get()){
  const rows=db.prepare('SELECT * FROM dsh_execution_binding_runtime_refreshes WHERE batch_id=? ORDER BY sequence').all(original.batchId) as any[]
  for(let i=0;i<rows.length;i++){
   const row=rows[i];let p:any;try{p=JSON.parse(row.payload)}catch{return fail('invalid-runtime-refresh')}
   const {previewSha256,...body}=p
   if(row.sequence!==i+1||row.previous_sha!==current.sha256||p.schemaVersion!==1||p.sequence!==row.sequence||p.taskId!==original.taskId||p.batchId!==original.batchId||p.previousEffectiveSha256!==current.sha256||previewSha256!==row.preview_sha||digest(body)!==previewSha256)fail('invalid-runtime-refresh')
   assertBinding(p.binding,original.taskId,original.batchId)
   if(canonical(p.binding.agents)!==canonical(current.agents)||canonical(p.binding.fallback)!==canonical(current.fallback)||p.binding.runtimeSha256===current.runtimeSha256)fail('invalid-runtime-refresh')
   current=p.binding
  }
 }
 return current
}
export function executionMigrationSha(db:any,batchId:string):string|null{
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_execution_binding_runtime_refreshes'").get()){
  const refresh=db.prepare('SELECT preview_sha FROM dsh_execution_binding_runtime_refreshes WHERE batch_id=? ORDER BY sequence DESC LIMIT 1').get(batchId)?.preview_sha
  if(refresh)return refresh
 }
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_execution_binding_migrations'").get())return null
 return db.prepare('SELECT preview_sha FROM dsh_execution_binding_migrations WHERE batch_id=?').get(batchId)?.preview_sha??null
}
export function assertEffectiveBinding(db:any,original:BatchExecutionBinding,selected:BatchExecutionBinding){if(effectiveExecutionBinding(db,original).sha256!==selected.sha256)fail('overlay-changed')}
/** Only a generated module location may differ. No YAML reserialization. */
export function releasePathOnly(old:string,current:string,targetRoot:string){
 const a=old.split('\n'),b=current.split('\n');if(a.length!==b.length)return false
 return a.every((line,i)=>{
  if(line===b[i])return true
  const pattern=/^  name: '([^']+\/filtered-mcp-client\.js)'$/
  const x=line.match(pattern),y=b[i].match(pattern)
  if(!x||!y||!a[i-1]?.startsWith('- id: mcp-')||y[1]!==join(targetRoot,'lib/filtered-mcp-client.js'))return false
  const oldRoot=dirname(dirname(x[1])),parent=dirname(targetRoot)
  return dirname(oldRoot)===parent&&/^[A-Za-z0-9_-]+-[a-f0-9]{12,40}(?:-[a-z0-9-]+)?$/.test(oldRoot.slice(parent.length+1))
 })
}
function assertQuiescent(store:any){
 const db=store.kernel.db
 if(db.prepare("SELECT 1 FROM tasks WHERE status='running' OR current_run_id IS NOT NULL OR claim_lock IS NOT NULL OR claim_expires IS NOT NULL OR worker_pid IS NOT NULL LIMIT 1").get()||db.prepare("SELECT 1 FROM task_runs WHERE status='running' LIMIT 1").get())fail('not-quiescent')
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_preparation'").get()&&db.prepare("SELECT 1 FROM dsh_studio_preparation WHERE state='draining' LIMIT 1").get())fail('preparation-draining')
 const ready=db.prepare("SELECT c.spec_id FROM tasks t JOIN dsh_card_bindings c ON c.card_id=t.id JOIN dsh_batches b ON b.id=c.batch_id WHERE t.status IN ('ready','review') AND b.settled_at IS NULL AND b.archived_at IS NULL").all()
 if(ready.some((r:any)=>{const task=store.tasks.get(r.spec_id);return task&&!task.archivedAt}))fail('not-quiescent')
}
async function safeBytes(path:string){if(await realpath(path)!==resolve(path)||(await lstat(path)).isSymbolicLink()||!(await lstat(path)).isFile())fail('snapshot-path');return readFile(path)}
export async function previewExecutionMigration(store:any,ctx:any,value:any,options:{runtime?:()=>Promise<string>;runtimeRoot?:string;quiescent?:()=>boolean}={}){
 if(!value||Object.keys(value).some(k=>!['taskId','batchId'].includes(k))||typeof value.taskId!=='string'||typeof value.batchId!=='string')fail('input')
 const context=()=>{
  if(options.quiescent&&!options.quiescent())fail('sessions-not-quiescent')
  const base=store.tasks.get(value.taskId),batch=store.s.batches.get(value.batchId)
  if(!base||!batch||batch.taskId!==base.id||base.archivedAt||batch.archivedAt||batch.settled||!batch.turn?.executionBinding)fail('context')
  // Global quiescence includes durable claims and ready/review dispatch queues.
  assertQuiescent(store)
  const original=batch.turn.executionBinding;assertBinding(original,base.id,batch.id)
  const previous=effectiveExecutionBinding(store.kernel.db,original)
  return {task:taskForBatch(base,batch),batch,original,previous}
 }
 const {task,original,previous}=context(),root=options.runtimeRoot??runtimeRoot,dir=join(dirname(root),'evidence/execution-binding-snapshots',original.sha256)
 const manifest=JSON.parse((await safeBytes(join(dir,'snapshot.json'))).toString())
 if(manifest.bindingSha256!==original.sha256||manifest.runtimeSha256!==original.runtimeSha256||!Array.isArray(manifest.roles)||manifest.roles.length!==original.agents.length)fail('snapshot-identity')
 const current=await captureExecutionBinding(ctx,task,original.batchId,original.fallback,options.runtime??executionRuntimeIdentity)
 if(current.agents.length!==original.agents.length)fail('roles-changed')
 for(const old of original.agents){
  if(!/^[A-Za-z0-9_-]+$/.test(old.id))fail('snapshot-agent-id')
  const now=current.agents.find(a=>a.id===old.id),row=manifest.roles.filter((r:any)=>r.agentId===old.id)
  if(!now||row.length!==1)fail('snapshot-agent')
  const files={'task-console.json':old.specSha256,'agent.cordis.yml':old.compositionSha256,'capabilities.lock.json':old.capabilitySha256,'skills.lock.json':old.skillLockSha256},bytes:Record<string,Buffer>={}
  for(const [name,expected] of Object.entries(files)){
   if(expected===null){if(row[0].files[name]!==undefined&&row[0].files[name]!==null)fail('snapshot-hash');continue}
   bytes[name]=await safeBytes(join(dir,old.id,name));if(sha(bytes[name])!==expected||row[0].files[name]!==expected)fail('snapshot-hash')
  }
  if(previous.sha256!==original.sha256){
   const before=previous.agents.find((a:any)=>a.id===old.id)
   if(!before||canonical(before)!==canonical(now))fail('authored-or-authority-drift')
  }else{
   const {compositionSha256:oc,capabilitySha256:ok,...oa}=old,{compositionSha256:nc,capabilitySha256:nk,...na}=now
   if(canonical(oa)!==canonical(na))fail('authored-or-authority-drift')
   const composition=(await safeBytes(join(now.directory,'agent.cordis.yml'))).toString()
   if(!releasePathOnly(bytes['agent.cordis.yml'].toString(),composition,root))fail('composition-not-path-only')
   const oldCap=JSON.parse(bytes['capabilities.lock.json'].toString()),newBytes=await safeBytes(join(now.directory,'capabilities.lock.json')),newCap=JSON.parse(newBytes.toString())
   if(sha(newBytes)!==now.capabilitySha256||sha(composition)!==now.compositionSha256)fail('current-changed')
   delete oldCap.compositionSha256;delete newCap.compositionSha256
   if(canonical(oldCap)!==canonical(newCap))fail('capabilities-changed')
  }
 }
 const bindingBody={...current,capturedAt:original.capturedAt};delete (bindingBody as any).sha256
 const binding={...bindingBody,sha256:digest(bindingBody)}
 if(binding.runtimeSha256===previous.runtimeSha256)fail('runtime-current')
 for(const a of binding.agents)await verifyExecutionBinding(ctx,binding,value.taskId,value.batchId,a.id,options.runtime??executionRuntimeIdentity)
 if(context().original.sha256!==original.sha256)fail('original-changed')
 const hasRefreshTable=!!store.kernel.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_execution_binding_runtime_refreshes'").get()
 const sequence=previous.sha256===original.sha256?undefined:(hasRefreshTable?(store.kernel.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM dsh_execution_binding_runtime_refreshes WHERE batch_id=?').get(value.batchId) as any).n:1)
 const body={schemaVersion:1,taskId:value.taskId,batchId:value.batchId,originalSha256:original.sha256,previousEffectiveSha256:previous.sha256,...(sequence?{sequence}:{}),snapshotSha256:sha(await safeBytes(join(dir,'snapshot.json'))),binding,assisted:true,unblocked:false}
 return {...body,previewSha256:digest(body)}
}
export async function applyExecutionMigration(store:any,ctx:any,value:any,options:any={}){
 if(!value||Object.keys(value).some(k=>!['taskId','batchId','expectedPreviewSha256','reason'].includes(k))||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>2000||!/^[a-f0-9]{64}$/.test(value.expectedPreviewSha256))fail('input')
 const preview=await previewExecutionMigration(store,ctx,{taskId:value.taskId,batchId:value.batchId},options)
 if(preview.previewSha256!==value.expectedPreviewSha256)fail('preview-changed')
 const audit=new StudioInterventions(store);migrationTable(store.kernel.db)
 const locked=async(i:number):Promise<void>=>{
  if(i<preview.binding.agents.length){await withPresetLock(preview.binding.agents[i].directory,()=>locked(i+1));return}
  for(const a of preview.binding.agents)await verifyExecutionBinding(ctx,preview.binding,value.taskId,value.batchId,a.id,options.runtime??executionRuntimeIdentity)
 await store.transition(()=>{
  if(options.quiescent&&!options.quiescent())fail('sessions-not-quiescent')
  for(const a of preview.binding.agents){
   for(const [name,expected] of Object.entries({'task-console.json':a.specSha256,'agent.cordis.yml':a.compositionSha256,'capabilities.lock.json':a.capabilitySha256,'skills.lock.json':a.skillLockSha256})){if(expected!==null){const path=join(a.directory,name);if(realpathSync(path)!==path||!lstatSync(path).isFile()||sha(readFileSync(path))!==expected)fail('current-changed')}}
   if(a.selectionSource==='default'&&canonical(ctx.get('agentDefaultModel')?.currentSelection?.())!==canonical(a.selection))fail('default-model-changed')
  }
  assertQuiescent(store)
  const base=store.tasks.get(value.taskId),batch=store.s.batches.get(value.batchId)
  if(!base||base.archivedAt||!batch||batch.taskId!==value.taskId||batch.archivedAt||batch.settled)fail('context')
  const original=batch.turn?.executionBinding
  if(!original||original.sha256!==preview.originalSha256||effectiveExecutionBinding(store.kernel.db,original).sha256!==preview.previousEffectiveSha256)fail('original-changed')
  if(preview.previousEffectiveSha256===original.sha256){
   store.kernel.db.prepare('INSERT INTO dsh_execution_binding_migrations VALUES (?,?,?,?)').run(value.batchId,original.sha256,preview.previewSha256,JSON.stringify(preview))
   audit.record({id:'runtime-migration:'+preview.previewSha256,taskId:value.taskId,batchId:value.batchId,kind:'operator-runtime-migration',reason:value.reason})
  }else{
   migrationTable(store.kernel.db)
   const sequence=preview.sequence
   if(typeof sequence!=='number'||sequence!==(store.kernel.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM dsh_execution_binding_runtime_refreshes WHERE batch_id=?').get(value.batchId) as any).n)fail('preview-changed')
   store.kernel.db.prepare('INSERT INTO dsh_execution_binding_runtime_refreshes VALUES (?,?,?,?,?)').run(value.batchId,sequence,preview.previousEffectiveSha256,preview.previewSha256,JSON.stringify(preview))
   audit.record({id:'runtime-refresh:'+preview.previewSha256,taskId:value.taskId,batchId:value.batchId,kind:'operator-runtime-refresh',reason:value.reason})
  }
 },()=>undefined)
 }
 await locked(0)
 return {ok:true,...preview}
}
