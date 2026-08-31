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
var BLOCK_RECURRENCE_LIMIT = 3;
function fold(events) {
  const s = { tasks: /* @__PURE__ */ new Map(), batches: /* @__PURE__ */ new Map(), cards: /* @__PURE__ */ new Map(), runs: /* @__PURE__ */ new Map() };
  const finishRun = (r, status, outcome, at, error) => {
    r.status = status;
    r.outcome = outcome;
    r.endedAt = at;
    if (error) r.error = error;
    const c = s.cards.get(r.cardId);
    if (c && c.currentRunId === r.id) c.currentRunId = void 0;
    return c;
  };
  for (const e of events) {
    switch (e.t) {
      case "task/created":
        s.tasks.set(e.task.id, e.task);
        break;
      case "task/enabled": {
        const t = s.tasks.get(e.taskId);
        if (t) s.tasks.set(t.id, { ...t, enabled: e.enabled });
        break;
      }
      case "task/deleted": {
        s.tasks.delete(e.taskId);
        for (const b of [...s.batches.values()]) if (b.taskId === e.taskId) s.batches.delete(b.id);
        for (const c of [...s.cards.values()]) if (c.taskId === e.taskId) s.cards.delete(c.id);
        for (const r of [...s.runs.values()]) if (r.taskId === e.taskId) s.runs.delete(r.id);
        break;
      }
      case "batch/fired": {
        s.batches.set(e.batch.id, { id: e.batch.id, taskId: e.taskId, firedAt: e.at, by: e.batch.by, cardIds: e.batch.cards.map((c) => c.id) });
        e.batch.cards.forEach((c, i) => s.cards.set(c.id, { id: c.id, batchId: e.batch.id, taskId: e.taskId, index: i, agentId: c.agentId, brief: c.brief, deps: c.deps, status: c.deps.length ? "todo" : "ready", runIds: [], consecutiveFailures: 0, blockRecurrences: 0 }));
        break;
      }
      case "card/ready": {
        const c = s.cards.get(e.cardId);
        if (c && (c.status === "todo" || c.status === "ready")) c.status = "ready";
        break;
      }
      case "run/claimed": {
        const c = s.cards.get(e.cardId);
        if (!c) break;
        s.runs.set(e.runId, { id: e.runId, cardId: c.id, batchId: c.batchId, taskId: e.taskId, attempt: e.attempt, sessionId: e.sessionId, startedAt: e.at, status: "running", nudges: 0 });
        c.runIds.push(e.runId);
        c.currentRunId = e.runId;
        c.status = "running";
        c.startedAt ??= e.at;
        c.error = void 0;
        break;
      }
      case "run/blocked": {
        const r = s.runs.get(e.runId);
        if (!r) break;
        r.status = "blocked";
        r.blockKind = e.kind;
        r.question = e.reason;
        const c = s.cards.get(r.cardId);
        if (c) {
          c.status = "blocked";
          if (c.lastBlockReason === e.reason) c.blockRecurrences++;
          else {
            c.lastBlockReason = e.reason;
            c.blockRecurrences = 1;
          }
        }
        break;
      }
      case "run/resumed": {
        const r = s.runs.get(e.runId);
        if (!r) break;
        r.status = "running";
        r.question = void 0;
        const c = s.cards.get(r.cardId);
        if (c) c.status = "running";
        break;
      }
      case "run/nudged": {
        const r = s.runs.get(e.runId);
        if (r) r.nudges++;
        break;
      }
      case "run/completed":
      case "run/review_requested": {
        const r = s.runs.get(e.runId);
        if (!r) break;
        r.summary = e.summary;
        const c = finishRun(r, "done", e.t === "run/completed" ? "completed" : "review", e.at);
        if (c) {
          c.status = e.t === "run/completed" ? "done" : "review";
          c.summary = e.summary;
          c.endedAt = e.at;
          c.consecutiveFailures = 0;
          c.blockRecurrences = 0;
        }
        break;
      }
      case "run/failed":
      case "run/timed_out":
      case "run/crashed":
      case "run/cancelled": {
        const r = s.runs.get(e.runId);
        if (!r) break;
        const status = e.t.slice(4);
        const outcome = e.outcome ?? (status === "failed" ? "failed" : status === "timed_out" ? "timed_out" : status === "crashed" ? "crashed" : "cancelled");
        const c = finishRun(r, status, outcome, e.at, e.error);
        if (c) {
          if (status === "cancelled") {
            c.status = "cancelled";
            c.endedAt = e.at;
          } else {
            c.consecutiveFailures++;
            c.status = "ready";
            c.error = e.error;
          }
        }
        break;
      }
      case "card/gave_up": {
        const c = s.cards.get(e.cardId);
        if (c) {
          c.status = "failed";
          c.error = e.error;
          c.endedAt = e.at;
        }
        break;
      }
      case "card/cancelled": {
        const c = s.cards.get(e.cardId);
        if (c && c.status !== "done") {
          c.status = "cancelled";
          c.endedAt = e.at;
        }
        break;
      }
      case "batch/settled": {
        const b = s.batches.get(e.batchId);
        if (b) b.settled = { at: e.at, outcome: e.outcome };
        break;
      }
    }
  }
  return s;
}
function readyCards(s) {
  const out = [];
  for (const c of s.cards.values()) {
    if (c.status !== "todo" && c.status !== "ready") continue;
    if (c.deps.every((d) => {
      const p = s.cards.get(d);
      return p && (p.status === "done" || p.status === "review");
    })) out.push(c);
  }
  return out;
}
function batchStatus(s, b) {
  const cards = b.cardIds.map((id) => s.cards.get(id)).filter(Boolean);
  if (cards.some((c) => c.status === "blocked")) return "park";
  if (b.settled) return b.settled.outcome === "done" ? "done" : "bad";
  if (cards.some((c) => c.status === "failed" || c.status === "cancelled")) return "bad";
  if (cards.length && cards.every((c) => c.status === "done" || c.status === "review")) return "done";
  return "run";
}
function cardRun(s, c) {
  return c.currentRunId && s.runs.get(c.currentRunId) || (c.runIds.length ? s.runs.get(c.runIds[c.runIds.length - 1]) : void 0);
}
function migrate(events) {
  const out = [];
  const legs = /* @__PURE__ */ new Map();
  for (const e of events) {
    switch (e.t) {
      case "task/created":
        out.push({ t: "task/created", at: e.at, taskId: e.task.id, task: e.task });
        break;
      case "task/enabled":
      case "task/deleted":
        out.push(e);
        break;
      case "run/fired": {
        if (e.run?.cards) {
          out.push(e);
          break;
        }
        const agents = e.run.legs;
        const cards = agents.map((agentId, i) => ({ id: `${e.run.id}#${i}`, agentId, deps: i ? [`${e.run.id}#${i - 1}`] : [] }));
        legs.set(e.run.id, { taskId: e.run.taskId, agents, tries: agents.map(() => 0) });
        out.push({ t: "batch/fired", at: e.at, taskId: e.run.taskId, batch: { id: e.run.id, by: e.run.by, cards } });
        break;
      }
      case "leg/spawned": {
        const l = legs.get(e.runId);
        if (!l) break;
        l.tries[e.leg] = e.tries;
        out.push({ t: "run/claimed", at: e.at, taskId: l.taskId, cardId: `${e.runId}#${e.leg}`, runId: `${e.runId}#${e.leg}#${e.tries}`, sessionId: e.sessionId, attempt: e.tries });
        break;
      }
      case "leg/blocked": {
        const l = legs.get(e.runId);
        if (!l) break;
        out.push({ t: "run/blocked", at: e.at, taskId: l.taskId, runId: `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}`, kind: "needs_input", reason: e.question });
        break;
      }
      case "leg/resumed": {
        const l = legs.get(e.runId);
        if (!l) break;
        out.push({ t: "run/resumed", at: e.at, taskId: l.taskId, runId: `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}` });
        break;
      }
      case "leg/done": {
        const l = legs.get(e.runId);
        if (!l) break;
        out.push({ t: "run/completed", at: e.at, taskId: l.taskId, runId: `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}`, summary: e.handoff ?? "" });
        break;
      }
      case "leg/failed":
      case "leg/timed_out":
      case "leg/lost":
      case "leg/cancelled": {
        const l = legs.get(e.runId);
        if (!l) break;
        const runId = `${e.runId}#${e.leg}#${l.tries[e.leg] || 1}`;
        if (e.t === "leg/cancelled" && !l.tries[e.leg]) {
          out.push({ t: "card/cancelled", at: e.at, taskId: l.taskId, cardId: `${e.runId}#${e.leg}` });
          break;
        }
        const t = e.t === "leg/lost" ? "run/crashed" : e.t === "leg/timed_out" ? "run/timed_out" : e.t === "leg/cancelled" ? "run/cancelled" : "run/failed";
        out.push({ t, at: e.at, taskId: l.taskId, runId, error: e.error });
        if (t !== "run/cancelled") out.push({ t: "card/gave_up", at: e.at, taskId: l.taskId, cardId: `${e.runId}#${e.leg}`, error: e.error ?? t });
        break;
      }
      case "run/settled": {
        const l = legs.get(e.runId);
        if (!l) {
          out.push(e);
          break;
        }
        out.push({ t: "batch/settled", at: e.at, taskId: l.taskId, batchId: e.runId, outcome: e.outcome });
        break;
      }
      default:
        out.push(e);
    }
  }
  return out;
}
var preview = (s, n) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? t.slice(0, n) + "\u2026" : t;
};
function foldTurns(sessionId, events, agentPreset) {
  const turns = [];
  const byCall = /* @__PURE__ */ new Map();
  const totals = { turns: 0, steps: 0, mcp: 0, skill: 0, native: 0, ask: 0, task: 0, input: 0, output: 0, ms: 0, byServer: {}, skills: [] };
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
        const kind = name2.endsWith("ask_user_question") ? "ask" : /^task_(complete|block|request_review)$/.test(name2) ? "task" : m ? "mcp" : name2 === "skill" ? "skill" : "native";
        const row = { callId: d.callId, name: m ? m[2] : name2, kind, server: m?.[1], args: preview(d.arguments, 240), result: "", ok: true, ms: 0, at: iso(e.time), _t: e.time };
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
        row.ms = e.time - (row._t ?? e.time);
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
  state = fold([]);
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
    const raw = text.split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    this.events = migrate(raw);
    this.state = fold(this.events);
  }
  all() {
    return this.events;
  }
  get s() {
    return this.state;
  }
  get tasks() {
    return this.state.tasks;
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
function cardMessage(task, card, batchId, upstream) {
  const lines = [`# \u4EFB\u52A1:${task.title} \xB7 ${batchId} \xB7 \u7B2C ${card.index + 1}/${task.participants.length} \u5F20\u5361`, "", "[TASK]", task.brief.trim()];
  if (card.brief?.trim()) lines.push("", "[YOUR PART]", card.brief.trim());
  for (const u of upstream) lines.push("", `[UPSTREAM HANDOFF from ${u.agentName}]`, u.summary.trim() || "(\u4E0A\u6E38\u6CA1\u6709\u7559\u4E0B\u4EA4\u63A5\u5355)");
  lines.push(
    "",
    "[CONTRACT]",
    "\u505A\u5B8C\u540E\u5FC5\u987B\u8C03\u7528 task_complete(summary) \u4EA4\u5377;summary \u5199\u300C\u4EA7\u7269 / \u5E72\u4E86\u4EC0\u4E48 / \u4E0B\u6E38\u6CE8\u610F\u300D,\u5B83\u4F1A\u539F\u6837\u4EA4\u7ED9\u4E0B\u4E00\u5F20\u5361\u3002",
    '\u62FF\u4E0D\u51C6\u4E14\u4E0D\u53EF\u9006\u7684\u4E8B:\u80FD\u7528 ask_user_question \u5C31\u95EE;\u5426\u5219 task_block(reason, kind="needs_input")\u3002',
    '\u7F3A\u5DE5\u5177\u6216\u6743\u9650\u505A\u4E0D\u4E86:task_block(reason, kind="capability")\u3002',
    "\u4E0D\u8981\u5728\u6CA1\u6709\u8C03\u7528 task_complete \u6216 task_block \u7684\u60C5\u51B5\u4E0B\u7ED3\u675F\u3002"
  );
  return lines.join("\n");
}
var NUDGE = "\u4F60\u505C\u4E0B\u6765\u4E86,\u4F46\u6CA1\u6709\u4EA4\u5377\u3002\u8BF7\u73B0\u5728\u8C03\u7528 task_complete(summary) \u4EA4\u5377,\u6216 task_block(reason, kind) \u8BF4\u660E\u4E3A\u4EC0\u4E48\u505A\u4E0D\u4E0B\u53BB\u3002";
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

// src/worker-tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var OUT = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, note: { type: "string" } } };
var render = (_args, value) => [{ type: "text", text: JSON.stringify(value) }];
function registerWorkerTools(agentCtx, hooks) {
  const disposers = [];
  disposers.push(agentCtx.tools.register(defineTool({
    name: "task_complete",
    description: "\u4EA4\u5377:\u8FD9\u5F20\u5361\u505A\u5B8C\u4E86\u3002summary \u5199\u300C\u4EA7\u7269 / \u5E72\u4E86\u4EC0\u4E48 / \u4E0B\u6E38\u6CE8\u610F\u300D,\u4F1A\u539F\u6837\u4EA4\u7ED9\u4E0B\u4E00\u5F20\u5361\u3002\u8C03\u7528\u540E\u4E0D\u8981\u518D\u505A\u522B\u7684\u3002",
    parameters: { summary: { type: "string", required: true, description: "\u4EA4\u63A5\u5355\u6B63\u6587,\u7ED9\u4E0B\u6E38\u770B\u7684\u3002" } },
    output: { schema: OUT, render },
    async execute(args) {
      const summary = String(args.summary ?? "").trim();
      if (!summary) return { ok: false, note: "summary \u4E0D\u80FD\u4E3A\u7A7A" };
      await hooks.complete(summary);
      return { ok: true, note: "\u5DF2\u4EA4\u5377,\u4E0B\u4E00\u5F20\u5361\u4F1A\u6536\u5230\u8FD9\u4EFD\u4EA4\u63A5\u5355\u3002" };
    }
  })));
  disposers.push(agentCtx.tools.register(defineTool({
    name: "task_block",
    description: "\u505A\u4E0D\u4E0B\u53BB\u65F6\u8C03\u7528\u3002kind: needs_input=\u8981\u4EBA\u56DE\u7B54(\u4F1A\u505C\u8F66\u7B49\u4EBA,\u4EBA\u5728\u8FD9\u4E2A\u4F1A\u8BDD\u91CC\u56DE\u7B54\u540E\u4F60\u7EE7\u7EED);capability=\u7F3A\u5DE5\u5177\u6216\u6743\u9650;transient=\u4E34\u65F6\u6545\u969C\u53EF\u91CD\u8BD5;dependency=\u8981\u7B49\u522B\u7684\u5361\u3002",
    parameters: {
      reason: { type: "string", required: true, description: "\u4E00\u53E5\u8BDD\u8BF4\u6E05\u5361\u5728\u54EA\u3002" },
      kind: { type: "string", required: true, enum: ["needs_input", "capability", "transient", "dependency"], description: "\u5361\u4F4F\u7684\u7C7B\u578B\u3002" }
    },
    output: { schema: OUT, render },
    async execute(args) {
      const reason = String(args.reason ?? "").trim();
      const kind = String(args.kind ?? "needs_input");
      if (!reason) return { ok: false, note: "reason \u4E0D\u80FD\u4E3A\u7A7A" };
      await hooks.block(reason, ["needs_input", "capability", "transient", "dependency"].includes(kind) ? kind : "needs_input");
      return { ok: true, note: kind === "needs_input" ? "\u5DF2\u505C\u8F66\u7B49\u4EBA\u3002\u7B49\u5BF9\u65B9\u5728\u8FD9\u4E2A\u4F1A\u8BDD\u91CC\u56DE\u7B54,\u7136\u540E\u7EE7\u7EED\u3002" : "\u5DF2\u8BB0\u5F55\u3002\u8FD9\u4E00\u6B21\u8FD0\u884C\u5230\u6B64\u4E3A\u6B62\u3002" };
    }
  })));
  disposers.push(agentCtx.tools.register(defineTool({
    name: "task_request_review",
    description: "\u505A\u5B8C\u4E86\u4F46\u9700\u8981\u4EBA\u6216\u9A8C\u6536\u5361\u628A\u5173\u65F6\u8C03\u7528,summary \u540C task_complete\u3002",
    parameters: { summary: { type: "string", required: true, description: "\u4EA4\u63A5\u5355\u6B63\u6587\u3002" } },
    output: { schema: OUT, render },
    async execute(args) {
      const summary = String(args.summary ?? "").trim();
      if (!summary) return { ok: false, note: "summary \u4E0D\u80FD\u4E3A\u7A7A" };
      await hooks.requestReview(summary);
      return { ok: true, note: "\u5DF2\u63D0\u4EA4\u9A8C\u6536\u3002" };
    }
  })));
  return () => {
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
      }
    }
  };
}

// src/runner.ts
var TaskRunner = class {
  ctx;
  store;
  flights = /* @__PURE__ */ new Map();
  ticker;
  firedMinute = /* @__PURE__ */ new Map();
  disposeListener;
  ticking = false;
  maxInProgress;
  clock;
  constructor(ctx, store, opts = {}) {
    this.ctx = ctx;
    this.store = store;
    this.maxInProgress = opts.maxInProgress ?? 3;
    this.clock = opts.now ?? (() => Date.now());
  }
  async start() {
    await this.store.load();
    for (const r of this.store.s.runs.values()) {
      if (r.status === "running" || r.status === "blocked") await this.append({ t: "run/crashed", taskId: r.taskId, runId: r.id, error: "\u5BBF\u4E3B\u91CD\u542F,\u4F1A\u8BDD\u4E0D\u5728\u4E86" });
    }
    await this.settleBatches();
    this.disposeListener = this.ctx.on("session/event", (session, event) => this.onSessionEvent(session, event));
    this.ticker = setInterval(() => {
      void this.tick();
    }, 6e4);
    this.ticker.unref?.();
    this.ctx.effect?.(() => () => this.stop(), "task-console: runner");
    await this.tick();
  }
  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.disposeListener?.();
    for (const f of this.flights.values()) {
      if (f.timer) clearTimeout(f.timer);
      f.disposeTools?.();
    }
  }
  now() {
    return new Date(this.clock()).toISOString();
  }
  append(e) {
    return this.store.append({ at: this.now(), ...e });
  }
  // ── the tick ──────────────────────────────────────────────────────────
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.fireDueCron();
      await this.dispatch();
    } finally {
      this.ticking = false;
    }
  }
  async fireDueCron() {
    const d = new Date(this.clock());
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
  /** Promote, claim, spawn — bounded by the in-progress cap. */
  async dispatch() {
    const s = this.store.s;
    for (const c of readyCards(s)) if (c.status === "todo") await this.append({ t: "card/ready", taskId: c.taskId, cardId: c.id });
    let inProgress = [...this.store.s.runs.values()].filter((r) => r.status === "running" || r.status === "blocked").length;
    const ready = readyCards(this.store.s).sort((a, b) => a.batchId.localeCompare(b.batchId) || a.index - b.index);
    for (const c of ready) {
      if (inProgress >= this.maxInProgress) break;
      const task = this.store.tasks.get(c.taskId);
      if (!task) continue;
      const batch = this.store.s.batches.get(c.batchId);
      if (!batch || batch.settled) continue;
      if (c.consecutiveFailures > 0 && (task.onFail !== "retry" || c.consecutiveFailures >= task.maxTries)) {
        await this.append({ t: "card/gave_up", taskId: c.taskId, cardId: c.id, error: c.error ?? `\u8FDE\u7EED\u5931\u8D25 ${c.consecutiveFailures} \u6B21` });
        await this.settleBatches();
        continue;
      }
      await this.startRun(task, batch, c);
      inProgress++;
    }
    await this.settleBatches();
  }
  /** Close batches whose cards are all terminal; cancel cards a failure made unreachable. */
  async settleBatches() {
    for (const b of this.store.s.batches.values()) {
      if (b.settled) continue;
      const cards = b.cardIds.map((id) => this.store.s.cards.get(id)).filter(Boolean);
      if (!cards.length) continue;
      const dead = cards.filter((c) => c.status === "failed" || c.status === "cancelled");
      if (dead.length) {
        for (const c of cards) if (c.status === "todo" || c.status === "ready") await this.append({ t: "card/cancelled", taskId: b.taskId, cardId: c.id });
        const stillLive = cards.some((c) => c.status === "running" || c.status === "blocked");
        if (!stillLive) await this.append({ t: "batch/settled", taskId: b.taskId, batchId: b.id, outcome: dead.some((c) => c.status === "failed") ? "failed" : "cancelled" });
        continue;
      }
      if (cards.every((c) => c.status === "done" || c.status === "review")) await this.append({ t: "batch/settled", taskId: b.taskId, batchId: b.id, outcome: "done" });
    }
  }
  // ── firing ────────────────────────────────────────────────────────────
  /** Create a batch (one card per participant, chained) and dispatch. */
  async fire(taskId, by) {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    const batchId = `b-${this.clock().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const cards = task.participants.map((p, i) => ({ id: `${batchId}#${i}`, agentId: p.agentId, ...p.brief ? { brief: p.brief } : {}, deps: i ? [`${batchId}#${i - 1}`] : [] }));
    await this.append({ t: "batch/fired", taskId, batch: { id: batchId, by, cards } });
    const problem = await this.preflight(task);
    if (problem) {
      const first = cards[0];
      await this.append({ t: "run/claimed", taskId, cardId: first.id, runId: `${first.id}#0`, sessionId: "", attempt: 0 });
      await this.append({ t: "run/failed", taskId, runId: `${first.id}#0`, error: `\u9884\u68C0\u4E0D\u8FC7:${problem}` });
      await this.append({ t: "card/gave_up", taskId, cardId: first.id, error: `\u9884\u68C0\u4E0D\u8FC7:${problem}` });
      await this.settleBatches();
    } else {
      await this.tick();
    }
    return this.store.s.batches.get(batchId);
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
  // ── one run ───────────────────────────────────────────────────────────
  async startRun(task, batch, card) {
    const presets = this.ctx.get("agentPresets");
    const preset = await presets.resolve(card.agentId);
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
    const attempt = card.runIds.length + 1;
    const runId = `${card.id}#${attempt}`;
    const sessionId = `task-${task.id}-${batch.id}-${card.index + 1}${attempt > 1 ? `-t${attempt}` : ""}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    this.nameCache.set(card.agentId, agentName);
    const upstream = [];
    for (const d of card.deps.map((x) => this.store.s.cards.get(x)).filter(Boolean)) upstream.push({ agentName: await this.displayName(d.agentId), summary: d.summary ?? "" });
    const text = cardMessage(task, card, batch.id, upstream);
    const messageId = randomUUID();
    const flight = { runId, cardId: card.id, taskId: task.id, sessionId, messageId, consumed: false, handle: void 0, lastText: "", timeoutSec: task.timeoutSec };
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
      try {
        flight.disposeTools = registerWorkerTools(flight.handle.agent.ctx, {
          complete: async (summary) => {
            flight.terminal = { kind: "completed", summary };
          },
          requestReview: async (summary) => {
            flight.terminal = { kind: "review", summary };
          },
          block: async (reason, kind) => {
            flight.terminal = { kind: "blocked", reason, blockKind: kind };
            if (kind === "needs_input") this.disarm(flight);
            await this.append({ t: "run/blocked", taskId: task.id, runId, kind, reason });
          }
        });
      } catch (error) {
        console.warn("[task-console] worker tools not registered:", error);
      }
      await this.append({ t: "run/claimed", taskId: task.id, cardId: card.id, runId, sessionId, attempt });
      try {
        this.ctx.get("sessionTitle")?.rename?.(flight.handle.agent.session, `task: ${task.title} \xB7 ${batch.id} \xB7 ${agentName}`);
      } catch {
      }
      try {
        const registry = this.ctx.get("workspaceRegistry");
        const ws = registry ? await registry.resolveByPath(task.cwd).catch(() => void 0) ?? await registry.create(task.cwd).catch(() => void 0) : void 0;
        await ws?.attachSession?.(sessionId);
      } catch {
      }
      flight.handle.agent.followup({ id: messageId, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
      this.arm(flight);
    } catch (error) {
      this.flights.delete(sessionId);
      if (!this.store.s.runs.has(runId)) await this.append({ t: "run/claimed", taskId: task.id, cardId: card.id, runId, sessionId, attempt });
      await this.append({ t: "run/failed", taskId: task.id, runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  /** The watchdog counts working time only: it pauses while a person is being waited on. */
  arm(f) {
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      void this.finish(f, "run/timed_out", "timed_out", `${f.timeoutSec} \u79D2\u6CA1\u4EA4\u5377`);
    }, f.timeoutSec * 1e3);
    f.timer.unref?.();
  }
  disarm(f) {
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = void 0;
    }
  }
  nameCache = /* @__PURE__ */ new Map();
  async displayName(id) {
    const hit = this.nameCache.get(id);
    if (hit) return hit;
    try {
      const p = await this.ctx.get("agentPresets").resolve(id);
      const spec = await readSpec(dirname(String(p.path)));
      const name2 = spec?.name ?? p.name ?? id;
      this.nameCache.set(id, name2);
      return name2;
    } catch {
      return id;
    }
  }
  // ── session events ────────────────────────────────────────────────────
  onSessionEvent(session, event) {
    const f = this.flights.get(session?.id);
    if (!f) return;
    const run = this.store.s.runs.get(f.runId);
    switch (event.type) {
      case "user/message":
        if (event.data?.id === f.messageId) f.consumed = true;
        else if (run?.status === "blocked" && event.data?.source?.kind === "user" && f.terminal?.kind === "blocked") {
          f.terminal = void 0;
          this.arm(f);
          void this.append({ t: "run/resumed", taskId: f.taskId, runId: f.runId });
        }
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
          this.disarm(f);
          void this.append({ t: "run/blocked", taskId: f.taskId, runId: f.runId, kind: "needs_input", reason: q });
        }
        break;
      case "tool/result":
        if (f.pendingAsk && event.data?.message?.source?.callId === f.pendingAsk) {
          f.pendingAsk = void 0;
          this.arm(f);
          void this.append({ t: "run/resumed", taskId: f.taskId, runId: f.runId });
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
        void this.onTurnEnd(f, event.data?.reason);
        break;
    }
  }
  async onTurnEnd(f, reason) {
    if (!this.flights.has(f.sessionId)) return;
    if (reason && reason.kind !== "completed") {
      await this.finish(f, "run/failed", "failed", JSON.stringify(reason));
      return;
    }
    const t = f.terminal;
    if (t?.kind === "completed") {
      await this.finish(f, "run/completed", "completed", void 0, t.summary);
      return;
    }
    if (t?.kind === "review") {
      await this.finish(f, "run/review_requested", "review", void 0, t.summary);
      return;
    }
    if (t?.kind === "blocked") {
      if (t.blockKind === "needs_input") return;
      const card = this.store.s.cards.get(f.cardId);
      if (t.blockKind === "transient" || t.blockKind === "dependency") {
        await this.finish(f, "run/failed", "blocked", t.reason);
        return;
      }
      if (card && card.blockRecurrences >= BLOCK_RECURRENCE_LIMIT) {
        await this.finish(f, "run/failed", "blocked", t.reason);
        return;
      }
      await this.finish(f, "run/failed", "blocked", t.reason, void 0, true);
      return;
    }
    const run = this.store.s.runs.get(f.runId);
    if (run?.status === "blocked") return;
    if ((run?.nudges ?? 0) < 1) {
      await this.append({ t: "run/nudged", taskId: f.taskId, runId: f.runId });
      f.handle.agent.followup({ id: randomUUID(), role: "user", content: [{ type: "text", text: NUDGE }], source: { kind: "user" } });
      return;
    }
    await this.finish(f, "run/failed", "protocol_violation", "\u505C\u4E86\u4E24\u6B21\u90FD\u6CA1\u6709\u8C03\u7528 task_complete / task_block");
  }
  async finish(f, t, outcome, error, summary, giveUpNow = false) {
    if (!this.flights.has(f.sessionId)) return;
    this.flights.delete(f.sessionId);
    if (f.timer) clearTimeout(f.timer);
    f.disposeTools?.();
    try {
      await f.handle?.dispose?.();
    } catch {
    }
    if (t === "run/completed" || t === "run/review_requested") {
      await this.append({ t, taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText });
    } else {
      await this.append({ t, taskId: f.taskId, runId: f.runId, outcome, error });
      if (giveUpNow) {
        const c = this.store.s.cards.get(f.cardId);
        if (c && c.status !== "failed") await this.append({ t: "card/gave_up", taskId: f.taskId, cardId: f.cardId, error: error ?? outcome });
      }
    }
    await this.tick();
  }
  async cancelBatch(batchId) {
    const b = this.store.s.batches.get(batchId);
    if (!b) return;
    for (const f of [...this.flights.values()]) {
      const r = this.store.s.runs.get(f.runId);
      if (r?.batchId === batchId) await this.finish(f, "run/cancelled", "cancelled", "\u4EBA\u5DE5\u53D6\u6D88");
    }
    for (const id of b.cardIds) {
      const c = this.store.s.cards.get(id);
      if (c && (c.status === "todo" || c.status === "ready")) await this.append({ t: "card/cancelled", taskId: b.taskId, cardId: id });
    }
    if (!this.store.s.batches.get(batchId)?.settled) await this.append({ t: "batch/settled", taskId: b.taskId, batchId, outcome: "cancelled" });
  }
  /** Remember display names so upstream handoffs read "from 巡检员", not "from inspector". */
  rememberName(id, name2) {
    this.nameCache.set(id, name2);
  }
};

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
  ["board", 0],
  ["tasks", 0],
  ["createTask", 1],
  ["setTaskEnabled", 1],
  ["deleteTask", 1],
  ["fireTask", 1],
  ["cancelRun", 1],
  ["taskEvents", 1],
  ["agentActivity", 1]
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
  withNext(t) {
    return { ...t, nextFire: t.trigger.kind === "cron" && t.enabled ? nextFire(parseCron(t.trigger.expr))?.toISOString() ?? null : null };
  }
  /** Every map as arrays — one payload for the board and the detail page. */
  async board() {
    const st = this.runner.store.s;
    const out = {
      tasks: [...st.tasks.values()].map((t) => this.withNext(t)),
      batches: [...st.batches.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt)),
      cards: [...st.cards.values()],
      runs: [...st.runs.values()]
    };
    return JSON.stringify(out);
  }
  /**
   * Legacy projection for the 0.4 UI: a batch rendered as the old Run
   * with `legs`. Kept until the 0.5 pages land; then removed.
   */
  async tasks() {
    const st = this.runner.store.s;
    const runs = [...st.batches.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt)).map((b) => {
      const legs = b.cardIds.map((id) => st.cards.get(id)).filter(Boolean).map((c) => {
        const r = cardRun(st, c);
        const status = c.status === "done" || c.status === "review" ? "done" : c.status === "running" ? "running" : c.status === "blocked" ? "blocked" : c.status === "failed" ? r?.status === "timed_out" ? "timed_out" : r?.status === "crashed" ? "lost" : "failed" : c.status === "cancelled" ? "cancelled" : "queued";
        return { agentId: c.agentId, status, tries: c.runIds.length, sessionId: r?.sessionId || void 0, startedAt: c.startedAt, endedAt: c.endedAt, handoff: c.summary, question: r?.status === "blocked" ? r.question : void 0, error: c.error };
      });
      const bs = batchStatus(st, b);
      return { id: b.id, taskId: b.taskId, firedAt: b.firedAt, by: b.by, legs, ...b.settled ? { settled: b.settled } : bs === "done" ? { settled: { at: b.firedAt, outcome: "done" } } : {} };
    });
    return JSON.stringify({ tasks: [...st.tasks.values()].map((t) => this.withNext(t)), runs });
  }
  async createTask(payload) {
    const presets = this.ctx.get("agentPresets");
    const rows = presets ? await presets.list() : [];
    const ids = new Set(rows.filter((p) => !p.broken).map((p) => String(p.id)));
    const task = validateTask(JSON.parse(payload), ids);
    for (const p of rows) {
      const spec = p.trust === "user" ? await readSpec(dirname2(String(p.path))) : null;
      this.runner.rememberName(p.id, spec?.name ?? p.name ?? p.id);
    }
    await this.runner.store.append({ t: "task/created", at: task.createdAt, taskId: task.id, task });
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
    for (const b of this.runner.store.s.batches.values()) if (b.taskId === id && !b.settled) await this.runner.cancelBatch(b.id);
    await this.runner.store.append({ t: "task/deleted", at: (/* @__PURE__ */ new Date()).toISOString(), taskId: id });
    return JSON.stringify({ ok: true });
  }
  async fireTask(payload) {
    const { id, by } = JSON.parse(payload);
    const presets = this.ctx.get("agentPresets");
    for (const p of presets ? await presets.list() : []) {
      const spec = p.trust === "user" ? await readSpec(dirname2(String(p.path))) : null;
      this.runner.rememberName(p.id, spec?.name ?? p.name ?? p.id);
    }
    const batch = await this.runner.fire(id, by === "retry" ? "retry" : "manual");
    return JSON.stringify({ runId: batch.id, batchId: batch.id });
  }
  async cancelRun(payload) {
    const { runId, batchId } = JSON.parse(payload);
    await this.runner.cancelBatch(batchId ?? runId ?? "");
    return JSON.stringify({ ok: true });
  }
  async taskEvents(payload) {
    const { id } = JSON.parse(payload);
    return JSON.stringify(this.runner.store.all().filter((e) => e.taskId === id).slice(-200));
  }
  /** What one agent has been doing: cards, last run, tasks it takes part in. */
  async agentActivity(payload) {
    const { agentId } = JSON.parse(payload);
    const st = this.runner.store.s;
    const cards = [...st.cards.values()].filter((c) => c.agentId === agentId);
    const runs = cards.flatMap((c) => c.runIds.map((id) => st.runs.get(id)).filter(Boolean));
    const last = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const tasks = [...st.tasks.values()].filter((t) => t.participants.some((p) => p.agentId === agentId)).map((t) => ({ id: t.id, title: t.title }));
    const done = cards.filter((c) => c.status === "done" || c.status === "review").length;
    const failed = cards.filter((c) => c.status === "failed").length;
    return JSON.stringify({ cards: cards.length, done, failed, runs: runs.length, lastRunAt: last?.startedAt ?? null, lastOutcome: last?.outcome ?? last?.status ?? null, tasks });
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
