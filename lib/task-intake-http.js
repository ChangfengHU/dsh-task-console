// src/task-intake-http.ts
import { timingSafeEqual } from "node:crypto";
var MAX_BODY = 64 * 1024;
function reply(res, status, value) {
  const body2 = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body2),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  res.end(body2);
}
function bearer(req) {
  const value = String(req.headers?.authorization ?? "");
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "") : "";
}
function sameSecret(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Signal \u8D85\u8FC7 64 KiB"), { status: 413 });
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("\u8BF7\u6C42\u4F53\u4E0D\u662F JSON"), { status: 400 });
  }
}
async function handleTaskSignalHttp(req, res, service, token = process.env.DSH_TASK_INTAKE_TOKEN ?? "") {
  if (!token) {
    reply(res, 503, { ok: false, error: "Task Signal API \u672A\u914D\u7F6E" });
    return;
  }
  if (!sameSecret(bearer(req), token)) {
    reply(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
  try {
    if (req.method === "POST") {
      const value = JSON.parse(await service.submitTaskSignal(JSON.stringify({ signal: await body(req) })));
      reply(res, 202, { ok: true, ...value });
      return;
    }
    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const value = id ? JSON.parse(await service.taskSignal(JSON.stringify({ id }))) : JSON.parse(await service.taskSignals(JSON.stringify({ limit: Number(url.searchParams.get("limit")) || 50 })));
      reply(res, 200, id ? { ok: true, ...value } : { ok: true, signals: value });
      return;
    }
    reply(res, 405, { ok: false, error: "method not allowed" });
  } catch (error) {
    const status = Number(error?.status) || 400;
    reply(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
function registerTaskSignalHttp(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/dsh-task-console/api/task-signals",
    handler: (req, res) => {
      const service = ctx.get("taskConsole") ?? ctx.taskConsole;
      if (!service) {
        reply(res, 503, { ok: false, error: "Task Console \u5C1A\u672A\u5C31\u7EEA" });
        return;
      }
      return handleTaskSignalHttp(req, res, service);
    }
  });
}
export {
  handleTaskSignalHttp,
  registerTaskSignalHttp
};
