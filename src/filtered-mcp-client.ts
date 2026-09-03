/**
 * Exact-tool MCP adapter for Agent presets.
 *
 * The official DSH MCP client owns transport, reconnect and schema handling.
 * This adapter supplies it a narrow ToolRuntime facade: only definitions whose
 * stable public names correspond to the selected raw MCP tools are registered.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'

export const name = 'task-console-filtered-mcp-client'
export const inject = ['tools', 'loader']

interface ToolRule {
  requiredArguments?: string[]
  valuesOrPrefixes?: Record<string, string[]>
  patterns?: Record<string, string>
}

export type Config = Partial<McpConfig> & {
  /** Resolve transport/auth from this official host MCP entry; never persist its headers in a preset. */
  sourceEntryId?: string
  serverName: string
  allowedTools: string[]
  toolRules?: Record<string, ToolRule>
}

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** Resolve a safe preset reference back to the host-owned MCP config. */
export function resolveSourceConfig(ctx: Context, sourceEntryId: string): McpConfig {
  const loader = (ctx as any).get?.('loader') ?? (ctx as any).loader
  const entry = loader?.entries?.().find((candidate: any) => String(candidate?.options?.id) === sourceEntryId)
  if (!entry) throw new Error(`filtered-mcp-client: source entry "${sourceEntryId}" is unavailable`)
  if (entry?.options?.name !== MCP_CLIENT) throw new Error(`filtered-mcp-client: source entry "${sourceEntryId}" is not an official MCP client`)
  if (entry.disabled === true || entry.options?.disabled === true) {
    throw new Error(`filtered-mcp-client: source entry "${sourceEntryId}" is disabled`)
  }
  const config = entry.options?.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`filtered-mcp-client: source entry "${sourceEntryId}" has no MCP config`)
  }
  return { ...config } as McpConfig
}

/** Must stay byte-for-byte compatible with dsh-mcp-client's public naming. */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

/** Give every live Agent its own MCP namespace without changing model-facing tool names. */
export function instanceServerName(serverName: string, agentId: string): string {
  const hash = createHash('sha256').update(`${serverName}\0${agentId}`).digest('hex').slice(0, 12)
  return `${serverName.slice(0, 19)}-${hash}`
}

export function assertToolArguments(rawName: string, rule: ToolRule | undefined, candidate: unknown): void {
  if (!rule) return
  const args = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {}
  for (const argument of rule.requiredArguments ?? []) {
    if (args[argument] === undefined || args[argument] === null || args[argument] === '') {
      throw new Error(`MCP policy denied ${rawName}: argument "${argument}" is required`)
    }
  }
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
  const { allowedTools: rawAllowed, toolRules = {}, sourceEntryId, ...inlineMcp } = config
  if (!Array.isArray(rawAllowed) || rawAllowed.some(tool => typeof tool !== 'string' || !tool.trim())) {
    throw new Error('filtered-mcp-client: allowedTools must be a non-empty string array')
  }
  const allowedTools = [...new Set(rawAllowed.map(tool => tool.trim()))]
  if (!allowedTools.length) throw new Error('filtered-mcp-client: allowedTools must not be empty')
  const stableServerName = config.serverName
  if (typeof stableServerName !== 'string' || !stableServerName.trim()) {
    throw new Error('filtered-mcp-client: serverName must be a non-empty string')
  }
  // `inlineMcp` is accepted only for previously generated presets. All new
  // presets use sourceEntryId so auth remains owned by the host composition.
  const sourceMcp = sourceEntryId ? resolveSourceConfig(ctx, sourceEntryId) : inlineMcp as McpConfig
  const liveServerName = instanceServerName(stableServerName, randomUUID())
  const rawByInternal = new Map(allowedTools.map(tool => [publicToolName(liveServerName, tool), tool]))

  const tools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition: { name: string; execute: (args: unknown, exec: unknown) => unknown }) => {
          const rawName = rawByInternal.get(definition.name)
          if (!rawName) return () => undefined
          const execute = definition.execute
          return target.register({
            ...definition,
            name: publicToolName(stableServerName, rawName),
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
  await applyMcpClient(facade as Context, { ...sourceMcp, serverName: liveServerName } as McpConfig)
}
