/**
 * Exact-tool MCP adapter for Agent presets.
 *
 * The official DSH MCP client owns transport, reconnect and schema handling.
 * This adapter supplies it a narrow ToolRuntime facade: only definitions whose
 * stable public names correspond to the selected raw MCP tools are registered.
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'

export const name = 'task-console-filtered-mcp-client'
export const inject = ['tools']

interface ToolRule {
  valuesOrPrefixes?: Record<string, string[]>
  patterns?: Record<string, string>
}

export type Config = McpConfig & { allowedTools: string[]; toolRules?: Record<string, ToolRule> }

/** Must stay byte-for-byte compatible with dsh-mcp-client's public naming. */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export function assertToolArguments(rawName: string, rule: ToolRule | undefined, candidate: unknown): void {
  if (!rule) return
  const args = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {}
  for (const [argument, choices] of Object.entries(rule.valuesOrPrefixes ?? {})) {
    const value = args[argument]
    if (typeof value !== 'string' || !choices.some(choice => value === choice || value.startsWith(choice))) {
      throw new Error(`MCP policy denied ${rawName}: argument "${argument}" is outside the allowed values/prefixes`)
    }
  }
  for (const [argument, pattern] of Object.entries(rule.patterns ?? {})) {
    const value = args[argument]
    if (value !== undefined && (typeof value !== 'string' || !new RegExp(pattern).test(value))) {
      throw new Error(`MCP policy denied ${rawName}: argument "${argument}" does not match the allowed pattern`)
    }
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const { allowedTools: rawAllowed, toolRules = {}, ...mcp } = config
  if (!Array.isArray(rawAllowed) || rawAllowed.some(tool => typeof tool !== 'string' || !tool.trim())) {
    throw new Error('filtered-mcp-client: allowedTools must be a non-empty string array')
  }
  const allowedTools = [...new Set(rawAllowed.map(tool => tool.trim()))]
  if (!allowedTools.length) throw new Error('filtered-mcp-client: allowedTools must not be empty')
  const allowedPublic = new Set(allowedTools.map(tool => publicToolName(mcp.serverName, tool)))
  const rawByPublic = new Map(allowedTools.map(tool => [publicToolName(mcp.serverName, tool), tool]))

  const tools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition: { name: string; execute: (args: unknown, exec: unknown) => unknown }) => {
          if (!allowedPublic.has(definition.name)) return () => undefined
          const rawName = rawByPublic.get(definition.name)!
          const execute = definition.execute
          return target.register({
            ...definition,
            execute(args: unknown, exec: unknown) {
              assertToolArguments(rawName, toolRules[rawName], args)
              return execute(args, exec)
            },
          } as never)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const facade = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return tools
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await applyMcpClient(facade as Context, mcp as McpConfig)
}
