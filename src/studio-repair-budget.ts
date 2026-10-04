/** Candidate revisions include acknowledgement/metadata updates, not production rounds.
 * Count materialized rounds, including cancelled preparation, but not the future
 * decision planner created alongside each round. Never refund a persisted count.
 */
export function readStudioRepairRounds(store:any,input:any):number{
 const db=store.kernel.db,task=input.task?.id,batch=input.batch?.id
 if(typeof task!=='string'||!task||typeof batch!=='string'||!batch)throw Error('studio-repair-budget-context-required')
 const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
 const rounds=new Set<number>()
 if(exists('tasks')&&exists('dsh_card_bindings')){
  const rows=db.prepare("SELECT t.round FROM tasks t JOIN dsh_card_bindings b ON b.card_id=t.id WHERE b.spec_id=? AND b.batch_id=? AND t.tenant=? AND t.role IN ('studio-stage','gate','executor','reviewer')").all(task,batch,batch)
  for(const row of rows)if(Number.isInteger(row.round)&&row.round>0)rounds.add(row.round)
 }
 // Preserve reserved preparation rounds even if a future projection omits cancelled cards.
 if(exists('dsh_studio_preparation'))for(const row of db.prepare('SELECT round FROM dsh_studio_preparation WHERE task_id=? AND batch_id=?').all(task,batch))if(Number.isInteger(row.round)&&row.round>0)rounds.add(row.round)
 let recorded=0
 if(exists('dsh_studio_state')){
  const row=db.prepare("SELECT payload FROM dsh_studio_state WHERE task_id=? AND batch_id=? AND kind='budget'").get(task,batch)
  if(row){const value=JSON.parse(row.payload).repairRounds;if(!Number.isInteger(value)||value<0)throw Error('studio-repair-budget-invalid-recorded-count');recorded=value}
 }
 return Math.max(recorded,rounds.size-1,0)
}
