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

export interface Config { allow?: string[]; deny?: string[] }

export function apply(ctx: Context, config: Config): void {
  if (Array.isArray(config?.allow)) {
    // An empty allow-list is intentional: DSH restrictions apply only to the
    // inherited surface, then merge this Agent scope's local registrations.
    ctx.tools.restrict({ allow: [...new Set(config.allow)] })
    return
  }
  // Keep legacy generated presets loadable until they are explicitly synced.
  if (Array.isArray(config?.deny) && config.deny.length) {
    ctx.tools.restrict({ deny: [...new Set(config.deny)] })
    return
  }
  throw new Error('agent-tool-fence: expected allow (empty is valid) or a non-empty legacy deny')
}
