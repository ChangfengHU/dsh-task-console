import type { TaskSpec } from './fold.ts'
/** Imported configuration is not a fabricated historical chat-origin receipt. */
export const isChatWorkflow = (task: Pick<TaskSpec, 'origin' | 'configMigration'>) => task.origin?.source === 'task-chat' || task.configMigration?.workflowKind === 'chat'
export const isExternalWorkflow = (task: Pick<TaskSpec, 'origin' | 'configMigration'>) => task.configMigration?.workflowKind === 'external' || !!task.origin?.signalId && task.origin.source !== 'task-chat'
