export {loadStudioRolePack,inspectStudioRoleDependencies,STUDIO_ROLE_IDS,type StudioRolePack,type StudioRoleTemplate,type StudioPackRole,type StudioDependencyInventory} from './studio-role-pack.js'
/**
 * `dsh-task-console` — host half.
 *
 * Function plugin — no default export (the Loader unwraps
 * `exports.default ?? exports`). Mounts the `taskConsole` Remote service the
 * browser console calls.
 *
 * @module dsh-task-console
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CapabilityPolicy } from './session-capabilities.ts'
import { readFile } from 'node:fs/promises'
import { TaskConsoleService } from './service.ts'
import {loadWorkflowModules,loadBundledWorkflowModules,type WorkflowModule} from './workflow-loader.js'
import { registerPublicHtmlTool } from './public-upload.ts'
import { registerTaskSignalHttp } from './task-intake-http.ts'
import { fallbackSelection } from './model-fallback.ts'
import {readStudioHostConfiguration,type StudioConfigBinding} from './studio-config.js'

export const name = 'task-console'
export const inject = ['loader', 'tools', 'agents', 'webServer', 'workspaceRegistry']
export const Config = z.object({
  studioConfigPath: z.string(),
  workflowModules: z.array(z.object({path:z.string(),sha256:z.string()})).default([]),
  taskFallbackModel: z.string().default(''),
  taskFallbackFromProvider: z.string().default('codex-local'),
  standardMaxSteps: z.natural().min(1).default(24),
  standardMcpInheritance: z.union(['inherit', 'discover-only']).default('inherit'),
  standardSkillInheritance: z.union(['inherit', 'discover-only']).default('inherit'),
  standardExcludedSkills: z.array(z.string()).default([]),
  standardExcludedMcpServers: z.array(z.string()).default([]),
  standardExcludedTools: z.array(z.string()).default([]),
})

export { TaskConsoleService } from './service.ts'
export {
  ID_RE, NATIVE_TOOLS, SKILL_LOCK_FILE, hashSkillTree, mask, permissionOf, readSpec, removePreset, renderComposition,
  scanSkills, syncPresetSkills, userPresetRoot, validateSpec, verifyPresetSkills, writePreset,
} from './presets.ts'
export { CONSOLE_INVOCATIONS, METHODS, NAMESPACE, PKG } from './wire.ts'
export type { AgentRow, AgentSpec, Catalog, McpServer, NativeTool, Preview, SkillEntry, TryRunResult } from './wire.ts'
export { applyAgentPermission } from './agent-session.ts'
export { TaskIntakeCoordinator, validateTaskIntakeDecision, validateTaskSignal } from './task-intake.ts'
export { TASK_INTAKE_AGENT_ID } from './task-intake-agent.ts'

export async function apply(ctx: Context, config: CapabilityPolicy & StudioConfigBinding & { taskFallbackModel?: string; taskFallbackFromProvider?: string; workflowModules?:WorkflowModule[] } = {}): Promise<void> {
  // Reject explicit broken configuration before the service recovers/dispatches Tasks.
  if(config.studioConfigPath!==undefined)await readStudioHostConfiguration(config.studioConfigPath)
  const bundled=await loadBundledWorkflowModules(new URL('../',import.meta.url))
  const workflowExtensions=[...bundled,...await loadWorkflowModules(config.workflowModules??[])]
  await ctx.plugin(TaskConsoleService,{workflowExtensions,studioConfigPath:config.studioConfigPath})
  await (ctx as any).get('taskConsole').ready
  const fallback = fallbackSelection(config.taskFallbackModel ?? '')
  ;(ctx as any).get('taskConsole').runner.modelFallback = fallback ? { ...fallback, fromProvider: config.taskFallbackFromProvider ?? 'codex-local' } : undefined
  ;(ctx as any).get('taskConsole').capabilities.policy = config
  ctx.effect(() => (ctx as any).get('taskConsole').capabilities.install(), 'task-console: session capability facts and progress guard')
  ctx.effect(() => registerPublicHtmlTool(ctx), 'task-console: public HTML publisher')
  ctx.effect(() => registerTaskSignalHttp(ctx), 'task-console: authenticated Task Signal API')
  ctx.effect(() => (ctx as any).webServer.register({
    kind: 'exact',
    path: '/dsh-task-console/client-heavy.js',
    handler: async (req: any, res: any) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      try {
        const body = await readFile(new URL('./client-heavy.js', import.meta.url))
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch { res.writeHead(404); res.end() }
    },
  }), 'task-console: lazy client bundle')
}
