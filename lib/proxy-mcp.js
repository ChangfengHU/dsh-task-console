// src/proxy-mcp.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

// src/proxy-policy.ts
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
var proxyIp = z.string().regex(/^(?:[1-9]\d{0,2}|0)(?:\.(?:[1-9]\d{0,2}|0)){3}$/).refine((value) => {
  const [a, b, ...rest] = value.split(".").map(Number);
  return [a, b, ...rest].every((n) => n <= 255) && ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}, "public-ip-required");
var path = z.string().refine(isAbsolute, "absolute-path-required");
var proxyPolicySchema = z.object({
  version: z.literal(1),
  principal: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  stateDir: path,
  knownHostsFile: path,
  vaultOrigin: z.string().url().refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/";
  }, "https-origin-required"),
  vaultTokenFile: path,
  sshResolveTokenFile: path,
  sshResolveTokenKey: z.literal("FLEET_ONBOARD_VAULT_RESOLVE_TOKEN").optional(),
  nodes: z.array(z.object({
    ip: proxyIp,
    lineId: z.string().regex(/^line-[a-zA-Z0-9_-]{1,48}$/),
    repair: z.boolean().default(false)
  }).strict()).max(1e3)
}).strict().refine((p) => new Set(p.nodes.map((n) => n.ip)).size === p.nodes.length, "duplicate-node");
async function privateFile(path2) {
  const s = await lstat(path2);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.mode & 63) throw new Error("private-file-required");
  return readFile(path2, "utf8");
}
async function loadProxyPolicy(path2) {
  if (!isAbsolute(path2)) throw new Error("absolute-policy-path-required");
  return proxyPolicySchema.parse(JSON.parse(await privateFile(path2)));
}
function authorizeProxy(policy, ip, repair = false) {
  const node = policy?.nodes.find((n) => n.ip === ip);
  if (!node || repair && !node.repair) throw new Error("proxy-scope-denied");
  return node;
}

// src/proxy-service.ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, lstat as lstat2, open } from "node:fs/promises";
import { join } from "node:path";
import { z as z2 } from "zod";
var requestId = z2.string().regex(/^[a-zA-Z0-9_-]{16,96}$/);
var schemas = {
  proxy_inspect: z2.object({ ip: proxyIp }).strict(),
  proxy_verify: z2.object({ ip: proxyIp, requestId }).strict(),
  proxy_repair: z2.object({ ip: proxyIp, requestId }).strict(),
  proxy_status: z2.object({ operationId: z2.string().uuid(), after: z2.number().int().min(0).default(0) }).strict()
};
var proxyTools = Object.entries(schemas).map(([name, schema]) => ({
  name,
  inputSchema: z2.toJSONSchema(schema),
  description: {
    proxy_inspect: "\u53EA\u8BFB\u67E5\u8BE2\u5141\u8BB8\u8282\u70B9\u7684Controller\u4E0E\u5386\u53F2\u51FA\u53E3\u8BC1\u636E\uFF1B\u5386\u53F2\u5FEB\u7167\u4E0D\u662F\u672C\u6B21\u9A8C\u6536\u3002",
    proxy_verify: "\u53EA\u8BFB\u4E3B\u52A8\u9A8C\u6536\uFF1A\u7CFB\u7EDF\u4EE3\u7406TCP/UDP\u53CA\u9884\u671F\u51FA\u53E3\u3002\u8FD4\u56DE\u64CD\u4F5C\u7F16\u53F7\uFF0C\u4F7F\u7528proxy_status\u67E5\u770B\u7ED3\u679C\uFF1B\u4E0D\u4F1A\u4FEE\u590D\u4EE3\u7406\u6216\u8C03\u6574\u65F6\u533A\u3002",
    proxy_repair: "\u4EC5\u5BF9\u5141\u8BB8\u4FEE\u590D\u7684\u8282\u70B9\u5E42\u7B49\u6062\u590D\u5DF2\u6279\u51C6\u7EBF\u8DEF\uFF1B\u4E0D\u63A5\u6536\u547D\u4EE4\u3001\u51ED\u636E\u6216URL\u3002\u4E0D\u64CD\u4F5C\u672C\u673A\u3001\u4E0D\u88C5\u673A\u3001\u4E0D\u6539\u6D4F\u89C8\u5668\u3002\u8FD4\u56DE\u64CD\u4F5C\u7F16\u53F7\uFF1B\u672A\u77E5\u7ED3\u679C\u7981\u6B62\u6362requestId\u76F2\u91CD\u8BD5\u3002",
    proxy_status: "\u5206\u9875\u67E5\u8BE2\u64CD\u4F5C\u9636\u6BB5\u548C\u7EC8\u6001\uFF0C\u6BCF\u9875\u6700\u591A50\u4E8B\u4EF6\u3002unknown\u8868\u793A\u7ED3\u679C\u4E0D\u786E\u5B9A\u4E14\u9501\u4FDD\u7559\uFF0C\u4E0D\u662F\u5931\u8D25\u91CD\u8BD5\u8BB8\u53EF\u3002"
  }[name],
  annotations: { readOnlyHint: name !== "proxy_repair", destructiveHint: name === "proxy_repair", idempotentHint: true, openWorldHint: true }
}));
var safeReason = (e) => e instanceof Error && /^[a-z][a-z0-9-]{1,95}$/.test(e.message) ? e.message : "proxy-operation-failed";
var ProxyService = class _ProxyService {
  constructor(db, policy, transport) {
    this.db = db;
    this.policy = policy;
    this.transport = transport;
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS proxy_operations(id TEXT PRIMARY KEY,principal TEXT NOT NULL,ip TEXT NOT NULL,action TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,owner_pid INTEGER NOT NULL,result_json TEXT,UNIQUE(principal,request_id));
      CREATE TABLE IF NOT EXISTS proxy_node_locks(ip TEXT PRIMARY KEY,operation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proxy_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,at TEXT NOT NULL,payload_json TEXT NOT NULL);`);
  }
  pending = /* @__PURE__ */ new Set();
  static async open(policy, transport) {
    let file = ":memory:";
    if (policy) {
      await mkdir(policy.stateDir, { recursive: true, mode: 448 });
      const s = await lstat2(policy.stateDir);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.mode & 63) throw new Error("private-state-directory-required");
      file = join(policy.stateDir, "proxy.db");
      const f = await lstat2(file).catch(() => void 0);
      if (f && (!f.isFile() || f.isSymbolicLink() || f.uid !== process.getuid?.() || f.mode & 63)) throw new Error("private-database-required");
      if (!f) await open(file, "wx", 384).then((f2) => f2.close()).catch(async (e) => {
        if (e.code !== "EEXIST") throw e;
        const row = await lstat2(file);
        if (!row.isFile() || row.isSymbolicLink() || row.uid !== process.getuid?.() || row.mode & 63) throw new Error("private-database-required");
      });
    }
    return new _ProxyService(new Database(file), policy, transport);
  }
  tools() {
    return proxyTools.filter((t) => t.name !== "proxy_repair" || this.policy?.nodes.some((n) => n.repair));
  }
  async call(name, raw) {
    if (!Object.hasOwn(schemas, name)) throw new Error("unknown-proxy-tool");
    const parsed = schemas[name].safeParse(raw);
    if (!parsed.success) throw new Error("invalid-proxy-arguments");
    const args = parsed.data;
    if (name === "proxy_status") return this.status(args.operationId, args.after);
    authorizeProxy(this.policy, args.ip, name === "proxy_repair");
    if (name === "proxy_inspect") return this.transport("inspect", args.ip, randomUUID(), () => {
    });
    const action = name === "proxy_verify" ? "verify" : "repair", now = (/* @__PURE__ */ new Date()).toISOString(), principal = this.policy.principal;
    const existing = this.db.prepare("SELECT * FROM proxy_operations WHERE principal=? AND request_id=?").get(principal, args.requestId);
    if (existing) {
      if (existing.ip !== args.ip || existing.action !== action) throw new Error("request-id-conflict");
      return this.status(existing.id, 0);
    }
    const id = randomUUID();
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM proxy_node_locks WHERE ip=?").get(args.ip)) throw new Error("proxy-node-busy-or-unknown");
      this.db.prepare("INSERT INTO proxy_operations VALUES (?,?,?,?,?,?,?,?,?,NULL)").run(id, principal, args.ip, action, args.requestId, "running", now, now, process.pid);
      this.db.prepare("INSERT INTO proxy_node_locks VALUES (?,?)").run(args.ip, id);
      this.event(id, { stage: "accepted", action });
    }).immediate();
    const work = this.run(id, args.ip, action);
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return this.status(id, 0);
  }
  event(id, event) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("INSERT INTO proxy_events(operation_id,at,payload_json) VALUES (?,?,?)").run(id, now, JSON.stringify(event));
    this.db.prepare("UPDATE proxy_operations SET updated_at=? WHERE id=?").run(now, id);
  }
  finish(id, result) {
    const state = result.quiescent === true ? result.ok ? "succeeded" : "blocked" : "unknown";
    this.db.transaction(() => {
      this.db.prepare("UPDATE proxy_operations SET state=?,updated_at=?,result_json=? WHERE id=?").run(state, (/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(result), id);
      if (state !== "unknown") this.db.prepare("DELETE FROM proxy_node_locks WHERE operation_id=?").run(id);
      this.event(id, { stage: state, reason: result.reason ?? null });
    }).immediate();
  }
  async run(id, ip, action) {
    const heartbeat = setInterval(() => this.event(id, { stage: "heartbeat" }), 15e3);
    try {
      this.finish(id, await this.transport(action, ip, id, (event) => this.event(id, event)));
    } catch (e) {
      this.finish(id, { ok: false, reason: safeReason(e), quiescent: false });
    } finally {
      clearInterval(heartbeat);
    }
  }
  async status(id, after = 0) {
    let row = this.db.prepare("SELECT * FROM proxy_operations WHERE id=? AND principal=?").get(id, this.policy?.principal ?? "");
    if (!row) throw new Error("proxy-operation-not-found");
    authorizeProxy(this.policy, row.ip);
    if (row.state === "running" && Date.now() - Date.parse(row.updated_at) > 18e4) {
      this.db.prepare("UPDATE proxy_operations SET state='unknown' WHERE id=? AND state='running'").run(id);
      row = { ...row, state: "unknown" };
    }
    if (row.state === "unknown") {
      try {
        const result = await this.transport("receipt", row.ip, id, () => {
        }, row.action);
        if (result.quiescent === true && result.receiptOperationId === id) {
          this.finish(id, result);
          row = this.db.prepare("SELECT * FROM proxy_operations WHERE id=?").get(id);
        }
      } catch {
      }
    }
    const rows = this.db.prepare("SELECT seq,at,payload_json FROM proxy_events WHERE operation_id=? AND seq>? ORDER BY seq LIMIT 51").all(id, after);
    const events = rows.slice(0, 50).map((r) => ({ seq: r.seq, at: r.at, ...JSON.parse(r.payload_json) }));
    return {
      operationId: id,
      ip: row.ip,
      lineId: authorizeProxy(this.policy, row.ip).lineId,
      action: row.action,
      state: row.state,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      events,
      hasMore: rows.length > 50,
      nextAfter: events.at(-1)?.seq ?? after,
      result: row.result_json ? JSON.parse(row.result_json) : null
    };
  }
  async close() {
    await Promise.all(this.pending);
    this.db.close();
  }
};

// src/proxy-transport.ts
import { spawn } from "node:child_process";
import { readFile as readFile2, mkdtemp, rm, stat } from "node:fs/promises";
import { join as join2 } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
function tokenFromFile(text, key) {
  if (!key) return text.trim();
  const lines = text.split("\n").filter((line) => line.startsWith(key + "="));
  if (lines.length !== 1) throw new Error("credential-file-invalid");
  const value = lines[0].slice(key.length + 1).trim();
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}
async function rpc(policy, capability, tool, args, tokenFile, key) {
  const token = tokenFromFile(await privateFile(tokenFile), key);
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new Error("credential-file-invalid");
  const r = await fetch(policy.vaultOrigin + "/mcp/" + capability, {
    method: "POST",
    redirect: "error",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(25e3)
  });
  if (!r.ok) throw new Error("proxy-provider-http-" + r.status);
  const raw = await r.text();
  if (raw.length > 262144) throw new Error("proxy-provider-response-too-large");
  const body = JSON.parse(raw);
  if (body.error || body.result?.isError) throw new Error("proxy-provider-denied");
  for (const c of body.result?.content ?? []) if (c.type === "text") {
    try {
      const value = JSON.parse(c.text);
      if (value.ok === true) return value;
    } catch {
    }
  }
  throw new Error("proxy-provider-invalid-response");
}
async function proxyMaterial(policy, ip, action) {
  const node = authorizeProxy(policy, ip, action === "repair");
  const ssh = await rpc(policy, "fleet-onboard-vault", "vyibc-fleet-onboard-vault_resolve_ssh", { ip }, policy.sshResolveTokenFile, policy.sshResolveTokenKey);
  if (ssh.ip !== ip || ssh.username !== "claude" || ssh.source !== "vault" || typeof ssh.private_key !== "string" || ssh.private_key.length > 65536) throw new Error("managed-ssh-key-unavailable");
  const source = await rpc(policy, "vault", "vyibc-vault_get_config", { key: "clash:lines" }, policy.vaultTokenFile);
  if (!Array.isArray(source.value)) throw new Error("proxy-lines-invalid");
  const matches = source.value.filter((line2) => line2?.id === node.lineId);
  if (matches.length !== 1) throw new Error("approved-proxy-line-unavailable");
  const line = matches[0];
  if (typeof line.config_url !== "string" || line.config_url.length > 8192) throw new Error("approved-proxy-line-invalid");
  const url = new URL(line.config_url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !proxyIp.safeParse(line.expected_ip).success) throw new Error("approved-proxy-line-invalid");
  return { key: ssh.private_key.replace(/\n*$/, "\n"), line };
}
function capture(command, args, input, env, timeout, max = 262144) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", size = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > max) child.kill("SIGTERM");
      else stdout += b.toString();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}
function proxyTransport(policy) {
  return async (action, ip, operationId, emit, receiptAction) => {
    const untouched = action !== "receipt";
    if (!policy) return { ok: false, reason: "proxy-policy-unconfigured", quiescent: untouched };
    let material, source, machineId;
    try {
      material = await proxyMaterial(policy, ip, action);
      source = await readFile2(new URL("../src/proxy-remote.py", import.meta.url), "utf8");
      machineId = (await readFile2("/etc/machine-id", "utf8")).trim();
      if (!/^[a-f0-9]{32}$/.test(machineId)) throw new Error("operator-identity-unavailable");
      const known = await stat(policy.knownHostsFile);
      if (!known.isFile() || known.mode & 18) throw new Error("known-hosts-unavailable");
      const trusted = await capture("/usr/bin/ssh-keygen", ["-F", ip, "-f", policy.knownHostsFile], "", { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, 5e3, 65536);
      if (trusted.code !== 0) throw new Error("known-host-target-unavailable");
    } catch (e) {
      return { ok: false, reason: e instanceof Error && /^[a-z][a-z0-9-]{1,95}$/.test(e.message) ? e.message : "proxy-provider-or-host-configuration-unavailable", quiescent: untouched };
    }
    const dir = await mkdtemp(join2(tmpdir(), "dsh-proxy-agent-")), socket = join2(dir, "agent.sock");
    const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SSH_AUTH_SOCK: socket };
    const agent = spawn("/usr/bin/ssh-agent", ["-D", "-a", socket], { env, stdio: "ignore" });
    let agentFailed = false;
    agent.on("error", () => {
      agentFailed = true;
    });
    try {
      for (let i = 0; i < 40; i++) {
        if (agentFailed) break;
        if (await stat(socket).then((s) => s.isSocket()).catch(() => false)) break;
        await delay(50);
      }
      const added = await capture("/usr/bin/ssh-add", ["-"], material.key, env, 5e3, 1024);
      material.key = "";
      if (agentFailed || added.code !== 0) return { ok: false, reason: "ssh-agent-unavailable", quiescent: untouched };
      emit({ stage: "ssh-connect", lineId: material.line.id, expectedIp: material.line.expected_ip });
      const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
      const args = [
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentityFile=none",
        "-o",
        "IdentitiesOnly=no",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UserKnownHostsFile=" + policy.knownHostsFile,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ControlMaster=no",
        "claude@" + ip,
        "sudo -n /usr/bin/python3 -c " + quote(source)
      ];
      const input = JSON.stringify({
        action,
        operationId,
        operatorMachineId: machineId,
        lineId: material.line.id,
        ...action === "receipt" ? { receiptAction } : {},
        configUrl: material.line.config_url,
        expectedIp: material.line.expected_ip
      });
      return await new Promise((resolve) => {
        const child = spawn("/usr/bin/ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
        let buffer = "", bytes = 0, result;
        const timer = setTimeout(() => child.kill("SIGTERM"), 15e5);
        child.stdout.on("data", (data) => {
          bytes += data.length;
          if (bytes > 262144) {
            child.kill("SIGTERM");
            return;
          }
          buffer += data.toString();
          for (; ; ) {
            const i = buffer.indexOf("\n");
            if (i < 0) break;
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            try {
              const row = JSON.parse(line);
              if (row.event) emit(row.event);
              if (row.result) result = row.result;
            } catch {
            }
          }
        });
        child.stderr.resume();
        child.stdin.on("error", () => {
        });
        child.stdin.end(input);
        child.on("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, reason: "ssh-process-unavailable", quiescent: untouched });
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(result ?? { ok: false, reason: "ssh-outcome-unknown", quiescent: false });
        });
      });
    } finally {
      agent.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// src/proxy-mcp.ts
function createProxyMcp(service) {
  const server = new Server({ name: "vyibc-proxy", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: service.tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await service.call(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.ok === false };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: e instanceof Error && /^[a-z][a-z0-9-]{1,95}$/.test(e.message) ? e.message : "proxy-request-rejected" }) }], isError: true };
    }
  });
  return server;
}
async function main() {
  process.umask(63);
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--config")) throw new Error("invalid-startup-arguments");
  const policy = args.length ? await loadProxyPolicy(args[1]) : void 0;
  const service = await ProxyService.open(policy, proxyTransport(policy)), server = createProxyMcp(service);
  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => {
    void service.close();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => {
  process.stderr.write("proxy-mcp startup failed: check protected host policy\n");
  process.exitCode = 1;
});
export {
  createProxyMcp
};
