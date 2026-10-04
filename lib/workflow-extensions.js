// src/workflow-tool-grants.ts
var KEY = Symbol.for("dsh-task-console.workflow-tool-grants.v1");
var grants = globalThis[KEY] ??= globalThis[KEY] = /* @__PURE__ */ new Set();
function grantWorkflowTool(sessionId, name, active) {
  if (!sessionId || !name || typeof active !== "function") throw Error("workflow-tool-grant-invalid");
  const grant = { sessionId, name, active };
  grants.add(grant);
  return () => {
    grants.delete(grant);
  };
}

// src/workflow-extensions.ts
import { createHash as createHash2 } from "node:crypto";

// src/capability-contract.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().filter((k) => value[k] !== void 0).map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}

// src/workflow-selection.ts
var HASH = /^[a-f0-9]{64}$/;
var ID = /^[a-z][a-z0-9-]{0,79}$/;
var VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/;
function workflowJsonObject(value, maxBytes = 65536) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("workflow-policy-object-required");
  const walk = (v, depth) => {
    if (depth > 24) throw Error("workflow-policy-too-deep");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      for (const [key, item] of Object.entries(v)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("workflow-policy-key-invalid");
        walk(item, depth + 1);
      }
      return;
    }
    throw Error("workflow-policy-json-required");
  };
  walk(value, 0);
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).length > maxBytes) throw Error("workflow-policy-too-large");
  return JSON.parse(raw);
}
function validateWorkflowSelection(value) {
  const v = value;
  if (!v || Object.keys(v).some((k) => !["id", "version", "policy", "implementationSha256", "policySha256", "hostApi"].includes(k)) || !ID.test(v.id ?? "") || !VERSION.test(v.version ?? "")) throw Error("workflow-extension-selection-invalid");
  if (v.hostApi !== void 0 && (![1, 2].includes(v.hostApi) || !v.implementationSha256)) throw Error("workflow-extension-host-api-invalid");
  if (v.implementationSha256 === void 0 !== (v.policySha256 === void 0)) throw Error("workflow-extension-binding-incomplete");
  for (const h of [v.implementationSha256, v.policySha256]) if (h !== void 0 && !HASH.test(h)) throw Error("workflow-extension-hash-invalid");
  return { id: v.id, version: v.version, policy: workflowJsonObject(v.policy), ...v.implementationSha256 ? { implementationSha256: v.implementationSha256, policySha256: v.policySha256, ...v.hostApi ? { hostApi: v.hostApi } : {} } : {} };
}

// src/workflow-extensions.ts
var WORKFLOW_HOST_API = 2;
var HASH2 = /^[a-f0-9]{64}$/;
var ID2 = /^[a-z][a-z0-9-]{0,79}$/;
var VERSION2 = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/;
var digest = (value) => createHash2("sha256").update(canonical(value)).digest("hex");
var WorkflowExtensions = class {
  constructor(inUse = () => false, evidence) {
    this.inUse = inUse;
    this.evidence = evidence;
  }
  entries = /* @__PURE__ */ new Map();
  calls = /* @__PURE__ */ new Map();
  register(extension) {
    if (!extension || !ID2.test(extension.id ?? "") || !VERSION2.test(extension.version ?? "") || ![1, WORKFLOW_HOST_API].includes(extension.hostApi) || !HASH2.test(extension.implementationSha256 ?? "") || typeof extension.validatePolicy !== "function" || typeof extension.beforeComplete !== "function") throw Error("workflow-extension-definition-invalid");
    for (const name of ["beforeStart", "beforePlanRound", "registerTools"]) if (extension[name] !== void 0 && typeof extension[name] !== "function") throw Error("workflow-extension-hook-invalid");
    if (extension.toolAccess !== void 0 && extension.toolAccess !== "scoped-only") throw Error("workflow-extension-tool-access-invalid");
    if ((extension.registerTools || extension.toolAccess) && extension.hostApi < 2) throw Error("workflow-extension-tools-require-host-api-2");
    const key = extension.id + "@" + extension.version;
    if (this.entries.has(key)) throw Error("workflow-extension-already-registered");
    const entry = Object.freeze({ ...extension });
    this.entries.set(key, entry);
    return () => {
      if (this.entries.get(key) !== entry) return;
      if (this.calls.get(key) || this.inUse(entry.id, entry.version)) throw Error("workflow-extension-in-use");
      this.entries.delete(key);
    };
  }
  list() {
    return [...this.entries.values()].map(({ id, version, hostApi, implementationSha256, toolAccess }) => ({ id, version, hostApi, implementationSha256, ...toolAccess ? { toolAccess } : {}, scope: "installed-definition-only" }));
  }
  entry(selection) {
    const entry = this.entries.get(selection.id + "@" + selection.version);
    if (!entry) throw Error("workflow-extension-version-unavailable: " + selection.id + "@" + selection.version);
    return entry;
  }
  bind(value) {
    const selection = validateWorkflowSelection(value), entry = this.entry(selection);
    const policy = workflowJsonObject(entry.validatePolicy(workflowJsonObject(selection.policy))), policySha256 = digest(policy);
    if (selection.hostApi !== void 0 && selection.hostApi !== entry.hostApi) throw Error("workflow-extension-host-api-mismatch");
    if (selection.implementationSha256 !== void 0 && (selection.implementationSha256 !== entry.implementationSha256 || selection.policySha256 !== policySha256 || digest(selection.policy) !== policySha256)) throw Error("workflow-extension-binding-mismatch");
    return { ...selection, policy, implementationSha256: entry.implementationSha256, policySha256, ...entry.hostApi === 2 ? { hostApi: 2 } : {} };
  }
  bound(input) {
    const selection = validateWorkflowSelection(input.task.design?.extension);
    if (!selection.implementationSha256 || !selection.policySha256) throw Error("workflow-extension-host-binding-required");
    return { binding: this.bind(selection), entry: this.entry(selection) };
  }
  async invoke(input, run) {
    const { binding, entry } = this.bound(input), key = binding.id + "@" + binding.version;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    try {
      return await run(entry);
    } finally {
      const n = (this.calls.get(key) ?? 1) - 1;
      if (n) this.calls.set(key, n);
      else this.calls.delete(key);
    }
  }
  requiresScopedTools(input) {
    return this.bound(input).entry.toolAccess === "scoped-only";
  }
  beforeStart(input) {
    return this.invoke(input, (entry) => entry.beforeStart?.(input, this.evidence?.(input)));
  }
  beforePlanRound(input, items, proxyItems) {
    return this.invoke(input, (entry) => entry.beforePlanRound?.(input, items, proxyItems, this.evidence?.(input)));
  }
  async registerTools(ctx, input, isActive) {
    return this.invoke(input, async (entry) => {
      if (!entry.registerTools) return () => {
      };
      let disposed = false;
      const host = this.evidence?.(input, () => !disposed && isActive());
      if (!host) throw Error("workflow-extension-evidence-port-required");
      const defineTool = process.env.NODE_ENV === "test" ? (v) => v : (await import("@deepseek-ai/dsh-tools")).defineTool;
      const disposers = [];
      const facade = { tools: { register: (definition) => {
        if (typeof definition?.name !== "string" || !definition.name.startsWith(entry.id.replace(/-/g, "_") + "_") || typeof definition.execute !== "function") throw Error("workflow-extension-tool-definition-invalid");
        const execute = definition.execute;
        const ungrant = grantWorkflowTool(input.sessionId, definition.name, () => {
          host.assertActive();
          return true;
        });
        let unregister;
        try {
          unregister = ctx.tools.register(defineTool({ ...definition, execute: async (args, exec) => {
            host.assertActive();
            if (exec?.agent?.session?.id && exec.agent.session.id !== input.sessionId) throw Error("workflow-extension-session-mismatch");
            const result = await execute(args, exec);
            host.assertActive();
            return result;
          } }));
        } catch (error) {
          ungrant();
          throw error;
        }
        let released = false;
        const drop = () => {
          if (released) return;
          released = true;
          ungrant();
          unregister();
        };
        disposers.push(drop);
        return drop;
      } } };
      let dispose;
      try {
        dispose = await entry.registerTools(facade, input, host);
      } catch (error) {
        disposed = true;
        for (const drop of disposers) drop();
        throw error;
      }
      if (typeof dispose !== "function") {
        disposed = true;
        for (const drop of disposers) drop();
        throw Error("workflow-extension-disposer-required");
      }
      try {
        host.assertActive();
      } catch (e) {
        disposed = true;
        try {
          dispose();
        } finally {
          for (const drop of disposers) drop();
        }
        throw e;
      }
      return () => {
        if (disposed) return;
        disposed = true;
        try {
          dispose();
        } finally {
          for (const drop of disposers) drop();
        }
      };
    });
  }
  beforeComplete(input) {
    return this.invoke(input, async (entry) => {
      const decision = await entry.beforeComplete(input, this.evidence?.(input));
      if (!decision || typeof decision.summary !== "string" || !decision.summary.trim() || decision.summary.length > 32e3) throw Error("workflow-extension-completion-evidence-required");
      if (decision.artifacts !== void 0 && (!Array.isArray(decision.artifacts) || decision.artifacts.some((a) => !a || typeof a.path !== "string" || !HASH2.test(a.sha256)))) throw Error("workflow-extension-artifact-evidence-invalid");
      return { summary: decision.summary, metadata: workflowJsonObject(decision.metadata), ...decision.artifacts ? { artifacts: decision.artifacts.map((a) => ({ ...a })) } : {} };
    });
  }
};
export {
  WORKFLOW_HOST_API,
  WorkflowExtensions,
  validateWorkflowSelection
};
