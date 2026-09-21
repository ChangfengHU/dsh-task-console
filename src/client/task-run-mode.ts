import type { TaskSpec } from '../wire.ts'

/** Board execution never routes through the conversation composer. */
export function taskRunMode(task: TaskSpec): 'external' | 'parameters' | 'direct' {
  if (task.origin?.signalId && task.origin.source !== 'task-chat') return 'external'
  if (task.trigger.kind === 'cron') return 'direct'
  return task.origin?.source === 'task-chat' ? 'parameters' : 'direct'
}
