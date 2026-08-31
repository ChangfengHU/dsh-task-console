// src/service.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2 } from "node:path";
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
  const preview2 = renderComposition(spec, hostMcp);
  await writeFile(join(dir, "agent.cordis.yml"), preview2.yml, { mode: 384 });
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
  return { path: dir, preview: preview2 };
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

// src/runner.ts
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// src/tasks.ts
import { appendFile, mkdir as mkdir2, readFile as readFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/fold.ts
function fold(events) {
  const tasks = /* @__PURE__ */ new Map();
  const runs = /* @__PURE__ */ new Map();
  for (const e of events) {
    switch (e.t) {
      case "task/created":
        tasks.set(e.task.id, e.task);
        break;
      case "task/enabled": {
        const t = tasks.get(e.taskId);
        if (t) tasks.set(t.id, { ...t, enabled: e.enabled });
        break;
      }
      case "task/deleted":
        tasks.delete(e.taskId);
        for (const r of [...runs.values()]) if (r.taskId === e.taskId) runs.delete(r.id);
        break;
      case "run/fired":
        runs.set(e.run.id, { id: e.run.id, taskId: e.run.taskId, firedAt: e.at, by: e.run.by, legs: e.run.legs.map((agentId) => ({ agentId, status: "queued", tries: 0 })) });
        break;
      case "run/settled": {
        const r = runs.get(e.runId);
        if (r) r.settled = { at: e.at, outcome: e.outcome };
        break;
      }
      default: {
        const r = runs.get(e.runId);
        const l = r?.legs[e.leg];
        if (!l) break;
        if (e.t === "leg/spawned") Object.assign(l, { status: "running", sessionId: e.sessionId, startedAt: e.at, tries: e.tries, question: void 0, error: void 0, endedAt: void 0 });
        else if (e.t === "leg/blocked") Object.assign(l, { status: "blocked", question: e.question });
        else if (e.t === "leg/resumed") Object.assign(l, { status: "running", question: void 0 });
        else if (e.t === "leg/done") Object.assign(l, { status: "done", handoff: e.handoff, endedAt: e.at, question: void 0 });
        else Object.assign(l, { status: e.t.slice(4), endedAt: e.at, error: e.error, question: void 0 });
      }
    }
  }
  return { tasks, runs };
}
var preview = (s, n) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? t.slice(0, n) + "\u2026" : t;
};
function foldTurns(sessionId, events, agentPreset) {
  const turns = [];
  const byCall = /* @__PURE__ */ new Map();
  const totals = { turns: 0, steps: 0, mcp: 0, skill: 0, native: 0, ask: 0, input: 0, output: 0, ms: 0, byServer: {}, skills: [] };
  let cur, step;
  let model = {};
  let pendingUser = "";
  const iso = (t) => new Date(t).toISOString();
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "agent/inbox/spliced": {
        const txt = (d.inserted ?? []).flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text)).join("\n");
        if (txt) pendingUser = txt;
        break;
      }
      case "user/message": {
        if (d.source?.kind === "user" || !d.source) {
          const txt = (d.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
          if (txt && !txt.startsWith("<system-reminder>")) pendingUser = txt;
        }
        break;
      }
      case "request/context":
        model = { provider: d.provider, model: d.model };
        break;
      case "turn/start":
        cur = { turn: d.turn, at: iso(e.time), user: pendingUser, steps: [] };
        pendingUser = "";
        turns.push(cur);
        totals.turns++;
        break;
      case "step/start":
        if (!cur) {
          cur = { turn: d.turn ?? turns.length + 1, at: iso(e.time), user: pendingUser, steps: [] };
          turns.push(cur);
          totals.turns++;
        }
        step = { step: d.step, ...model, at: iso(e.time), ms: 0, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, tools: [], text: "" };
        cur.steps.push(step);
        totals.steps++;
        break;
      case "assistant/message": {
        if (!step) break;
        const u = d.usage ?? {};
        step.usage.input += u.inputTokens ?? 0;
        step.usage.output += u.outputTokens ?? 0;
        step.usage.reasoning += u.reasoningTokens ?? 0;
        step.usage.cacheRead += u.cacheReadTokens ?? 0;
        totals.input += u.inputTokens ?? 0;
        totals.output += u.outputTokens ?? 0;
        const txt = (d.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        if (txt) step.text = txt;
        if (!step.ms) step.ms = e.time - +new Date(step.at);
        break;
      }
      case "tool/call": {
        const name2 = String(d.name ?? "");
        const m = /^mcp__(.+?)__(.+)$/.exec(name2);
        const kind = name2.endsWith("ask_user_question") ? "ask" : m ? "mcp" : name2 === "skill" ? "skill" : "native";
        const row = { callId: d.callId, name: m ? m[2] : name2, kind, server: m?.[1], args: preview(d.arguments, 240), result: "", ok: true, ms: 0, at: iso(e.time) };
        row._t = e.time;
        byCall.set(d.callId, row);
        step?.tools.push(row);
        totals[kind]++;
        if (m) totals.byServer[m[1]] = (totals.byServer[m[1]] ?? 0) + 1;
        if (kind === "skill") {
          try {
            const n = JSON.parse(d.arguments ?? "{}").name;
            if (n && !totals.skills.includes(n)) totals.skills.push(n);
          } catch {
          }
        }
        break;
      }
      case "tool/result": {
        const id = d.message?.source?.callId;
        const row = id && byCall.get(id);
        if (!row) break;
        const parts = (d.message?.content ?? []).flatMap((c) => c.type === "tool-result" ? c.content ?? [] : [c]);
        const txt = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        row.result = preview(txt, 400);
        row.ms = e.time - row._t;
        delete row._t;
        row.ok = !/"ok":\s*false|^error|exit code [1-9]|Traceback|failed/i.test(txt.slice(0, 200));
        break;
      }
      case "step/end":
        if (step && !step.ms) step.ms = e.time - +new Date(step.at);
        step = void 0;
        break;
      case "turn/end":
        if (cur) {
          cur.endedAt = iso(e.time);
          cur.reason = d.reason?.kind;
          totals.ms += e.time - +new Date(cur.at);
        }
        cur = void 0;
        break;
    }
  }
  return { sessionId, agentPreset, turns, totals };
}

// src/cron.ts
function field(spec, min, max) {
  const out = /* @__PURE__ */ new Set();
  for (const part of spec.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    let lo, hi;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[1]);
      hi = m[2] ? Number(m[2]) : m[3] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = field(parts[0], 0, 59), hour = field(parts[1], 0, 23), dom = field(parts[2], 1, 31), month = field(parts[3], 1, 12), dow = field(parts[4].replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}
function cronMatches(c, d) {
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.dom.has(d.getDate()) && c.month.has(d.getMonth() + 1) && c.dow.has(d.getDay());
}
function nextFire(c, from = /* @__PURE__ */ new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// src/tasks.ts
function storeDir(home = homedir2()) {
  return join2(process.env.DSH_HOME ?? join2(home, ".dsh"), "task-console");
}
var EventStore = class {
  events = [];
  state = { tasks: /* @__PURE__ */ new Map(), runs: /* @__PURE__ */ new Map() };
  queue = Promise.resolve();
  dir;
  constructor(dir = storeDir()) {
    this.dir = dir;
  }
  get file() {
    return join2(this.dir, "events.jsonl");
  }
  async load() {
    await mkdir2(this.dir, { recursive: true, mode: 448 });
    let text = "";
    try {
      text = await readFile2(this.file, "utf8");
    } catch {
    }
    this.events = text.split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    this.state = fold(this.events);
  }
  all() {
    return this.events;
  }
  get tasks() {
    return this.state.tasks;
  }
  get runs() {
    return this.state.runs;
  }
  /** Serialized append: the fold is updated only after the line is on disk. */
  append(e) {
    const next = this.queue.then(async () => {
      await appendFile(this.file, JSON.stringify(e) + "\n", { mode: 384 });
      this.events.push(e);
      this.state = fold(this.events);
    });
    this.queue = next.catch(() => void 0);
    return next;
  }
};
function legMessage(task, run, leg, upstream) {
  const p = task.participants[leg];
  const lines = [`# \u4EFB\u52A1:${task.title} \xB7 ${run.id} \xB7 \u7B2C ${leg + 1}/${task.participants.length} \u6BB5`, "", "[TASK]", task.brief.trim()];
  if (p?.brief?.trim()) lines.push("", "[YOUR PART]", p.brief.trim());
  if (upstream) lines.push("", `[UPSTREAM HANDOFF from ${upstream.agentName}]`, upstream.handoff.trim() || "(\u4E0A\u6E38\u6CA1\u6709\u7559\u4E0B\u4EA4\u63A5\u5355)");
  lines.push("", "\u4EA4\u5377:\u628A\u300C\u4EA7\u7269 / \u5E72\u4E86\u4EC0\u4E48 / \u4E0B\u6E38\u6CE8\u610F\u300D\u5199\u5728\u4F60\u7684\u6700\u540E\u4E00\u6761\u56DE\u590D\u91CC,\u5B83\u4F1A\u539F\u6837\u4EA4\u7ED9\u4E0B\u4E00\u6BB5\u3002\u62FF\u4E0D\u51C6\u4E14\u4E0D\u53EF\u9006\u7684\u4E8B,\u7528 ask_user_question \u505C\u4E0B\u6765\u95EE\u3002");
  return lines.join("\n");
}
function validateTask(raw, agentIds) {
  const s = raw ?? {};
  const brief = String(s.brief ?? "").trim();
  if (brief.length < 4) throw new Error("\u4EFB\u52A1\u4E66\u81F3\u5C11\u5199\u4E00\u53E5");
  const title = String(s.title ?? "").trim() || brief.split(/[,,;。\n]/)[0].slice(0, 26);
  const participants = (Array.isArray(s.participants) ? s.participants : []).map((p) => ({ agentId: String(p.agentId ?? ""), ...p.brief ? { brief: String(p.brief) } : {} })).filter((p) => p.agentId);
  if (!participants.length) throw new Error("\u81F3\u5C11\u4E00\u4E2A\u53C2\u4E0E\u8005");
  for (const p of participants) if (!agentIds.has(p.agentId)) throw new Error(`\u6CA1\u6709\u8FD9\u4E2A Agent:${p.agentId}`);
  let trigger = { kind: "once" };
  if (s.trigger?.kind === "cron") {
    const expr = String(s.trigger.expr ?? "").trim();
    if (!parseCron(expr)) throw new Error("cron \u8868\u8FBE\u5F0F\u4E0D\u5408\u6CD5(\u8981 5 \u6BB5)");
    trigger = { kind: "cron", expr };
  }
  const timeoutSec = Math.min(Math.max(Number(s.timeoutSec) || 1800, 60), 6 * 3600);
  const onFail = s.onFail === "retry" ? "retry" : "stop";
  return {
    id: String(s.id ?? "") || `T-${Date.now().toString(36)}`,
    title,
    brief,
    trigger,
    participants,
    cwd: String(s.cwd ?? "").trim() || homedir2(),
    timeoutSec,
    onFail,
    maxTries: onFail === "retry" ? Math.min(Math.max(Number(s.maxTries) || 2, 1), 5) : 1,
    enabled: true,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/runner.ts
var TaskRunner = class {
  flights = /* @__PURE__ */ new Map();
  ticker;
  firedMinute = /* @__PURE__ */ new Map();
  disposeListener;
  ctx;
  store;
  constructor(ctx, store) {
    this.ctx = ctx;
    this.store = store;
  }
  async start() {
    await this.store.load();
    for (const run of this.store.runs.values()) {
      for (const [i, leg] of run.legs.entries()) {
        if (leg.status === "running" || leg.status === "blocked") await this.store.append({ t: "leg/lost", at: now(), runId: run.id, leg: i, error: "\u5BBF\u4E3B\u91CD\u542F,\u8FDB\u7A0B\u4E0D\u5728\u4E86" });
      }
      if (!run.settled && run.legs.some((l) => l.status === "lost")) await this.store.append({ t: "run/settled", at: now(), runId: run.id, outcome: "failed" });
    }
    this.disposeListener = this.ctx.on("session/event", (session, event) => this.onSessionEvent(session, event));
    this.ticker = setInterval(() => {
      void this.tick();
    }, 6e4);
    this.ctx.effect?.(() => () => this.stop(), "task-console: runner");
  }
  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.disposeListener?.();
    for (const f of this.flights.values()) if (f.timer) clearTimeout(f.timer);
  }
  /** Cron: fire every enabled cron task whose expression matches this minute, once per minute. */
  async tick() {
    const d = /* @__PURE__ */ new Date();
    const key = d.toISOString().slice(0, 16);
    for (const task of this.store.tasks.values()) {
      if (task.trigger.kind !== "cron" || !task.enabled) continue;
      const c = parseCron(task.trigger.expr);
      if (!c || !cronMatches(c, d)) continue;
      if (this.firedMinute.get(task.id) === key) continue;
      this.firedMinute.set(task.id, key);
      await this.fire(task.id, "cron").catch((err) => console.warn("[task-console] cron fire failed:", err));
    }
  }
  /** Create a run and start its first leg. Preflight failures settle the run without spending a model call. */
  async fire(taskId, by) {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    const runId = `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    await this.store.append({ t: "run/fired", at: now(), run: { id: runId, taskId, by, legs: task.participants.map((p) => p.agentId) } });
    const problem = await this.preflight(task);
    if (problem) {
      await this.store.append({ t: "leg/failed", at: now(), runId, leg: 0, error: `\u9884\u68C0\u4E0D\u8FC7:${problem}` });
      await this.store.append({ t: "run/settled", at: now(), runId, outcome: "failed" });
    } else {
      await this.startLeg(runId, 0, 1);
    }
    return this.store.runs.get(runId);
  }
  async preflight(task) {
    const presets = this.ctx.get("agentPresets");
    if (!presets) return "\u8FD9\u4E2A\u90E8\u7F72\u6CA1\u6709 preset \u670D\u52A1";
    for (const p of task.participants) {
      try {
        const r = await presets.resolve(p.agentId);
        if (r.broken) return `preset ${p.agentId} \u574F\u4E86:${r.broken}`;
      } catch {
        return `preset ${p.agentId} \u4E0D\u5728\u540D\u518C\u4E0A`;
      }
    }
    try {
      const { stat: stat2 } = await import("node:fs/promises");
      if (!(await stat2(task.cwd)).isDirectory()) return `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728:${task.cwd}`;
    } catch {
      return `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728:${task.cwd}`;
    }
    return null;
  }
  async startLeg(runId, leg, tries) {
    const run = this.store.runs.get(runId);
    const task = run && this.store.tasks.get(run.taskId);
    if (!run || !task) return;
    const participant = task.participants[leg];
    const presets = this.ctx.get("agentPresets");
    const preset = await presets.resolve(participant.agentId);
    const spec = await readSpec(dirname(String(preset.path)));
    const agentName = spec?.name ?? preset.name ?? preset.id;
    let selection = (() => {
      try {
        return this.ctx.get("agentDefaultModel")?.currentSelection?.();
      } catch {
        return void 0;
      }
    })();
    if (spec?.model?.includes("/")) {
      const [provider, ...rest] = spec.model.split("/");
      selection = { provider, model: rest.join("/"), ...spec.effort ? { reasoningEffort: spec.effort } : {} };
    }
    const sessionId = `task-${run.taskId}-${runId}-${leg + 1}${tries > 1 ? `-t${tries}` : ""}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const upstream = leg > 0 ? { agentName: await this.agentName(task.participants[leg - 1].agentId), handoff: run.legs[leg - 1].handoff ?? "" } : void 0;
    const text = legMessage(task, run, leg, upstream);
    const messageId = randomUUID();
    const flight = { runId, leg, sessionId, messageId, consumed: false, handle: void 0, lastText: "" };
    this.flights.set(sessionId, flight);
    try {
      flight.handle = await this.ctx.agents.create({
        sessionId,
        ...selection ? { agentOptions: selection } : {},
        meta: { cwd: task.cwd, agentPreset: preset.id },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id);
        }
      });
      await this.store.append({ t: "leg/spawned", at: now(), runId, leg, sessionId, tries });
      try {
        this.ctx.get("sessionTitle")?.rename?.(flight.handle.agent.session, `task: ${task.title} \xB7 ${runId} \xB7 ${agentName}`);
      } catch {
      }
      try {
        const registry = this.ctx.get("workspaceRegistry");
        const workspace = registry ? await registry.resolveByPath(task.cwd).catch(() => void 0) ?? await registry.create(task.cwd).catch(() => void 0) : void 0;
        await workspace?.attachSession?.(sessionId);
      } catch {
      }
      flight.handle.agent.followup({ id: messageId, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
      flight.timer = setTimeout(() => {
        void this.finish(flight, "timed_out", `${task.timeoutSec} \u79D2\u6CA1\u4EA4\u5377`);
      }, task.timeoutSec * 1e3);
    } catch (error) {
      this.flights.delete(sessionId);
      await this.store.append({ t: "leg/failed", at: now(), runId, leg, error: error instanceof Error ? error.message : String(error) });
      await this.store.append({ t: "run/settled", at: now(), runId, outcome: "failed" });
    }
  }
  async agentName(id) {
    try {
      const presets = this.ctx.get("agentPresets");
      const p = await presets.resolve(id);
      const s = await readSpec(dirname(String(p.path)));
      return s?.name ?? p.name ?? id;
    } catch {
      return id;
    }
  }
  onSessionEvent(session, event) {
    const f = this.flights.get(session?.id);
    if (!f) return;
    switch (event.type) {
      case "user/message":
        if (event.data?.id === f.messageId) f.consumed = true;
        break;
      case "tool/call":
        if (String(event.data?.name ?? "").endsWith("ask_user_question")) {
          let q = "";
          try {
            const a = JSON.parse(event.data.arguments ?? "{}");
            q = a.questions?.[0]?.question ?? a.question ?? JSON.stringify(a).slice(0, 200);
          } catch {
            q = String(event.data.arguments ?? "").slice(0, 200);
          }
          f.pendingAsk = event.data.callId;
          void this.store.append({ t: "leg/blocked", at: now(), runId: f.runId, leg: f.leg, question: q });
        }
        break;
      case "tool/result":
        if (f.pendingAsk && event.data?.message?.source?.callId === f.pendingAsk) {
          f.pendingAsk = void 0;
          void this.store.append({ t: "leg/resumed", at: now(), runId: f.runId, leg: f.leg });
        }
        break;
      case "assistant/message": {
        const blocks = event.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
          if (t) f.lastText = t;
        }
        break;
      }
      case "turn/end":
        if (!f.consumed) break;
        if (event.data?.reason && event.data.reason.kind !== "completed") void this.finish(f, "failed", JSON.stringify(event.data.reason));
        else void this.finish(f, "done");
        break;
    }
  }
  async finish(f, outcome, error) {
    if (!this.flights.has(f.sessionId)) return;
    this.flights.delete(f.sessionId);
    if (f.timer) clearTimeout(f.timer);
    try {
      await f.handle?.dispose?.();
    } catch {
    }
    const run = this.store.runs.get(f.runId);
    const task = run && this.store.tasks.get(run.taskId);
    if (!run || !task) return;
    if (outcome === "done") {
      await this.store.append({ t: "leg/done", at: now(), runId: f.runId, leg: f.leg, handoff: f.lastText });
      if (f.leg + 1 < task.participants.length) await this.startLeg(f.runId, f.leg + 1, 1);
      else await this.store.append({ t: "run/settled", at: now(), runId: f.runId, outcome: "done" });
      return;
    }
    await this.store.append({ t: `leg/${outcome}`, at: now(), runId: f.runId, leg: f.leg, error });
    const tries = run.legs[f.leg].tries;
    if (outcome !== "cancelled" && task.onFail === "retry" && tries < task.maxTries) {
      await this.startLeg(f.runId, f.leg, tries + 1);
      return;
    }
    await this.store.append({ t: "run/settled", at: now(), runId: f.runId, outcome: outcome === "cancelled" ? "cancelled" : "failed" });
  }
  async cancel(runId) {
    for (const f of [...this.flights.values()]) if (f.runId === runId) await this.finish(f, "cancelled", "\u4EBA\u5DE5\u53D6\u6D88");
    const run = this.store.runs.get(runId);
    if (run && !run.settled) await this.store.append({ t: "run/settled", at: now(), runId, outcome: "cancelled" });
  }
};
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
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
  ["tryRun", 1],
  ["startAgentSession", 1],
  ["sessionTurns", 1],
  ["tasks", 0],
  ["createTask", 1],
  ["setTaskEnabled", 1],
  ["deleteTask", 1],
  ["fireTask", 1],
  ["cancelRun", 1],
  ["taskEvents", 1]
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
  runner;
  constructor(ctx) {
    super(ctx, NAMESPACE);
    this.runner = new TaskRunner(ctx, new EventStore());
    void this.runner.start().catch((err) => console.error("[task-console] runner failed to start:", err));
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
  /** Registered workspaces in sidebar order; empty when the registry is not composed. */
  workspaces() {
    try {
      const reg = this.ctx.get("workspaceRegistry");
      return (reg?.list?.() ?? []).map((w) => ({ id: String(w.id), path: String(w.path), title: String(w.title ?? w.path.split("/").pop() ?? w.path) }));
    } catch {
      return [];
    }
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
      userRoot: presets?.authorable === false ? null : userPresetRoot(),
      workspaces: this.workspaces()
    };
    return JSON.stringify(out);
  }
  async agents() {
    const presets = this.ctx.get("agentPresets");
    if (!presets) return JSON.stringify([]);
    const rows = [];
    for (const p of await presets.list()) {
      const dir = dirname2(String(p.path));
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
    const preview2 = renderComposition(spec, this.hostMcp());
    return JSON.stringify({ ...preview2, yml: mask(preview2.yml) });
  }
  async saveAgent(payload) {
    const spec = validateSpec(JSON.parse(payload));
    const presets = this.ctx.get("agentPresets");
    if (presets && presets.authorable === false) throw new Error("\u8FD9\u4E2A\u90E8\u7F72\u6CA1\u6709\u53EF\u5199\u7684 preset \u6839");
    const shipped = presets ? (await presets.list()).find((p) => p.id === spec.id && p.trust === "system") : void 0;
    if (shipped) throw new Error(`"${spec.id}" \u662F\u51FA\u5382 preset,\u4E0D\u80FD\u8986\u76D6;\u6362\u4E2A id`);
    const { path, preview: preview2 } = await writePreset(spec, this.hostMcp(), await scanSkills());
    return JSON.stringify({ path, preview: { ...preview2, yml: mask(preview2.yml) } });
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
    const spec = await readSpec(dirname2(String(preset.path)));
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
        meta: { cwd: homedir3(), agentPreset: preset.id },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id);
        }
      });
      messageId = randomUUID2();
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
  // ── chat with an agent ─────────────────────────────────────────────────
  /** Live handles for sessions started from the composer; disposing them would kill the chat. */
  chats = /* @__PURE__ */ new Map();
  /**
   * Start a root session on an agent's preset, pin a readable title, file it
   * under the workspace, and (optionally) submit the first message. The UI
   * then opens the session; the person keeps talking to it there.
   */
  async startAgentSession(payload) {
    const { agentId, text, cwd } = JSON.parse(payload);
    const presets = this.ctx.get("agentPresets");
    if (!presets) throw new Error("\u8FD9\u4E2A\u90E8\u7F72\u6CA1\u6709 preset \u670D\u52A1");
    const preset = await presets.resolve(agentId);
    if (preset.broken) throw new Error(`preset \u574F\u4E86:${preset.broken}`);
    const spec = await readSpec(dirname2(String(preset.path)));
    const name2 = spec?.name ?? preset.name ?? preset.id;
    let selection = this.defaultModel();
    if (spec?.model?.includes("/")) {
      const [provider, ...rest] = spec.model.split("/");
      selection = { provider, model: rest.join("/"), ...spec.effort ? { reasoningEffort: spec.effort } : {} };
    }
    const workspaces = this.workspaces();
    const dir = cwd && cwd.trim() ? cwd.trim() : workspaces[0]?.path ?? homedir3();
    const sessionId = `agent-${agentId}-${Date.now().toString(36)}`;
    const handle = await this.ctx.agents.create({
      sessionId,
      ...selection ? { agentOptions: selection } : {},
      meta: { cwd: dir, agentPreset: preset.id },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, preset.id);
      }
    });
    this.chats.set(sessionId, handle);
    const head = (text ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
    try {
      this.ctx.get("sessionTitle")?.rename?.(handle.agent.session, head ? `${name2} \xB7 ${head}` : `${name2} \xB7 \u65B0\u4F1A\u8BDD`);
    } catch {
    }
    try {
      const registry = this.ctx.get("workspaceRegistry");
      const ws = registry ? await registry.resolveByPath(dir).catch(() => void 0) ?? await registry.create(dir).catch(() => void 0) : void 0;
      await ws?.attachSession?.(sessionId);
    } catch {
    }
    if (text && text.trim()) handle.agent.followup({ id: randomUUID2(), role: "user", content: [{ type: "text", text: text.trim() }], source: { kind: "user" } });
    return JSON.stringify({ sessionId, agentPreset: preset.id, name: name2 });
  }
  // ── turn ledger ────────────────────────────────────────────────────────
  /** Fold one session's own log into turns → steps → tool calls (live or cold). */
  async sessionTurns(payload) {
    const { sessionId } = JSON.parse(payload);
    const persistence = this.ctx.get("sessionPersistence");
    let events = [];
    let agentPreset;
    if (persistence?.inspect) {
      const insp = await persistence.inspect(sessionId);
      events = insp.events ?? [];
      agentPreset = insp.header?.agentPreset;
    } else {
      const live = this.ctx.get("sessions")?.get?.(sessionId);
      events = live?.events ?? [];
      agentPreset = live?.header?.agentPreset;
    }
    return JSON.stringify(foldTurns(sessionId, events, agentPreset));
  }
  // ── tasks ──────────────────────────────────────────────────────────────
  /** Every task with its runs, plus the next cron fire time; one payload for the board. */
  async tasks() {
    const store = this.runner.store;
    const tasks = [...store.tasks.values()].map((t) => ({
      ...t,
      nextFire: t.trigger.kind === "cron" && t.enabled ? nextFire(parseCron(t.trigger.expr))?.toISOString() ?? null : null
    }));
    const runs = [...store.runs.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt));
    return JSON.stringify({ tasks, runs });
  }
  async createTask(payload) {
    const presets = this.ctx.get("agentPresets");
    const ids = new Set(presets ? (await presets.list()).filter((p) => !p.broken).map((p) => String(p.id)) : []);
    const task = validateTask(JSON.parse(payload), ids);
    await this.runner.store.append({ t: "task/created", at: task.createdAt, task });
    if (task.trigger.kind === "once") await this.runner.fire(task.id, "manual");
    return JSON.stringify({ id: task.id });
  }
  async setTaskEnabled(payload) {
    const { id, enabled } = JSON.parse(payload);
    if (!this.runner.store.tasks.has(id)) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    await this.runner.store.append({ t: "task/enabled", at: (/* @__PURE__ */ new Date()).toISOString(), taskId: id, enabled: !!enabled });
    return JSON.stringify({ ok: true });
  }
  async deleteTask(payload) {
    const { id } = JSON.parse(payload);
    for (const r of this.runner.store.runs.values()) if (r.taskId === id && !r.settled) await this.runner.cancel(r.id);
    await this.runner.store.append({ t: "task/deleted", at: (/* @__PURE__ */ new Date()).toISOString(), taskId: id });
    return JSON.stringify({ ok: true });
  }
  async fireTask(payload) {
    const { id, by } = JSON.parse(payload);
    const run = await this.runner.fire(id, by === "retry" ? "retry" : "manual");
    return JSON.stringify({ runId: run.id });
  }
  async cancelRun(payload) {
    const { runId } = JSON.parse(payload);
    await this.runner.cancel(runId);
    return JSON.stringify({ ok: true });
  }
  async taskEvents(payload) {
    const { id } = JSON.parse(payload);
    const runIds = new Set([...this.runner.store.runs.values()].filter((r) => r.taskId === id).map((r) => r.id));
    const events = this.runner.store.all().filter((e) => e.taskId === id || e.task?.id === id || runIds.has(e.runId) || runIds.has(e.run?.id)).slice(-60);
    return JSON.stringify(events);
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
