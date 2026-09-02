/**
 * Agent-preset tool fence.
 *
 * Preset tools are registered on the Agent's own scope. The host deployment's
 * global tools are inherited unless the preset explicitly masks them, which
 * made a visually "restricted" Agent retain every host MCP tool. This adapter
 * snapshots a deny-list for the inherited host surface; DSH then merges the
 * preset's own native, MCP, Skill and task-completion tools back into view.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'task-console-agent-tool-fence'
export const inject = ['tools']

export interface Config { deny: string[] }

export function apply(ctx: Context, config: Config): void {
  if (!Array.isArray(config?.deny) || !config.deny.length) throw new Error('agent-tool-fence: deny must be a non-empty array')
  // A deny-list intentionally admits later preset-local registrations while
  // masking the deployment tools that existed when this Agent was created.
  ctx.tools.restrict({ deny: [...new Set(config.deny)] })
}
