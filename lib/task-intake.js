// src/task-intake.ts
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
var SAFE_KIND = /^[a-z][a-z0-9._-]{0,63}$/;
var SECRET_TEXT = /(?:\bauthorization\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:pass(?:word|wd)?|secret|api[_ -]?key|private[_ -]?key)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
var oneLine = (value, maximum) => String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").slice(0, maximum);
var noSecretText = (value, field) => {
  if (SECRET_TEXT.test(value)) throw new Error(`${field} \u4E0D\u5141\u8BB8\u5305\u542B\u51ED\u636E`);
  return value;
};
var iso = (value) => {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error("observedAt \u5FC5\u987B\u662F ISO \u65F6\u95F4");
  return new Date(parsed).toISOString();
};
function stringId(value, field) {
  const out = oneLine(value, 160);
  if (!ID.test(out)) throw new Error(`${field} \u4E0D\u5408\u6CD5`);
  return out;
}
function validateTaskSignal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("signal \u5FC5\u987B\u662F\u5BF9\u8C61");
  const input = raw;
  let items;
  if (input.items !== void 0) {
    if (!Array.isArray(input.items) || input.items.length > 32) throw new Error("items \u6700\u591A 32 \u9879");
    if (input.items.some((item) => !item || typeof item !== "object" || Object.hasOwn(item, "items"))) throw new Error("items \u4E0D\u5141\u8BB8\u5D4C\u5957\u6C47\u603B");
    items = input.items.map(validateTaskSignal);
    if (new Set(items.map((item) => item.id)).size !== items.length || items.some((item) => item.id === input.id)) throw new Error("items \u7684 Signal id \u5FC5\u987B\u552F\u4E00");
    if (input.incident || input.requiredExecutorTools) throw new Error("\u6C47\u603B\u4E0D\u7ED1\u5B9A\u5355\u4E2A Incident \u6216\u6267\u884C\u5DE5\u5177\uFF1B\u8FB9\u754C\u4FDD\u7559\u5728\u5404 item");
  }
  const requiredExecutorTools = input.requiredExecutorTools === void 0 ? void 0 : input.requiredExecutorTools;
  if (requiredExecutorTools !== void 0 && (!Array.isArray(requiredExecutorTools) || requiredExecutorTools.length > 32 || requiredExecutorTools.some((x) => typeof x !== "string" || !/^[A-Za-z][A-Za-z0-9_:-]{0,159}$/.test(x)))) throw new Error("requiredExecutorTools \u5FC5\u987B\u662F\u660E\u786E\u7684\u5DE5\u5177\u540D\u79F0\u5217\u8868");
  if (Number(input.schemaVersion) !== 1) throw new Error("\u53EA\u652F\u6301 Task Signal schemaVersion=1");
  const source = oneLine(input.source, 120);
  if (!source) throw new Error("source \u5FC5\u586B");
  const kind = oneLine(input.kind, 64).toLowerCase();
  if (!SAFE_KIND.test(kind)) throw new Error("kind \u4E0D\u5408\u6CD5");
  const goalRaw = input.goal;
  if (!goalRaw || typeof goalRaw !== "object" || Array.isArray(goalRaw)) throw new Error("goal \u5FC5\u586B");
  const goalInput = goalRaw;
  const title = noSecretText(oneLine(goalInput.title, 120), "goal.title");
  const objective = noSecretText(String(goalInput.objective ?? "").trim().slice(0, 12e3), "goal.objective");
  if (title.length < 2) throw new Error("goal.title \u81F3\u5C11 2 \u4E2A\u5B57\u7B26");
  if (objective.length < 8) throw new Error("goal.objective \u81F3\u5C11 8 \u4E2A\u5B57\u7B26");
  const goalKey = oneLine(goalInput.key, 160);
  if (goalKey && !ID.test(goalKey)) throw new Error("goal.key \u4E0D\u5408\u6CD5");
  let incident;
  if (input.incident !== void 0) {
    if (!input.incident || typeof input.incident !== "object" || Array.isArray(input.incident)) throw new Error("incident \u4E0D\u5408\u6CD5");
    const value = input.incident;
    const faultKind = oneLine(value.faultKind, 64).toLowerCase();
    if (!SAFE_KIND.test(faultKind)) throw new Error("incident.faultKind \u4E0D\u5408\u6CD5");
    incident = {
      id: stringId(value.id, "incident.id"),
      faultKind,
      state: oneLine(value.state, 40) || "confirmed",
      ...oneLine(value.severity, 24) ? { severity: oneLine(value.severity, 24) } : {},
      ...oneLine(value.summary, 1e3) ? { summary: noSecretText(oneLine(value.summary, 1e3), "incident.summary") } : {}
    };
  }
  const targets = (Array.isArray(input.targets) ? input.targets : []).slice(0, 32).map((rawTarget, index) => {
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) throw new Error(`targets[${index}] \u4E0D\u5408\u6CD5`);
    const target = rawTarget;
    const targetKind = oneLine(target.kind, 64).toLowerCase();
    if (!SAFE_KIND.test(targetKind)) throw new Error(`targets[${index}].kind \u4E0D\u5408\u6CD5`);
    return { kind: targetKind, id: stringId(target.id, `targets[${index}].id`), ...oneLine(target.label, 120) ? { label: oneLine(target.label, 120) } : {} };
  });
  const constraints = [...new Set((Array.isArray(input.constraints) ? input.constraints : []).map((value, index) => noSecretText(oneLine(value, 300), `constraints[${index}]`)).filter(Boolean))].slice(0, 32);
  const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 64).map((rawFact, index) => {
    if (!rawFact || typeof rawFact !== "object" || Array.isArray(rawFact)) throw new Error(`facts[${index}] \u4E0D\u5408\u6CD5`);
    const fact = rawFact;
    const name = oneLine(fact.name, 80);
    if (!name || /pass(word)?|secret|token|authorization|cookie|private.?key/i.test(name)) throw new Error(`facts[${index}].name \u4E0D\u5141\u8BB8`);
    const candidate = fact.value;
    if (candidate !== null && !["string", "number", "boolean"].includes(typeof candidate)) throw new Error(`facts[${index}].value \u53EA\u5141\u8BB8\u6807\u91CF`);
    return { name, value: typeof candidate === "string" ? noSecretText(oneLine(candidate, 1e3), `facts[${index}].value`) : candidate };
  });
  return {
    schemaVersion: 1,
    id: stringId(input.id, "id"),
    source,
    kind,
    observedAt: iso(input.observedAt),
    goal: { ...goalKey ? { key: goalKey } : {}, title, objective },
    ...incident ? { incident } : {},
    targets,
    constraints,
    facts,
    ...requiredExecutorTools ? { requiredExecutorTools: [...new Set(requiredExecutorTools)] } : {},
    ...items ? { items } : {}
  };
}
function validateTaskIntakeDecision(raw, context) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("decision \u5FC5\u987B\u662F\u5BF9\u8C61");
  const input = raw;
  const action = oneLine(input.action, 20);
  const reason = oneLine(input.reason, 1500);
  if (reason.length < 6) throw new Error("reason \u5FC5\u987B\u8BF4\u660E\u5224\u65AD\u4F9D\u636E");
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence \u5FC5\u987B\u5728 0..1");
  if (context.items) {
    if (action !== "batch" || !Array.isArray(input.decisions)) throw new Error("\u6C47\u603B\u5FC5\u987B\u63D0\u4EA4 batch \u51B3\u7B56");
    const seen = /* @__PURE__ */ new Set();
    const decisions = input.decisions.map((rawItem) => {
      const signalId = stringId(rawItem?.signalId, "decisions.signalId");
      const item = context.items.find((row) => row.signal.id === signalId);
      if (!item || seen.has(signalId)) throw new Error("\u53EA\u80FD\u51B3\u5B9A\u6C47\u603B\u4E2D\u7684\u552F\u4E00 Signal");
      seen.add(signalId);
      if (item.existing) {
        if (rawItem.keep !== true || rawItem.decision) throw new Error("\u5DF2\u6709\u63A5\u6536\u8BF7\u6C42\u5FC5\u987B keep\uFF0C\u4E0D\u5F97\u56E0\u518D\u6B21\u5DE1\u68C0\u91CD\u590D\u6267\u884C\uFF1B\u91CD\u8BD5\u987B\u6709\u65B0\u7684\u663E\u5F0F Signal");
        return { signalId, keep: true };
      }
      if (rawItem.keep) throw new Error("\u672A\u63A5\u6536\u8BF7\u6C42\u4E0D\u80FD\u5192\u5145\u5DF2\u6709\u5904\u7F6E");
      return { signalId, decision: validateTaskIntakeDecision(rawItem.decision, { ...item.context, agents: context.agents }) };
    });
    if (seen.size !== context.items.length) throw new Error("\u5FC5\u987B\u8BF4\u660E\u6BCF\u9879\u8BF7\u6C42\u7684\u5904\u7F6E\uFF0C\u4E0D\u80FD\u9057\u6F0F");
    return { action: "batch", reason, confidence, decisions };
  }
  if (!["create", "reuse", "triage"].includes(action)) throw new Error("action \u5FC5\u987B\u662F create / reuse / triage");
  if (action === "triage") return { action, reason, confidence };
  const workflow = input.workflow === "static-chain" ? "static-chain" : "dynamic-rounds";
  const participants = (Array.isArray(input.participants) ? input.participants : []).map((rawParticipant, index) => {
    if (!rawParticipant || typeof rawParticipant !== "object" || Array.isArray(rawParticipant)) throw new Error(`participants[${index}] \u4E0D\u5408\u6CD5`);
    const participant = rawParticipant;
    const agentId = stringId(participant.agentId, `participants[${index}].agentId`);
    if (!context.agents.some((agent) => agent.id === agentId)) throw new Error(`Agent \u4E0D\u5728\u53EF\u7528\u540D\u518C:${agentId}`);
    const role = oneLine(participant.role, 20);
    if (role && !["planner", "executor", "reviewer", "worker"].includes(role)) throw new Error(`participants[${index}].role \u4E0D\u5408\u6CD5`);
    return { agentId, ...role ? { role } : {}, ...oneLine(participant.brief, 1e3) ? { brief: oneLine(participant.brief, 1e3) } : {} };
  });
  if (!participants.length) throw new Error("\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A Agent");
  if (new Set(participants.map((row) => row.agentId)).size !== participants.length) throw new Error("\u540C\u4E00 Agent \u4E0D\u80FD\u5728\u4E00\u4E2A Turn \u91CD\u590D\u51FA\u73B0");
  if (workflow === "dynamic-rounds") {
    const expected = ["planner", "executor", "reviewer"];
    if (participants.length !== 3 || participants.some((row, index) => row.role !== expected[index])) throw new Error("\u52A8\u6001\u56DE\u5408\u5FC5\u987B\u4F9D\u6B21\u9009\u62E9 planner\u3001executor\u3001reviewer");
  }
  if (context.requiredExecutorTools?.length) {
    const executors = participants.filter((row) => row.role === "executor" || row.role === "worker");
    if (!executors.some((row) => {
      const agent = context.agents.find((agent2) => agent2.id === row.agentId);
      return context.requiredExecutorTools.every((tool) => agent.toolSchemas?.includes(tool));
    })) throw new Error("\u6267\u884C\u8005\u4E0D\u5177\u5907\u6240\u9700\u7684\u5B9E\u9645\u5DE5\u5177\uFF1B\u8BF7\u9009\u62E9\u6709\u80FD\u529B\u7684 Agent\uFF0C\u6216 triage\u3002\u4E0D\u5F97\u4EE5\u57FA\u7840\u88C5\u673A\u6216\u901A\u7528 shell \u66FF\u4EE3\u53D7\u9650\u5DE5\u5177\u3002");
    for (const row of participants.filter((row2) => row2.role === "planner" || row2.role === "reviewer")) {
      const agent = context.agents.find((agent2) => agent2.id === row.agentId);
      if (!context.requiredExecutorTools.every((tool) => agent.taskExpertise?.includes(tool))) {
        throw new Error(`${row.role} \u7684 taskExpertise \u4E0D\u8986\u76D6\u672C\u6B21\u6267\u884C\u5DE5\u5177\u5951\u7EA6\uFF1B\u8BF7\u9009\u62E9\u5BF9\u5E94\u9886\u57DF\u7684\u89C4\u5212/\u9A8C\u6536\u89D2\u8272\u6216 triage\uFF0C\u4E0D\u5F97\u8BA9\u57FA\u7840\u8282\u70B9\u89D2\u8272\u89C4\u5212 Runner \u90E8\u7F72\u3002`);
      }
    }
  }
  const objective = String(input.objective ?? "").trim().slice(0, 12e3);
  if (objective && objective.length < 8) throw new Error("objective \u81F3\u5C11 8 \u4E2A\u5B57\u7B26");
  const title = oneLine(input.title, 120);
  if (action === "create" && title.length < 2) throw new Error("create \u5FC5\u987B\u7ED9\u51FA title");
  let taskId;
  if (action === "reuse") {
    taskId = stringId(input.taskId, "taskId");
    if (!context.candidateTasks.some((task) => task.id === taskId)) throw new Error("\u53EA\u80FD\u590D\u7528\u4E0A\u4E0B\u6587\u4E2D\u5217\u51FA\u7684\u5019\u9009 Task");
    if (context.recommendedTaskId && taskId !== context.recommendedTaskId) throw new Error(`\u5F53\u524D Incident \u5DF2\u5173\u8054 ${context.recommendedTaskId}\uFF0C\u4E0D\u5F97\u6539\u7ED1\u5176\u4ED6 Task`);
  } else if (context.recommendedTaskId) {
    throw new Error(`\u5F53\u524D Incident \u5DF2\u5173\u8054 ${context.recommendedTaskId}\uFF0C\u5E94\u590D\u7528\u800C\u4E0D\u662F\u65B0\u5EFA`);
  }
  return {
    action,
    reason,
    confidence,
    ...taskId ? { taskId } : {},
    ...title ? { title } : {},
    ...objective ? { objective } : {},
    workflow,
    participants
  };
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
var TaskIntakeCoordinator = class {
  runner;
  options;
  active = /* @__PURE__ */ new Map();
  /** One bounded routing queue prevents concurrent Signals from racing the same Incident/goal decision. */
  decisionQueue = Promise.resolve();
  constructor(runner, options) {
    this.runner = runner;
    this.options = options;
  }
  now() {
    return Math.floor((this.options.now?.() ?? Date.now()) / 1e3);
  }
  workspace() {
    return this.options.workspace ?? process.env.DSH_TASK_INTAKE_WORKSPACE ?? join(homedir(), ".dsh", "task-console", "intake-workspace");
  }
  async start() {
    const db = this.runner.store.kernel.db;
    this.runner.store.kernel.write(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dsh_task_signals (
          signal_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          source TEXT NOT NULL,
          signal_kind TEXT NOT NULL,
          incident_id TEXT,
          goal_key TEXT,
          signal_json TEXT NOT NULL,
          status TEXT NOT NULL,
          intake_session_id TEXT,
          input_message_id TEXT,
          delivered_at INTEGER,
          parent_signal_id TEXT,
          decision_json TEXT,
          task_id TEXT,
          batch_id TEXT,
          error TEXT,
          received_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signals_status ON dsh_task_signals(status, received_at);
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signals_incident ON dsh_task_signals(incident_id, received_at);
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signals_goal ON dsh_task_signals(goal_key, received_at);
        CREATE TABLE IF NOT EXISTS dsh_task_signal_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_signal_events_signal ON dsh_task_signal_events(signal_id, id);
        CREATE TABLE IF NOT EXISTS dsh_task_incident_links (
          incident_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          first_signal_id TEXT NOT NULL,
          last_signal_id TEXT NOT NULL,
          incident_state TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (incident_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_incident_task ON dsh_task_incident_links(task_id, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_task_incident_one_task ON dsh_task_incident_links(incident_id);
        CREATE TABLE IF NOT EXISTS dsh_task_targets (
          task_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          label TEXT,
          first_signal_id TEXT NOT NULL,
          last_signal_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, target_kind, target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dsh_task_targets_resource ON dsh_task_targets(target_kind, target_id, updated_at);
      `);
      const columns = new Set(db.prepare("PRAGMA table_info(dsh_task_signals)").all().map((row) => row.name));
      if (!columns.has("input_message_id")) db.exec("ALTER TABLE dsh_task_signals ADD COLUMN input_message_id TEXT");
      if (!columns.has("delivered_at")) db.exec("ALTER TABLE dsh_task_signals ADD COLUMN delivered_at INTEGER");
      if (!columns.has("parent_signal_id")) db.exec("ALTER TABLE dsh_task_signals ADD COLUMN parent_signal_id TEXT");
      const interrupted = db.prepare(`SELECT signal_id FROM dsh_task_signals WHERE status IN ('deciding','materializing')`).all();
      const reset = db.prepare(`UPDATE dsh_task_signals SET status='received', error=NULL, updated_at=? WHERE signal_id=?`);
      const event = db.prepare(`INSERT INTO dsh_task_signal_events(signal_id, kind, payload_json, created_at) VALUES (?, 'recovered', ?, ?)`);
      for (const row of interrupted) {
        reset.run(this.now(), row.signal_id);
        event.run(row.signal_id, JSON.stringify({ reason: "host_restart" }), this.now());
      }
    });
    const pending = db.prepare(`SELECT signal_id FROM dsh_task_signals WHERE status='received' AND parent_signal_id IS NULL ORDER BY received_at`).all();
    for (const row of pending) this.kick(row.signal_id);
  }
  async submit(raw) {
    const signal = validateTaskSignal(raw);
    const db = this.runner.store.kernel.db;
    const now = this.now();
    const encoded = JSON.stringify(signal);
    if (Buffer.byteLength(encoded) > 64 * 1024) throw Object.assign(new Error("Signal \u8D85\u8FC7 64 KiB"), { status: 413 });
    for (const item of signal.items ?? []) {
      const existing = db.prepare("SELECT signal_json FROM dsh_task_signals WHERE signal_id=?").get(item.id);
      if (existing && existing.signal_json !== JSON.stringify(item)) throw Object.assign(new Error("\u6C47\u603B item \u5DF2\u5B58\u5728\uFF0C\u4F46\u5185\u5BB9\u4E0D\u540C"), { status: 409 });
    }
    const inserted = this.runner.store.kernel.write(() => {
      const result = db.prepare(`INSERT OR IGNORE INTO dsh_task_signals(
        signal_id,schema_version,source,signal_kind,incident_id,goal_key,signal_json,status,received_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'received',?,?)`).run(
        signal.id,
        signal.schemaVersion,
        signal.source,
        signal.kind,
        signal.incident?.id ?? null,
        signal.goal.key ?? null,
        encoded,
        now,
        now
      );
      if (result.changes) db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'received',?,?)`).run(signal.id, JSON.stringify({ source: signal.source, kind: signal.kind, incident_id: signal.incident?.id ?? null }), now);
      return result.changes === 1;
    });
    if (!inserted) {
      const existing = db.prepare("SELECT signal_json FROM dsh_task_signals WHERE signal_id=?").get(signal.id);
      if (!existing || existing.signal_json !== encoded) throw Object.assign(new Error("Signal id \u5DF2\u5B58\u5728\uFF0C\u4F46\u5185\u5BB9\u4E0D\u540C"), { status: 409 });
    }
    if (inserted) this.kick(signal.id);
    return this.get(signal.id);
  }
  get(signalId) {
    const row = this.runner.store.kernel.db.prepare("SELECT * FROM dsh_task_signals WHERE signal_id=?").get(signalId);
    return row ? this.view(row) : void 0;
  }
  list(limit = 50) {
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.runner.store.kernel.db.prepare("SELECT * FROM dsh_task_signals ORDER BY received_at DESC, signal_id DESC LIMIT ?").all(size).map((row) => this.view(row));
  }
  events(signalId) {
    const rows = this.runner.store.kernel.db.prepare("SELECT id,kind,payload_json,created_at FROM dsh_task_signal_events WHERE signal_id=? ORDER BY id").all(signalId);
    return rows.map((row) => ({ id: row.id, kind: row.kind, at: new Date(row.created_at * 1e3).toISOString(), payload: parseJson(row.payload_json, {}) }));
  }
  async wait(signalId, timeoutMs = 3e5) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const row = this.get(signalId);
      if (!row) throw new Error("\u6CA1\u6709\u8FD9\u4E2A Task Signal");
      if (["materialized", "needs_triage", "failed"].includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("\u7B49\u5F85 Task Intake \u51B3\u7B56\u8D85\u65F6");
  }
  context(signal, agents) {
    if (signal.items) {
      return {
        policy: ["One report, one Task Intake Session. Existing accepted Signals are retained, never retried by repeated inspections. Independent items may create or reuse different goal Tasks."],
        agents: agents.filter((agent) => agent.id !== "task-intake"),
        candidateTasks: [],
        items: signal.items.map((item) => ({ signal: item, context: { ...this.context(item, agents), agents: [] }, existing: this.get(item.id) }))
      };
    }
    const db = this.runner.store.kernel.db;
    const direct = signal.incident?.id ? db.prepare(`SELECT task_id FROM dsh_task_incident_links WHERE incident_id=? ORDER BY updated_at DESC`).all(signal.incident.id).map((row) => row.task_id) : [];
    const targetMatches = /* @__PURE__ */ new Set();
    for (const target of signal.targets) for (const row of db.prepare(`SELECT task_id FROM dsh_task_targets WHERE target_kind=? AND target_id=?`).all(target.kind, target.id)) targetMatches.add(row.task_id);
    const goalMatches = signal.goal.key ? new Set(db.prepare(`SELECT DISTINCT task_id FROM dsh_task_signals WHERE goal_key=? AND task_id IS NOT NULL`).all(signal.goal.key).map((row) => row.task_id)) : /* @__PURE__ */ new Set();
    const candidates = [];
    for (const task of this.runner.store.s.tasks.values()) {
      const batches = [...this.runner.store.s.batches.values()].filter((batch) => batch.taskId === task.id).sort((a, b) => b.firedAt.localeCompare(a.firedAt));
      const active = batches.some((batch) => !batch.settled);
      const latest = batches[0];
      const state = active ? "active" : latest?.settled?.outcome === "done" ? "done" : latest?.settled ? "failed" : "idle";
      const incidentIds = db.prepare("SELECT incident_id FROM dsh_task_incident_links WHERE task_id=? ORDER BY updated_at DESC").all(task.id).map((row) => row.incident_id);
      const targets = db.prepare("SELECT target_kind AS kind,target_id AS id,label FROM dsh_task_targets WHERE task_id=? ORDER BY updated_at DESC").all(task.id).map((row) => ({ kind: row.kind, id: row.id, ...row.label ? { label: row.label } : {} }));
      const reasons = [];
      let score = active ? 5 : 0;
      if (direct.includes(task.id)) {
        score += 100;
        reasons.push("same incident lifecycle");
      }
      if (goalMatches.has(task.id)) {
        score += 40;
        reasons.push("same goal key");
      }
      if (targetMatches.has(task.id)) {
        score += 10;
        reasons.push("overlapping target; target is not identity");
      }
      if (score || candidates.length < 12) candidates.push({ id: task.id, title: task.title, objective: task.brief, state, graphMode: task.graphMode ?? "static-chain", participantIds: task.participants.map((row) => row.agentId), incidentIds, targets, score, reasons });
    }
    candidates.sort((a, b) => b.score - a.score || Number(a.state !== "active") - Number(b.state !== "active") || a.id.localeCompare(b.id));
    const usable = agents.filter((agent) => agent.id !== "task-intake");
    const recommendedTaskId = direct.find((id) => this.runner.store.s.tasks.has(id));
    return {
      policy: [
        "Task identity is a durable goal/root-cause boundary; never use a node, IP, account, or other target as the Task identity.",
        "Reuse a Task for a later Turn only when it continues the same goal or incident lifecycle. A target overlap alone is weak evidence.",
        "Create a Task for an independent goal/root cause or when no semantically matching Task exists.",
        "Select only registered Agents and never expand their configured Tool, MCP, Skill, or permission boundaries.",
        "When evidence is insufficient, choose triage instead of silently merging unrelated work."
      ],
      agents: usable,
      ...signal.requiredExecutorTools?.length ? { requiredExecutorTools: signal.requiredExecutorTools } : {},
      candidateTasks: candidates.slice(0, 20),
      ...recommendedTaskId ? { recommendedTaskId } : {}
    };
  }
  view(row) {
    const batch = row.batch_id ? this.runner.store.s.batches.get(row.batch_id) : void 0;
    const cards = batch?.cardIds.map((id) => this.runner.store.s.cards.get(id)) ?? [];
    const blocked = cards.some((card) => card?.status === "blocked") && !cards.some((card) => card?.status === "running");
    const runState = !row.batch_id ? void 0 : !batch ? "missing" : !batch.settled ? blocked ? "blocked" : "active" : batch.settled.outcome === "done" ? "done" : "failed";
    return {
      signal: parseJson(row.signal_json, {}),
      status: row.status,
      intakeAgentId: "task-intake",
      receivedAt: new Date(row.received_at * 1e3).toISOString(),
      updatedAt: new Date(row.updated_at * 1e3).toISOString(),
      ...row.intake_session_id ? { intakeSessionId: row.intake_session_id } : {},
      ...row.input_message_id ? { inputMessageId: row.input_message_id } : {},
      ...row.delivered_at ? { deliveredAt: new Date(row.delivered_at * 1e3).toISOString() } : {},
      ...parseJson(row.signal_json, {}).items ? {
        intakeProtocol: "bundle-v1",
        items: parseJson(row.signal_json, {}).items.map((item) => this.get(item.id)).filter((item) => Boolean(item))
      } : {},
      ...row.decision_json ? { decision: parseJson(row.decision_json, {}) } : {},
      ...row.task_id ? { taskId: row.task_id } : {},
      ...row.batch_id ? { batchId: row.batch_id } : {},
      ...row.error ? { error: row.error } : {},
      ...runState ? { runState } : {}
    };
  }
  kick(signalId) {
    if (this.active.has(signalId)) return;
    const work = this.decisionQueue.catch(() => void 0).then(() => this.process(signalId));
    this.decisionQueue = work.catch(() => void 0);
    void work.finally(() => this.active.delete(signalId)).catch(() => void 0);
    this.active.set(signalId, work);
    void work.catch(() => void 0);
  }
  transition(signalId, from, to, kind, payload) {
    const db = this.runner.store.kernel.db;
    return this.runner.store.kernel.write(() => {
      const marks = from.map(() => "?").join(",");
      const result = db.prepare(`UPDATE dsh_task_signals SET status=?, updated_at=?, error=NULL WHERE signal_id=? AND status IN (${marks})`).run(to, this.now(), signalId, ...from);
      if (result.changes) db.prepare("INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,?,?,?)").run(signalId, kind, payload ? JSON.stringify(payload) : null, this.now());
      return result.changes === 1;
    });
  }
  fail(signalId, error) {
    const message = oneLine(error instanceof Error ? error.message : error, 2e3) || "Task Intake failed";
    const db = this.runner.store.kernel.db;
    this.runner.store.kernel.write(() => {
      db.prepare(`UPDATE dsh_task_signals SET status='failed',error=?,updated_at=? WHERE signal_id=? AND status NOT IN ('materialized','needs_triage')`).run(message, this.now(), signalId);
      db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'failed',?,?)`).run(signalId, JSON.stringify({ error: message }), this.now());
    });
  }
  async process(signalId) {
    if (!this.transition(signalId, ["received"], "deciding", "decision_started")) return;
    try {
      const row = this.get(signalId);
      if (!row) throw new Error("Task Signal disappeared");
      const agents = await this.options.agents();
      const context = this.context(row.signal, agents);
      const routed = row.decision && row.intakeSessionId ? { decision: row.decision, sessionId: row.intakeSessionId } : await this.options.decide(row.signal, context, {
        onSessionReady: (sessionId) => this.recordDelivery(signalId, sessionId),
        onInputDelivered: (messageId) => this.recordDelivery(signalId, void 0, messageId)
      });
      const decision = row.decision && row.intakeSessionId ? row.decision : validateTaskIntakeDecision(routed.decision, context);
      const db = this.runner.store.kernel.db;
      this.runner.store.kernel.write(() => {
        db.prepare(`UPDATE dsh_task_signals SET intake_session_id=?,decision_json=?,updated_at=? WHERE signal_id=? AND status='deciding'`).run(routed.sessionId, JSON.stringify(decision), this.now(), signalId);
        db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'decision_recorded',?,?)`).run(signalId, JSON.stringify({ session_id: routed.sessionId, decision }), this.now());
      });
      if (decision.action === "triage") {
        this.transition(signalId, ["deciding"], "needs_triage", "triage_required", { reason: decision.reason, confidence: decision.confidence });
        return;
      }
      if (!this.transition(signalId, ["deciding"], "materializing", "materialization_started", { action: decision.action })) throw new Error("Task Signal \u72B6\u6001\u5DF2\u6539\u53D8");
      if (row.signal.items) {
        for (const item of decision.decisions) {
          if (item.keep) continue;
          const signal = row.signal.items.find((value) => value.id === item.signalId);
          this.runner.store.kernel.write(() => {
            db.prepare(`INSERT OR IGNORE INTO dsh_task_signals(signal_id,schema_version,source,signal_kind,incident_id,goal_key,signal_json,status,intake_session_id,decision_json,parent_signal_id,received_at,updated_at)
              VALUES (?,?,?,?,?,?,?,'deciding',?,?,?,?,?)`).run(signal.id, 1, signal.source, signal.kind, signal.incident?.id ?? null, signal.goal.key ?? null, JSON.stringify(signal), routed.sessionId, JSON.stringify(item.decision), signalId, this.now(), this.now());
          });
          const current = this.get(signal.id);
          if (JSON.stringify(current.signal) !== JSON.stringify(signal)) throw new Error("\u6C47\u603B item \u5728\u51B3\u7B56\u671F\u95F4\u53D1\u751F Signal id \u5185\u5BB9\u51B2\u7A81");
          if (["materialized", "needs_triage"].includes(current.status)) continue;
          if (item.decision.action === "triage") this.transition(signal.id, ["received", "deciding"], "needs_triage", "triage_required", { reason: item.decision.reason });
          else {
            this.transition(signal.id, ["received", "deciding"], "materializing", "materialization_started", { parentSignalId: signalId });
            await this.materialize(signal, item.decision, routed.sessionId);
          }
        }
        this.transition(signalId, ["materializing"], "materialized", "report_routed", { sessionId: routed.sessionId });
      } else await this.materialize(row.signal, decision, routed.sessionId);
    } catch (error) {
      this.fail(signalId, error);
    }
  }
  /** Persist the Session before routing finishes; a failed Agent must remain inspectable. */
  recordDelivery(signalId, sessionId, messageId) {
    const db = this.runner.store.kernel.db;
    this.runner.store.kernel.write(() => {
      if (sessionId) db.prepare("UPDATE dsh_task_signals SET intake_session_id=?,updated_at=? WHERE signal_id=?").run(sessionId, this.now(), signalId);
      if (messageId) db.prepare("UPDATE dsh_task_signals SET input_message_id=?,delivered_at=?,updated_at=? WHERE signal_id=?").run(messageId, this.now(), this.now(), signalId);
      db.prepare("INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,?,?,?)").run(signalId, sessionId ? "session_ready" : "input_delivered", JSON.stringify(sessionId ? { sessionId } : { messageId }), this.now());
    });
  }
  async materialize(signal, decision, sessionId) {
    if (decision.action !== "create" && decision.action !== "reuse") throw new Error("\u53EA\u6709 create/reuse \u53EF\u4EE5\u751F\u6210 Task \u6267\u884C");
    const participants = decision.participants.map((row) => ({ agentId: row.agentId, ...row.brief ? { brief: row.brief } : {} }));
    const graphMode = decision.workflow ?? "dynamic-rounds";
    const taskId = decision.action === "reuse" ? decision.taskId : `T-intake-${hash(signal.id)}`;
    const existing = this.runner.store.s.tasks.get(taskId);
    if (decision.action === "reuse") {
      if (!existing) throw new Error("\u8981\u590D\u7528\u7684 Task \u5DF2\u4E0D\u5B58\u5728");
      if ((existing.graphMode ?? "static-chain") !== graphMode) throw new Error("\u590D\u7528 Turn \u7684 workflow \u5FC5\u987B\u4E0E\u5DF2\u6709 Task \u4E00\u81F4");
    } else if (!existing) {
      const at = new Date(this.now() * 1e3).toISOString();
      const origin2 = { source: signal.source, signalId: signal.id, ...signal.incident ? { incidentId: signal.incident.id } : {}, intakeSessionId: sessionId, decision: "create", reason: decision.reason };
      const task2 = {
        id: taskId,
        title: decision.title || signal.goal.title,
        brief: decision.objective || signal.goal.objective,
        trigger: { kind: "once" },
        participants,
        graphMode,
        cwd: this.workspace(),
        timeoutSec: Math.min(Math.max(this.options.timeoutSec ?? (Number(process.env.DSH_TASK_INTAKE_TIMEOUT_SEC) || 1800), 60), 21600),
        onFail: "retry",
        maxTries: 2,
        enabled: true,
        createdAt: at,
        origin: origin2
      };
      await mkdir(task2.cwd, { recursive: true, mode: 448 });
      await this.runner.store.append({ t: "task/created", at, taskId, task: task2 });
    }
    const task = this.runner.store.s.tasks.get(taskId);
    if (!task) throw new Error("Task materialization failed");
    await mkdir(this.workspace(), { recursive: true, mode: 448 });
    const origin = { source: signal.source, signalId: signal.id, ...signal.incident ? { incidentId: signal.incident.id } : {}, intakeSessionId: sessionId, decision: decision.action, reason: decision.reason };
    const turn = {
      objective: decision.objective || signal.goal.objective,
      participants,
      targets: signal.targets,
      origin
    };
    const batchId = `b-intake-${hash(signal.id)}`;
    const batch = await this.runner.fire(taskId, "manual", { batchId, turn });
    const db = this.runner.store.kernel.db;
    this.runner.store.kernel.write(() => {
      const now = this.now();
      if (signal.incident) db.prepare(`INSERT INTO dsh_task_incident_links(incident_id,task_id,first_signal_id,last_signal_id,incident_state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(incident_id,task_id) DO UPDATE SET last_signal_id=excluded.last_signal_id,incident_state=excluded.incident_state,updated_at=excluded.updated_at`).run(signal.incident.id, taskId, signal.id, signal.id, signal.incident.state, now, now);
      for (const target of signal.targets) db.prepare(`INSERT INTO dsh_task_targets(task_id,target_kind,target_id,label,first_signal_id,last_signal_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id,target_kind,target_id) DO UPDATE SET label=COALESCE(excluded.label,dsh_task_targets.label),last_signal_id=excluded.last_signal_id,updated_at=excluded.updated_at`).run(taskId, target.kind, target.id, target.label ?? null, signal.id, signal.id, now, now);
      const updated = db.prepare(`UPDATE dsh_task_signals SET status='materialized',task_id=?,batch_id=?,updated_at=?,error=NULL WHERE signal_id=? AND status='materializing'`).run(taskId, batch.id, now, signal.id);
      if (updated.changes !== 1) throw new Error("Task Signal materialization lost its claim");
      db.prepare(`INSERT INTO dsh_task_signal_events(signal_id,kind,payload_json,created_at) VALUES (?,'materialized',?,?)`).run(signal.id, JSON.stringify({ task_id: taskId, batch_id: batch.id, action: decision.action }), now);
    });
  }
};
export {
  TaskIntakeCoordinator,
  validateTaskIntakeDecision,
  validateTaskSignal
};
