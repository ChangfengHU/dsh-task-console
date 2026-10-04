import type { TaskSpec } from '../wire.ts'
import { isChatWorkflow, isExternalWorkflow } from '../task-kind.ts'

/** Board execution never routes through the conversation composer. */
export function taskRunMode(task: TaskSpec): 'external' | 'parameters' | 'direct' {
  if (isExternalWorkflow(task)) return 'external'
  if (task.trigger.kind === 'cron') return 'direct'
  return isChatWorkflow(task) ? 'parameters' : 'direct'
}
