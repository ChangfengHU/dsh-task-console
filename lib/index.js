// src/service.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname3 } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/artifacts.ts
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile as readFile2, realpath as realpath2, stat as stat2 } from "node:fs/promises";
import { basename as basename2, extname, isAbsolute as isAbsolute2, join, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// src/public-upload.ts
import { homedir } from "node:os";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
var MAX_HTML_BYTES = 20 * 1024 * 1024;
function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
function safeUploadPart(value) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120) || "page.html";
}
function safeUploadPath(value) {
  return value.split("/").map(safeUploadPart).filter(Boolean).join("/").slice(0, 300);
}
function publicUploadConfig() {
  const token = process.env.DSH_TASK_CONSOLE_UPLOAD_TOKEN ?? process.env.UPLOAD_R2_TOKEN ?? "";
  if (!token) throw new Error("\u5BBF\u4E3B\u672A\u914D\u7F6E DSH_TASK_CONSOLE_UPLOAD_TOKEN,\u4E0D\u80FD\u53D1\u5E03\u516C\u7F51\u94FE\u63A5");
  return {
    endpoint: process.env.DSH_TASK_CONSOLE_UPLOAD_URL ?? process.env.UPLOAD_R2_URL ?? "https://upload-r2.vyibc.com",
    domain: process.env.DSH_TASK_CONSOLE_PUBLIC_DOMAIN ?? process.env.UPLOAD_R2_DOMAIN ?? "https://resource.vyibc.com",
    token
  };
}
async function uploadPublicHtml(config, input) {
  if (!/\.html?$/i.test(input.name)) throw new Error("\u76EE\u524D\u53EA\u5141\u8BB8\u53D1\u5E03 .html \u6587\u4EF6");
  if (input.data.byteLength > MAX_HTML_BYTES) throw new Error("HTML \u8D85\u8FC7 20 MiB");
  const name2 = safeUploadPart(input.name);
  const path = input.path ? safeUploadPath(input.path) : "";
  const form = new FormData();
  form.append("file", new Blob([input.data], { type: "text/html; charset=utf-8" }), name2);
  form.append("domain", config.domain);
  form.append("name", name2);
  if (path) form.append("path", path);
  const response = await fetch(config.endpoint, { method: "POST", headers: { Authorization: `Bearer ${config.token}` }, body: form });
  const body = await response.text();
  if (!response.ok) throw new Error(`\u53D1\u5E03\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  let url = "";
  try {
    const parsed = JSON.parse(body);
    url = String(parsed.url ?? parsed.data?.url ?? parsed.result?.url ?? "");
  } catch {
    url = body.trim();
  }
  if (!/^https:\/\//.test(url)) {
    const base = config.domain.replace(/\/$/, "");
    url = `${base}/${path ? `${path}/` : ""}${encodeURIComponent(name2)}`;
  }
  return url;
}
async function readPublishableHtml(filePath) {
  const raw = String(filePath ?? "").trim();
  if (!raw) throw new Error("path \u4E0D\u80FD\u4E3A\u7A7A");
  const file = await realpath(resolve(raw));
  const configured = (process.env.DSH_TASK_CONSOLE_PUBLISH_ROOTS ?? homedir()).split(":").map((value) => value.trim()).filter(Boolean);
  const roots = await Promise.all(configured.map((root) => realpath(resolve(root))));
  if (!roots.some((root) => inside(file, root))) throw new Error("HTML \u5FC5\u987B\u4F4D\u4E8E\u5141\u8BB8\u7684\u5DE5\u4F5C\u533A\u5185");
  if (!/\.html?$/i.test(file)) throw new Error("\u76EE\u524D\u53EA\u5141\u8BB8\u53D1\u5E03 .html \u6587\u4EF6");
  const info = await stat(file);
  if (!info.isFile()) throw new Error("path \u4E0D\u662F\u666E\u901A\u6587\u4EF6");
  if (info.size > MAX_HTML_BYTES) throw new Error("HTML \u8D85\u8FC7 20 MiB");
  return { path: file, name: basename(file), data: await readFile(file) };
}
async function registerPublicHtmlTool(ctx) {
  const defineTool = process.env.NODE_ENV === "test" ? ((spec) => spec) : (await import("@deepseek-ai/dsh-tools")).defineTool;
  return ctx.tools.register(defineTool({
    name: "publish_public_html",
    description: "\u628A\u5DE5\u4F5C\u533A\u91CC\u7684\u4E00\u4E2A HTML \u6587\u4EF6\u53D1\u5E03\u4E3A\u516C\u7F51 HTTPS \u9875\u9762\u3002\u53D1\u5E03\u51ED\u636E\u4FDD\u7559\u5728\u5BBF\u4E3B\u7AEF\uFF1B\u53EA\u8FD4\u56DE\u516C\u5F00 URL\u3002\u9002\u5408\u4EA4\u4ED8\u539F\u578B\u3001\u62A5\u544A\u548C\u53EF\u4EA4\u4E92\u6F14\u793A\u3002",
    parameters: {
      path: { type: "string", required: true, description: "\u672C\u673A HTML \u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u5FC5\u987B\u4F4D\u4E8E\u5141\u8BB8\u7684\u5DE5\u4F5C\u533A\u3002" },
      name: { type: "string", description: "\u53EF\u9009\u7684\u516C\u7F51\u6587\u4EF6\u540D\uFF0C\u5FC5\u987B\u4EE5 .html \u6216 .htm \u7ED3\u5C3E\u3002" },
      publicPath: { type: "string", description: "\u53EF\u9009\u7684\u516C\u7F51\u76EE\u5F55\uFF0C\u4F8B\u5982 dsh-task-console/prototypes\u3002" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          publicUrl: { type: "string", required: true },
          bytes: { type: "number", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
    },
    async execute(args) {
      const file = await readPublishableHtml(String(args.path ?? ""));
      const requestedName = String(args.name ?? file.name).trim() || file.name;
      const publicUrl = await uploadPublicHtml(publicUploadConfig(), {
        name: requestedName,
        data: file.data,
        path: String(args.publicPath ?? "").trim() || "dsh-task-console/exports"
      });
      return { ok: true, publicUrl, bytes: file.data.byteLength };
    }
  }));
}

// src/artifacts.ts
var MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
var MAX_BROWSER_BYTES = 8 * 1024 * 1024;
var MIMES = {
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".css": "text/css",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml"
};
function mimeOf(path) {
  return MIMES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
function inside2(child, parent) {
  const r = relative2(parent, child);
  return r === "" || !r.startsWith(`..${sep2}`) && r !== ".." && !isAbsolute2(r);
}
function safePart(value) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100) || "artifact";
}
async function sha256(path) {
  return createHash("sha256").update(await readFile2(path)).digest("hex");
}
async function captureArtifacts(ctx, requested) {
  if (!requested.length) return [];
  if (requested.length > 20) throw new Error("\u4E00\u6B21\u6700\u591A\u767B\u8BB0 20 \u4E2A\u4EA7\u7269");
  const workspace = await realpath2(ctx.task.cwd);
  const checked = [];
  for (const raw of [...new Set(requested.map((x) => String(x).trim()).filter(Boolean))]) {
    const candidate = resolve2(ctx.task.cwd, raw);
    let original;
    try {
      original = await realpath2(candidate);
    } catch {
      throw new Error(`\u4EA7\u7269\u4E0D\u5B58\u5728:${raw}`);
    }
    if (!inside2(original, workspace)) throw new Error(`\u4EA7\u7269\u5FC5\u987B\u4F4D\u4E8E\u4EFB\u52A1\u5DE5\u4F5C\u533A\u5185:${raw}`);
    const info = await stat2(original);
    if (!info.isFile()) throw new Error(`\u4EA7\u7269\u4E0D\u662F\u666E\u901A\u6587\u4EF6:${raw}`);
    if (info.size > MAX_CAPTURE_BYTES) throw new Error(`\u4EA7\u7269\u8D85\u8FC7 20 MiB:${raw}`);
    checked.push({ original, name: safePart(basename2(original)), size: info.size, sha: await sha256(original) });
  }
  const dir = join(ctx.root, "artifacts", safePart(ctx.task.id), safePart(ctx.batchId), safePart(ctx.runId));
  await mkdir(dir, { recursive: true, mode: 448 });
  const out = [];
  for (const file of checked) {
    const id = `a-${randomUUID()}`;
    const storagePath = join(dir, `${id.slice(2, 10)}-${file.name}`);
    await copyFile(file.original, storagePath);
    out.push({
      id,
      taskId: ctx.task.id,
      batchId: ctx.batchId,
      cardId: ctx.cardId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      name: file.name,
      mime: mimeOf(file.name),
      size: file.size,
      sha256: file.sha,
      createdAt: ctx.at,
      originalPath: file.original,
      storagePath
    });
  }
  return out;
}
var PATH_TOKEN = /(?:`|"|')?(\/[\w\p{L} ._@+~()\[\]-]+(?:\/[\w\p{L} ._@+~()\[\]-]+)*\.[A-Za-z0-9]{1,12})(?:`|"|')?/gu;
async function discoverLegacyArtifacts(task, runs, knownOriginals) {
  let workspace;
  try {
    workspace = await realpath2(task.cwd);
  } catch {
    return [];
  }
  const found = /* @__PURE__ */ new Map();
  for (const run of runs) {
    for (const match of (run.summary ?? "").matchAll(PATH_TOKEN)) {
      const candidate = match[1].trim();
      if (!found.has(candidate)) found.set(candidate, { run, path: candidate });
    }
  }
  const out = [];
  for (const { run, path } of found.values()) {
    try {
      const original = await realpath2(path);
      if (!inside2(original, workspace) || knownOriginals.has(original)) continue;
      const info = await stat2(original);
      if (!info.isFile() || info.size > MAX_CAPTURE_BYTES) continue;
      out.push({
        id: `legacy-${createHash("sha256").update(`${run.id}\0${original}`).digest("hex").slice(0, 24)}`,
        taskId: task.id,
        batchId: run.batchId,
        cardId: run.cardId,
        runId: run.id,
        sessionId: run.sessionId,
        name: safePart(basename2(original)),
        mime: mimeOf(original),
        size: info.size,
        sha256: await sha256(original),
        createdAt: run.endedAt ?? run.startedAt,
        originalPath: original,
        storagePath: original,
        legacy: true
      });
    } catch {
    }
  }
  return out;
}
async function readArtifact(root, task, artifact) {
  const file = await realpath2(artifact.storagePath);
  const allowed = artifact.legacy ? await realpath2(task.cwd) : await realpath2(join(root, "artifacts"));
  if (!inside2(file, allowed)) throw new Error("\u4EA7\u7269\u8DEF\u5F84\u8D8A\u754C");
  const info = await stat2(file);
  if (!info.isFile()) throw new Error("\u4EA7\u7269\u5DF2\u4E0D\u5B58\u5728");
  if (info.size > MAX_BROWSER_BYTES) throw new Error("\u4EA7\u7269\u8D85\u8FC7 8 MiB,\u6682\u4E0D\u80FD\u901A\u8FC7\u6D4F\u89C8\u5668\u8BFB\u53D6");
  return readFile2(file);
}
async function publishHtml(config, artifact, data) {
  if (artifact.mime !== "text/html" && !/\.html?$/i.test(artifact.name)) throw new Error("\u76EE\u524D\u53EA\u5141\u8BB8\u628A HTML \u4EA7\u7269\u53D1\u5E03\u5230\u516C\u7F51");
  return uploadPublicHtml(config, {
    name: artifact.name,
    data,
    path: `dsh-task-console/${safePart(artifact.taskId)}/${safePart(artifact.batchId)}`
  });
}

// src/presets.ts
import { cp, mkdir as mkdir2, readFile as readFile3, readdir, rm, stat as stat3, writeFile, chmod } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename as basename3, join as join2, resolve as resolve3 } from "node:path";
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
function userPresetRoot(home = homedir2()) {
  return join2(process.env.DSH_HOME ?? join2(home, ".dsh"), ".agent-presets");
}
function skillRoots(home = homedir2()) {
  return [
    { root: join2(process.env.DSH_HOME ?? join2(home, ".dsh"), "skills"), label: "user-dsh" },
    { root: join2(process.env.DSH_AGENTS_HOME ?? join2(home, ".agents"), "skills"), label: "user-agents" }
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
async function scanSkills(home = homedir2()) {
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
      const dir = join2(root, name2);
      try {
        if (!(await stat3(dir)).isDirectory()) continue;
        const text = await readFile3(join2(dir, "SKILL.md"), "utf8");
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
  const dir = resolve3(root, spec.id);
  if (!dir.startsWith(resolve3(root) + "/")) throw new Error("\u975E\u6CD5 id");
  await mkdir2(dir, { recursive: true, mode: 448 });
  await chmod(root, 448).catch(() => void 0);
  const preview2 = renderComposition(spec, hostMcp);
  await writeFile(join2(dir, "agent.cordis.yml"), preview2.yml, { mode: 384 });
  await writeFile(join2(dir, "preset.yml"), `name: ${JSON.stringify(spec.name)}
description: ${JSON.stringify(spec.description)}
`, { mode: 384 });
  await writeFile(join2(dir, SPEC_FILE), JSON.stringify(spec, null, 2) + "\n", { mode: 384 });
  const skillsDir = join2(dir, "skills");
  await rm(skillsDir, { recursive: true, force: true });
  if (spec.skills.length) {
    await mkdir2(skillsDir, { recursive: true, mode: 448 });
    for (const name2 of spec.skills) {
      const entry = library.find((s) => s.name === name2) ?? library.find((s) => basename3(s.dir) === name2);
      if (!entry) continue;
      await cp(entry.dir, join2(skillsDir, basename3(entry.dir)), { recursive: true, dereference: true });
    }
  }
  return { path: dir, preview: preview2 };
}
async function readSpec(dir) {
  try {
    return validateSpec(JSON.parse(await readFile3(join2(dir, SPEC_FILE), "utf8")));
  } catch {
    return null;
  }
}
async function removePreset(id, root = userPresetRoot()) {
  if (!ID_RE.test(id)) throw new Error("\u975E\u6CD5 id");
  const dir = resolve3(root, id);
  if (!dir.startsWith(resolve3(root) + "/")) throw new Error("\u975E\u6CD5 id");
  await rm(dir, { recursive: true, force: true });
}

// src/runner.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { dirname as dirname2 } from "node:path";

// src/tasks.ts
import { mkdir as mkdir3, readFile as readFile4 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";

// src/fold.ts
function fold(events) {
  const s = { tasks: /* @__PURE__ */ new Map(), batches: /* @__PURE__ */ new Map(), cards: /* @__PURE__ */ new Map(), runs: /* @__PURE__ */ new Map(), artifacts: /* @__PURE__ */ new Map() };
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
        for (const a of [...s.artifacts.values()]) if (a.taskId === e.taskId) s.artifacts.delete(a.id);
        break;
      }
      case "batch/fired": {
        s.batches.set(e.batch.id, { id: e.batch.id, taskId: e.taskId, firedAt: e.at, by: e.batch.by, cardIds: e.batch.cards.map((c) => c.id) });
        e.batch.cards.forEach((c, i) => s.cards.set(c.id, { ...c, id: c.id, batchId: e.batch.id, taskId: e.taskId, index: i, agentId: c.agentId, brief: c.brief, deps: c.deps, status: c.deps.length ? "todo" : "ready", runIds: [], consecutiveFailures: 0, blockRecurrences: 0 }));
        break;
      }
      case "card/created": {
        const b = s.batches.get(e.batchId);
        if (!b || s.cards.has(e.card.id)) break;
        const index = b.cardIds.length;
        b.cardIds.push(e.card.id);
        s.cards.set(e.card.id, { ...e.card, batchId: e.batchId, taskId: e.taskId, index, status: e.card.deps.length ? "todo" : "ready", runIds: [], consecutiveFailures: 0, blockRecurrences: 0 });
        break;
      }
      case "gate/opened": {
        const c = s.cards.get(e.cardId);
        if (c?.kind === "gate") {
          c.status = "done";
          c.endedAt = e.at;
          c.summary = "Gate opened after its dependencies completed.";
        }
        break;
      }
      case "card/ready": {
        const c = s.cards.get(e.cardId);
        if (c && ["todo", "ready", "blocked"].includes(c.status)) {
          c.status = "ready";
          c.error = void 0;
        }
        break;
      }
      case "run/claimed": {
        const c = s.cards.get(e.cardId);
        if (!c) break;
        s.runs.set(e.runId, { id: e.runId, cardId: c.id, batchId: c.batchId, taskId: e.taskId, attempt: e.attempt, profileId: e.profileId ?? c.agentId, sessionId: e.sessionId, startedAt: e.at, status: "running", nudges: 0 });
        c.runIds.push(e.runId);
        c.currentRunId = e.runId;
        c.status = "running";
        c.startedAt ??= e.at;
        c.error = void 0;
        break;
      }
      case "run/session_created": {
        const r = s.runs.get(e.runId);
        if (r) {
          r.sessionId = e.sessionId;
          r.sessionCreatedAt = e.at;
        }
        break;
      }
      case "run/prompt_dispatched": {
        const r = s.runs.get(e.runId);
        if (r) r.promptDispatchedAt = e.at;
        break;
      }
      case "run/blocked": {
        const r = s.runs.get(e.runId);
        if (!r) break;
        r.status = "blocked";
        r.blockKind = e.kind;
        r.question = e.reason;
        r.terminalBlock = !!e.terminal;
        if (e.terminal) r.endedAt = e.at;
        const c = s.cards.get(r.cardId);
        if (c) {
          c.status = "blocked";
          if (e.terminal && c.currentRunId === r.id) c.currentRunId = void 0;
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
        r.terminalBlock = false;
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
        r.metadata = e.metadata;
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
      case "card/review_approved": {
        const c = s.cards.get(e.cardId);
        if (c && c.status === "review") {
          c.status = "done";
          c.reviewNote = e.note;
          c.endedAt = e.at;
        }
        break;
      }
      case "card/changes_requested": {
        const c = s.cards.get(e.cardId);
        if (c && (c.status === "review" || c.status === "running")) {
          const reviewRun = s.runs.get(e.runId);
          if (reviewRun && !reviewRun.endedAt) {
            reviewRun.status = "done";
            reviewRun.outcome = "changes_requested";
            reviewRun.summary = e.note;
            reviewRun.endedAt = e.at;
          }
          const target = e.targetCardId ? s.cards.get(e.targetCardId) : c;
          if (!target || target.batchId !== c.batchId || target.index > c.index) break;
          for (const affected of s.cards.values()) {
            if (affected.batchId !== c.batchId || affected.index < target.index || affected.index > c.index) continue;
            affected.status = affected.id === target.id ? "ready" : "todo";
            affected.currentRunId = void 0;
            affected.summary = void 0;
            affected.endedAt = void 0;
            affected.error = void 0;
            affected.reviewNote = affected.id === target.id ? e.note : void 0;
          }
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
      case "artifact/registered":
        s.artifacts.set(e.artifact.id, e.artifact);
        break;
      case "artifact/published": {
        const a = s.artifacts.get(e.artifactId);
        if (a) a.publicUrl = e.publicUrl;
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
function batchStatus(s, b) {
  const cards = b.cardIds.map((id) => s.cards.get(id)).filter(Boolean);
  if (cards.some((c) => c.status === "blocked")) return "park";
  if (b.settled) return b.settled.outcome === "done" ? "done" : "bad";
  if (cards.some((c) => c.status === "failed" || c.status === "cancelled")) return "bad";
  if (cards.some((c) => c.status === "review")) return "review";
  if (cards.length && cards.every((c) => c.status === "done")) return "done";
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

// src/hermes-kernel.ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var HERMES_COMPAT_VERSION = "0.20.4";
var DEFAULT_CLAIM_TTL_SECONDS = 900;
var BLOCK_RECURRENCE_LIMIT = 3;
var CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,
  status TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  workspace_kind TEXT NOT NULL DEFAULT 'scratch',
  workspace_path TEXT,
  branch_name TEXT,
  project_id TEXT,
  claim_lock TEXT,
  claim_expires INTEGER,
  tenant TEXT,
  result TEXT,
  idempotency_key TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  worker_pid INTEGER,
  last_failure_error TEXT,
  max_runtime_seconds INTEGER,
  last_heartbeat_at INTEGER,
  current_run_id INTEGER,
  workflow_template_id TEXT,
  current_step_key TEXT,
  skills TEXT,
  model_override TEXT,
  provider_override TEXT,
  reasoning_effort TEXT,
  max_retries INTEGER,
  goal_mode INTEGER NOT NULL DEFAULT 0,
  goal_max_turns INTEGER,
  session_id TEXT,
  block_kind TEXT,
  block_recurrences INTEGER NOT NULL DEFAULT 0,
  node_kind TEXT NOT NULL DEFAULT 'agent',
  round INTEGER,
  role TEXT
);

CREATE TABLE IF NOT EXISTS task_links (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dependency',
  created_at INTEGER,
  PRIMARY KEY (parent_id, child_id)
);

CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  graph_id TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  profile TEXT,
  step_key TEXT,
  status TEXT NOT NULL,
  claim_lock TEXT,
  claim_expires INTEGER,
  worker_pid INTEGER,
  max_runtime_seconds INTEGER,
  last_heartbeat_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  summary TEXT,
  metadata TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_notify_subs (
  task_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  user_id_alt TEXT,
  chat_type TEXT,
  notifier_profile TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'notify',
  delivery_metadata TEXT,
  created_at INTEGER NOT NULL,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, platform, chat_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_links_child ON task_links(child_id);
CREATE INDEX IF NOT EXISTS idx_links_parent ON task_links(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON task_attachments(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notify_task ON kanban_notify_subs(task_id);

-- DSH owns these extensions. The Hermes-compatible tables above remain usable
-- without the DSH task-template and UI layers.
CREATE TABLE IF NOT EXISTS dsh_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dsh_task_specs (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dsh_batches (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  fired_by TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  settled_at INTEGER,
  outcome TEXT
);
CREATE TABLE IF NOT EXISTS dsh_card_bindings (
  card_id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  brief TEXT
);
CREATE TABLE IF NOT EXISTS dsh_run_bindings (
  external_run_id TEXT PRIMARY KEY,
  core_run_id INTEGER NOT NULL UNIQUE,
  session_id TEXT,
  message_id TEXT,
  nudges INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dsh_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  task_id TEXT,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dsh_events_task_seq ON dsh_events(task_id, seq);
`;
var VALID_STATUSES = /* @__PURE__ */ new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"]);
var json = (value) => value === void 0 ? null : JSON.stringify(value);
var parseJson = (value, fallback) => {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
var HermesKernel = class {
  db;
  composeDepth = 0;
  path;
  clock;
  claimer;
  isPidAlive;
  constructor(path, options = {}) {
    this.path = path;
    this.clock = options.now ?? (() => Math.floor(Date.now() / 1e3));
    this.claimer = options.claimer ?? (() => `${hostname()}:${process.pid}:${randomUUID2()}`);
    this.isPidAlive = options.isPidAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    this.db = new Database(path, { timeout: 5e3 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("wal_autocheckpoint = 100");
    this.db.pragma("journal_size_limit = 8388608");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("secure_delete = ON");
    this.db.pragma("busy_timeout = 5000");
    this.prepareLegacyEventTable();
    this.db.exec(CORE_SCHEMA_SQL);
    this.ensureGraphColumns();
    this.db.prepare(`INSERT INTO dsh_meta(key, value) VALUES ('hermes_compat_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(HERMES_COMPAT_VERSION);
  }
  ensureGraphColumns() {
    const ensure = (table, column, ddl) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    ensure("tasks", "node_kind", `node_kind TEXT NOT NULL DEFAULT 'agent'`);
    ensure("tasks", "round", "round INTEGER");
    ensure("tasks", "role", "role TEXT");
    ensure("task_links", "kind", `kind TEXT NOT NULL DEFAULT 'dependency'`);
    ensure("task_links", "created_at", "created_at INTEGER");
    ensure("task_events", "graph_id", "graph_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_graph_id ON task_events(graph_id, id)");
  }
  close() {
    this.db.close();
  }
  /** Move the former one-table store aside before creating Hermes task_events. */
  prepareLegacyEventTable() {
    const table = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events'`).get();
    if (!table) return;
    const columns = this.db.prepare("PRAGMA table_info(task_events)").all().map((row) => row.name);
    if (!columns.includes("payload_json") || columns.includes("kind")) return;
    const hasDestination = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dsh_events'`).get();
    this.write(() => {
      if (!hasDestination) this.db.exec("ALTER TABLE task_events RENAME TO dsh_events");
      else {
        this.db.exec(`INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json)
          SELECT event_type, task_id, occurred_at, payload_json FROM task_events ORDER BY seq`);
        this.db.exec("DROP TABLE task_events");
      }
    });
  }
  write(fn) {
    if (this.db.inTransaction) {
      if (this.composeDepth > 0) return fn();
      throw new Error("HermesKernel.write cannot nest; use compose() for an explicit extension transaction");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  /** Explicitly let DSH extension rows join one core transaction; ordinary nested writes stay forbidden. */
  compose(fn) {
    if (this.db.inTransaction) throw new Error("HermesKernel.compose must start the outer transaction");
    return this.write(() => {
      this.composeDepth++;
      try {
        return fn();
      } finally {
        this.composeDepth--;
      }
    });
  }
  now() {
    return Math.floor(this.clock());
  }
  appendEvent(taskId, kind, payload, runId) {
    const graphId = this.taskRow(taskId)?.tenant ?? null;
    this.db.prepare("INSERT INTO task_events(task_id, run_id, kind, payload, created_at, graph_id) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, runId ?? null, kind, json(payload), this.now(), graphId);
  }
  taskRow(id) {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  }
  getTask(id) {
    return this.taskRow(id);
  }
  listTasks() {
    return this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at, id").all();
  }
  listRuns(taskId) {
    return this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at, id").all(taskId);
  }
  listEvents(taskId) {
    return this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(taskId);
  }
  parentIds(taskId) {
    return this.db.prepare("SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id").all(taskId).map((row) => row.parent_id);
  }
  childIds(taskId) {
    return this.db.prepare("SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id").all(taskId).map((row) => row.child_id);
  }
  createTask(input) {
    if (!input.id.trim() || !input.title.trim()) throw new Error("task id and title are required");
    const requested = input.status ?? "ready";
    if (!VALID_STATUSES.has(requested)) throw new Error(`invalid task status: ${requested}`);
    const parents = [...new Set(input.parents ?? [])];
    if (parents.includes(input.id)) throw new Error("task cannot depend on itself");
    return this.write(() => {
      for (const parent of parents) if (!this.taskRow(parent)) throw new Error(`unknown parent task: ${parent}`);
      const parentsDone = parents.every((parent) => ["done", "archived"].includes(this.taskRow(parent).status));
      const status = requested === "ready" && !parentsDone ? "todo" : requested;
      const now = this.now();
      this.db.prepare(`INSERT INTO tasks(
        id, title, body, assignee, status, priority, created_by, created_at,
        workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries,
        model_override, provider_override, reasoning_effort, node_kind, round, role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id,
        input.title.trim(),
        input.body?.trim() || null,
        input.assignee?.trim() || null,
        status,
        input.priority ?? 0,
        input.createdBy?.trim() || null,
        now,
        input.workspaceKind ?? "dir",
        input.workspacePath?.trim() || null,
        input.tenant?.trim() || null,
        input.maxRuntimeSeconds ?? null,
        input.maxRetries ?? null,
        input.modelOverride?.trim() || null,
        input.providerOverride?.trim() || null,
        input.reasoningEffort?.trim() || null,
        input.nodeKind ?? "agent",
        input.round ?? null,
        input.role?.trim() || null
      );
      for (const parent of parents) this.db.prepare("INSERT INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, ?, ?)").run(parent, input.id, "dependency", now);
      this.appendEvent(input.id, "created", { title: input.title.trim(), assignee: input.assignee ?? null, status, parents, tenant: input.tenant ?? null, node_kind: input.nodeKind ?? "agent", round: input.round ?? null, role: input.role ?? null, created_at: now });
      return this.taskRow(input.id);
    });
  }
  linkTasks(parentId, childId) {
    if (parentId === childId) throw new Error("task cannot depend on itself");
    this.write(() => {
      if (!this.taskRow(parentId) || !this.taskRow(childId)) throw new Error("both tasks must exist");
      const cycle = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT child_id FROM task_links WHERE parent_id = ?
        UNION SELECT l.child_id FROM task_links l JOIN descendants d ON l.parent_id = d.id
      ) SELECT 1 FROM descendants WHERE id = ? LIMIT 1`).get(childId, parentId);
      if (cycle) throw new Error("dependency would create a cycle");
      this.db.prepare("INSERT OR IGNORE INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, ?, ?)").run(parentId, childId, "dependency", this.now());
      this.db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = ? AND status = 'ready'
        AND EXISTS (SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id
          WHERE l.child_id = tasks.id AND p.status NOT IN ('done', 'archived'))`).run(childId);
      this.appendEvent(childId, "linked", { parent_id: parentId });
    });
  }
  /** Gates are durable task rows but never own an agent run. */
  openReadyGates() {
    return this.write(() => {
      const rows = this.db.prepare(`SELECT id FROM tasks WHERE node_kind = 'gate' AND status = 'todo' ORDER BY created_at, id`).all();
      const opened = [];
      for (const row of rows) {
        if (!this.parentsSatisfied(row.id)) continue;
        const now = this.now();
        const cur = this.db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, result = 'gate_opened' WHERE id = ? AND status = 'todo'`).run(now, row.id);
        if (!cur.changes) continue;
        this.appendEvent(row.id, "gate_opened", { status: "done" });
        this.promoteChildren(row.id);
        opened.push(row.id);
      }
      return opened;
    });
  }
  parentsSatisfied(taskId) {
    return !this.db.prepare(`SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id
      WHERE l.child_id = ? AND p.status NOT IN ('done', 'archived') LIMIT 1`).get(taskId);
  }
  promoteChildren(parentId) {
    const children = this.childIds(parentId);
    let promoted = 0;
    for (const childId of children) {
      const cur = this.db.prepare(`UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'
        AND assignee IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id
          WHERE l.child_id = tasks.id AND p.status NOT IN ('done', 'archived')
        )`).run(childId);
      if (cur.changes) {
        this.appendEvent(childId, "promoted");
        promoted++;
      }
    }
    return promoted;
  }
  promoteReadyTasks() {
    return this.write(() => {
      const rows = this.db.prepare(`SELECT id FROM tasks WHERE status = 'todo' AND assignee IS NOT NULL`).all();
      let promoted = 0;
      for (const row of rows) {
        if (!this.parentsSatisfied(row.id)) continue;
        const cur = this.db.prepare(`UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'`).run(row.id);
        if (cur.changes) {
          this.appendEvent(row.id, "promoted");
          promoted++;
        }
      }
      return promoted;
    });
  }
  claimTask(taskId, options = {}) {
    return this.write(() => {
      const source = options.fromReview ? "review" : "ready";
      if (!this.parentsSatisfied(taskId)) {
        const cur2 = this.db.prepare(`UPDATE tasks SET status = 'todo' WHERE id = ? AND status = ? AND claim_lock IS NULL`).run(taskId, source);
        if (cur2.changes) this.appendEvent(taskId, "claim_rejected", { reason: "parents_not_done", source_status: source });
        return void 0;
      }
      const now = this.now();
      const lock = options.claimer ?? this.claimer();
      const expires = now + Math.max(1, options.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS);
      const cur = this.db.prepare(`UPDATE tasks SET status = 'running', claim_lock = ?, claim_expires = ?,
        started_at = COALESCE(started_at, ?), last_heartbeat_at = ?
        WHERE id = ? AND status = ? AND claim_lock IS NULL`).run(lock, expires, now, now, taskId, source);
      if (cur.changes !== 1) return void 0;
      const task = this.taskRow(taskId);
      const inserted = this.db.prepare(`INSERT INTO task_runs(
        task_id, profile, step_key, status, claim_lock, claim_expires,
        max_runtime_seconds, last_heartbeat_at, started_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(
        taskId,
        task.assignee,
        null,
        lock,
        expires,
        task.max_runtime_seconds,
        now,
        now
      );
      const runId = Number(inserted.lastInsertRowid);
      this.db.prepare("UPDATE tasks SET current_run_id = ? WHERE id = ?").run(runId, taskId);
      this.appendEvent(taskId, "claimed", { lock, expires, run_id: runId, ...source === "review" ? { source_status: "review" } : {} }, runId);
      return { task: this.taskRow(taskId), run: this.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId), lock };
    });
  }
  setWorkerPid(taskId, runId, lock, pid) {
    return this.write(() => {
      const cur = this.db.prepare(`UPDATE tasks SET worker_pid = ? WHERE id = ? AND status = 'running'
        AND current_run_id = ? AND claim_lock = ?`).run(pid, taskId, runId, lock);
      if (!cur.changes) return false;
      this.db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ? AND claim_lock = ? AND ended_at IS NULL").run(pid, runId, lock);
      this.appendEvent(taskId, "spawned", { pid }, runId);
      return true;
    });
  }
  heartbeat(taskId, runId, lock, ttlSeconds = DEFAULT_CLAIM_TTL_SECONDS, note) {
    return this.write(() => {
      const now = this.now();
      const expires = now + Math.max(1, ttlSeconds);
      const cur = this.db.prepare(`UPDATE tasks SET claim_expires = ?, last_heartbeat_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ? AND claim_lock = ?`).run(expires, now, taskId, runId, lock);
      if (!cur.changes) return false;
      this.db.prepare(`UPDATE task_runs SET claim_expires = ?, last_heartbeat_at = ?
        WHERE id = ? AND claim_lock = ? AND ended_at IS NULL`).run(expires, now, runId, lock);
      this.appendEvent(taskId, "heartbeat", note ? { note } : void 0, runId);
      return true;
    });
  }
  endRun(taskId, runId, status, outcome, summary, metadata, error) {
    const now = this.now();
    this.db.prepare(`UPDATE task_runs SET status = ?, outcome = ?, summary = COALESCE(?, summary),
      metadata = COALESCE(?, metadata), error = COALESCE(?, error), ended_at = ?,
      claim_lock = NULL, claim_expires = NULL, worker_pid = NULL
      WHERE id = ? AND task_id = ? AND ended_at IS NULL`).run(status, outcome, summary ?? null, json(metadata), error ?? null, now, runId, taskId);
    this.db.prepare("UPDATE tasks SET current_run_id = NULL WHERE id = ? AND current_run_id = ?").run(taskId, runId);
  }
  completeTask(taskId, options = {}) {
    const completed = this.write(() => {
      if (!this.parentsSatisfied(taskId)) return false;
      const task = this.taskRow(taskId);
      if (!task || !["running", "ready", "blocked", "review"].includes(task.status)) return false;
      if (options.expectedRunId !== void 0 && task.current_run_id !== options.expectedRunId) return false;
      const now = this.now();
      const cur = this.db.prepare(`UPDATE tasks SET status = 'done', result = ?, completed_at = ?,
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL, block_kind = NULL,
        block_recurrences = 0, consecutive_failures = 0
        WHERE id = ? AND status IN ('running', 'ready', 'blocked', 'review')
        ${options.expectedRunId === void 0 ? "" : "AND current_run_id = ?"}`).run(options.result ?? null, now, taskId, ...options.expectedRunId === void 0 ? [] : [options.expectedRunId]);
      if (!cur.changes) return false;
      let runId = task.current_run_id;
      if (runId !== null) this.endRun(taskId, runId, "done", "completed", options.summary ?? options.result, options.metadata);
      else if (options.summary || options.result || options.metadata || task.status === "review") {
        const inserted = this.db.prepare(`INSERT INTO task_runs(task_id, profile, status, started_at, ended_at, outcome, summary, metadata)
          VALUES (?, ?, 'done', ?, ?, 'completed', ?, ?)`).run(taskId, task.assignee, now, now, options.summary ?? options.result ?? "Review approved without additional evidence.", json(options.metadata));
        runId = Number(inserted.lastInsertRowid);
      }
      const first = (options.summary ?? options.result ?? "").trim().split(/\r?\n/)[0]?.slice(0, 400);
      this.appendEvent(taskId, "completed", { result_len: options.result?.length ?? 0, summary: first || void 0 }, runId);
      this.promoteChildren(taskId);
      return true;
    });
    return completed;
  }
  requestReview(taskId, options) {
    if (!options.summary.trim()) throw new Error("summary is required");
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || !["running", "ready"].includes(task.status)) return false;
      if (options.expectedRunId !== void 0 && task.current_run_id !== options.expectedRunId) return false;
      const implementer = task.assignee;
      const cur = this.db.prepare(`UPDATE tasks SET status = 'review', assignee = COALESCE(?, assignee),
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL
        WHERE id = ? AND status IN ('running', 'ready')
        ${options.expectedRunId === void 0 ? "" : "AND current_run_id = ?"}`).run(options.reviewer?.trim() || null, taskId, ...options.expectedRunId === void 0 ? [] : [options.expectedRunId]);
      if (!cur.changes) return false;
      let runId = task.current_run_id;
      if (runId !== null) this.endRun(taskId, runId, "review", "review_requested", options.summary, options.metadata);
      else {
        const now = this.now();
        const inserted = this.db.prepare(`INSERT INTO task_runs(task_id, profile, status, started_at, ended_at, outcome, summary, metadata)
          VALUES (?, ?, 'review', ?, ?, 'review_requested', ?, ?)`).run(taskId, implementer, now, now, options.summary, json(options.metadata));
        runId = Number(inserted.lastInsertRowid);
      }
      this.appendEvent(taskId, "review_requested", {
        summary: options.summary.trim().split(/\r?\n/)[0].slice(0, 400),
        implementer,
        reviewer: options.reviewer?.trim() || null
      }, runId);
      return true;
    });
  }
  requestChanges(taskId, options) {
    const reason = options.reason.trim();
    if (!reason) return { ok: false, error: "reason is required" };
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || task.status !== "running" || task.current_run_id !== options.expectedRunId) return { ok: false, error: "task is not in the expected active review run" };
      const claimed = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id DESC LIMIT 1`).get(taskId, options.expectedRunId);
      if (parseJson(claimed?.payload, {}).source_status !== "review") return { ok: false, error: "active run was not claimed from review" };
      const requested = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND kind = 'review_requested' ORDER BY id DESC LIMIT 1`).get(taskId);
      const implementer = parseJson(requested?.payload, {}).implementer;
      if (typeof implementer !== "string" || !implementer.trim()) return { ok: false, error: "review handoff has no implementer provenance" };
      const reviewer = task.assignee;
      const status = this.parentsSatisfied(taskId) ? "ready" : "todo";
      const cur = this.db.prepare(`UPDATE tasks SET status = ?, assignee = ?, claim_lock = NULL,
        claim_expires = NULL, worker_pid = NULL WHERE id = ? AND status = 'running' AND current_run_id = ?`).run(status, implementer, taskId, options.expectedRunId);
      if (!cur.changes) return { ok: false, error: "task changed during review handoff" };
      this.endRun(taskId, options.expectedRunId, status, "changes_requested", reason);
      this.appendEvent(taskId, "changes_requested", { reason, implementer, reviewer, status }, options.expectedRunId);
      return { ok: true, implementer };
    });
  }
  blockTask(taskId, options) {
    if (!options.reason.trim()) throw new Error("reason is required");
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || !["running", "ready"].includes(task.status)) return false;
      if (options.expectedRunId !== void 0 && task.current_run_id !== options.expectedRunId) return false;
      const kind = options.kind ?? null;
      const priorSame = task.block_kind === kind && kind !== null;
      const recurrences = priorSame ? task.block_recurrences + 1 : kind ? 1 : task.block_recurrences;
      const status = kind === "dependency" ? this.parentsSatisfied(taskId) ? "ready" : "todo" : recurrences >= BLOCK_RECURRENCE_LIMIT ? "triage" : "blocked";
      this.db.prepare(`UPDATE tasks SET status = ?, block_kind = ?, block_recurrences = ?,
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ?`).run(status, kind, recurrences, taskId);
      const runId = task.current_run_id;
      if (runId !== null) this.endRun(taskId, runId, status, "blocked", options.reason);
      this.appendEvent(taskId, "blocked", { reason: options.reason, kind, recurrences, status }, runId);
      return true;
    });
  }
  unblockTask(taskId) {
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || !["blocked", "scheduled", "triage"].includes(task.status)) return false;
      const status = this.parentsSatisfied(taskId) && task.assignee ? "ready" : "todo";
      const cur = this.db.prepare(`UPDATE tasks SET status = ? WHERE id = ? AND status IN ('blocked', 'scheduled', 'triage')`).run(status, taskId);
      if (cur.changes) this.appendEvent(taskId, "unblocked", { status });
      return cur.changes === 1;
    });
  }
  cancelTask(taskId, reason = "cancelled") {
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || ["done", "archived"].includes(task.status) || task.current_run_id !== null) return false;
      const cur = this.db.prepare(`UPDATE tasks SET status = 'archived', claim_lock = NULL,
        claim_expires = NULL, worker_pid = NULL WHERE id = ? AND current_run_id IS NULL
        AND status NOT IN ('done', 'archived')`).run(taskId);
      if (cur.changes) this.appendEvent(taskId, "cancelled", { reason });
      return cur.changes === 1;
    });
  }
  giveUpTask(taskId, error) {
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || task.current_run_id !== null || ["done", "archived", "triage"].includes(task.status)) return false;
      const cur = this.db.prepare(`UPDATE tasks SET status = 'triage', last_failure_error = ?,
        claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ?
        AND current_run_id IS NULL AND status NOT IN ('done', 'archived', 'triage')`).run(error, taskId);
      if (cur.changes) this.appendEvent(taskId, "gave_up", { error });
      return cur.changes === 1;
    });
  }
  reclaimTask(taskId, reason = "manual reclaim") {
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || task.status !== "running" || task.current_run_id === null) return false;
      const runId = task.current_run_id;
      const claimed = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id DESC LIMIT 1`).get(taskId, runId);
      const source = parseJson(claimed?.payload, {}).source_status === "review" ? "review" : "ready";
      this.db.prepare(`UPDATE tasks SET status = ?, claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ? AND status = 'running' AND current_run_id = ?`).run(source, taskId, runId);
      this.endRun(taskId, runId, "reclaimed", "reclaimed", void 0, void 0, reason);
      this.appendEvent(taskId, "reclaimed", { manual: true, reason, retry_status: source }, runId);
      return true;
    });
  }
  releaseStaleClaims() {
    const now = this.now();
    const stale = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running' AND claim_expires IS NOT NULL AND claim_expires < ?`).all(now);
    let reclaimed = 0;
    for (const task of stale) {
      if (task.worker_pid && this.isPidAlive(task.worker_pid) && task.last_heartbeat_at && now - task.last_heartbeat_at < 3600) {
        this.write(() => {
          const expires = now + DEFAULT_CLAIM_TTL_SECONDS;
          const cur = this.db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ? AND status = 'running' AND claim_lock IS ? AND claim_expires < ?`).run(expires, task.id, task.claim_lock, now);
          if (cur.changes && task.current_run_id !== null) {
            this.db.prepare("UPDATE task_runs SET claim_expires = ? WHERE id = ?").run(expires, task.current_run_id);
            this.appendEvent(task.id, "claim_extended", { reason: "pid_alive", worker_pid: task.worker_pid, claim_expires_now: expires }, task.current_run_id);
          }
        });
        continue;
      }
      if (this.reclaimTask(task.id, `stale_lock=${task.claim_lock ?? ""}`)) reclaimed++;
    }
    return reclaimed;
  }
  /** Append non-state telemetry (session creation, prompt dispatch, nudge). */
  recordEvent(taskId, kind, payload, runId) {
    if (!this.taskRow(taskId)) throw new Error("task not found");
    this.write(() => this.appendEvent(taskId, kind, payload, runId));
  }
  /** Close an interrupted run and restore the phase it was claimed from. */
  failRun(taskId, options) {
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || task.current_run_id !== options.expectedRunId || !["running", "blocked"].includes(task.status)) return { ok: false };
      const claimed = this.db.prepare(`SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id DESC LIMIT 1`).get(taskId, options.expectedRunId);
      const fromReview = parseJson(claimed?.payload, {}).source_status === "review";
      const retryStatus = this.parentsSatisfied(taskId) ? fromReview ? "review" : "ready" : "todo";
      const failures = task.consecutive_failures + (options.outcome === "cancelled" ? 0 : 1);
      this.db.prepare(`UPDATE tasks SET status = ?, claim_lock = NULL, claim_expires = NULL,
        worker_pid = NULL, current_run_id = NULL, consecutive_failures = ?, last_failure_error = ?
        WHERE id = ? AND current_run_id = ?`).run(retryStatus, failures, options.error ?? options.outcome, taskId, options.expectedRunId);
      const runStatus = options.outcome === "protocol_violation" ? "failed" : options.outcome;
      this.endRun(taskId, options.expectedRunId, runStatus, options.outcome, void 0, void 0, options.error);
      this.appendEvent(taskId, options.outcome, { error: options.error, retry_status: retryStatus }, options.expectedRunId);
      return { ok: true, retryStatus };
    });
  }
  /** Human/UI review extension: reopen one card without fabricating a worker run. */
  reopenForChanges(taskId, options) {
    if (!options.reason.trim()) throw new Error("reason is required");
    return this.write(() => {
      const task = this.taskRow(taskId);
      if (!task || !["done", "review", "ready", "todo"].includes(task.status)) return false;
      const status = options.forceTodo || !this.parentsSatisfied(taskId) ? "todo" : "ready";
      const cur = this.db.prepare(`UPDATE tasks SET status = ?, assignee = COALESCE(?, assignee),
        completed_at = NULL, result = NULL, claim_lock = NULL, claim_expires = NULL,
        worker_pid = NULL, current_run_id = NULL WHERE id = ?`).run(status, options.assignee?.trim() || null, taskId);
      if (!cur.changes) return false;
      this.appendEvent(taskId, "changes_requested", {
        reason: options.reason.trim(),
        status,
        human: true,
        source_task_id: options.sourceTaskId ?? taskId
      });
      return true;
    });
  }
  /** Remove a DSH-owned card and its local history. User-facing delete calls only. */
  deleteTask(taskId) {
    return this.write(() => {
      if (!this.taskRow(taskId)) return false;
      this.db.prepare("DELETE FROM task_links WHERE parent_id = ? OR child_id = ?").run(taskId, taskId);
      this.db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM task_attachments WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      return true;
    });
  }
  addComment(taskId, author, body) {
    if (!this.taskRow(taskId)) throw new Error("task not found");
    return this.write(() => {
      const inserted = this.db.prepare("INSERT INTO task_comments(task_id, author, body, created_at) VALUES (?, ?, ?, ?)").run(taskId, author.trim() || "user", body.trim(), this.now());
      this.appendEvent(taskId, "commented", { author: author.trim() || "user", len: body.trim().length });
      return Number(inserted.lastInsertRowid);
    });
  }
  buildWorkerContext(taskId) {
    const task = this.taskRow(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const cap = (value, limit = 8e3) => {
      const text = String(value ?? "").trim();
      return text.length <= limit ? text : `${text.slice(0, limit)}\u2026 [truncated]`;
    };
    const lines = [`# Kanban task ${task.id}: ${task.title}`, "", `Assignee: ${task.assignee ?? "(unassigned)"}`, `Status:   ${task.status}`, `Workspace: ${task.workspace_kind} @ ${task.workspace_path ?? "(unresolved)"}`, ""];
    if (task.body?.trim()) lines.push("## Body", cap(task.body), "");
    const prior = this.listRuns(taskId).filter((run) => run.ended_at !== null).slice(-8);
    if (prior.length) {
      lines.push("## Prior attempts on this task");
      prior.forEach((run, index) => {
        lines.push(`### Attempt ${index + 1} \u2014 ${run.outcome ?? run.status} (${run.profile ?? "(unknown)"})`);
        if (run.summary) lines.push(cap(run.summary, 4e3));
        if (run.error) lines.push(`_error_: ${cap(run.error, 4e3)}`);
        if (run.metadata) lines.push(`_metadata_: \`${cap(run.metadata, 4e3)}\``);
        lines.push("");
      });
    }
    let wroteParents = false;
    for (const parentId of this.parentIds(taskId)) {
      const parent = this.taskRow(parentId);
      if (!parent || parent.status !== "done") continue;
      const runs = this.listRuns(parentId).filter((run2) => run2.outcome === "completed").sort((a, b) => b.started_at - a.started_at || b.id - a.id);
      const run = runs[0];
      if (!wroteParents) {
        lines.push("## Parent task results");
        wroteParents = true;
      }
      lines.push(`### ${parentId}`, cap(run?.summary || parent.result || "(no result recorded)", 4e3));
      if (run?.metadata) lines.push(`_metadata_: \`${cap(run.metadata, 4e3)}\``);
      lines.push("");
    }
    if (task.assignee) {
      const recent = this.db.prepare(`SELECT t.id, t.title, r.summary FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.profile = ? AND r.task_id <> ? AND r.outcome = 'completed' ORDER BY r.ended_at DESC LIMIT 5`).all(task.assignee, taskId);
      if (recent.length) {
        lines.push(`## Recent work by @${task.assignee}`);
        for (const row of recent) lines.push(`- ${row.id} \u2014 ${row.title}: ${cap(row.summary || "(no summary)", 200)}`);
        lines.push("");
      }
    }
    const comments = this.db.prepare("SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 20").all(taskId);
    if (comments.length) {
      lines.push("## Comment thread");
      for (const comment of comments.reverse()) lines.push(`comment from worker \`${comment.author.replaceAll("`", "")}\`:`, cap(comment.body, 2e3), "");
    }
    return lines.join("\n").trimEnd() + "\n";
  }
};

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
function storeDir(home = homedir3()) {
  return join3(process.env.DSH_HOME ?? join3(home, ".dsh"), "task-console");
}
var EventStore = class {
  events = [];
  state = fold([]);
  queue = Promise.resolve();
  dir;
  _kernel;
  constructor(dir = storeDir()) {
    this.dir = dir;
  }
  get file() {
    return join3(this.dir, "task.db");
  }
  get legacyFile() {
    return join3(this.dir, "events.jsonl");
  }
  get root() {
    return this.dir;
  }
  get kernel() {
    if (!this._kernel) throw new Error("task store \u5C1A\u672A\u52A0\u8F7D");
    return this._kernel;
  }
  async load() {
    await mkdir3(this.dir, { recursive: true, mode: 448 });
    this._kernel = new HermesKernel(this.file);
    const count = Number(this.kernel.db.prepare("SELECT COUNT(*) AS n FROM dsh_events").get().n);
    if (count === 0) await this.importLegacyJsonl();
    const rows = this.kernel.db.prepare("SELECT payload_json FROM dsh_events ORDER BY seq").all();
    this.events = rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload_json)];
      } catch {
        return [];
      }
    });
    this.state = fold(this.events);
    this.backfillCoreProjection();
  }
  /** One-time, read-only import. The JSONL file remains untouched for rollback and audit. */
  async importLegacyJsonl() {
    let text = "";
    try {
      text = await readFile4(this.legacyFile, "utf8");
    } catch {
      return;
    }
    const raw = text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const events = migrate(raw);
    this.kernel.write(() => {
      const insert = this.kernel.db.prepare("INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)");
      for (const event of events) insert.run(event.t, "taskId" in event ? event.taskId : null, event.at, JSON.stringify(event));
    });
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
  /**
   * One-time migration of the pre-0.11 event projection into normalized core
   * rows. The historical DSH events remain untouched and continue to power
   * replay; all new scheduling decisions read `tasks` / `task_runs`.
   */
  backfillCoreProjection() {
    const marker = this.kernel.db.prepare(`SELECT value FROM dsh_meta WHERE key = 'dsh_projection_v1'`).get();
    if (marker) return;
    const st = this.state;
    this.kernel.write(() => {
      const db = this.kernel.db;
      const specStmt = db.prepare(`INSERT OR REPLACE INTO dsh_task_specs(id, spec_json, enabled, created_at) VALUES (?, ?, ?, ?)`);
      for (const spec of st.tasks.values()) specStmt.run(spec.id, JSON.stringify(spec), spec.enabled ? 1 : 0, toEpoch(spec.createdAt));
      const batchStmt = db.prepare(`INSERT OR REPLACE INTO dsh_batches(id, spec_id, fired_by, fired_at, settled_at, outcome) VALUES (?, ?, ?, ?, ?, ?)`);
      const cardStmt = db.prepare(`INSERT OR REPLACE INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`);
      const taskStmt = db.prepare(`INSERT OR IGNORE INTO tasks(
        id, title, body, assignee, status, priority, created_by, created_at, started_at,
        completed_at, workspace_kind, workspace_path, tenant, consecutive_failures,
        max_runtime_seconds, max_retries, block_kind, block_recurrences
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`);
      for (const batch of st.batches.values()) {
        const spec = st.tasks.get(batch.taskId);
        if (!spec) continue;
        batchStmt.run(batch.id, spec.id, batch.by, toEpoch(batch.firedAt), batch.settled ? toEpoch(batch.settled.at) : null, batch.settled?.outcome ?? null);
        for (const cardId of batch.cardIds) {
          const card = st.cards.get(cardId);
          if (!card) continue;
          cardStmt.run(card.id, spec.id, batch.id, card.index, card.brief ?? null);
          taskStmt.run(
            card.id,
            `${spec.title} \xB7 ${card.agentId}`,
            card.brief || spec.brief,
            card.agentId,
            coreStatus(card.status),
            card.index * -1,
            "dsh-task-console",
            toEpoch(batch.firedAt),
            card.startedAt ? toEpoch(card.startedAt) : null,
            card.endedAt ? toEpoch(card.endedAt) : null,
            spec.cwd,
            batch.id,
            card.consecutiveFailures,
            spec.timeoutSec,
            spec.maxTries,
            card.status === "blocked" ? st.runs.get(card.currentRunId ?? "")?.blockKind ?? null : null,
            card.blockRecurrences
          );
        }
        for (const cardId of batch.cardIds) {
          const card = st.cards.get(cardId);
          if (!card) continue;
          for (const parent of card.deps) db.prepare("INSERT OR IGNORE INTO task_links(parent_id, child_id) VALUES (?, ?)").run(parent, card.id);
        }
      }
      const runStmt = db.prepare(`INSERT INTO task_runs(
        task_id, profile, status, started_at, ended_at, outcome, summary, metadata, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const bindStmt = db.prepare(`INSERT OR REPLACE INTO dsh_run_bindings(external_run_id, core_run_id, session_id, message_id, nudges) VALUES (?, ?, ?, ?, ?)`);
      for (const run of st.runs.values()) {
        const card = st.cards.get(run.cardId);
        if (!card) continue;
        const inserted = runStmt.run(card.id, card.agentId, coreRunStatus(run.status), toEpoch(run.startedAt), run.endedAt ? toEpoch(run.endedAt) : null, run.outcome ?? null, run.summary ?? null, run.metadata ? JSON.stringify(run.metadata) : null, run.error ?? null);
        const coreRunId = Number(inserted.lastInsertRowid);
        bindStmt.run(run.id, coreRunId, run.sessionId || null, null, run.nudges);
        if (card.currentRunId === run.id) db.prepare("UPDATE tasks SET current_run_id = ? WHERE id = ?").run(coreRunId, card.id);
      }
      db.prepare(`INSERT INTO dsh_meta(key, value) VALUES ('dsh_projection_v1', ?)`).run((/* @__PURE__ */ new Date()).toISOString());
    });
  }
  applyExtension(e) {
    const db = this.kernel.db;
    switch (e.t) {
      case "task/created":
        db.prepare(`INSERT OR REPLACE INTO dsh_task_specs(id, spec_json, enabled, created_at) VALUES (?, ?, ?, ?)`).run(e.task.id, JSON.stringify(e.task), e.task.enabled ? 1 : 0, toEpoch(e.at));
        break;
      case "task/enabled":
        db.prepare("UPDATE dsh_task_specs SET enabled = ? WHERE id = ?").run(e.enabled ? 1 : 0, e.taskId);
        break;
      case "task/deleted": {
        const cards = db.prepare("SELECT card_id FROM dsh_card_bindings WHERE spec_id = ?").all(e.taskId);
        for (const { card_id } of cards) {
          db.prepare("DELETE FROM task_links WHERE parent_id = ? OR child_id = ?").run(card_id, card_id);
          db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(card_id);
          db.prepare("DELETE FROM task_events WHERE task_id = ?").run(card_id);
          db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(card_id);
          db.prepare("DELETE FROM task_attachments WHERE task_id = ?").run(card_id);
          db.prepare("DELETE FROM tasks WHERE id = ?").run(card_id);
        }
        db.prepare("DELETE FROM dsh_run_bindings WHERE core_run_id NOT IN (SELECT id FROM task_runs)").run();
        db.prepare("DELETE FROM dsh_card_bindings WHERE spec_id = ?").run(e.taskId);
        db.prepare("DELETE FROM dsh_batches WHERE spec_id = ?").run(e.taskId);
        db.prepare("DELETE FROM dsh_task_specs WHERE id = ?").run(e.taskId);
        break;
      }
      case "batch/settled":
        db.prepare("UPDATE dsh_batches SET settled_at = ?, outcome = ? WHERE id = ?").run(toEpoch(e.at), e.outcome, e.batchId);
        break;
      case "run/session_created":
        db.prepare("UPDATE dsh_run_bindings SET session_id = ? WHERE external_run_id = ?").run(e.sessionId, e.runId);
        break;
      case "run/prompt_dispatched":
        db.prepare("UPDATE dsh_run_bindings SET message_id = ? WHERE external_run_id = ?").run(e.messageId, e.runId);
        break;
      case "run/nudged":
        db.prepare("UPDATE dsh_run_bindings SET nudges = nudges + 1 WHERE external_run_id = ?").run(e.runId);
        break;
      case "artifact/registered":
        db.prepare(`INSERT INTO task_attachments(task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.artifact.cardId, e.artifact.name, e.artifact.storagePath, e.artifact.mime, e.artifact.size, e.artifact.sessionId, toEpoch(e.at));
        break;
      default:
        break;
    }
  }
  /** Serialized append: the UI projection is updated only after SQLite commits. */
  append(e) {
    const next = this.queue.then(async () => {
      this.kernel.write(() => {
        this.applyExtension(e);
        this.kernel.db.prepare("INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)").run(e.t, "taskId" in e ? e.taskId : null, e.at, JSON.stringify(e));
      });
      this.events.push(e);
      this.state = fold(this.events);
    });
    this.queue = next.catch(() => void 0);
    return next;
  }
  /** Atomically mutate the normalized core and persist the matching DSH read event. */
  transition(mutate, project) {
    let projected;
    const next = this.queue.then(async () => {
      const result = this.kernel.compose(() => {
        const value = mutate();
        projected = project(value);
        if (projected) {
          this.applyExtension(projected);
          this.kernel.db.prepare("INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)").run(projected.t, "taskId" in projected ? projected.taskId : null, projected.at, JSON.stringify(projected));
        }
        return value;
      });
      if (projected) {
        this.events.push(projected);
        this.state = fold(this.events);
      }
      return result;
    });
    this.queue = next.then(() => void 0, () => void 0);
    return next;
  }
  /** Create executable Hermes rows for one DSH batch, then emit its UI event. */
  async createBatch(task, event) {
    this.kernel.write(() => {
      const db = this.kernel.db;
      db.prepare(`INSERT INTO dsh_batches(id, spec_id, fired_by, fired_at) VALUES (?, ?, ?, ?)`).run(event.batch.id, task.id, event.batch.by, toEpoch(event.at));
      const insertedCards = [];
      for (const [index, card] of event.batch.cards.entries()) {
        db.prepare(`INSERT INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`).run(card.id, task.id, event.batch.id, index, card.brief ?? null);
        const status = card.deps.length ? "todo" : "ready";
        db.prepare(`INSERT INTO tasks(id, title, body, assignee, status, priority, created_by, created_at,
          workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries, node_kind, round, role)
          VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`).run(
          card.id,
          `${task.title} \xB7 ${card.agentId}`,
          [task.brief, card.brief].filter(Boolean).join("\n\n"),
          card.agentId,
          status,
          index * -1,
          toEpoch(event.at),
          task.cwd,
          event.batch.id,
          task.timeoutSec,
          task.maxTries,
          card.kind ?? "agent",
          card.round ?? null,
          card.role ?? null
        );
        const at = toEpoch(event.at);
        db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'created', ?, ?, ?)`).run(card.id, JSON.stringify({ title: `${task.title} \xB7 ${card.role ?? card.agentId}`, body: [task.brief, card.brief].filter(Boolean).join("\n\n"), assignee: card.agentId, status, parents: card.deps, tenant: event.batch.id, node_kind: card.kind ?? "agent", round: card.round ?? null, role: card.role ?? null, created_at: at }), at, event.batch.id);
        for (const parent of card.deps) {
          db.prepare(`INSERT INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, 'dependency', ?)`).run(parent, card.id, at);
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'linked', ?, ?, ?)`).run(card.id, JSON.stringify({ parent_id: parent, kind: "dependency" }), at, event.batch.id);
        }
        insertedCards.push(card.id);
      }
      if (insertedCards.length !== event.batch.cards.length) throw new Error("batch card insert incomplete");
      db.prepare("INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)").run(event.t, event.taskId, event.at, JSON.stringify(event));
    });
    this.events.push(event);
    this.state = fold(this.events);
  }
  /** Materialize one real rework round. Nothing is inferred by the browser. */
  async expandRound(task, batch, planner, summary) {
    if (task.graphMode !== "dynamic-rounds" || planner.role !== "planner" || !planner.round) throw new Error("\u53EA\u6709\u52A8\u6001\u56DE\u5408\u7684\u89C4\u5212\u8005\u80FD\u521B\u5EFA\u4E0B\u4E00\u8F6E");
    const round = planner.round;
    const seeds = [];
    const next = this.queue.then(async () => {
      this.kernel.compose(() => {
        const db = this.kernel.db;
        const active = this.kernel.getTask(planner.id);
        if (!active || active.status !== "running") throw new Error("\u89C4\u5212\u8005\u5DF2\u4E0D\u5728\u8FD0\u884C\u4E2D");
        if (db.prepare("SELECT COUNT(*) AS n FROM task_links WHERE parent_id = ?").get(planner.id).n) throw new Error("\u8FD9\u4E2A\u89C4\u5212\u8005\u5DF2\u7ECF\u521B\u5EFA\u8FC7\u4E0B\u4E00\u8F6E");
        const atIso = (/* @__PURE__ */ new Date()).toISOString();
        const at = toEpoch(atIso);
        const rows = [
          { id: `${batch.id}#g${round}`, agentId: "__gate__", kind: "gate", role: "gate", round, deps: [planner.id], brief: `Round ${round} \u653E\u884C\u95F8\u95E8` },
          { id: `${batch.id}#e${round}`, agentId: task.participants[1].agentId, kind: "agent", role: "executor", round, deps: [`${batch.id}#g${round}`], brief: task.participants[1].brief ?? `\u6267\u884C\u89C4\u5212\u8005\u7ED9\u51FA\u7684\u7B2C ${round} \u8F6E\u65B9\u6848\u3002` },
          { id: `${batch.id}#r${round}`, agentId: task.participants[2].agentId, kind: "agent", role: "reviewer", round, deps: [`${batch.id}#e${round}`], brief: task.participants[2].brief ?? `\u8BC4\u4F30\u7B2C ${round} \u8F6E\u7ED3\u679C\uFF0C\u660E\u786E\u7ED9\u51FA\u901A\u8FC7\u6216\u8FD4\u5DE5\u4F9D\u636E\u3002` },
          { id: `${batch.id}#p${round + 1}`, agentId: task.participants[0].agentId, kind: "agent", role: "planner", round: round + 1, deps: [`${batch.id}#r${round}`], brief: task.participants[0].brief ?? `\u8BFB\u53D6\u7B2C ${round} \u8F6E\u8BC4\u4F30\uFF0C\u51B3\u5B9A\u7ED3\u675F\u6216\u521B\u5EFA\u7B2C ${round + 1} \u8F6E\u3002` }
        ];
        const position = Number(db.prepare("SELECT COALESCE(MAX(position), -1) AS n FROM dsh_card_bindings WHERE batch_id = ?").get(batch.id).n) + 1;
        for (const [offset, row] of rows.entries()) {
          const status = "todo";
          const assignee = row.kind === "gate" ? null : row.agentId;
          const title = `${task.title} \xB7 ${row.role} ${row.round}`;
          db.prepare(`INSERT INTO dsh_card_bindings(card_id, spec_id, batch_id, position, brief) VALUES (?, ?, ?, ?, ?)`).run(row.id, task.id, batch.id, position + offset, row.brief);
          db.prepare(`INSERT INTO tasks(id, title, body, assignee, status, priority, created_by, created_at, workspace_kind, workspace_path, tenant, max_runtime_seconds, max_retries, node_kind, round, role)
            VALUES (?, ?, ?, ?, ?, ?, 'dsh-task-console', ?, 'dir', ?, ?, ?, ?, ?, ?, ?)`).run(row.id, title, [task.brief, row.brief, summary].filter(Boolean).join("\n\n"), assignee, status, -(position + offset), at, task.cwd, batch.id, task.timeoutSec, task.maxTries, row.kind, row.round, row.role);
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'created', ?, ?, ?)`).run(row.id, JSON.stringify({ title, body: [task.brief, row.brief].join("\n\n"), assignee, status, parents: row.deps, tenant: batch.id, node_kind: row.kind, round: row.round, role: row.role, created_at: at }), at, batch.id);
          seeds.push({ t: "card/created", at: atIso, taskId: task.id, batchId: batch.id, card: row });
        }
        for (const row of rows) for (const parent of row.deps) {
          db.prepare(`INSERT INTO task_links(parent_id, child_id, kind, created_at) VALUES (?, ?, 'dependency', ?)`).run(parent, row.id, at);
          db.prepare(`INSERT INTO task_events(task_id, kind, payload, created_at, graph_id) VALUES (?, 'linked', ?, ?, ?)`).run(row.id, JSON.stringify({ parent_id: parent, kind: "dependency" }), at, batch.id);
        }
        const insertEvent = db.prepare("INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)");
        for (const e of seeds) insertEvent.run(e.t, e.taskId, e.at, JSON.stringify(e));
      });
      this.events.push(...seeds);
      this.state = fold(this.events);
    });
    this.queue = next.then(() => void 0, () => void 0);
    return next;
  }
  async openReadyGates() {
    const projected = [];
    const next = this.queue.then(async () => {
      const ids = this.kernel.compose(() => {
        const opened = this.kernel.openReadyGates();
        const insert = this.kernel.db.prepare("INSERT INTO dsh_events(event_type, task_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)");
        for (const cardId of opened) {
          const card = this.state.cards.get(cardId);
          if (!card) continue;
          const e = { t: "gate/opened", at: (/* @__PURE__ */ new Date()).toISOString(), taskId: card.taskId, cardId };
          insert.run(e.t, e.taskId, e.at, JSON.stringify(e));
          projected.push(e);
        }
        return opened;
      });
      if (projected.length) {
        this.events.push(...projected);
        this.state = fold(this.events);
      }
      return ids;
    });
    this.queue = next.then(() => void 0, () => void 0);
    return next;
  }
  graphSnapshot(taskId, batchId) {
    const db = this.kernel.db;
    const batch = db.prepare(`SELECT id, fired_at, settled_at, outcome FROM dsh_batches WHERE id = ? AND spec_id = ?`).get(batchId, taskId);
    if (!batch) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1\u8FD0\u884C");
    const tasks = db.prepare(`SELECT id,title,body,assignee,status,created_at,started_at,completed_at,result,node_kind,round,role,current_run_id FROM tasks WHERE tenant = ? ORDER BY created_at,id`).all(batchId);
    const links = db.prepare(`SELECT l.parent_id,l.child_id,l.kind,l.created_at FROM task_links l JOIN tasks c ON c.id=l.child_id WHERE c.tenant=? ORDER BY COALESCE(l.created_at,0),l.rowid`).all(batchId);
    const runs = db.prepare(`SELECT r.id,b.external_run_id,r.task_id,r.profile,r.status,r.started_at,r.ended_at,r.outcome,r.summary,r.error,b.session_id FROM task_runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN dsh_run_bindings b ON b.core_run_id=r.id WHERE t.tenant=? ORDER BY r.started_at,r.id`).all(batchId);
    const eventRows = db.prepare(`SELECT id,graph_id,task_id,run_id,kind,payload,created_at FROM task_events WHERE graph_id=? ORDER BY id`).all(batchId);
    const events = eventRows.map((row) => ({ ...row, payload: (() => {
      try {
        return row.payload ? JSON.parse(row.payload) : {};
      } catch {
        return {};
      }
    })() }));
    return { graphId: batchId, taskId, batch: { id: batch.id, firedAt: batch.fired_at, settledAt: batch.settled_at, outcome: batch.outcome }, live: { tasks, links, runs }, events };
  }
  async claimCard(cardId, externalRunId, sessionId, attempt, fromReview = false) {
    return this.transition(
      () => this.kernel.claimTask(cardId, { fromReview }),
      (claim) => {
        if (!claim) return void 0;
        this.kernel.db.prepare(`INSERT INTO dsh_run_bindings(external_run_id, core_run_id, session_id) VALUES (?, ?, ?)`).run(externalRunId, claim.run.id, sessionId);
        this.kernel.recordEvent(cardId, "run_bound", { external_run_id: externalRunId, session_id: sessionId }, claim.run.id);
        return { t: "run/claimed", at: new Date(claim.run.started_at * 1e3).toISOString(), taskId: this.state.cards.get(cardId)?.taskId ?? "", cardId, runId: externalRunId, sessionId, attempt, profileId: claim.run.profile ?? void 0 };
      }
    );
  }
  coreRunId(externalRunId) {
    return this.kernel.db.prepare("SELECT core_run_id FROM dsh_run_bindings WHERE external_run_id = ?").get(externalRunId)?.core_run_id;
  }
};
var toEpoch = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1e3) : Math.floor(Date.now() / 1e3);
};
var coreStatus = (status) => status === "failed" ? "blocked" : status === "cancelled" ? "archived" : status;
var coreRunStatus = (status) => status === "cancelled" ? "released" : status;
function cardMessage(task, card, batchId, upstream) {
  const lines = [`# \u4EFB\u52A1:${task.title} \xB7 ${batchId} \xB7 \u7B2C ${card.index + 1}/${task.participants.length} \u5F20\u5361`, "", "[TASK]", task.brief.trim()];
  if (card.brief?.trim()) lines.push("", "[YOUR PART]", card.brief.trim());
  for (const u of upstream) lines.push("", `[UPSTREAM HANDOFF from ${u.agentName}]`, u.summary.trim() || "(\u4E0A\u6E38\u6CA1\u6709\u7559\u4E0B\u4EA4\u63A5\u5355)");
  if (card.reviewNote?.trim()) lines.push("", "[REVIEW CHANGES]", card.reviewNote.trim());
  if (task.graphMode === "dynamic-rounds" && card.role === "planner") {
    lines.push(
      "",
      "[DYNAMIC DAG CONTRACT]",
      card.round === 1 ? "\u4F60\u662F\u521D\u59CB\u89C4\u5212\u8005\u3002\u5B8C\u6210\u65B9\u6848\u540E\u5FC5\u987B\u8C03\u7528 task_plan_round(summary)\uFF1B\u7CFB\u7EDF\u968F\u540E\u624D\u4F1A\u521B\u5EFA\u771F\u5B9E Gate\u3001\u6267\u884C\u8005\u3001\u8BC4\u4F30\u8005\u548C\u4E0B\u4E00\u4F4D\u89C4\u5212\u8005\u8BB0\u5F55\u3002" : "\u4F60\u662F\u56DE\u5408\u51B3\u7B56\u8005\u3002\u7ED3\u5408\u4E0A\u6E38\u8BC4\u4F30\uFF1A\u9700\u8981\u8FD4\u5DE5\u5C31\u8C03\u7528 task_plan_round(summary) \u521B\u5EFA\u65B0\u4E00\u8F6E\u771F\u5B9E\u8BB0\u5F55\uFF1B\u5DF2\u7ECF\u901A\u8FC7\u5C31\u8C03\u7528 task_finalize(summary)\u3002",
      "\u4E0D\u8981\u8C03\u7528 task_complete\uFF1B\u672C\u4F1A\u8BDD\u53EA\u63D0\u4F9B task_plan_round\u3001task_finalize \u548C task_block\u3002"
    );
    return lines.join("\n");
  }
  if (task.graphMode === "dynamic-rounds" && card.role === "executor") lines.push("", "[ROLE]", `\u4F60\u662F\u7B2C ${card.round} \u8F6E\u6267\u884C\u8005\u3002\u4E25\u683C\u6267\u884C\u672C Task body \u4E2D\u7684\u89C4\u5212\uFF0C\u5B8C\u6210\u540E\u8C03\u7528 task_complete\u3002`);
  if (task.graphMode === "dynamic-rounds" && card.role === "reviewer") lines.push("", "[ROLE]", `\u4F60\u662F\u7B2C ${card.round} \u8F6E\u8BC4\u4F30\u8005\u3002\u7ED9\u51FA\u660E\u786E\u901A\u8FC7/\u8FD4\u5DE5\u7ED3\u8BBA\u548C\u4F9D\u636E\uFF0C\u5B8C\u6210\u540E\u8C03\u7528 task_complete\uFF1B\u4E0B\u4E00\u4F4D\u89C4\u5212\u8005\u8D1F\u8D23\u636E\u6B64\u7ED3\u675F\u6216\u521B\u5EFA\u65B0\u4E00\u8F6E\u3002`);
  lines.push(
    "",
    "[CONTRACT]",
    "\u505A\u5B8C\u540E\u5FC5\u987B\u8C03\u7528 task_complete(summary, artifacts, metadata) \u4EA4\u5377;summary \u5199\u300C\u4EA7\u7269 / \u5E72\u4E86\u4EC0\u4E48 / \u4E0B\u6E38\u6CE8\u610F\u300D,\u5B83\u4F1A\u539F\u6837\u4EA4\u7ED9\u4E0B\u4E00\u5F20\u5361\u3002",
    "\u751F\u6210\u4E86\u6587\u4EF6\u65F6,\u5FC5\u987B\u628A\u6587\u4EF6\u8DEF\u5F84\u653E\u8FDB artifacts \u6570\u7EC4;\u7CFB\u7EDF\u4F1A\u4FDD\u5B58\u4E0D\u53EF\u53D8\u526F\u672C\u5E76\u8BA9\u6D4F\u89C8\u5668\u76F4\u63A5\u9884\u89C8\u6216\u4E0B\u8F7D\u3002",
    "\u505A\u5B8C\u4F46\u9700\u8981\u9A8C\u6536\u65F6\u8C03\u7528 task_request_review(summary, artifacts, metadata, reviewer?);\u9A8C\u6536\u901A\u8FC7\u524D\u4E0D\u4F1A\u542F\u52A8\u4E0B\u6E38\u3002\u6307\u5B9A reviewer \u4F1A\u7531\u8BC4\u4F30 Agent \u9886\u53D6\uFF0C\u4E0D\u6307\u5B9A\u5219\u8FDB\u5165\u4EBA\u5DE5\u95F8\u95E8\u3002",
    "\u4F5C\u4E3A\u8BC4\u4F30\u8005\u53D1\u73B0\u95EE\u9898\u65F6\u8C03\u7528 task_request_changes(reason);\u65E7\u8BC4\u5BA1 Run \u4F1A\u5173\u95ED\uFF0C\u539F\u6267\u884C\u8005\u5F97\u5230\u65B0\u7684\u8FD4\u5DE5 Run\u3002",
    '\u62FF\u4E0D\u51C6\u4E14\u4E0D\u53EF\u9006\u7684\u4E8B:\u80FD\u7528 ask_user_question \u5C31\u95EE;\u5426\u5219 task_block(reason, kind="needs_input")\u3002',
    '\u7F3A\u5DE5\u5177\u6216\u6743\u9650\u505A\u4E0D\u4E86:task_block(reason, kind="capability")\u3002',
    "\u4E0D\u8981\u5728\u6CA1\u6709\u8C03\u7528 task_complete \u6216 task_block \u7684\u60C5\u51B5\u4E0B\u7ED3\u675F\u3002"
  );
  return lines.join("\n");
}
var NUDGE = "\u4F60\u505C\u4E0B\u6765\u4E86,\u4F46\u6CA1\u6709\u4EA4\u5377\u3002\u8BF7\u73B0\u5728\u8C03\u7528 task_complete(summary, artifacts) \u4EA4\u5377,\u6216 task_block(reason, kind) \u8BF4\u660E\u4E3A\u4EC0\u4E48\u505A\u4E0D\u4E0B\u53BB\u3002";
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
  const graphMode = s.graphMode === "dynamic-rounds" ? "dynamic-rounds" : "static-chain";
  if (graphMode === "dynamic-rounds" && participants.length !== 3) throw new Error("\u52A8\u6001\u56DE\u5408\u5FC5\u987B\u4F9D\u6B21\u9009\u62E9 3 \u4F4D\u53C2\u4E0E\u8005:\u89C4\u5212\u8005\u3001\u6267\u884C\u8005\u3001\u8BC4\u4F30\u8005");
  return {
    id: String(s.id ?? "") || `T-${Date.now().toString(36)}`,
    title,
    brief,
    trigger,
    participants,
    graphMode,
    cwd: String(s.cwd ?? "").trim() || homedir3(),
    timeoutSec,
    onFail,
    maxTries: onFail === "retry" ? Math.min(Math.max(Number(s.maxTries) || 2, 1), 5) : 1,
    enabled: true,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/worker-tools.ts
var OUT = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, note: { type: "string" } } };
var render = (_args, value) => [{ type: "text", text: JSON.stringify(value) }];
async function registerWorkerTools(agentCtx, hooks, options = {}) {
  const defineTool = process.env.NODE_ENV === "test" ? ((spec) => spec) : (await import("@deepseek-ai/dsh-tools")).defineTool;
  const disposers = [];
  if (!options.planner) disposers.push(agentCtx.tools.register(defineTool({
    name: "task_complete",
    description: "\u4EA4\u5377:\u8FD9\u5F20\u5361\u505A\u5B8C\u4E86\u3002summary \u5199\u300C\u4EA7\u7269 / \u5E72\u4E86\u4EC0\u4E48 / \u4E0B\u6E38\u6CE8\u610F\u300D;\u751F\u6210\u7684\u6587\u4EF6\u8DEF\u5F84\u5FC5\u987B\u653E\u8FDB artifacts,\u7CFB\u7EDF\u4F1A\u4FDD\u5B58\u526F\u672C\u4F9B\u6D4F\u89C8\u5668\u9884\u89C8\u548C\u4E0B\u8F7D\u3002\u8C03\u7528\u540E\u4E0D\u8981\u518D\u505A\u522B\u7684\u3002",
    parameters: {
      summary: { type: "string", required: true, description: "\u4EA4\u63A5\u5355\u6B63\u6587,\u7ED9\u4E0B\u6E38\u770B\u7684\u3002" },
      artifacts: { type: "array", items: { type: "string" }, description: "\u4EA4\u4ED8\u6587\u4EF6\u8DEF\u5F84,\u76F8\u5BF9\u8DEF\u5F84\u6309\u4EFB\u52A1\u5DE5\u4F5C\u533A\u89E3\u6790\u3002\u6CA1\u6709\u6587\u4EF6\u53EF\u7701\u7565\u3002" },
      metadata: { type: "object", additionalProperties: true, description: "\u53EF\u9009\u7684\u7ED3\u6784\u5316\u7ED3\u679C\u6570\u636E\u3002" }
    },
    output: { schema: OUT, render },
    async execute(args) {
      const summary = String(args.summary ?? "").trim();
      if (!summary) return { ok: false, note: "summary \u4E0D\u80FD\u4E3A\u7A7A" };
      const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String) : [];
      await hooks.complete(summary, artifacts, args.metadata);
      return { ok: true, note: artifacts.length ? `\u5DF2\u4EA4\u5377\u5E76\u767B\u8BB0 ${artifacts.length} \u4E2A\u4EA7\u7269\u3002` : "\u5DF2\u4EA4\u5377,\u4E0B\u4E00\u5F20\u5361\u4F1A\u6536\u5230\u8FD9\u4EFD\u4EA4\u63A5\u5355\u3002" };
    }
  })));
  disposers.push(agentCtx.tools.register(defineTool({
    name: "task_block",
    description: "\u505A\u4E0D\u4E0B\u53BB\u65F6\u8C03\u7528\u5E76\u7ED3\u675F\u672C\u6B21\u8FD0\u884C\u3002kind: needs_input=\u9700\u8981\u4EBA\u56DE\u7B54;capability=\u7F3A\u5DE5\u5177\u6216\u6743\u9650;transient=\u4E34\u65F6\u6545\u969C;dependency=\u7B49\u5F85\u5176\u4ED6\u4EFB\u52A1\u3002\u89E3\u9664\u540E\u4F1A\u521B\u5EFA\u65B0\u7684 run\uFF0C\u4E0D\u4F1A\u590D\u6D3B\u65E7 worker\u3002",
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
      return { ok: true, note: "\u5DF2\u8BB0\u5F55\u5E76\u7ED3\u675F\u672C\u6B21\u8FD0\u884C\uFF1B\u89E3\u9664\u963B\u585E\u540E\u4F1A\u521B\u5EFA\u65B0\u7684 run\u3002" };
    }
  })));
  if (!options.planner) disposers.push(agentCtx.tools.register(defineTool({
    name: "task_request_review",
    description: "\u63D0\u4EA4\u540C\u5361\u8BC4\u5BA1\u3002\u6307\u5B9A reviewer \u65F6\u7531\u8BE5 Agent \u521B\u5EFA\u72EC\u7ACB review run\uFF1B\u4E0D\u6307\u5B9A\u65F6\u8FDB\u5165\u4EBA\u5DE5\u9A8C\u6536\u3002\u9A8C\u6536\u901A\u8FC7\u524D\u4E0D\u4F1A\u653E\u884C\u4E0B\u6E38\u3002",
    parameters: {
      summary: { type: "string", required: true, description: "\u4EA4\u63A5\u5355\u6B63\u6587\u3002" },
      artifacts: { type: "array", items: { type: "string" }, description: "\u5F85\u9A8C\u6536\u7684\u4EA4\u4ED8\u6587\u4EF6\u8DEF\u5F84\u3002" },
      metadata: { type: "object", additionalProperties: true, description: "\u53EF\u9009\u7684\u7ED3\u6784\u5316\u7ED3\u679C\u6570\u636E\u3002" },
      reviewer: { type: "string", description: "\u53EF\u9009 reviewer Agent preset id\uFF1B\u7701\u7565\u8868\u793A\u4EBA\u5DE5\u9A8C\u6536\u3002" }
    },
    output: { schema: OUT, render },
    async execute(args) {
      const summary = String(args.summary ?? "").trim();
      if (!summary) return { ok: false, note: "summary \u4E0D\u80FD\u4E3A\u7A7A" };
      const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String) : [];
      await hooks.requestReview(summary, artifacts, args.metadata, String(args.reviewer ?? "").trim() || void 0);
      return { ok: true, note: `\u5DF2\u63D0\u4EA4\u9A8C\u6536${artifacts.length ? `,\u767B\u8BB0 ${artifacts.length} \u4E2A\u4EA7\u7269` : ""}\u3002` };
    }
  })));
  if (!options.planner) disposers.push(agentCtx.tools.register(defineTool({
    name: "task_request_changes",
    description: "\u4EC5\u4F9B\u540C\u5361 reviewer \u4F7F\u7528\uFF1A\u9000\u56DE\u5F53\u524D\u5B9E\u73B0\u5E76\u7ED3\u675F\u672C\u6B21 review run\u3002\u4EFB\u52A1\u4F1A\u6062\u590D\u7ED9\u539F implementer\uFF0C\u8BC4\u5BA1\u610F\u89C1\u8FDB\u5165\u4E0B\u4E00\u6B21 handoff\u3002",
    parameters: { reason: { type: "string", required: true, description: "\u660E\u786E\u3001\u53EF\u6267\u884C\u7684\u8FD4\u5DE5\u539F\u56E0\u3002" } },
    output: { schema: OUT, render },
    async execute(args) {
      const reason = String(args.reason ?? "").trim();
      if (!reason) return { ok: false, note: "reason \u4E0D\u80FD\u4E3A\u7A7A" };
      await hooks.requestChanges(reason);
      return { ok: true, note: "\u5DF2\u9000\u56DE\u539F implementer\uFF1B\u672C\u6B21 review run \u5DF2\u7ED3\u675F\u3002" };
    }
  })));
  if (options.planner) {
    disposers.push(agentCtx.tools.register(defineTool({
      name: "task_plan_round",
      description: "\u89C4\u5212\u8005\u51B3\u5B9A\u7EE7\u7EED\u6216\u8FD4\u5DE5\u65F6\u8C03\u7528\u3002\u7CFB\u7EDF\u4F1A\u5728\u4E00\u4E2A SQLite \u4E8B\u52A1\u91CC\u521B\u5EFA\u771F\u5B9E\u7684 Gate\u3001\u6267\u884C\u8005\u3001\u8BC4\u4F30\u8005\u548C\u4E0B\u4E00\u4F4D\u89C4\u5212\u8005 Task\uFF0C\u5E76\u5199\u5165\u771F\u5B9E task_links\u3002",
      parameters: { summary: { type: "string", required: true, description: "\u672C\u8F6E\u8BA1\u5212\uFF1B\u8FD4\u5DE5\u65F6\u8981\u5305\u542B\u8BC4\u4F30\u610F\u89C1\u548C\u53EF\u6267\u884C\u6539\u52A8\u3002" } },
      output: { schema: OUT, render },
      async execute(args) {
        const summary = String(args.summary ?? "").trim();
        if (!summary) return { ok: false, note: "summary \u4E0D\u80FD\u4E3A\u7A7A" };
        if (!hooks.planRound) return { ok: false, note: "\u5F53\u524D\u4EFB\u52A1\u4E0D\u652F\u6301\u52A8\u6001\u56DE\u5408" };
        await hooks.planRound(summary);
        return { ok: true, note: "\u4E0B\u4E00\u8F6E Task \u4E0E task_links \u5DF2\u5199\u5165\u6570\u636E\u5E93\uFF1B\u89C4\u5212\u8005\u4EA4\u5377\u540E Gate \u624D\u4F1A\u653E\u884C\u3002" };
      }
    })));
    disposers.push(agentCtx.tools.register(defineTool({
      name: "task_finalize",
      description: "\u89C4\u5212\u8005\u786E\u8BA4\u4E0A\u4E00\u8F6E\u901A\u8FC7\u65F6\u8C03\u7528\uFF0C\u7ED3\u675F\u6574\u4E2A\u52A8\u6001 DAG\uFF1B\u4E0D\u4F1A\u865A\u6784\u4E0B\u4E00\u8F6E\u8282\u70B9\u3002",
      parameters: { summary: { type: "string", required: true, description: "\u6279\u51C6\u4F9D\u636E\u548C\u6700\u7EC8\u4EA4\u63A5\u3002" } },
      output: { schema: OUT, render },
      async execute(args) {
        const summary = String(args.summary ?? "").trim();
        if (!summary) return { ok: false, note: "summary \u4E0D\u80FD\u4E3A\u7A7A" };
        if (!hooks.finalize) return { ok: false, note: "\u5F53\u524D\u4EFB\u52A1\u4E0D\u652F\u6301\u7ED3\u675F\u51B3\u7B56" };
        await hooks.finalize(summary);
        return { ok: true, note: "\u52A8\u6001 DAG \u5DF2\u6279\u51C6\u7ED3\u675F\u3002" };
      }
    })));
  }
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
  dispatchSuspended = 0;
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
      if (r.status !== "running" && r.status !== "blocked") continue;
      const coreRunId = this.store.coreRunId(r.id);
      if (coreRunId === void 0) continue;
      await this.store.transition(
        () => this.store.kernel.failRun(r.cardId, { expectedRunId: coreRunId, outcome: "crashed", error: "\u5BBF\u4E3B\u91CD\u542F,\u4F1A\u8BDD\u4E0D\u5728\u4E86" }),
        (result) => result.ok ? { t: "run/crashed", at: this.now(), taskId: r.taskId, runId: r.id, error: "\u5BBF\u4E3B\u91CD\u542F,\u4F1A\u8BDD\u4E0D\u5728\u4E86" } : void 0
      );
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
      this.disarm(f);
      this.stopHeartbeat(f);
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
    if (this.ticking || this.dispatchSuspended > 0) return;
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
    await this.store.openReadyGates();
    const s = this.store.s;
    this.store.kernel.promoteReadyTasks();
    const core = this.store.kernel.listTasks();
    for (const task of core.filter((row) => row.status === "ready")) {
      const card = s.cards.get(task.id);
      if (card?.status === "todo") await this.append({ t: "card/ready", taskId: card.taskId, cardId: card.id });
    }
    let inProgress = core.filter((row) => row.status === "running").length;
    const automatedReview = (cardId) => {
      const event = this.store.kernel.listEvents(cardId).filter((row) => row.kind === "review_requested").at(-1);
      if (!event?.payload) return false;
      try {
        return !!JSON.parse(event.payload).reviewer;
      } catch {
        return false;
      }
    };
    const ready = core.filter((row) => row.status === "ready" || row.status === "review" && automatedReview(row.id)).map((row) => s.cards.get(row.id)).filter(Boolean);
    ready.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.index - b.index);
    for (const c of ready) {
      if (inProgress >= this.maxInProgress) break;
      const task = this.store.tasks.get(c.taskId);
      if (!task) continue;
      const batch = this.store.s.batches.get(c.batchId);
      if (!batch || batch.settled) continue;
      if (c.consecutiveFailures > 0 && (task.onFail !== "retry" || c.consecutiveFailures >= task.maxTries)) {
        const failure = c.error ?? `\u8FDE\u7EED\u5931\u8D25 ${c.consecutiveFailures} \u6B21`;
        await this.store.transition(
          () => this.store.kernel.giveUpTask(c.id, failure),
          (ok) => ok ? { t: "card/gave_up", at: this.now(), taskId: c.taskId, cardId: c.id, error: failure } : void 0
        );
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
        for (const c of cards) if (c.status === "todo" || c.status === "ready") {
          await this.store.transition(
            () => this.store.kernel.cancelTask(c.id, "\u4E0A\u6E38\u5931\u8D25\uFF0C\u4EFB\u52A1\u4E0D\u53EF\u8FBE"),
            (ok) => ok ? { t: "card/cancelled", at: this.now(), taskId: b.taskId, cardId: c.id } : void 0
          );
        }
        const stillLive = cards.some((c) => c.status === "running" || c.status === "blocked");
        if (!stillLive) await this.append({ t: "batch/settled", taskId: b.taskId, batchId: b.id, outcome: dead.some((c) => c.status === "failed") ? "failed" : "cancelled" });
        continue;
      }
      if (cards.every((c) => c.status === "done")) await this.append({ t: "batch/settled", taskId: b.taskId, batchId: b.id, outcome: "done" });
    }
  }
  // ── firing ────────────────────────────────────────────────────────────
  /** Create a batch (one card per participant, chained) and dispatch. */
  async fire(taskId, by) {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    const batchId = `b-${this.clock().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const cards = task.graphMode === "dynamic-rounds" ? [{ id: `${batchId}#p1`, agentId: task.participants[0].agentId, ...task.participants[0].brief ? { brief: task.participants[0].brief } : {}, deps: [], kind: "agent", role: "planner", round: 1 }] : task.participants.map((p, i) => ({ id: `${batchId}#${i}`, agentId: p.agentId, ...p.brief ? { brief: p.brief } : {}, deps: i ? [`${batchId}#${i - 1}`] : [] }));
    await this.store.createBatch(task, { t: "batch/fired", at: this.now(), taskId, batch: { id: batchId, by, cards } });
    const problem = await this.preflight(task);
    if (problem) {
      const first = cards[0];
      const runId = `${first.id}#1`;
      const failure = `\u9884\u68C0\u4E0D\u8FC7:${problem}`;
      const claim = await this.store.claimCard(first.id, runId, "", 1);
      if (claim) {
        await this.store.transition(
          () => this.store.kernel.failRun(first.id, { expectedRunId: claim.run.id, outcome: "failed", error: failure }),
          (result) => result.ok ? { t: "run/failed", at: this.now(), taskId, runId, outcome: "failed", error: failure } : void 0
        );
        await this.store.transition(
          () => this.store.kernel.giveUpTask(first.id, failure),
          (ok) => ok ? { t: "card/gave_up", at: this.now(), taskId, cardId: first.id, error: failure } : void 0
        );
      }
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
      const { stat: stat4 } = await import("node:fs/promises");
      if (!(await stat4(task.cwd)).isDirectory()) return `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728:${task.cwd}`;
    } catch {
      return `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728:${task.cwd}`;
    }
    return null;
  }
  // ── one run ───────────────────────────────────────────────────────────
  async startRun(task, batch, card) {
    const presets = this.ctx.get("agentPresets");
    const coreTask = this.store.kernel.getTask(card.id);
    if (!coreTask || !["ready", "review"].includes(coreTask.status)) return;
    const fromReview = coreTask.status === "review";
    const profileId = coreTask.assignee ?? card.agentId;
    const preset = await presets.resolve(profileId);
    const spec = await readSpec(dirname2(String(preset.path)));
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
    const attempt = this.store.kernel.listRuns(card.id).length + 1;
    const runId = `${card.id}#${attempt}`;
    const sessionId = `task-${task.id}-${batch.id}-${card.index + 1}${attempt > 1 ? `-t${attempt}` : ""}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    this.nameCache.set(profileId, agentName);
    const upstream = [];
    for (const d of card.deps.map((x) => this.store.s.cards.get(x)).filter(Boolean)) upstream.push({ agentName: await this.displayName(d.agentId), summary: d.summary ?? "" });
    const text = `${this.store.kernel.buildWorkerContext(card.id)}
${cardMessage(task, card, batch.id, upstream)}`;
    const messageId = randomUUID3();
    const claim = await this.store.claimCard(card.id, runId, sessionId, attempt, fromReview);
    if (!claim) return;
    const flight = {
      runId,
      cardId: card.id,
      taskId: task.id,
      sessionId,
      messageId,
      consumed: false,
      handle: void 0,
      lastText: "",
      timeoutSec: task.timeoutSec,
      coreRunId: claim.run.id,
      claimLock: claim.lock,
      profileId
    };
    this.flights.set(sessionId, flight);
    this.startHeartbeat(flight);
    try {
      flight.handle = await this.ctx.agents.create({
        sessionId,
        ...selection ? { agentOptions: selection } : {},
        meta: { cwd: task.cwd, agentPreset: preset.id },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id);
        }
      });
      this.store.kernel.recordEvent(card.id, "session_created", { session_id: sessionId }, flight.coreRunId);
      await this.append({ t: "run/session_created", taskId: task.id, runId, sessionId });
      try {
        const submit = async (kind, summary, paths, metadata, reviewer) => {
          if (flight.terminal) throw new Error("\u8FD9\u6B21\u8FD0\u884C\u5DF2\u7ECF\u63D0\u4EA4\u4E86\u7EC8\u6001");
          const at = this.now();
          const captured = await captureArtifacts({ root: this.store.root, task, batchId: batch.id, cardId: card.id, runId, sessionId, at }, paths);
          for (const artifact of captured) await this.append({ t: "artifact/registered", at, taskId: task.id, artifact });
          flight.terminal = { kind, summary, metadata, reviewer };
        };
        flight.disposeTools = await registerWorkerTools(flight.handle.agent.ctx, {
          complete: async (summary, artifacts, metadata) => submit("completed", summary, artifacts, metadata),
          requestReview: async (summary, artifacts, metadata, reviewer) => submit("review", summary, artifacts, metadata, reviewer),
          requestChanges: async (reason) => {
            if (flight.terminal) throw new Error("\u8FD9\u6B21\u8FD0\u884C\u5DF2\u7ECF\u63D0\u4EA4\u4E86\u7EC8\u6001");
            flight.terminal = { kind: "changes", reason };
          },
          block: async (reason, kind) => {
            flight.terminal = { kind: "blocked", reason, blockKind: kind };
          },
          planRound: async (summary) => {
            if (flight.terminal) throw new Error("\u8FD9\u6B21\u8FD0\u884C\u5DF2\u7ECF\u63D0\u4EA4\u4E86\u7EC8\u6001");
            await this.store.expandRound(task, batch, card, summary);
            flight.terminal = { kind: "completed", summary, metadata: { decision: card.round === 1 ? "planned" : "rework", round: card.round } };
          },
          finalize: async (summary) => {
            if (flight.terminal) throw new Error("\u8FD9\u6B21\u8FD0\u884C\u5DF2\u7ECF\u63D0\u4EA4\u4E86\u7EC8\u6001");
            flight.terminal = { kind: "completed", summary, metadata: { decision: "approved", round: card.round } };
          }
        }, { planner: task.graphMode === "dynamic-rounds" && card.role === "planner" });
      } catch (error) {
        console.warn("[task-console] worker tools not registered:", error);
      }
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
      this.store.kernel.recordEvent(card.id, "prompt_dispatched", { message_id: messageId }, flight.coreRunId);
      await this.append({ t: "run/prompt_dispatched", taskId: task.id, runId, messageId });
      this.arm(flight);
    } catch (error) {
      this.flights.delete(sessionId);
      this.stopHeartbeat(flight);
      this.store.kernel.failRun(card.id, { expectedRunId: flight.coreRunId, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
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
  startHeartbeat(f) {
    this.stopHeartbeat(f);
    f.heartbeatTimer = setInterval(() => {
      if (!this.store.kernel.heartbeat(f.cardId, f.coreRunId, f.claimLock, void 0, `session=${f.sessionId}`)) {
        console.warn(`[task-console] heartbeat refused: ${f.cardId} core run ${f.coreRunId}`);
      }
    }, 6e4);
    f.heartbeatTimer.unref?.();
  }
  stopHeartbeat(f) {
    if (f.heartbeatTimer) {
      clearInterval(f.heartbeatTimer);
      f.heartbeatTimer = void 0;
    }
  }
  nameCache = /* @__PURE__ */ new Map();
  async displayName(id) {
    const hit = this.nameCache.get(id);
    if (hit) return hit;
    try {
      const p = await this.ctx.get("agentPresets").resolve(id);
      const spec = await readSpec(dirname2(String(p.path)));
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
      await this.finish(f, "run/completed", "completed", void 0, t.summary, false, t.metadata);
      return;
    }
    if (t?.kind === "review") {
      await this.finish(f, "run/review_requested", "review", void 0, t.summary, false, t.metadata, t.reviewer);
      return;
    }
    if (t?.kind === "changes") {
      await this.finishChanges(f, t.reason ?? "changes requested");
      return;
    }
    if (t?.kind === "blocked") {
      await this.finishBlocked(f, t.reason ?? "blocked", t.blockKind ?? "needs_input");
      return;
    }
    const run = this.store.s.runs.get(f.runId);
    if (run?.status === "blocked") return;
    if ((run?.nudges ?? 0) < 1) {
      await this.append({ t: "run/nudged", taskId: f.taskId, runId: f.runId });
      f.handle.agent.followup({ id: randomUUID3(), role: "user", content: [{ type: "text", text: NUDGE }], source: { kind: "user" } });
      return;
    }
    await this.finish(f, "run/failed", "protocol_violation", "\u505C\u4E86\u4E24\u6B21\u90FD\u6CA1\u6709\u8C03\u7528 task_complete / task_block");
  }
  async finish(f, t, outcome, error, summary, giveUpNow = false, metadata, reviewer) {
    if (!this.flights.has(f.sessionId)) return;
    this.flights.delete(f.sessionId);
    if (f.timer) clearTimeout(f.timer);
    this.stopHeartbeat(f);
    f.disposeTools?.();
    try {
      await f.handle?.dispose?.();
    } catch {
    }
    let changed = false;
    if (t === "run/completed") {
      changed = await this.store.transition(
        () => this.store.kernel.completeTask(f.cardId, { expectedRunId: f.coreRunId, summary: summary ?? f.lastText, metadata }),
        (ok) => ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...metadata ? { metadata } : {} } : void 0
      );
    } else if (t === "run/review_requested") {
      changed = await this.store.transition(
        () => this.store.kernel.requestReview(f.cardId, { expectedRunId: f.coreRunId, summary: summary ?? f.lastText, metadata, reviewer }),
        (ok) => ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, summary: summary ?? f.lastText, ...metadata ? { metadata } : {}, ...reviewer ? { reviewer } : {} } : void 0
      );
    } else {
      const mapped = outcome === "timed_out" ? "timed_out" : outcome === "cancelled" ? "cancelled" : outcome === "protocol_violation" ? "protocol_violation" : "failed";
      const result = await this.store.transition(
        () => {
          const failed = this.store.kernel.failRun(f.cardId, { expectedRunId: f.coreRunId, outcome: mapped, error });
          if (failed.ok && mapped === "cancelled" && !this.store.kernel.cancelTask(f.cardId, error ?? "\u4EBA\u5DE5\u53D6\u6D88")) throw new Error(`\u65E0\u6CD5\u5F52\u6863\u5DF2\u53D6\u6D88\u4EFB\u52A1 ${f.cardId}`);
          return failed;
        },
        (value) => value.ok ? { t, at: this.now(), taskId: f.taskId, runId: f.runId, outcome, error } : void 0
      );
      changed = result.ok;
    }
    if (!changed) {
      console.warn(`[task-console] stale terminal transition refused: ${f.cardId} core run ${f.coreRunId}`);
      await this.tick();
      return;
    }
    if (giveUpNow) {
      const c = this.store.s.cards.get(f.cardId);
      if (c && c.status !== "failed") await this.store.transition(
        () => this.store.kernel.giveUpTask(f.cardId, error ?? outcome),
        (ok) => ok ? { t: "card/gave_up", at: this.now(), taskId: f.taskId, cardId: f.cardId, error: error ?? outcome } : void 0
      );
    }
    await this.tick();
  }
  async finishBlocked(f, reason, kind) {
    if (!this.flights.has(f.sessionId)) return;
    this.flights.delete(f.sessionId);
    if (f.timer) clearTimeout(f.timer);
    this.stopHeartbeat(f);
    f.disposeTools?.();
    try {
      await f.handle?.dispose?.();
    } catch {
    }
    const ok = await this.store.transition(
      () => this.store.kernel.blockTask(f.cardId, { expectedRunId: f.coreRunId, reason, kind }),
      (changed) => changed ? { t: "run/blocked", at: this.now(), taskId: f.taskId, runId: f.runId, kind, reason, terminal: true } : void 0
    );
    if (!ok) console.warn(`[task-console] stale block refused: ${f.cardId} core run ${f.coreRunId}`);
    await this.tick();
  }
  async finishChanges(f, reason) {
    if (!this.flights.has(f.sessionId)) return;
    this.flights.delete(f.sessionId);
    if (f.timer) clearTimeout(f.timer);
    this.stopHeartbeat(f);
    f.disposeTools?.();
    try {
      await f.handle?.dispose?.();
    } catch {
    }
    const result = await this.store.transition(
      () => this.store.kernel.requestChanges(f.cardId, { expectedRunId: f.coreRunId, reason }),
      (value) => value.ok ? { t: "card/changes_requested", at: this.now(), taskId: f.taskId, cardId: f.cardId, runId: f.runId, note: reason, targetCardId: f.cardId, reviewer: f.profileId } : void 0
    );
    if (!result.ok) console.warn(`[task-console] request_changes refused: ${result.error}`);
    await this.tick();
  }
  async cancelBatch(batchId) {
    const b = this.store.s.batches.get(batchId);
    if (!b) return;
    this.dispatchSuspended++;
    try {
      for (const f of [...this.flights.values()]) {
        const r = this.store.s.runs.get(f.runId);
        if (r?.batchId === batchId) await this.finish(f, "run/cancelled", "cancelled", "\u4EBA\u5DE5\u53D6\u6D88");
      }
      for (const id of b.cardIds) {
        const c = this.store.s.cards.get(id);
        if (c && (c.status === "todo" || c.status === "ready" || c.status === "review")) await this.store.transition(
          () => this.store.kernel.cancelTask(id, "\u4EBA\u5DE5\u53D6\u6D88\u6279\u6B21"),
          (ok) => ok ? { t: "card/cancelled", at: this.now(), taskId: b.taskId, cardId: id } : void 0
        );
      }
      if (!this.store.s.batches.get(batchId)?.settled) await this.append({ t: "batch/settled", taskId: b.taskId, batchId, outcome: "cancelled" });
    } finally {
      this.dispatchSuspended--;
    }
    await this.tick();
  }
  /** Resolve the explicit human review gate for one card. */
  async reviewCard(cardId, decision, note = "", targetCardId) {
    const card = this.store.s.cards.get(cardId);
    if (!card || card.status !== "review" || !card.currentRunId && !card.runIds.length) throw new Error("\u8FD9\u5F20\u5361\u4E0D\u5728\u5F85\u9A8C\u6536\u72B6\u6001");
    const runId = card.runIds[card.runIds.length - 1];
    if (decision === "approve") {
      const ok = await this.store.transition(
        () => this.store.kernel.completeTask(cardId, { summary: note.trim() || "Human review approved.", metadata: { approval: "human" } }),
        (changed) => changed ? { t: "card/review_approved", at: this.now(), taskId: card.taskId, cardId, runId, ...note.trim() ? { note: note.trim() } : {} } : void 0
      );
      if (!ok) throw new Error("\u6838\u5FC3\u4EFB\u52A1\u72B6\u6001\u5DF2\u7ECF\u53D8\u5316\uFF0C\u65E0\u6CD5\u6279\u51C6");
    } else {
      if (!note.trim()) throw new Error("\u9000\u56DE\u4FEE\u6539\u65F6\u5FC5\u987B\u5199\u660E\u539F\u56E0");
      const target = this.store.s.cards.get(targetCardId ?? card.deps[0] ?? card.id);
      if (!target || target.batchId !== card.batchId || target.index > card.index) throw new Error("\u8FD4\u5DE5\u76EE\u6807\u5FC5\u987B\u662F\u540C\u4E00\u8FD0\u884C\u4E2D\u5F53\u524D\u89D2\u8272\u6216\u5B83\u7684\u4E0A\u6E38");
      const affected = [...this.store.s.cards.values()].filter((row) => row.batchId === card.batchId && row.index >= target.index && row.index <= card.index).sort((a, b) => a.index - b.index);
      await this.store.transition(
        () => {
          for (const row of affected) {
            const ok = this.store.kernel.reopenForChanges(row.id, {
              reason: note.trim(),
              assignee: row.agentId,
              forceTodo: row.id !== target.id,
              sourceTaskId: card.id
            });
            if (!ok) throw new Error(`\u65E0\u6CD5\u91CD\u5F00\u6838\u5FC3\u4EFB\u52A1 ${row.id}`);
          }
          return true;
        },
        () => ({ t: "card/changes_requested", at: this.now(), taskId: card.taskId, cardId, runId, note: note.trim(), targetCardId: target.id })
      );
    }
    await this.tick();
  }
  /** Hermes unblock semantics: a blocked run stays closed and a new run is claimed. */
  async unblockCard(cardId) {
    const card = this.store.s.cards.get(cardId);
    if (!card || card.status !== "blocked") throw new Error("\u8FD9\u5F20\u5361\u4E0D\u5728\u963B\u585E\u72B6\u6001");
    const ok = await this.store.transition(
      () => this.store.kernel.unblockTask(cardId),
      (changed) => changed && this.store.kernel.getTask(cardId)?.status === "ready" ? { t: "card/ready", at: this.now(), taskId: card.taskId, cardId } : void 0
    );
    if (!ok) throw new Error("\u6838\u5FC3\u4EFB\u52A1\u72B6\u6001\u5DF2\u7ECF\u53D8\u5316\uFF0C\u65E0\u6CD5\u89E3\u9664\u963B\u585E");
    await this.tick();
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
  ["taskSnapshot", 1],
  ["taskGraph", 1],
  ["taskArtifacts", 1],
  ["artifactContent", 1],
  ["publishArtifact", 1],
  ["reviewCard", 1],
  ["unblockCard", 1],
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
      const dir = dirname3(String(p.path));
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
    const spec = await readSpec(dirname3(String(preset.path)));
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
    const done = new Promise((resolve4) => {
      finish = resolve4;
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
        meta: { cwd: homedir4(), agentPreset: preset.id },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id);
        }
      });
      messageId = randomUUID4();
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
    const spec = await readSpec(dirname3(String(preset.path)));
    const name2 = spec?.name ?? preset.name ?? preset.id;
    let selection = this.defaultModel();
    if (spec?.model?.includes("/")) {
      const [provider, ...rest] = spec.model.split("/");
      selection = { provider, model: rest.join("/"), ...spec.effort ? { reasoningEffort: spec.effort } : {} };
    }
    const workspaces = this.workspaces();
    const dir = cwd && cwd.trim() ? cwd.trim() : workspaces[0]?.path ?? homedir4();
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
    if (text && text.trim()) handle.agent.followup({ id: randomUUID4(), role: "user", content: [{ type: "text", text: text.trim() }], source: { kind: "user" } });
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
        const status = c.status === "done" ? "done" : c.status === "review" ? "review" : c.status === "running" ? "running" : c.status === "blocked" ? "blocked" : c.status === "failed" ? r?.status === "timed_out" ? "timed_out" : r?.status === "crashed" ? "lost" : "failed" : c.status === "cancelled" ? "cancelled" : "queued";
        return { agentId: c.kind === "gate" ? "\u7CFB\u7EDF\u95F8\u95E8" : c.agentId, status, tries: c.runIds.length, sessionId: r?.sessionId || void 0, startedAt: c.startedAt, endedAt: c.endedAt, handoff: c.summary, question: r?.status === "blocked" ? r.question : void 0, error: c.error };
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
      const spec = p.trust === "user" ? await readSpec(dirname3(String(p.path))) : null;
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
      const spec = p.trust === "user" ? await readSpec(dirname3(String(p.path))) : null;
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
    return JSON.stringify(this.runner.store.all().filter((e) => e.taskId === id).map((e) => e.t === "artifact/registered" ? { ...e, artifact: this.artifactView(e.artifact) } : e));
  }
  /** Initial detail payload in one round trip; live polling stays event-only afterwards. */
  async taskSnapshot(payload) {
    const { id, batchId } = JSON.parse(payload);
    const events = this.runner.store.all().filter((e) => e.taskId === id).map((e) => e.t === "artifact/registered" ? { ...e, artifact: this.artifactView(e.artifact) } : e);
    if (!this.runner.store.s.tasks.has(id)) return JSON.stringify({ events, artifacts: [], batchId: null });
    const selected = batchId ?? [...this.runner.store.s.batches.values()].filter((batch) => batch.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]?.id;
    const artifacts = selected ? (await this.artifactsFor(id, selected)).map((a) => this.artifactView(a)) : [];
    return JSON.stringify({ events, artifacts, batchId: selected ?? null });
  }
  /** Raw normalized rows plus the canonical event log for DB-faithful replay. */
  async taskGraph(payload) {
    const { id, batchId } = JSON.parse(payload);
    if (!this.runner.store.s.tasks.has(id)) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    const selected = batchId ?? [...this.runner.store.s.batches.values()].filter((batch) => batch.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]?.id;
    if (!selected) throw new Error("\u8FD9\u4E2A\u4EFB\u52A1\u8FD8\u6CA1\u6709\u8FD0\u884C");
    return JSON.stringify(this.runner.store.graphSnapshot(id, selected));
  }
  artifactView(a) {
    const { storagePath: _storagePath, ...view } = a;
    return view;
  }
  async artifactsFor(taskId, batchId) {
    const task = this.runner.store.s.tasks.get(taskId);
    if (!task) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    const registered = [...this.runner.store.s.artifacts.values()].filter((a) => a.taskId === taskId && (!batchId || a.batchId === batchId));
    const runs = [...this.runner.store.s.runs.values()].filter((r) => r.taskId === taskId && (!batchId || r.batchId === batchId));
    const legacy = await discoverLegacyArtifacts(task, runs, new Set(registered.map((a) => a.originalPath)));
    return [...registered, ...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async taskArtifacts(payload) {
    const { id, batchId } = JSON.parse(payload);
    return JSON.stringify((await this.artifactsFor(id, batchId)).map((a) => this.artifactView(a)));
  }
  async artifactContent(payload) {
    const { id, batchId, artifactId } = JSON.parse(payload);
    const task = this.runner.store.s.tasks.get(id);
    if (!task) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1");
    const artifact = (await this.artifactsFor(id, batchId)).find((a) => a.id === artifactId);
    if (!artifact) throw new Error("\u6CA1\u6709\u8FD9\u4E2A\u4EA7\u7269");
    const data = await readArtifact(this.runner.store.root, task, artifact);
    return JSON.stringify({ artifact: this.artifactView(artifact), base64: data.toString("base64") });
  }
  async publishArtifact(payload) {
    const { id, artifactId } = JSON.parse(payload);
    const task = this.runner.store.s.tasks.get(id);
    const artifact = this.runner.store.s.artifacts.get(artifactId);
    if (!task || !artifact || artifact.taskId !== id) throw new Error("\u53EA\u80FD\u53D1\u5E03\u5DF2\u767B\u8BB0\u5E76\u4FDD\u5B58\u5FEB\u7167\u7684\u4EA7\u7269");
    const token = process.env.DSH_TASK_CONSOLE_UPLOAD_TOKEN ?? process.env.UPLOAD_R2_TOKEN ?? "";
    if (!token) throw new Error("\u5BBF\u4E3B\u672A\u914D\u7F6E DSH_TASK_CONSOLE_UPLOAD_TOKEN,\u4E0D\u80FD\u53D1\u5E03\u516C\u7F51\u94FE\u63A5");
    const data = await readArtifact(this.runner.store.root, task, artifact);
    const publicUrl = await publishHtml({
      endpoint: process.env.DSH_TASK_CONSOLE_UPLOAD_URL ?? process.env.UPLOAD_R2_URL ?? "https://upload-r2.vyibc.com",
      domain: process.env.DSH_TASK_CONSOLE_PUBLIC_DOMAIN ?? process.env.UPLOAD_R2_DOMAIN ?? "https://resource.vyibc.com",
      token
    }, artifact, data);
    await this.runner.store.append({ t: "artifact/published", at: (/* @__PURE__ */ new Date()).toISOString(), taskId: id, artifactId, publicUrl });
    return JSON.stringify({ publicUrl });
  }
  async reviewCard(payload) {
    const { cardId, decision, note, targetCardId } = JSON.parse(payload);
    if (decision !== "approve" && decision !== "changes") throw new Error("\u4E0D\u652F\u6301\u7684\u9A8C\u6536\u51B3\u5B9A");
    await this.runner.reviewCard(cardId, decision, note, targetCardId);
    return JSON.stringify({ ok: true });
  }
  async unblockCard(payload) {
    const { cardId } = JSON.parse(payload);
    if (!cardId?.trim()) throw new Error("\u7F3A\u5C11 cardId");
    await this.runner.unblockCard(cardId);
    return JSON.stringify({ ok: true });
  }
  /** What one agent has been doing: cards, last run, tasks it takes part in. */
  async agentActivity(payload) {
    const { agentId } = JSON.parse(payload);
    const st = this.runner.store.s;
    const cards = [...st.cards.values()].filter((c) => c.agentId === agentId);
    const runs = cards.flatMap((c) => c.runIds.map((id) => st.runs.get(id)).filter(Boolean));
    const last = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const tasks = [...st.tasks.values()].filter((t) => t.participants.some((p) => p.agentId === agentId)).map((t) => ({ id: t.id, title: t.title }));
    const done = cards.filter((c) => c.status === "done").length;
    const failed = cards.filter((c) => c.status === "failed").length;
    return JSON.stringify({ cards: cards.length, done, failed, runs: runs.length, lastRunAt: last?.startedAt ?? null, lastOutcome: last?.outcome ?? last?.status ?? null, tasks });
  }
};

// src/index.ts
var name = "task-console";
var inject = ["loader", "tools", "agents"];
async function apply(ctx) {
  await ctx.plugin(TaskConsoleService);
  ctx.effect(() => registerPublicHtmlTool(ctx), "task-console: public HTML publisher");
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
