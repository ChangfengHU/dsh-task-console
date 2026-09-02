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
import { readFile } from 'node:fs/promises'
import { TaskConsoleService } from './service.ts'
import { registerPublicHtmlTool } from './public-upload.ts'

export const name = 'task-console'
export const inject = ['loader', 'tools', 'agents', 'webServer', 'workspaceRegistry']

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
