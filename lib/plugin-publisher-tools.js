// src/plugin-publisher.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
var PACKAGE_ID = "plugins_6ac15b9d3e4c8191b2f6ff943d1e574d";
var APP_ID = "asdk_app_6ac1f14048b88191a1aa282f102f65f6";
var PUBLISH_TARGETS = {
  "vyibc-personal-content": { packageId: PACKAGE_ID, appId: APP_ID },
  "vyibc-flow-video-studio": { packageId: "plugins_6ac374b9d988819187fc2677405e443d", appId: "" }
};
function targetFor(snapshot) {
  const target = PUBLISH_TARGETS[snapshot.packageName];
  requireValue(target && snapshot.packageId === target.packageId && snapshot.appId === target.appId, "identity_mismatch");
  return target;
}
var FILES = ["plugin.json", ".codex-plugin/plugin.json", ".app.json", "mcp.json", ".mcp.json", "skills/personal-content/SKILL.md"];
var fail = (code) => {
  throw new Error(code);
};
var requireValue = (ok, code) => {
  if (!ok) fail(code);
};
var publisherToken = (token) => createHmac("sha256", token).update("fleet-hub-plugin-publisher-v1").digest("hex");
function publisherRuntimeConfig(effective = {}) {
  const config = { "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false, "features.skill_mcp_dependency_install": false, web_search: "disabled", "apps._default.enabled": false, "apps.connector_openai_plugin_creator.enabled": true, "apps.connector_openai_plugin_creator.default_tools_enabled": false, "apps.connector_openai_plugin_creator.tools.update_plugin.enabled": true, "apps.connector_openai_plugin_creator.tools.get_plugin_files.enabled": true, "apps.connector_openai_plugin_creator.tools.get_owned_plugin_archive.enabled": true };
  for (const name2 of Object.keys(effective.mcp_servers || {})) config["mcp_servers." + name2 + ".enabled"] = false;
  for (const name2 of Object.keys(effective.apps || {})) if (!["_default", "connector_openai_plugin_creator"].includes(name2)) config["apps." + name2 + ".enabled"] = false;
  return config;
}
function verifyUploadInvocation(item, archive, expected, packageId = PACKAGE_ID) {
  requireValue(item?.type === "mcpToolCall" && item.server === "codex_apps" && item.tool === "plugin_creator.update_plugin", "verification_failed");
  const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
  requireValue(args?.plugin_id === packageId && args.archive === archive && args.expected_release_id === expected && Object.keys(args).length === 3, "verification_failed");
  requireValue(item.status === "completed" && !item.error && !item.result?.isError, "publisher_unavailable");
}
function uploadTurnRequest(archive, expected, packageId = PACKAGE_ID) {
  const args = { plugin_id: packageId, archive, expected_release_id: expected };
  return 'Use functions.exec to run exactly this JavaScript. Resolve the executable name from ALL_TOOLS; do not guess a namespace. const matches = ALL_TOOLS.filter(t => /plugin_creator.*update_plugin$/.test(t.name)); if (matches.length !== 1) throw new Error("publisher_tool_not_found"); text(await tools[matches[0].name](' + JSON.stringify(args) + ")); The archive is owner-approved and immutable. Call that external tool exactly once. Do not call any other external tool, change arguments, create files, or retry. Report its result and stop.";
}
async function openPluginCreator(binary = join(homedir(), ".local/bin/codex"), packageId = PACKAGE_ID) {
  requireValue(Object.values(PUBLISH_TARGETS).some((t) => t.packageId === packageId), "identity_mismatch");
  const env = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let serial = 0, ended = false, exited = false;
  let observeTurn;
  const pending = /* @__PURE__ */ new Map();
  const send = (value) => {
    if (!ended) child.stdin.write(JSON.stringify(value) + "\n");
  };
  const rejectAll = () => {
    ended = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("publisher_unavailable"));
    }
    pending.clear();
  };
  child.on("error", rejectAll);
  child.on("exit", () => {
    exited = true;
    rejectAll();
  });
  child.stdin.on("error", rejectAll);
  const lifetime = setTimeout(() => {
    rejectAll();
    child.kill("SIGTERM");
  }, 24e4);
  lifetime.unref();
  child.stderr.on("data", () => {
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.length > 4 * 1024 * 1024) {
      rejectAll();
      child.kill();
      return;
    }
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method && m.id != null) {
      send({ id: m.id, error: { code: -32601, message: "Interactive requests are not supported by the bounded publisher." } });
      return;
    }
    if (m.method) observeTurn?.(m);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error("publisher_unavailable"));
    else p.resolve(m.result);
  });
  const rpc = (method, params, timeout = 7e4) => new Promise((resolve, reject) => {
    if (ended) return reject(new Error("publisher_unavailable"));
    const id = ++serial, timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("publisher_unavailable"));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const close = async () => {
    clearTimeout(lifetime);
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
    if (!exited) await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2e3);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rejectAll();
  };
  try {
    await rpc("initialize", { clientInfo: { name: "fleet_private_plugin_publisher", title: "Fleet Private Plugin Publisher", version: "0.1.0" }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
    send({ method: "initialized", params: {} });
    const account = await rpc("account/read", { refreshToken: false });
    requireValue(account.account?.type === "chatgpt", "authorization_required");
    const effective = await rpc("config/read", { includeLayers: false });
    const started = await rpc("thread/start", { cwd: tmpdir(), ephemeral: true, sandbox: "read-only", approvalPolicy: "never", model: "gpt-5.6-terra", config: publisherRuntimeConfig(effective.config), baseInstructions: "You perform only the exact owner-approved Plugin Creator update requested. No shell, browsing, file changes, retries, plugin creation, or other operations.", developerInstructions: "The archive is immutable and prevalidated. Invoke the specified update_plugin once with the exact three arguments. Do not inspect or modify other files or plugins. Report the tool outcome and stop. Do not claim success without the tool result." });
    const threadId = started.thread.id;
    const apps = await rpc("app/installed", { threadId, forceRefresh: true });
    requireValue(apps.apps?.some((a) => a.id === "connector_openai_plugin_creator" && a.isEnabled !== false && a.isCallable !== false), "authorization_required");
    const found = /* @__PURE__ */ new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const inventory = await rpc("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", limit: 100, ...cursor ? { cursor } : {} });
      for (const server of inventory.data || []) if (server.name === "codex_apps") for (const [key, t] of Object.entries(server.tools || {})) found.add(t.name || key);
      cursor = inventory.nextCursor;
      if (!cursor) break;
    }
    const readTool = "plugin_creator.get_plugin_files", updateTool = "plugin_creator.update_plugin";
    const archiveTool = "plugin_creator.get_owned_plugin_archive";
    requireValue(found.has(readTool) && found.has(updateTool) && found.has(archiveTool), "authorization_required");
    const call = async (tool, args) => {
      const raw = await rpc("mcpServer/tool/call", { threadId, server: "codex_apps", tool, arguments: args }, 9e4);
      const result = raw.result ?? raw;
      requireValue(!result.isError, "publisher_unavailable");
      let value = result.structuredContent;
      if (!value) {
        for (const c of result.content || []) if (c.type === "text") {
          try {
            value = JSON.parse(c.text);
            break;
          } catch {
          }
        }
      }
      requireValue(value, "publisher_unavailable");
      return value.result ?? value;
    };
    const update = async (archive, expected) => {
      const invocations = [];
      let resolveTurn, rejectTurn;
      const done = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      void done.catch(() => {
      });
      const timer = setTimeout(() => rejectTurn(new Error("publisher_unavailable")), 12e4);
      observeTurn = (m) => {
        if (m.params?.threadId !== threadId) return;
        if (m.method === "item/completed" && m.params.item?.type === "mcpToolCall") invocations.push(m.params.item);
        if (m.method === "turn/completed") m.params.turn?.status === "completed" ? resolveTurn() : rejectTurn(new Error("publisher_unavailable"));
      };
      try {
        await rpc("turn/start", { threadId, effort: "low", input: [{ type: "text", text: uploadTurnRequest(archive, expected, packageId) }, { type: "mention", name: "Plugin Creator", path: "app://connector_openai_plugin_creator" }] });
        await done;
        console.info("[plugin-publisher] native upload receipt", JSON.stringify({ calls: invocations.map((item) => ({ server: item.server, tool: item.tool, status: item.status, error: Boolean(item.error || item.result?.isError) })) }));
        requireValue(invocations.length === 1, "verification_failed");
        verifyUploadInvocation(invocations[0], archive, expected, packageId);
      } finally {
        clearTimeout(timer);
        observeTurn = void 0;
        done.catch(() => {
        });
      }
    };
    const read = async (paths = FILES, binaryPaths = []) => {
      const hasApp = Object.values(PUBLISH_TARGETS).find((t) => t.packageId === packageId)?.appId;
      const result = await call(readTool, { plugin_id: packageId, read_paths: FILES.slice(0, 5).filter((path) => hasApp || path !== ".app.json") });
      let offset = result.next_offset;
      for (let page = 0; offset != null && page < 20; page++) {
        const next = await call(readTool, { plugin_id: packageId, offset });
        requireValue(next.plugin.current_release_id === result.plugin.current_release_id, "platform_conflict");
        result.files.push(...next.files);
        offset = next.next_offset;
      }
      requireValue(offset == null && result.files.length <= 250, "source_changed");
      const available = new Set(result.files.map((f) => f.path));
      const texts = paths.filter((p) => available.has(p) && !binaryPaths.includes(p) && !Object.hasOwn(result.contents, p));
      for (let i = 0; i < texts.length; i += 10) {
        const next = await call(readTool, { plugin_id: packageId, read_paths: texts.slice(i, i + 10) });
        requireValue(next.plugin.current_release_id === result.plugin.current_release_id, "platform_conflict");
        Object.assign(result.contents, next.contents);
      }
      if (binaryPaths.length) {
        const owned = await call(archiveTool, { plugin_id: packageId, release_id: result.plugin.current_release_id });
        requireValue(owned.plugin.plugin_id === packageId && owned.release.release_id === result.plugin.current_release_id, "identity_mismatch");
        const url = new URL(owned.download_url);
        requireValue(url.protocol === "https:" && url.hostname.endsWith(".oaiusercontent.com") && !url.username && !url.password && !url.port, "verification_failed");
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2e4) });
        requireValue(response.ok, "verification_failed");
        result.binaryContents = ownedTarFiles(await bytes(response, 8 * 1024 * 1024), binaryPaths.filter((path) => available.has(path)));
      }
      return result;
    };
    return { read, update, close };
  } catch (error) {
    await close();
    throw error;
  }
}
function sameText(path, a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (path.endsWith(".json")) {
    try {
      const normalized = (text) => {
        const value = JSON.parse(text);
        if (path === ".mcp.json") for (const server of Object.values(value.mcpServers || {})) {
          if (server.type === "http") server.type = "streamable-http";
          if (server.headers && Object.keys(server.headers).length === 0) delete server.headers;
        }
        if (path === ".codex-plugin/plugin.json") {
          if (typeof value.skills === "string") value.skills = value.skills.replace(/\/$/, "");
          if (Array.isArray(value.interface?.keywords) && value.interface.keywords.length === 0) delete value.interface.keywords;
        }
        return value;
      };
      return isDeepStrictEqual(normalized(a), normalized(b));
    } catch {
      return false;
    }
  }
  return a === b;
}
function ownedTarFiles(compressed, paths) {
  const data = gunzipSync(compressed, { maxOutputLength: 12 * 1024 * 1024 }), result = {};
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const string = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const checksum = parseInt(string(148, 156).trim(), 8), sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    requireValue(checksum === sum, "verification_failed");
    const size = parseInt(string(124, 136).trim() || "0", 8), type = string(156, 157), prefix = string(345, 500);
    let path = (prefix ? prefix + "/" : "") + string(0, 100);
    path = path.replace(/^\.\//, "");
    requireValue(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= data.length && !path.split("/").includes(".."), "verification_failed");
    if (paths.includes(path)) {
      requireValue((type === "" || type === "0") && !Object.hasOwn(result, path), "verification_failed");
      result[path] = data.subarray(offset + 512, offset + 512 + size).toString("base64");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireValue(paths.every((p) => Object.hasOwn(result, p)), "verification_failed");
  return result;
}
var allowedFile = (path) => FILES.includes(path) || path === "README.md" || path === "assets/icon.png" || /^skills\/[a-z][a-z0-9-]{1,79}\/(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_ -]+\/)*[A-Za-z0-9_ .-]+$/.test(path) && !path.split("/").some((p) => p === "." || p === ".." || p === "node_modules");
function validateSource(snapshot, current) {
  const target = targetFor(snapshot);
  requireValue(current.plugin?.plugin_id === target.packageId && current.plugin?.scope === "USER" && current.plugin?.discoverability === "PRIVATE", "identity_mismatch");
  requireValue(current.plugin.name === snapshot.packageName, "identity_mismatch");
  const next = JSON.parse(snapshot.files["plugin.json"]), before = JSON.parse(current.contents["plugin.json"]);
  requireValue(next.name === before.name && next.version === snapshot.version, "identity_mismatch");
  if (target.appId) {
    const app = JSON.parse(snapshot.files[".app.json"]);
    requireValue(app.apps?.[snapshot.packageName]?.id === target.appId && app.apps?.[snapshot.packageName]?.required === true && Object.keys(app.apps).length === 1, "identity_mismatch");
  } else requireValue(!snapshot.files[".app.json"] && !current.contents[".app.json"] && !next.extensions?.["com.openai"]?.apps, "identity_mismatch");
  for (const path of [".app.json", "mcp.json", ".mcp.json"]) if (snapshot.files[path] !== void 0 || current.contents[path] !== void 0) requireValue(sameText(path, snapshot.files[path], current.contents[path]), "source_changed");
  requireValue(JSON.stringify(next.extensions?.["com.openai"]?.interface?.defaultPrompt) === JSON.stringify(before.extensions?.["com.openai"]?.interface?.defaultPrompt), "source_changed");
  const paths = Object.keys(snapshot.files);
  requireValue(paths.length <= 250 && paths.every(allowedFile) && FILES.slice(0, 5).filter((p) => target.appId || p !== ".app.json").every((p) => typeof snapshot.files[p] === "string"), "source_changed");
  requireValue((snapshot.binaryPaths || []).every((p) => paths.includes(p) && allowedFile(p)), "source_changed");
  requireValue((current.files || []).filter((f) => f.path.startsWith("skills/") || f.path === "README.md").every((f) => paths.includes(f.path)), "platform_file_delete_unsupported");
}
function verifyReadback(snapshot, current) {
  validateSource(snapshot, current);
  requireValue(current.plugin.version === snapshot.version && /^pluginrel_[a-zA-Z0-9]+$/.test(current.plugin.current_release_id), "verification_failed");
  for (const path of Object.keys(snapshot.files)) {
    if ((snapshot.binaryPaths || []).includes(path)) requireValue(current.binaryContents?.[path] === snapshot.files[path], "verification_failed");
    else if (path !== "assets/icon.png") requireValue(sameText(path, snapshot.files[path], current.contents[path]), "verification_failed");
  }
  return current.plugin.current_release_id;
}
async function bytes(response, max = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      fail("publisher_unavailable");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
var PluginPublisher = class {
  constructor(options) {
    this.options = options;
  }
  active = /* @__PURE__ */ new Map();
  async request(id, action, body) {
    requireValue(/^[a-f0-9-]{36}$/.test(id), "invalid_release");
    const origin = this.options.origin || "https://fleet.vyibc.com";
    requireValue(["https://fleet.vyibc.com", "https://fleet-console.2513120790.workers.dev"].includes(origin), "publisher_unavailable");
    requireValue(this.options.token.length >= 24, "publisher_unavailable");
    const response = await (this.options.fetch || fetch)(origin + "/api/hub/publication/executor/" + action + "?id=" + id, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + publisherToken(this.options.token), "content-type": "application/json" }, ...body ? { body: JSON.stringify(body) } : {}, signal: AbortSignal.timeout(2e4), redirect: "error" });
    const data = await bytes(response);
    if (action === "archive") {
      requireValue(response.ok, "publisher_unavailable");
      return data;
    }
    const parsed = JSON.parse(data.toString());
    requireValue(response.ok && parsed.ok === true, parsed.error === "job_not_claimable" ? "job_not_claimable" : "publisher_unavailable");
    return parsed;
  }
  async status(id) {
    const data = await this.request(id, "job");
    return { ok: true, ...data.job, retryAfterSeconds: 10 };
  }
  async start(id) {
    const initial = await this.status(id);
    if (initial.state === "verified" || initial.state === "blocked" || this.active.has(id)) return initial;
    if (initial.state !== "queued" && (!initial.leaseUntil || Date.parse(initial.leaseUntil) > Date.now())) return initial;
    let claim;
    try {
      claim = (await this.request(id, "claim", {})).claim;
    } catch (error) {
      if (error.message === "job_not_claimable") return this.status(id);
      throw error;
    }
    const work = this.execute(id, claim).catch(() => {
    }).finally(() => this.active.delete(id));
    this.active.set(id, work);
    return { ok: true, ...initial, state: "running", retryAfterSeconds: 10 };
  }
  async settled(id) {
    await this.active.get(id);
    return this.status(id);
  }
  async execute(id, claim) {
    let platform, directory, mutationAttempted = false;
    try {
      const data = await this.request(id, "job"), s = data.snapshot;
      const archive = await this.request(id, "archive");
      requireValue(createHash("sha256").update(archive).digest("hex") === data.archiveSha, "archive_integrity_failed");
      const approved = targetFor(s);
      platform = await (this.options.platform ? this.options.platform() : openPluginCreator(void 0, approved.packageId));
      const paths = Object.keys(s.files), binaryPaths = s.binaryPaths || [];
      let current = await platform.read(paths, binaryPaths);
      validateSource(s, current);
      if (current.plugin.version !== s.version) {
        requireValue(current.plugin.current_release_id === data.job.expectedReleaseId, "platform_conflict");
        directory = await mkdtemp(join(tmpdir(), "fleet-plugin-publish-"));
        const path = join(directory, "release.zip");
        await writeFile(path, archive, { mode: 384 });
        mutationAttempted = true;
        await platform.update(path, data.job.expectedReleaseId);
        current = await platform.read(paths, binaryPaths);
      }
      if (current.plugin.version === s.version && binaryPaths.length && !current.binaryContents) current = await platform.read(paths, binaryPaths);
      const releaseId = verifyReadback(s, current);
      requireValue(releaseId !== data.job.expectedReleaseId, "verification_failed");
      await this.request(id, "finish", { claim, pluginId: approved.packageId, version: s.version, releaseId, archiveSha: data.archiveSha });
    } catch (error) {
      const allowed = ["platform_conflict", "identity_mismatch", "archive_integrity_failed", "source_changed", "authorization_required", "verification_failed", "platform_file_delete_unsupported"];
      const reason = mutationAttempted ? "unknown_outcome" : allowed.includes(error.message) ? error.message : "publisher_unavailable";
      await this.request(id, "finish", { claim, error: reason }).catch(() => {
      });
    } finally {
      if (platform) await platform.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
};

// src/plugin-publisher-tools.ts
var name = "task-console-plugin-publisher-tools";
var inject = ["tools"];
async function registerPluginPublisher(ctx, adapter, readOnly = false) {
  const defineTool = process.env.NODE_ENV === "test" ? (value) => value : (await import("@deepseek-ai/dsh-tools")).defineTool;
  const disposers = [];
  for (const operation of readOnly ? ["status"] : ["start", "status"]) {
    const tool = defineTool({
      name: operation === "start" ? "fleet_plugin_publish" : "fleet_plugin_publish_status",
      description: operation === "start" ? "\u53D1\u5E03\u7BA1\u7406\u5458\u5DF2\u5728 Fleet \u6279\u51C6\u7684\u4E0D\u53EF\u53D8\u63D2\u4EF6\u7248\u672C\u5305\u3002\u53EA\u63A5\u53D7 releaseId\uFF1B\u4FDD\u7559\u539F\u63D2\u4EF6\u4E0E\u6388\u6743\u8303\u56F4\u3002running \u65F6\u6301\u7EED\u8C03\u7528 status\uFF0C\u8D85\u65F6\u672A\u77E5\u7ED3\u679C\u4E0D\u53EF\u58F0\u79F0\u6210\u529F\u3002" : "\u8BFB\u53D6 Fleet \u63D2\u4EF6\u53D1\u5E03\u72B6\u6001\u3002\u4EC5 verified \u8868\u793A\u5B98\u65B9\u66F4\u65B0\u5E76\u56DE\u8BFB\u5B8C\u6210\uFF1B\u4E0D\u662F MCP \u4E1A\u52A1\u8C03\u7528\u9A8C\u6536\u3002",
      parameters: { releaseId: { type: "string", required: true, description: "Fleet Task Signal \u76EE\u6807\u4E2D\u7684\u7248\u672C\u8BB0\u5F55 UUID\u3002" } },
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }] },
      async execute(args) {
        if (!args || Object.keys(args).some((k) => k !== "releaseId") || !/^[a-f0-9-]{36}$/.test(args.releaseId || "")) throw Error("invalid_release");
        if (operation === "status") await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 0 : 4e3));
        return operation === "start" ? adapter.start(args.releaseId) : adapter.status(args.releaseId);
      }
    });
    if (tool.parameters.type === "object") tool.parameters = { ...tool.parameters, additionalProperties: false };
    else tool.parameters = { type: "object", properties: tool.parameters, required: ["releaseId"], additionalProperties: false };
    disposers.push(ctx.tools.register(tool));
  }
  return () => disposers.reverse().forEach((fn) => fn());
}
async function apply(ctx, config = {}) {
  const dispose = await registerPluginPublisher(ctx, new PluginPublisher({ token: process.env.DSH_TASK_INTAKE_TOKEN || "" }), config.readOnly === true);
  ctx.effect(() => dispose);
}
export {
  apply,
  inject,
  name,
  registerPluginPublisher
};
