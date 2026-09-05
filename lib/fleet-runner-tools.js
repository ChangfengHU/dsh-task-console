// src/fleet-runner-tools.ts
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
var name = "task-console-fleet-runner-tools";
var inject = ["tools"];
var key = Symbol.for("dsh.fleet-runner.jobs");
var jobs = globalThis[key] ??= /* @__PURE__ */ new Map();
function runnerIp(value) {
  if (typeof value !== "string" || !/^(?:[1-9]\d{0,2}|0)(?:\.(?:[1-9]\d{0,2}|0)){3}$/.test(value) || value.split(".").some((x) => Number(x) > 255)) throw new Error("\u9700\u8981\u5B8C\u6574 IPv4");
  return value;
}
var output = { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] };
async function apply(ctx, config = {}) {
  const defineTool = process.env.NODE_ENV === "test" ? (x) => x : (await import("@deepseek-ai/dsh-tools")).defineTool;
  const root = process.env.FLEET_RUNNER_OPERATOR_ROOT || "";
  const state = process.env.FLEET_RUNNER_STATE_DIR || join(homedir(), ".local/state/fleet-runner-operator");
  const entry = join(root, "operator/cli.mjs");
  const available = isAbsolute(root) && await stat(entry).then((s) => s.isFile()).catch(() => false);
  const owned = /* @__PURE__ */ new Set();
  const start = async (ip, operation, sessionId) => {
    if (!available) return { ok: false, phase: "blocked", reason: "Runner operator release is not installed on DSH host" };
    const active = jobs.get(ip);
    if (active && !active.result) return { ok: false, phase: "busy", sessionId: active.sessionId, events: active.events };
    await mkdir(state, { recursive: true, mode: 448 });
    const child = spawn("/usr/bin/flock", ["--nonblock", "--no-fork", join(state, ip + ".lock"), "/usr/bin/node", entry], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let resolve;
    const job = { child, sessionId, operation, events: [], startedAt: (/* @__PURE__ */ new Date()).toISOString(), done: new Promise((r) => resolve = r) };
    jobs.set(ip, job);
    owned.add(job);
    let pending = "", bytes = 0;
    const finish = (result) => {
      if (job.result) return;
      job.result = result;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, phase: "blocked", reason: "Runner operation timeout; verify external state before retry", events: job.events });
    }, 9e5);
    timer.unref();
    child.stdout.on("data", (data) => {
      bytes += data.length;
      if (bytes > 262144) {
        child.kill("SIGTERM");
        return;
      }
      pending += data.toString();
      for (; ; ) {
        const at = pending.indexOf("\n");
        if (at < 0) break;
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        try {
          const row = JSON.parse(line);
          if (row.event) job.events.push(row.event);
          if (row.result) finish(row.result);
        } catch {
        }
      }
    });
    child.stderr.resume();
    child.on("error", () => finish({ ok: false, phase: "blocked", reason: "Runner operator process unavailable" }));
    child.on("close", (code) => finish({ ok: false, phase: "blocked", reason: code === 1 ? "Runner target locked or operator failed" : "Runner process stopped without a verified result", events: job.events }));
    child.stdin.on("error", () => void 0);
    child.stdin.end(JSON.stringify({ ip, operation, sessionId }));
    return operation === "inspect" ? await job.done : { ok: true, phase: "running", ip, sessionId, startedAt: job.startedAt, note: "\u8C03\u7528 fleet_runner_status \u67E5\u770B\u5B9E\u9645\u9636\u6BB5\uFF1B\u672A\u5B8C\u6210\u524D\u4E0D\u8981\u4EA4\u5377\u3002" };
  };
  const specs = [
    ["fleet_runner_inspect", "\u53EA\u8BFB\u68C0\u67E5\u6307\u5B9A\u5DF2\u6CE8\u518C\u8282\u70B9\u7684 Runner\u3001\u57FA\u7840\u88C5\u673A\u6B8B\u7559\u8FDB\u7A0B\u3001\u670D\u52A1\u72B6\u6001\u548C\u7B7E\u540D\u5DE1\u68C0\u6CE8\u518C\u3002\u4E0D\u6267\u884C\u88C5\u673A\u6216\u7EC4\u4EF6\u4FEE\u590D\u3002"],
    ["fleet_runner_ensure", "\u5F02\u6B65\u542F\u52A8 Runner \u4E13\u9879\u5E42\u7B49\u90E8\u7F72/\u6062\u590D\u3002\u53EA\u64CD\u4F5C Runner release\u3001\u914D\u7F6E\u3001\u670D\u52A1\u548C\u65E2\u6709\u96A7\u9053\u7684\u65B0 ingress\uFF1B\u4E0D\u4FEE\u6539 Clash\u3001\u6D4F\u89C8\u5668\u6216\u8D26\u6237\u3002"],
    ["fleet_runner_status", "\u67E5\u770B\u771F\u5B9E\u90E8\u7F72\u9636\u6BB5\u3001\u6700\u7EC8\u9A8C\u6536\u62A5\u544A\u548C\u7B7E\u540D\u4F5C\u4E1A ID\uFF1B\u6CA1\u6709\u8FD4\u56DE complete \u5C31\u4E0D\u80FD\u5BA3\u79F0\u90E8\u7F72\u5B8C\u6210\u3002"],
    ["fleet_runner_cancel", "\u53D6\u6D88\u672C\u4F1A\u8BDD\u542F\u52A8\u7684 Runner \u64CD\u4F5C\u3002\u4FDD\u7559\u8BB0\u5F55\uFF1B\u53D6\u6D88\u4E0D\u662F\u8FDC\u7AEF\u5DF2\u6062\u590D\u6216\u5DF2\u505C\u6B62\u7684\u8BC1\u660E\uFF0C\u4E4B\u540E\u9700\u8981 inspect\u3002"]
  ];
  const disposers = specs.filter(([name2]) => !config.readOnly || ["fleet_runner_inspect", "fleet_runner_status"].includes(name2)).map(([name2, description]) => {
    const tool = defineTool({
      name: name2,
      description,
      parameters: { ip: { type: "string", required: true } },
      output,
      async execute(args, exec) {
        if (!args || Object.keys(args).some((k) => k !== "ip")) throw new Error("\u53EA\u5141\u8BB8 ip\uFF0C\u4E0D\u63A5\u53D7\u547D\u4EE4\u3001\u51ED\u636E\u6216\u914D\u7F6E");
        const ip = runnerIp(args.ip), sessionId = String(exec?.agent?.session?.id || exec?.agent?.session?.header?.id || "");
        if (!sessionId) return { ok: false, phase: "blocked", reason: "DSH session identity unavailable" };
        if (name2 === "fleet_runner_status") {
          const active = jobs.get(ip);
          if (active && (active.operation === "ensure" || !active.result)) {
            if (!active.result) await Promise.race([active.done, new Promise((r) => setTimeout(r, 2500))]);
            return active.result || { ok: true, phase: "running", ip, sessionId: active.sessionId, startedAt: active.startedAt, events: active.events };
          }
          return readFile(join(state, ip + ".json"), "utf8").then(JSON.parse).catch(() => ({ ok: false, phase: "not_started" }));
        }
        if (name2 === "fleet_runner_cancel") {
          const active = jobs.get(ip);
          if (!active || active.result) return { ok: true, phase: "no_active_operation" };
          if (active.sessionId !== sessionId) return { ok: false, phase: "blocked", reason: "Only the owning session can cancel" };
          active.child.kill("SIGTERM");
          return { ok: true, phase: "cancellation_requested", note: "\u68C0\u67E5 status \u548C inspect\uFF0C\u4E0D\u628A\u8BF7\u6C42\u53D6\u6D88\u5F53\u4F5C\u5B8C\u6210\u3002" };
        }
        return start(ip, name2 === "fleet_runner_inspect" ? "inspect" : "ensure", sessionId);
      }
    });
    if (tool.parameters?.type === "object") tool.parameters = { ...tool.parameters, additionalProperties: false };
    return ctx.tools.register(tool);
  });
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    for (const job of owned) {
      if (!job.result) job.child.kill("SIGTERM");
    }
  });
}
export {
  apply,
  inject,
  name,
  runnerIp
};
