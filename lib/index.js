// src/service.ts
import { randomUUID } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { dirname } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/presets.ts
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { stringify as toYaml } from "yaml";
var ID_RE = /^[a-z0-9][a-z0-9-]*$/;
var NATIVE_TOOLS = [
  {
    id: "ask-user",
    label: "ask_user_question",
    group: "\u4EA4\u4E92",
    writes: false,
    description: "\u505C\u4E0B\u6765\u95EE\u4EBA\u3002\u6CA1\u6709\u5B83,\u62FF\u4E0D\u51C6\u7684\u4E8B\u53EA\u80FD\u5931\u8D25\u91CD\u6765\u3002",
    rows: "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'"
  },
  {
    id: "bash",
    label: "bash",
    group: "\u672C\u673A",
    writes: true,
    description: "\u5728 dsh \u5BBF\u4E3B\u673A\u6267\u884C shell\u3002",
    rows: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'"
  },
  {
    id: "fs",
    label: "read / write / edit",
    group: "\u672C\u673A",
    writes: true,
    description: "\u8BFB\u5199\u6539\u6587\u4EF6\u3002",
    rows: "- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'"
  },
  {
    id: "fs-search",
    label: "glob / grep",
    group: "\u672C\u673A",
    writes: false,
    description: "\u627E\u6587\u4EF6\u3001\u641C\u5185\u5BB9,\u53EA\u8BFB\u3002",
    rows: "- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false"
  },
  {
    id: "str-replace-editor",
    label: "str_replace_editor",
    group: "\u672C\u673A",
    writes: true,
    description: "\u7CBE\u786E\u66FF\u6362\u5F0F\u7F16\u8F91\u5668\u3002",
    rows: "- id: tool-str-replace-editor\n  name: '@deepseek-ai/dsh-tool-str-replace-editor'"
  },
  {
    id: "web",
    label: "web_search / fetch",
    group: "\u7F51\u7EDC",
    writes: false,
    description: "\u641C\u7F51\u9875\u3001\u6293\u9875\u9762\u3002",
    rows: "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'"
  },
  {
    id: "jobs",
    label: "job_list / job_output / job_kill",
    group: "\u672C\u673A",
    writes: false,
    description: "\u6536\u540E\u53F0\u4EFB\u52A1\u7684\u8F93\u51FA\u3001\u505C\u6389\u5B83\u3002",
    rows: "- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'"
  },
  {
    id: "todo",
    label: "todo_write",
    group: "\u4EA4\u4E92",
    writes: false,
    description: "\u7ED9\u81EA\u5DF1\u8BB0\u5F85\u529E\u3002",
    rows: "- id: tool-todo\n  name: '@deepseek-ai/dsh-tool-todo'"
  }
];
var DANGEROUS = /* @__PURE__ */ new Set(["bash", "fs", "str-replace-editor"]);
function userPresetRoot(home = homedir()) {
  return join(process.env.DSH_HOME ?? join(home, ".dsh"), ".agent-presets");
}
function skillRoots(home = homedir()) {
  return [
    { root: join(process.env.DSH_HOME ?? join(home, ".dsh"), "skills"), label: "user-dsh" },
    { root: join(process.env.DSH_AGENTS_HOME ?? join(home, ".agents"), "skills"), label: "user-agents" }
  ];
}
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
async function scanSkills(home = homedir()) {
  const rows = [];
  for (const { root, label } of skillRoots(home)) {
    let names = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name2 of names.sort()) {
      if (name2.startsWith(".")) continue;
      const dir = join(root, name2);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        const text = await readFile(join(dir, "SKILL.md"), "utf8");
        const fm = frontmatter(text);
        rows.push({ name: fm.name ?? name2, dir, description: fm.description ?? "", root: label });
      } catch {
      }
    }
  }
  return rows;
}
function permissionOf(spec, mcpWrites) {
  const native = spec.tools.map((id) => NATIVE_TOOLS.find((t) => t.id === id)).filter(Boolean);
  if (native.some((t) => DANGEROUS.has(t.id))) return "write";
  if (native.some((t) => t.writes) || spec.mcp.some(mcpWrites)) return "limited-write";
  return "read-only";
}
function indent(text, n) {
  const pad = " ".repeat(n);
  return text.split("\n").map((l) => l.length ? pad + l : l).join("\n");
}
function mask(text) {
  return text.replace(/(Authorization:\s*)(["']?)Bearer\s+\S+/gi, "$1$2Bearer \u2022\u2022\u2022\u2022").replace(/((?:token|secret|password|api[-_]?key)\s*:\s*)(["']?)[^\s"'#]+/gi, "$1$2\u2022\u2022\u2022\u2022").replace(/\/\/[^@\s/]+@/g, "//\u2022\u2022\u2022\u2022@");
}
function renderComposition(spec, hostMcp) {
  const parts = [];
  const renamed = [];
  parts.push(`# ${spec.name || spec.id} \u2014 \u7531 dsh-task-console \u751F\u6210\u3002\u53EF\u4EE5\u76F4\u63A5\u6539;dsh \u70ED\u8BFB\u53D6 preset \u6839,\u4FDD\u5B58\u5373\u751F\u6548\u3002`);
  parts.push(`# \u53EA\u6709\u5217\u5728\u8FD9\u91CC\u7684\u5DE5\u5177\u4F1A\u6709 schema;\u6CA1\u5199\u7684,\u6A21\u578B\u770B\u4E0D\u5230\u3002`);
  const persona = (spec.persona.trim() || "\u4F60\u662F\u4E00\u4E2A\u52A9\u624B\u3002").split("\n").map((l) => "      " + l).join("\n");
  parts.push(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
${persona}`);
  for (const id of spec.tools) {
    const tool = NATIVE_TOOLS.find((t) => t.id === id);
    if (tool) parts.push(tool.rows);
  }
  for (const serverName of spec.mcp) {
    const host = hostMcp.find((h) => h.serverName === serverName);
    if (!host) {
      parts.push(`# mcp ${serverName}: \u5BBF\u4E3B\u91CC\u6CA1\u6709\u8FD9\u4E2A\u670D\u52A1,\u8DF3\u8FC7`);
      continue;
    }
    let name2 = serverName;
    if (host.live) {
      name2 = `${serverName}-${spec.id}`;
      renamed.push({ from: serverName, to: name2 });
    }
    const config = { ...host.config, serverName: name2 };
    const body = toYaml(config, { lineWidth: 0 }).trimEnd();
    parts.push(`${host.live ? `# \u5BBF\u4E3B\u5C42\u4ECD\u6709\u540C\u540D ${serverName},\u6539\u540D\u6302\u8F7D;\u5BBF\u4E3B\u90A3\u884C\u6458\u6389\u540E\u53EF\u6539\u56DE
` : ""}- id: mcp-${name2}
  name: '@deepseek-ai/dsh-mcp-client'
  config:
${indent(body, 4)}`);
  }
  if (spec.skills.length) {
    parts.push(`# skills/ \u968F preset \u8D70;baseUrl \u662F preset \u81EA\u5DF1\u7684\u76EE\u5F55
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: preset-${spec.id}
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'`);
  }
  return { yml: parts.join("\n\n") + "\n", renamed, permission: permissionOf(spec, () => true) };
}
var SPEC_FILE = "task-console.json";
function validateSpec(raw) {
  const s = raw ?? {};
  const id = String(s.id ?? "").trim();
  if (!ID_RE.test(id)) throw new Error("id \u53EA\u80FD\u7528 a-z 0-9 \u548C -,\u4E14\u4EE5\u5B57\u6BCD\u6216\u6570\u5B57\u5F00\u5934");
  const name2 = String(s.name ?? "").trim();
  if (!name2) throw new Error("\u540D\u5B57\u5FC5\u586B");
  const list = (v) => Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : [];
  const effort = s.effort === "low" || s.effort === "medium" || s.effort === "high" ? s.effort : "";
  return {
    id,
    name: name2,
    description: String(s.description ?? "").trim(),
    persona: String(s.persona ?? ""),
    model: String(s.model ?? "").trim(),
    effort,
    tools: list(s.tools).filter((t) => NATIVE_TOOLS.some((n) => n.id === t)),
    mcp: list(s.mcp),
    skills: list(s.skills)
  };
}
async function writePreset(spec, hostMcp, library, root = userPresetRoot()) {
  const dir = resolve(root, spec.id);
  if (!dir.startsWith(resolve(root) + "/")) throw new Error("\u975E\u6CD5 id");
  await mkdir(dir, { recursive: true, mode: 448 });
  await chmod(root, 448).catch(() => void 0);
  const preview = renderComposition(spec, hostMcp);
  await writeFile(join(dir, "agent.cordis.yml"), preview.yml, { mode: 384 });
  await writeFile(join(dir, "preset.yml"), `name: ${JSON.stringify(spec.name)}
description: ${JSON.stringify(spec.description)}
`, { mode: 384 });
  await writeFile(join(dir, SPEC_FILE), JSON.stringify(spec, null, 2) + "\n", { mode: 384 });
  const skillsDir = join(dir, "skills");
  await rm(skillsDir, { recursive: true, force: true });
  if (spec.skills.length) {
    await mkdir(skillsDir, { recursive: true, mode: 448 });
    for (const name2 of spec.skills) {
      const entry = library.find((s) => s.name === name2) ?? library.find((s) => basename(s.dir) === name2);
      if (!entry) continue;
      await cp(entry.dir, join(skillsDir, basename(entry.dir)), { recursive: true, dereference: true });
    }
  }
  return { path: dir, preview };
}
async function readSpec(dir) {
  try {
    return validateSpec(JSON.parse(await readFile(join(dir, SPEC_FILE), "utf8")));
  } catch {
    return null;
  }
}
async function removePreset(id, root = userPresetRoot()) {
  if (!ID_RE.test(id)) throw new Error("\u975E\u6CD5 id");
  const dir = resolve(root, id);
  if (!dir.startsWith(resolve(root) + "/")) throw new Error("\u975E\u6CD5 id");
  await rm(dir, { recursive: true, force: true });
}

// src/wire.ts
import { z } from "zod";
var PKG = "dsh-task-console";
var NAMESPACE = "taskConsole";
function jsonParam(name2) {
  return Object.freeze({
    name: name2,
    wire: name2,
    source: "json",
    codec: Object.freeze({ mode: "strict", typeSymbol: `${PKG}/types#Json`, schema: z.string() })
  });
}
var JSON_RESULT = Object.freeze({ mode: "strict", typeSymbol: `${PKG}/types#Json`, schema: z.string() });
function descriptor(method, argc) {
  return Object.freeze({
    id: `${PKG}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: Object.freeze({ kind: "direct" }),
    parameters: Object.freeze(argc === 1 ? [jsonParam("payload")] : []),
    result: JSON_RESULT,
    sourceLocation: Object.freeze({ file: "src/wire.ts", line: 1, column: 1 })
  });
}
var METHODS = [
  ["catalog", 0],
  ["agents", 0],
  ["previewAgent", 1],
  ["saveAgent", 1],
  ["deleteAgent", 1],
  ["tryRun", 1]
];
var CONSOLE_INVOCATIONS = Object.freeze(METHODS.map(([method, argc]) => descriptor(method, argc)));

// src/service.ts
var MCP_CLIENT = "@deepseek-ai/dsh-mcp-client";
var TOOL_PREFIX = /^mcp__(.+?)__(.+)$/;
var KNOWN_MODELS = [
  "codex-local/gpt-5.6-terra",
  "codex-local/gpt-5.6-mini",
  "claude-local/haiku",
  "claude-local/sonnet",
  "llm-deepseek/qwen-plus-latest",
  "llm-deepseek/deepseek-v3"
];
var TaskConsoleService = class extends TypertRemoteService {
  static inject = ["loader", "tools", "agents"];
  constructor(ctx) {
    super(ctx, NAMESPACE);
  }
  // ── facts ──────────────────────────────────────────────────────────────
  /** MCP servers the HOST composition runs, with the tools they registered. */
  hostMcp() {
    const registered = /* @__PURE__ */ new Map();
    for (const schema of this.ctx.tools.schemas()) {
      const m = TOOL_PREFIX.exec(schema.name);
      if (!m) continue;
      const list = registered.get(m[1]) ?? [];
      list.push(m[2]);
      registered.set(m[1], list);
    }
    const rows = [];
    for (const entry of this.ctx.loader.entries()) {
      if (entry?.options?.name !== MCP_CLIENT) continue;
      const config = entry.options.config ?? {};
      const serverName = String(config.serverName ?? entry.options.id);
      const target = typeof config.url === "string" ? config.url.replace(/\/\/[^@/]+@/, "//\u2022\u2022\u2022\u2022@") : [config.command, ...Array.isArray(config.args) ? config.args : []].filter(Boolean).join(" ");
      const disabled = entry.disabled === true || entry.options.disabled === true;
      rows.push({ entryId: String(entry.options.id), serverName, target, tools: registered.get(serverName) ?? [], disabled, config, live: !disabled });
    }
    return rows;
  }
  defaultModel() {
    const defaults = this.ctx.get("agentDefaultModel");
    try {
      const sel = defaults?.currentSelection?.();
      if (sel?.provider && sel?.model) return sel;
    } catch {
    }
    return void 0;
  }
  async catalog() {
    const presets = this.ctx.get("agentPresets");
    const def = this.defaultModel();
    const defaultModel = def ? `${def.provider}/${def.model}` : "";
    const models = [...new Set([defaultModel, ...KNOWN_MODELS].filter(Boolean))];
    const out = {
      tools: NATIVE_TOOLS.map(({ rows: _rows, ...t }) => t),
      mcp: this.hostMcp().map(({ config: _c, live: _l, ...m }) => m),
      skills: await scanSkills(),
      models,
      defaultModel,
      userRoot: presets?.authorable === false ? null : userPresetRoot()
    };
    return JSON.stringify(out);
  }
  async agents() {
    const presets = this.ctx.get("agentPresets");
    if (!presets) return JSON.stringify([]);
    const rows = [];
    for (const p of await presets.list()) {
      const dir = dirname(String(p.path));
      const spec = p.trust === "user" ? await readSpec(dir) : null;
      let name2 = p.name ?? p.id, description = p.description ?? "";
      if (!p.name || !p.description) {
        try {
          const text = await (await import("node:fs/promises")).readFile(`${dir}/preset.yml`, "utf8");
          const n = /^name:\s*(.*)$/m.exec(text)?.[1];
          const d = /^description:\s*(.*)$/m.exec(text)?.[1];
          const unq = (s) => s ? s.trim().replace(/^"(.*)"$/, (_, x) => JSON.parse(`"${x}"`)) : void 0;
          name2 = unq(n) ?? name2;
          description = unq(d) ?? description;
        } catch {
        }
      }
      rows.push({ id: p.id, name: name2, description, trust: p.trust, broken: p.broken, path: dir, spec });
    }
    return JSON.stringify(rows);
  }
  // ── authoring ──────────────────────────────────────────────────────────
  async previewAgent(payload) {
    const spec = validateSpec(JSON.parse(payload));
    const preview = renderComposition(spec, this.hostMcp());
    return JSON.stringify({ ...preview, yml: mask(preview.yml) });
  }
  async saveAgent(payload) {
    const spec = validateSpec(JSON.parse(payload));
    const presets = this.ctx.get("agentPresets");
    if (presets && presets.authorable === false) throw new Error("\u8FD9\u4E2A\u90E8\u7F72\u6CA1\u6709\u53EF\u5199\u7684 preset \u6839");
    const shipped = presets ? (await presets.list()).find((p) => p.id === spec.id && p.trust === "system") : void 0;
    if (shipped) throw new Error(`"${spec.id}" \u662F\u51FA\u5382 preset,\u4E0D\u80FD\u8986\u76D6;\u6362\u4E2A id`);
    const { path, preview } = await writePreset(spec, this.hostMcp(), await scanSkills());
    return JSON.stringify({ path, preview: { ...preview, yml: mask(preview.yml) } });
  }
  async deleteAgent(payload) {
    const { id } = JSON.parse(payload);
    const presets = this.ctx.get("agentPresets");
    const row = presets ? (await presets.list()).find((p) => p.id === id) : void 0;
    if (row && row.trust !== "user") throw new Error("\u51FA\u5382 preset \u4E0D\u80FD\u5220");
    await removePreset(id);
    return JSON.stringify({ ok: true });
  }
  // ── proof ──────────────────────────────────────────────────────────────
  /**
   * Start a real session on the preset, ask one question, and report what
   * dsh actually handed the model. The session is disposed afterwards but
   * its log stays, so the evidence can be reopened.
   */
  async tryRun(payload) {
    const { id, prompt } = JSON.parse(payload);
    const presets = this.ctx.get("agentPresets");
    if (!presets) throw new Error("\u8FD9\u4E2A\u90E8\u7F72\u6CA1\u6709 preset \u670D\u52A1");
    const preset = await presets.resolve(id);
    if (preset.broken) throw new Error(`preset \u574F\u4E86:${preset.broken}`);
    const spec = await readSpec(dirname(String(preset.path)));
    let selection = this.defaultModel();
    if (spec?.model && spec.model.includes("/")) {
      const [provider, ...rest] = spec.model.split("/");
      selection = { provider, model: rest.join("/"), ...spec.effort ? { reasoningEffort: spec.effort } : {} };
    }
    const sessionId = `tc-try-${id}-${Date.now().toString(36)}`;
    const started = Date.now();
    const question = prompt?.trim() || "\u628A\u4F60\u5F53\u524D\u5DE5\u5177\u5217\u8868\u91CC\u7684\u6BCF\u4E2A\u5DE5\u5177\u540D\u9010\u884C\u539F\u6837\u5217\u51FA,\u4E0D\u8981\u7701\u7565\u3001\u4E0D\u8981\u89E3\u91CA\u3002\u7136\u540E\u7528\u4E00\u53E5\u8BDD\u56DE\u7B54:\u4F60\u6709 bash \u5417?";
    const result = { sessionId, provider: selection?.provider ?? "", model: selection?.model ?? "", elapsedMs: 0, tools: [], answer: "" };
    let messageId = "";
    let consumed = false;
    let finish;
    const done = new Promise((resolve2) => {
      finish = resolve2;
    });
    const dispose = this.ctx.on("session/event", (session, event) => {
      if (session?.id !== sessionId) return;
      if (event.type === "request/header" && result.tools.length === 0) {
        const tools = event.data?.header?.tools;
        if (Array.isArray(tools)) result.tools = tools.map((t) => String(t.name));
      }
      if (event.type === "user/message" && event.data?.id === messageId) consumed = true;
      if (event.type === "assistant/message") {
        const blocks = event.data?.message?.content;
        if (Array.isArray(blocks)) result.answer = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      }
      if (event.type === "turn/end" && consumed) {
        const reason = event.data?.reason;
        if (reason && reason.kind !== "completed") result.error = JSON.stringify(reason);
        finish();
      }
    });
    let handle;
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        ...selection ? { agentOptions: selection } : {},
        meta: { cwd: homedir2(), agentPreset: preset.id },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id);
        }
      });
      messageId = randomUUID();
      handle.agent.followup({ id: messageId, role: "user", content: [{ type: "text", text: question }], source: { kind: "user" } });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("120 \u79D2\u6CA1\u7B49\u5230\u56DE\u5408\u7ED3\u675F")), 12e4));
      await Promise.race([done, timeout]);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        typeof dispose === "function" && dispose();
      } catch {
      }
      try {
        await handle?.dispose?.();
      } catch {
      }
    }
    result.elapsedMs = Date.now() - started;
    return JSON.stringify(result);
  }
};

// src/index.ts
var name = "task-console";
var inject = ["loader", "tools", "agents"];
async function apply(ctx) {
  await ctx.plugin(TaskConsoleService);
}
export {
  CONSOLE_INVOCATIONS,
  ID_RE,
  METHODS,
  NAMESPACE,
  NATIVE_TOOLS,
  PKG,
  TaskConsoleService,
  apply,
  inject,
  mask,
  name,
  permissionOf,
  readSpec,
  removePreset,
  renderComposition,
  scanSkills,
  userPresetRoot,
  validateSpec,
  writePreset
};
