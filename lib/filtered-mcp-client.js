// src/filtered-mcp-client.ts
import { createHash, randomUUID } from "node:crypto";
import { apply as applyMcpClient } from "@deepseek-ai/dsh-mcp-client";
var name = "task-console-filtered-mcp-client";
var inject = ["tools"];
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}
function instanceServerName(serverName, agentId) {
  const hash = createHash("sha256").update(`${serverName}\0${agentId}`).digest("hex").slice(0, 12);
  return `${serverName.slice(0, 19)}-${hash}`;
}
function assertToolArguments(rawName, rule, candidate) {
  if (!rule) return;
  const args = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  for (const [argument, choices] of Object.entries(rule.valuesOrPrefixes ?? {})) {
    const value = args[argument];
    if (typeof value !== "string" || !choices.some((choice) => value === choice || value.startsWith(choice))) {
      throw new Error(`MCP policy denied ${rawName}: argument "${argument}" is outside the allowed values/prefixes`);
    }
  }
  for (const [argument, pattern] of Object.entries(rule.patterns ?? {})) {
    const value = args[argument];
    if (value !== void 0 && (typeof value !== "string" || !new RegExp(pattern).test(value))) {
      throw new Error(`MCP policy denied ${rawName}: argument "${argument}" does not match the allowed pattern`);
    }
  }
}
async function apply(ctx, config) {
  const { allowedTools: rawAllowed, toolRules = {}, ...mcp } = config;
  if (!Array.isArray(rawAllowed) || rawAllowed.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error("filtered-mcp-client: allowedTools must be a non-empty string array");
  }
  const allowedTools = [...new Set(rawAllowed.map((tool) => tool.trim()))];
  if (!allowedTools.length) throw new Error("filtered-mcp-client: allowedTools must not be empty");
  const stableServerName = mcp.serverName;
  const liveServerName = instanceServerName(stableServerName, randomUUID());
  const rawByInternal = new Map(allowedTools.map((tool) => [publicToolName(liveServerName, tool), tool]));
  const tools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === "register") {
        return (definition) => {
          const rawName = rawByInternal.get(definition.name);
          if (!rawName) return () => void 0;
          const execute = definition.execute;
          return target.register({
            ...definition,
            name: publicToolName(stableServerName, rawName),
            execute(args, exec) {
              assertToolArguments(rawName, toolRules[rawName], args);
              return execute(args, exec);
            }
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const facade = new Proxy(ctx, {
    get(target, property) {
      if (property === "tools") return tools;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  await applyMcpClient(facade, { ...mcp, serverName: liveServerName });
}
export {
  apply,
  assertToolArguments,
  inject,
  instanceServerName,
  name,
  publicToolName
};
