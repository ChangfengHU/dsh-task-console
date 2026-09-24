import {hasWorkflowToolGrant} from './workflow-tool-grants.js'
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

// Platform read-only introspection is not a business or delegation grant.
const CAPABILITY_TOOLS = ['session_capabilities', 'environment_capabilities']

export const name = 'task-console-agent-tool-fence'
export const inject = ['tools']

export interface Config { workflowRunTools?:boolean; selected?: string[]; allow?: string[]; deny?: string[] }

export function deniedToolGuidance(name:string,selected:Set<string>):string {
  const base='This Agent has not been granted that tool.'
  if(name==='read_image'&&selected.has('studio_character_image'))return base+' For the locked studio character, call studio_status and then studio_character_image with an exact characterReferences[].id. This denial does not mean image inspection is unavailable.'+(selected.has('studio_preview_image')?' Production specialists can inspect an existing project image with studio_preview_image({path}); that tool still enforces its role and project scope.':'')
  return base
}

export function apply(ctx: Context, config: Config): void {
  if (Array.isArray(config?.selected)) {
    const selected = new Set([...config.selected, ...CAPABILITY_TOOLS])
    const inherited = ctx.tools.schemas().map(schema => schema.name)
    const deny = inherited.filter(name => !selected.has(name))
    if (deny.length) ctx.tools.restrict({ deny })
    ctx.tools.guard(exec => selected.has(exec.name) || config.workflowRunTools===true&&hasWorkflowToolGrant(exec) ? undefined : deniedToolGuidance(exec.name,selected))
    return
  }
  if (Array.isArray(config?.allow)) {
    // Legacy 0.20.2 presets remain parseable until explicitly regenerated.
    ctx.tools.restrict({ allow: [...new Set(config.allow)] })
    return
  }
  // Keep legacy generated presets loadable until they are explicitly synced.
  if (Array.isArray(config?.deny) && config.deny.length) {
    ctx.tools.restrict({ deny: [...new Set(config.deny)] })
    return
  }
  throw new Error('agent-tool-fence: expected selected, allow, or a non-empty legacy deny')
}
