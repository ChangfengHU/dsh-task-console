/**
 * `dsh-agent-task-console` — host half.
 *
 * Function plugin — no default export (the Loader unwraps
 * `exports.default ?? exports`). Mounts the `taskConsole` Remote service the
 * browser console calls.
 *
 * @module dsh-agent-task-console
 */

import type { Context } from '@deepseek-ai/cordis'
import { TaskConsoleService } from './service.ts'
import { registerPublicHtmlTool } from './public-upload.ts'

export const name = 'task-console'
export const inject = ['loader', 'tools', 'agents']

export { TaskConsoleService } from './service.ts'
export {
  ID_RE, NATIVE_TOOLS, mask, permissionOf, readSpec, removePreset, renderComposition, scanSkills, userPresetRoot,
  validateSpec, writePreset,
} from './presets.ts'
export { CONSOLE_INVOCATIONS, METHODS, NAMESPACE, PKG } from './wire.ts'
export type { AgentRow, AgentSpec, Catalog, McpServer, NativeTool, Preview, SkillEntry, TryRunResult } from './wire.ts'

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(TaskConsoleService)
  ctx.effect(() => registerPublicHtmlTool(ctx), 'task-console: public HTML publisher')
}
