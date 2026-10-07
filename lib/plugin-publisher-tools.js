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
var FAILURE_REASONS = {
  native_approval_required: { category: "authorization", fragment: "MCP tool call requires approval, but approval policy is never" },
  local_tool_disabled: { category: "authorization", pattern: /^(?:MCP tool '(?:plugin_creator\.update_plugin|plugin_creator\.get_plugin_files|plugin_creator\.get_owned_plugin_archive)' is disabled by (?:policy|config|configuration|app configuration)|MCP tool call blocked by app configuration|originating MCP tool is disabled by app configuration)$/ },
  local_file_open_failed: { category: "file_upload", fragment: "failed to open OpenAI file upload contents" },
  upload_response_parse_failed: { category: "file_upload", fragment: "failed to parse OpenAI file response from" },
  blob_upload_failed: { category: "file_upload", fragment: "OpenAI file blob upload attempt failed" },
  upload_finalization_failed: { category: "file_upload", fragment: "upload finalization returned an error" },
  upload_download_url_missing: { category: "file_upload", fragment: "missing download_url" },
  archive_empty: { category: "invalid_arguments", fragment: "archive_empty" },
  archive_too_large: { category: "invalid_arguments", fragment: "archive_too_large" },
  archive_format_not_zip: { category: "invalid_arguments", fragment: "archive_format_not_zip" },
  archive_member_path_empty: { category: "invalid_arguments", fragment: "archive_member_path_empty" },
  archive_member_path_has_outer_whitespace: { category: "invalid_arguments", fragment: "archive_member_path_has_outer_whitespace" },
  archive_member_path_has_backslash: { category: "invalid_arguments", fragment: "archive_member_path_has_backslash" },
  archive_member_path_absolute: { category: "invalid_arguments", fragment: "archive_member_path_absolute" },
  archive_member_path_has_empty_segment: { category: "invalid_arguments", fragment: "archive_member_path_has_empty_segment" },
  archive_member_path_has_parent_segment: { category: "invalid_arguments", fragment: "archive_member_path_has_parent_segment" },
  archive_member_path_too_deep: { category: "invalid_arguments", fragment: "archive_member_path_too_deep" },
  archive_member_path_too_long: { category: "invalid_arguments", fragment: "archive_member_path_too_long" },
  archive_member_path_normalization_collision: { category: "invalid_arguments", fragment: "archive_member_path_normalization_collision" },
  archive_member_type_unsupported: { category: "invalid_arguments", fragment: "archive_member_type_unsupported" },
  archive_member_too_large: { category: "invalid_arguments", fragment: "archive_member_too_large" },
  archive_member_path_duplicate: { category: "invalid_arguments", fragment: "archive_member_path_duplicate" },
  archive_member_path_type_conflict: { category: "invalid_arguments", fragment: "archive_member_path_type_conflict" },
  archive_too_many_entries: { category: "invalid_arguments", fragment: "archive_too_many_entries" },
  archive_uncompressed_too_large: { category: "invalid_arguments", fragment: "archive_uncompressed_too_large" },
  archive_member_unreadable: { category: "invalid_arguments", fragment: "archive_member_unreadable" },
  plugin_name_mismatch: { category: "invalid_arguments", fragment: "plugin_name_mismatch" },
  plugin_version_unchanged: { category: "release_conflict", fragment: "plugin_version_unchanged" }
};
var ERROR_CATEGORIES = {
  authorization_required: "authorization",
  unauthorized: "authorization",
  forbidden: "authorization",
  authentication_failed: "authorization",
  invalid_token: "authorization",
  expired_token: "authorization",
  permission_denied: "authorization",
  file_upload_failed: "file_upload",
  file_upload_error: "file_upload",
  upload_failed: "file_upload",
  release_conflict: "release_conflict",
  platform_conflict: "release_conflict",
  rate_limit_exceeded: "rate_limit",
  ratelimitexceeded: "rate_limit",
  usagelimitexceeded: "rate_limit",
  timeout: "timeout",
  request_timeout: "timeout",
  etimedout: "timeout",
  econnreset: "transport",
  econnrefused: "transport",
  epipe: "transport",
  httpconnectionfailed: "transport",
  responsestreamconnectionfailed: "transport",
  responsestreamdisconnected: "transport",
  responsetoomanyfailedattempts: "transport",
  invalid_arguments: "invalid_arguments",
  invalid_params: "invalid_arguments",
  badrequest: "invalid_arguments",
  internal_error: "upstream",
  internalservererror: "upstream",
  server_error: "upstream",
  interrupted: "interrupted"
};
var SERVER_REQUEST_METHODS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "item/permissions/requestApproval", "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "currentTime/read", "applyPatchApproval", "execCommandApproval"];
function publisherSafeDiagnostic(stage, error, fallback = "unknown") {
  const source = error && typeof error === "object" ? error : {};
  const info = source.codexErrorInfo ?? source.data?.codexErrorInfo;
  const fields = [source, source.data, typeof info === "object" ? info : void 0, info?.httpConnectionFailed, info?.responseStreamConnectionFailed, info?.responseStreamDisconnected, info?.responseTooManyFailedAttempts].filter(Boolean);
  const message = typeof source.message === "string" ? source.message.slice(0, 4096) : void 0;
  const messageCode = message?.match(/\bMCP\s+error\s*:?\s*(-(?:32700|3260[0-3]|320\d{2}))\b/i)?.[1];
  const errorCode = fields.map((value) => value.code).find((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647) ?? (messageCode === void 0 ? void 0 : Number(messageCode));
  const httpStatus = fields.flatMap((value) => [value.httpStatus, value.httpStatusCode, value.statusCode]).find((value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const labels = [source.code, source.data?.code, typeof info === "string" ? info : void 0, ...info && typeof info === "object" ? Object.keys(info) : []].filter((value) => typeof value === "string");
  const reason = Object.keys(FAILURE_REASONS).find((key) => {
    const rule = FAILURE_REASONS[key];
    return labels.some((label) => label.toLowerCase() === key) || message !== void 0 && ("pattern" in rule ? rule.pattern.test(message) : new RegExp("\\b" + rule.fragment + "\\b", "i").test(message));
  });
  let category = labels.map((value) => {
    const key = value.toLowerCase();
    return Object.hasOwn(ERROR_CATEGORIES, key) ? ERROR_CATEGORIES[key] : void 0;
  }).find(Boolean) || fallback;
  if (httpStatus === 401 || httpStatus === 403) category = "authorization";
  else if (httpStatus === 409 || httpStatus === 412) category = "release_conflict";
  else if (httpStatus === 429) category = "rate_limit";
  else if (httpStatus === 408 || httpStatus === 504) category = "timeout";
  else if (httpStatus === 400 || httpStatus === 422 || errorCode === -32602) category = "invalid_arguments";
  else if (httpStatus >= 500 || errorCode === -32603) category = "upstream";
  if (category === "unknown" && reason !== void 0) category = FAILURE_REASONS[reason].category;
  if (category === "unknown" && message !== void 0) {
    if (/\b(?:unauthorized|forbidden|permission denied|authentication required|invalid token|token expired)\b/i.test(message)) category = "authorization";
    else if (/\b(?:file upload|upload file|fileParams|uploaded-file|upload_failed)\b/i.test(message)) category = "file_upload";
    else if (/\b(?:release conflict|expected_release_id mismatch)\b/i.test(message)) category = "release_conflict";
    else if (/\b(?:rate limit|too many requests)\b/i.test(message)) category = "rate_limit";
    else if (/\b(?:timed out|timeout)\b/i.test(message)) category = "timeout";
    else if (/\b(?:invalid (?:arguments|params|parameters)|invalid_arguments|invalid_params)\b/i.test(message)) category = "invalid_arguments";
  }
  return { stage, category, ...reason !== void 0 ? { reason } : {}, ...errorCode !== void 0 ? { errorCode } : {}, ...httpStatus !== void 0 ? { httpStatus } : {} };
}
var PublisherDiagnosticError = class extends Error {
  diagnostic;
  constructor(diagnostic) {
    super("publisher_unavailable");
    this.name = "PublisherDiagnosticError";
    const safe = publisherSafeDiagnostic("publisher", { code: diagnostic.errorCode, httpStatus: diagnostic.httpStatus });
    const stages = ["native_upload", "native_rpc", "native_process", "publisher"];
    const categories = ["authorization", "file_upload", "release_conflict", "rate_limit", "timeout", "transport", "invalid_arguments", "upstream", "interrupted", "unknown"];
    const events = ["tool_failed", "rpc_error", "rpc_timeout", "turn_failed", "turn_interrupted", "turn_timeout", "process_error", "process_exit", "process_eof", "process_timeout", "process_closed", "stdin_error", "stdout_error", "stdout_limit", "server_request_rejected", "publish_failed"];
    this.diagnostic = Object.freeze({ stage: stages.includes(diagnostic.stage) ? diagnostic.stage : "publisher", category: categories.includes(diagnostic.category) ? diagnostic.category : "unknown", ...typeof diagnostic.reason === "string" && Object.hasOwn(FAILURE_REASONS, diagnostic.reason) ? { reason: diagnostic.reason } : {}, ...events.includes(diagnostic.event) ? { event: diagnostic.event } : {}, ...safe.errorCode !== void 0 ? { errorCode: safe.errorCode } : {}, ...safe.httpStatus !== void 0 ? { httpStatus: safe.httpStatus } : {} });
  }
};
function publisherRuntimeConfig(effective = {}) {
  const config = { "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false, "features.skill_mcp_dependency_install": false, web_search: "disabled", "apps._default.enabled": false, "apps.connector_openai_plugin_creator.enabled": true, "apps.connector_openai_plugin_creator.default_tools_enabled": false, "apps.connector_openai_plugin_creator.approvals_reviewer": "user" };
  config["apps.connector_openai_plugin_creator.tools"] = {
    "plugin_creator.update_plugin": { enabled: true, approval_mode: "prompt" },
    "plugin_creator.get_plugin_files": { enabled: true, approval_mode: "prompt" },
    "plugin_creator.get_owned_plugin_archive": { enabled: true, approval_mode: "prompt" }
  };
  for (const name2 of Object.keys(effective.mcp_servers || {})) config["mcp_servers." + name2 + ".enabled"] = false;
  for (const name2 of Object.keys(effective.apps || {})) if (!["_default", "connector_openai_plugin_creator"].includes(name2)) config["apps." + name2 + ".enabled"] = false;
  return config;
}
function verifyUploadInvocation(item, archive, expected, packageId = PACKAGE_ID) {
  requireValue(item?.type === "mcpToolCall" && item.server === "codex_apps" && item.tool === "plugin_creator.update_plugin", "verification_failed");
  const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
  requireValue(args?.plugin_id === packageId && args.archive === archive && args.expected_release_id === expected && Object.keys(args).length === 3, "verification_failed");
  if (item.status !== "completed" || item.error || item.result?.isError) throw new PublisherDiagnosticError({ ...publisherSafeDiagnostic("native_upload", item.error), event: "tool_failed" });
}
function uploadTurnRequest(archive, expected, packageId = PACKAGE_ID) {
  const args = { plugin_id: packageId, archive, expected_release_id: expected };
  return 'Use functions.exec to run exactly this JavaScript. Resolve the executable name from ALL_TOOLS; do not guess a namespace. const matches = ALL_TOOLS.filter(t => /plugin_creator.*update_plugin$/.test(t.name)); if (matches.length !== 1) throw new Error("publisher_tool_not_found"); text(await tools[matches[0].name](' + JSON.stringify(args) + ")); The archive is owner-approved and immutable. Call that external tool exactly once. Do not call any other external tool, change arguments, create files, or retry. Report its result and stop.";
}
var UPLOAD_APPROVAL_META_KEYS = /* @__PURE__ */ new Set(["codex_approval_kind", "persist", "tool_title", "tool_description", "source", "connector_id", "link_id", "link_is_implicit", "connector_name", "connector_description", "tool_params", "tool_params_display"]);
function approvedUploadArguments(value, expected) {
  let args = value;
  if (typeof args === "string") {
    if (args.length > 4096) return false;
    try {
      args = JSON.parse(args);
    } catch {
      return false;
    }
  }
  return Boolean(args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 3 && args.plugin_id === expected.packageId && args.archive === expected.archive && args.expected_release_id === expected.expectedReleaseId);
}
function approvedUploadItem(tracked, expected) {
  const item = tracked?.item;
  return Boolean(tracked?.threadId === expected.threadId && tracked?.turnId === expected.turnId && typeof item?.id === "string" && item.id && item.type === "mcpToolCall" && item.server === "codex_apps" && item.tool === "plugin_creator.update_plugin" && (item.appContext == null || item.appContext.connectorId === "connector_openai_plugin_creator") && approvedUploadArguments(item.arguments, expected));
}
function boundedUploadApproval(params, tracked, expected) {
  if (!params || !tracked || !expected.threadId || !expected.turnId) return;
  if (params.threadId !== expected.threadId || params.turnId !== expected.turnId || params.serverName !== "codex_apps" || params.mode !== "form" || !approvedUploadItem(tracked, expected) || tracked.item.status !== "inProgress") return;
  if (!isDeepStrictEqual(params.requestedSchema, { type: "object", properties: {} })) return;
  const meta = params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || Object.keys(meta).some((key) => !UPLOAD_APPROVAL_META_KEYS.has(key)) || meta.codex_approval_kind !== "mcp_tool_call" || meta.source !== "connector" || meta.connector_id !== "connector_openai_plugin_creator" || Object.hasOwn(meta, "persist") && !isDeepStrictEqual(meta.persist, ["session", "always"]) || typeof meta.tool_params !== "object" || !approvedUploadArguments(meta.tool_params, expected)) return;
  return { action: "accept", content: {}, _meta: null };
}
async function openPluginCreator(binary = join(homedir(), ".local/bin/codex"), packageId = PACKAGE_ID, dependencies = {}) {
  requireValue(Object.values(PUBLISH_TARGETS).some((t) => t.packageId === packageId), "identity_mismatch");
  const env = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = (dependencies.spawn || spawn)(binary, ["app-server", "--listen", "stdio://"], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let serial = 0, ended = false, exited = false, closing = false;
  let observeTurn;
  let handleServerRequest;
  let abortUpload, endedError;
  const pending = /* @__PURE__ */ new Map();
  const send = (value) => {
    if (!ended) child.stdin.write(JSON.stringify(value) + "\n");
  };
  const declineServerRequest = (m) => {
    console.warn("[plugin-publisher] native server request rejected", JSON.stringify({ stage: "native_rpc", category: "authorization", event: "server_request_rejected", method: SERVER_REQUEST_METHODS.includes(m.method) ? m.method : "unknown" }));
    send({ id: m.id, error: { code: -32601, message: "Interactive requests are not supported by the bounded publisher." } });
  };
  const processFailure = (event, error, category = "transport") => new PublisherDiagnosticError({ ...publisherSafeDiagnostic("native_process", error, category), event });
  const rejectAll = (error = processFailure("process_closed")) => {
    ended = true;
    endedError ??= error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(endedError);
    }
    pending.clear();
    abortUpload?.(endedError);
  };
  child.on("error", (error) => rejectAll(processFailure("process_error", error)));
  child.on("exit", () => {
    exited = true;
    rejectAll(processFailure("process_exit"));
  });
  child.stdin.on("error", (error) => rejectAll(processFailure("stdin_error", error)));
  child.stdout.on("error", (error) => rejectAll(processFailure("stdout_error", error)));
  child.stdout.on("end", () => {
    if (!closing) rejectAll(processFailure("process_eof"));
  });
  const lifetime = setTimeout(() => {
    rejectAll(processFailure("process_timeout", void 0, "timeout"));
    child.kill("SIGTERM");
  }, 24e4);
  lifetime.unref();
  child.stderr.on("data", () => {
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("error", (error) => rejectAll(processFailure("stdout_error", error)));
  lines.on("close", () => {
    if (!closing) rejectAll(processFailure("process_eof"));
  });
  lines.on("line", (line) => {
    if (line.length > 4 * 1024 * 1024) {
      rejectAll(processFailure("stdout_limit", void 0, "upstream"));
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
      if (!handleServerRequest?.(m)) declineServerRequest(m);
      return;
    }
    if (m.method) observeTurn?.(m);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new PublisherDiagnosticError({ ...publisherSafeDiagnostic("native_rpc", m.error), event: "rpc_error" }));
    else p.resolve(m.result);
  });
  const rpc = (method, params, timeout = 7e4) => new Promise((resolve, reject) => {
    if (ended) return reject(endedError || processFailure("process_closed"));
    const id = ++serial, timer = setTimeout(() => {
      pending.delete(id);
      reject(new PublisherDiagnosticError({ stage: "native_rpc", category: "timeout", event: "rpc_timeout" }));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const close = async () => {
    closing = true;
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
    const started = await rpc("thread/start", { cwd: tmpdir(), ephemeral: true, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", model: "gpt-5.6-terra", config: publisherRuntimeConfig(effective.config), baseInstructions: "You perform only the exact owner-approved Plugin Creator update requested. No shell, browsing, file changes, retries, plugin creation, or other operations.", developerInstructions: "The archive is immutable and prevalidated. Invoke the specified update_plugin once with the exact three arguments. Do not inspect or modify other files or plugins. Report the tool outcome and stop. Do not claim success without the tool result." });
    requireValue(started.approvalPolicy === "on-request" && started.approvalsReviewer === "user" && started.sandbox?.type === "readOnly", "authorization_required");
    const threadId = started.thread.id;
    const apps = await rpc("app/installed", { threadId, forceRefresh: true });
    requireValue(Array.isArray(apps.apps) && apps.apps.some((a) => a?.id === "connector_openai_plugin_creator" && a.enabled === true && a.callable === true), "authorization_required");
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
      const began = Date.now();
      let turnId, observedTurnId, trackedCall, pendingApproval, approvalGranted = false, startedCallCount = 0, itemClosed = false;
      let phase = "awaiting_turn";
      const earlyEvents = [];
      let turnDiagnostic;
      let resolveTurn, rejectTurn;
      const done = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      void done.catch(() => {
      });
      const end = (error, interrupt = false) => {
        if (phase === "terminal") return;
        phase = "terminal";
        if (pendingApproval) {
          const m = pendingApproval;
          pendingApproval = void 0;
          declineServerRequest(m);
        }
        if (interrupt && turnId && !ended) void rpc("turn/interrupt", { threadId, turnId }).catch(() => {
        });
        if (error) rejectTurn(error);
        else resolveTurn();
      };
      const invalidCall = () => end(new PublisherDiagnosticError({ stage: "native_upload", category: "authorization", event: "server_request_rejected" }), true);
      abortUpload = (error) => end(error);
      const timer = setTimeout(() => end(new PublisherDiagnosticError({ stage: "native_upload", category: "timeout", event: "turn_timeout" }), true), dependencies.uploadTimeoutMs ?? 12e4);
      const approve = (m) => {
        const response = phase === "active" && !itemClosed && !approvalGranted && startedCallCount === 1 && turnId ? boundedUploadApproval(m.params, trackedCall, { threadId, turnId, archive, expectedReleaseId: expected, packageId }) : void 0;
        if (!response) return false;
        approvalGranted = true;
        console.info("[plugin-publisher] native upload approval", JSON.stringify({ scope: "single_call", tool: "plugin_creator.update_plugin", approvalCount: 1 }));
        send({ id: m.id, result: response });
        return true;
      };
      const flushApproval = () => {
        if (!pendingApproval || !turnId || phase !== "active") return;
        const m = pendingApproval;
        pendingApproval = void 0;
        if (!approve(m)) {
          declineServerRequest(m);
          invalidCall();
        }
      };
      handleServerRequest = (m) => {
        if (m.method !== "mcpServer/elicitation/request" || m.params?.threadId !== threadId || phase === "terminal") return false;
        if ((typeof m.id !== "string" || !m.id || m.id.length > 256) && (typeof m.id !== "number" || !Number.isSafeInteger(m.id))) return false;
        if (typeof m.params.turnId !== "string" || !m.params.turnId) return false;
        if (phase === "awaiting_turn") {
          if (pendingApproval) {
            invalidCall();
            return false;
          }
          pendingApproval = m;
          return true;
        }
        if (m.params.turnId !== turnId) return false;
        if (approve(m)) return true;
        invalidCall();
        return false;
      };
      const eventTurnId = (m) => m.method === "turn/started" || m.method === "turn/completed" ? m.params?.turn?.id : m.params?.turnId;
      const processEvent = (m) => {
        if (phase !== "active" || eventTurnId(m) !== turnId) return;
        if (m.method === "item/started" && m.params.item?.type === "mcpToolCall") {
          startedCallCount++;
          if (startedCallCount !== 1 || !approvedUploadItem(m.params, { threadId, turnId, archive, expectedReleaseId: expected, packageId }) || m.params.item.status !== "inProgress") {
            invalidCall();
            return;
          }
          trackedCall = m.params;
        }
        if (m.method === "item/completed" && m.params.item?.type === "mcpToolCall") {
          if (itemClosed || !trackedCall || m.params.item.id !== trackedCall.item.id || !approvedUploadItem(m.params, { threadId, turnId, archive, expectedReleaseId: expected, packageId })) {
            invalidCall();
            return;
          }
          itemClosed = true;
          invocations.push(m.params.item);
          if (pendingApproval) {
            const request = pendingApproval;
            pendingApproval = void 0;
            declineServerRequest(request);
          }
        }
        if (m.method === "error") {
          turnDiagnostic = publisherSafeDiagnostic("native_upload", m.params.error);
          end(new PublisherDiagnosticError({ ...turnDiagnostic, event: "turn_failed" }), true);
          return;
        }
        if (m.method === "turn/completed") {
          if (m.params.turn?.status === "completed") end();
          else if (m.params.turn?.status === "interrupted") end(new PublisherDiagnosticError({ stage: "native_upload", category: "interrupted", event: "turn_interrupted" }));
          else end(new PublisherDiagnosticError({ ...(m.params.turn?.error ? publisherSafeDiagnostic("native_upload", m.params.turn.error) : turnDiagnostic) || { stage: "native_upload", category: "unknown" }, event: "turn_failed" }));
        }
      };
      observeTurn = (m) => {
        if (m.params?.threadId !== threadId || phase === "terminal") return;
        if (phase === "awaiting_turn") {
          if (m.method === "turn/started" && typeof m.params.turn?.id === "string") {
            if (observedTurnId && observedTurnId !== m.params.turn.id) {
              invalidCall();
              return;
            }
            observedTurnId = m.params.turn.id;
          }
          if (earlyEvents.length >= 16) {
            invalidCall();
            return;
          }
          earlyEvents.push(m);
          return;
        }
        processEvent(m);
      };
      try {
        const turn = await rpc("turn/start", { threadId, effort: "low", input: [{ type: "text", text: uploadTurnRequest(archive, expected, packageId) }, { type: "mention", name: "Plugin Creator", path: "app://connector_openai_plugin_creator" }] });
        requireValue(typeof turn.turn?.id === "string" && turn.turn.id && (!observedTurnId || observedTurnId === turn.turn.id), "verification_failed");
        turnId = turn.turn.id;
        if (phase !== "terminal") {
          phase = "active";
          for (const event of earlyEvents) processEvent(event);
          earlyEvents.length = 0;
          flushApproval();
        }
        await done;
        console.info("[plugin-publisher] native upload receipt", JSON.stringify({ elapsedMs: Date.now() - began, calls: invocations.map((item) => ({ server: item.server === "codex_apps" ? "codex_apps" : "unexpected", tool: ["plugin_creator.update_plugin", "plugin_creator.get_plugin_files", "plugin_creator.get_owned_plugin_archive"].includes(item.tool) ? item.tool : "unexpected", status: ["inProgress", "completed", "failed"].includes(item.status) ? item.status : "unknown", error: Boolean(item.error || item.result?.isError), ...item.status !== "completed" || item.error || item.result?.isError ? { diagnostic: publisherSafeDiagnostic("native_upload", item.error) } : {} })) }));
        requireValue(invocations.length === 1, "verification_failed");
        verifyUploadInvocation(invocations[0], archive, expected, packageId);
        requireValue(approvalGranted && startedCallCount === 1, "verification_failed");
      } catch (error) {
        const diagnostic = error instanceof PublisherDiagnosticError ? error.diagnostic : publisherSafeDiagnostic("native_upload", error);
        console.warn("[plugin-publisher] native upload failed", JSON.stringify({ ...diagnostic, elapsedMs: Date.now() - began, callCount: invocations.length }));
        throw error;
      } finally {
        phase = "terminal";
        clearTimeout(timer);
        if (pendingApproval) declineServerRequest(pendingApproval);
        handleServerRequest = void 0;
        observeTurn = void 0;
        abortUpload = void 0;
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
      const diagnostic = error instanceof PublisherDiagnosticError ? error.diagnostic : { ...publisherSafeDiagnostic("publisher", error), event: "publish_failed" };
      console.warn("[plugin-publisher] publish failed", JSON.stringify({ releaseId: id, outcome: reason, diagnostic }));
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
