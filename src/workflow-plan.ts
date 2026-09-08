import type { Batch, TaskSpec, WorkflowDefinition } from './fold.ts'

/** Shared read-only projection. No transcript loading or synthetic execution nodes. */
export function workflowDefinition(task: TaskSpec): WorkflowDefinition {
  return JSON.parse(JSON.stringify({ title: task.title, brief: task.brief,
    participants: task.participants, graphMode: task.graphMode ?? 'static-chain',
    timeoutSec: task.timeoutSec, onFail: task.onFail, maxTries: task.maxTries }))
}

export function workflowView(task: TaskSpec, batch?: Batch) {
  const turn = batch?.turn
  const origin = turn?.origin ?? task.origin
  const sessions: { id: string; label: string }[] = []
  if (task.origin?.intakeSessionId) sessions.push({ id: task.origin.intakeSessionId, label: '原始创建 Agent' })
  if (turn?.origin?.intakeSessionId && !sessions.some(s => s.id === turn.origin!.intakeSessionId))
    sessions.push({ id: turn.origin.intakeSessionId, label: '本次编排 Agent' })
  const legacyMarker = '\n\n[THIS EXECUTION — USER REQUEST]\n'
  const legacyIndex = turn?.objective.indexOf(legacyMarker) ?? -1
  const request = turn?.userRequest ?? (legacyIndex >= 0 ? turn!.objective.slice(legacyIndex + legacyMarker.length) : null)
  const definition = turn?.workflow?.definition ?? { ...workflowDefinition(task), participants: turn?.participants ?? task.participants }
  return { definition, origin, sessions, request, planId: turn?.workflow?.id ?? null,
    directReuse: origin?.source === 'task-chat' && origin.decision === 'reuse' && !origin.intakeSessionId,
    legacy: !turn?.workflow,
  }
}
