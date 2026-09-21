import { EventStore, taskForBatch, type Event } from './tasks.ts'

export interface StudioRecoveryInput { taskId: string; batchId: string; cardId: string; expectedRunId: string; recoveryId: string; reason: string }
/** Operator-only recovery, never a model tool. All mutations share one kernel transaction. */
export async function recoverStudioFailure(store: EventStore, input: StudioRecoveryInput) {
  for (const key of ['taskId','batchId','cardId','expectedRunId','recoveryId','reason'] as const)
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2000) throw Error('studio-recovery-invalid-input')
  return store.transition(() => {
    const previous = store.all().find(e => e.t === 'batch/studio_recovered' && e.recoveryId === input.recoveryId) as Extract<Event,{t:'batch/studio_recovered'}> | undefined
    if (previous) {
      if (['taskId','batchId','cardId','expectedRunId','reason'].some(k => (previous as any)[k] !== (input as any)[k])) throw Error('studio-recovery-id-conflict')
      return { replay: true, restored: previous.restored }
    }
    const {taskId,batchId,cardId,expectedRunId} = input
    const task = store.tasks.get(taskId), batch = store.s.batches.get(batchId), card = store.s.cards.get(cardId)
    if (!task || task.archivedAt || !batch || batch.taskId !== taskId || batch.archivedAt || batch.settled?.outcome !== 'failed'
      || taskForBatch(task,batch).design?.evidenceContract !== 'studio-video-v1') throw Error('studio-recovery-ineligible-batch')
    if (!card || card.taskId !== taskId || card.batchId !== batchId || card.status !== 'failed'
      || card.runIds.at(-1) !== expectedRunId || !['failed','crashed','timed_out'].includes(store.s.runs.get(expectedRunId)?.status ?? '')) throw Error('studio-recovery-failed-run-changed')
    const db = store.kernel.db
    const rows = db.prepare('SELECT id,status,current_run_id FROM tasks WHERE tenant=?').all(batchId) as any[]
    if (rows.length !== batch.cardIds.length || rows.some(r => !batch.cardIds.includes(r.id) || r.current_run_id !== null || !['done','triage','archived'].includes(r.status))) throw Error('studio-recovery-active-or-unexpected-node')
    if ([...store.s.batches.values()].some(b => b.taskId === taskId && b.id !== batchId && !b.settled && !b.archivedAt)) throw Error('studio-recovery-other-active-batch')
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_studio_operations'").get()
      || !db.prepare('SELECT 1 FROM dsh_studio_limits WHERE task_id=? AND batch_id=?').get(taskId,batchId)) throw Error('studio-recovery-missing-ledger')
    if (db.prepare("SELECT 1 FROM dsh_studio_operations WHERE task_id=? AND batch_id=? AND state NOT IN ('completed','failed') LIMIT 1").get(taskId,batchId)) throw Error('studio-recovery-reconcile-paid-operations-first')
    const descendants = new Set([cardId])
    let changed = true
    while (changed) { changed = false; for (const id of batch.cardIds) { const c = store.s.cards.get(id)!; if (!descendants.has(id) && c.deps.some(d => descendants.has(d))) { descendants.add(id); changed = true } } }
    const cancelled = batch.cardIds.filter(id => store.s.cards.get(id)?.status === 'cancelled')
    if (batch.cardIds.some(id => id !== cardId && store.s.cards.get(id)?.status === 'failed') || cancelled.some(id => !descendants.has(id))) throw Error('studio-recovery-unrelated-terminal-node')
    // Reopen root before descendants so dependency checks remain authoritative.
    const restored = [cardId,...cancelled].map(id => ({id,status:store.kernel.recoverStudioNode(id,id === cardId ? 'triage' : 'archived',input.recoveryId)}))
    return { replay: false, restored }
  }, result => result.replay ? undefined : {t:'batch/studio_recovered',at:new Date().toISOString(),...input,restored:result.restored})
}
