/** Host-derived append-only evidence; narrow-tool presets are required for isolation.
 * Same-UID unrestricted shell is NOT constrained by this SQLite ledger. */
import {randomUUID} from 'node:crypto'
import type {EventStore} from './tasks.js'
import type {CompletionCheck} from './runner.js'
import {workflowJsonObject} from './workflow-selection.js'

export interface WorkflowReceipt {
 id:string;kind:string;taskId:string;batchId:string;cardId:string;runId:string;coreRunId:number
 sessionId:string;profileId:string;role:string;round:number;attempt:number;claimLock:string
 extensionId:string;extensionVersion:string;implementationSha256:string;policySha256:string
 createdAt:string;data:Record<string,any>
}
export interface WorkflowEvidencePort {
 assertActive():void
 commit(kind:string,data:Record<string,unknown>):WorkflowReceipt
 receipts(scope:'run'|'batch'):WorkflowReceipt[]
 artifacts():any[]
}
export class WorkflowEvidence {
 constructor(private store:EventStore){store.kernel.db.exec(`CREATE TABLE IF NOT EXISTS dsh_workflow_receipts(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL,batch_id TEXT NOT NULL,session_id TEXT NOT NULL,extension_id TEXT NOT NULL,implementation_sha TEXT NOT NULL,policy_sha TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS dsh_workflow_receipts_scope ON dsh_workflow_receipts(task_id,batch_id,extension_id);`)}
 port(input:CompletionCheck,isActive:()=>boolean=()=>true):WorkflowEvidencePort {
  const store=this.store,db=store.kernel.db,binding=input.task.design?.extension
  if(!binding?.implementationSha256||!binding.policySha256)throw Error('workflow-evidence-binding-required')
  const run=[...store.s.runs.values()].find(r=>r.sessionId===input.sessionId&&r.cardId===input.card.id&&r.taskId===input.task.id&&r.batchId===input.batch.id&&r.status==='running')
  const core=store.kernel.getTask(input.card.id)
  if(!run||!core?.claim_lock)throw Error('workflow-evidence-live-run-required')
  const coreRunId=store.coreRunId(run.id),claimLock=core.claim_lock
  const assertActive=()=>{
   const task=store.kernel.getTask(input.card.id),batch=store.s.batches.get(input.batch.id)
   const actual=db.prepare('SELECT status,claim_lock FROM task_runs WHERE id=?').get(coreRunId) as any
   if(!isActive()||!coreRunId||!batch||batch.settled||batch.archivedAt||store.s.runs.get(run.id)?.status!=='running'||task?.status!=='running'||task.current_run_id!==coreRunId||task.claim_lock!==claimLock||!task.claim_expires||task.claim_expires<=Math.floor(Date.now()/1000)||actual?.status!=='running'||actual.claim_lock!==claimLock)throw Error('workflow-evidence-stale-run')
  }
  assertActive()
  return {assertActive,
   commit:(kind,data)=>db.transaction(()=>{
    assertActive();if(!/^[a-z][a-z0-9-]{0,63}$/.test(kind))throw Error('workflow-evidence-kind-invalid')
    const receipt:WorkflowReceipt={id:randomUUID(),kind,taskId:input.task.id,batchId:input.batch.id,cardId:input.card.id,runId:run.id,coreRunId:coreRunId!,sessionId:input.sessionId,profileId:input.profileId,role:input.card.role??'executor',round:input.card.round??1,attempt:run.attempt,claimLock,extensionId:binding.id,extensionVersion:binding.version,implementationSha256:binding.implementationSha256!,policySha256:binding.policySha256!,createdAt:new Date().toISOString(),data:workflowJsonObject(data,524288)}
    db.prepare('INSERT INTO dsh_workflow_receipts VALUES(?,?,?,?,?,?,?,?)').run(receipt.id,receipt.taskId,receipt.batchId,receipt.sessionId,receipt.extensionId,receipt.implementationSha256,receipt.policySha256,JSON.stringify(receipt))
    return receipt
   })(),
   receipts:scope=>{
    assertActive();if(!['run','batch'].includes(scope))throw Error('workflow-evidence-scope-invalid')
    const rows=db.prepare('SELECT payload FROM dsh_workflow_receipts WHERE task_id=? AND batch_id=? AND extension_id=? AND implementation_sha=? AND policy_sha=? ORDER BY rowid').all(input.task.id,input.batch.id,binding.id,binding.implementationSha256,binding.policySha256) as any[]
    return rows.map(r=>JSON.parse(r.payload)).filter(r=>r.extensionVersion===binding.version&&(scope==='batch'||r.runId===run.id&&r.coreRunId===coreRunId&&r.claimLock===claimLock))
   },
   artifacts:()=>{assertActive();return [...store.s.artifacts.values()].filter(a=>a.taskId===input.task.id&&a.batchId===input.batch.id).map(a=>({...a}))},
  }
 }
}
