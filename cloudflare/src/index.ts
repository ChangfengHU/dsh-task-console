interface Env {
  DB: D1Database
  API_TOKEN: string
}

type Json = Record<string, unknown>

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: jsonHeaders })
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'JSON object required')
  return value as Json
}

function textField(body: Json, key: string, required = true): string {
  const value = typeof body[key] === 'string' ? body[key].trim() : ''
  if (required && !value) throw new ApiError(400, `${key} is required`)
  return value
}

function integerField(body: Json, key: string, fallback?: number): number {
  const value = body[key] ?? fallback
  if (!Number.isInteger(value)) throw new ApiError(400, `${key} must be an integer`)
  return value as number
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0)
}

function safeJson(value: unknown, fallback: unknown = {}): string {
  return JSON.stringify(value === undefined ? fallback : value)
}

async function sameToken(left: string, right: string): Promise<boolean> {
  const bytes = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const [a, b] = await Promise.all([bytes(left), bytes(right)])
  const aa = new Uint8Array(a); const bb = new Uint8Array(b)
  let diff = aa.length ^ bb.length
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) diff |= aa[i] ^ bb[i]
  return diff === 0
}

async function authorize(request: Request, env: Env): Promise<void> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!env.API_TOKEN || !token || !await sameToken(token, env.API_TOKEN)) throw new ApiError(401, 'unauthorized')
}

async function bodyOf(request: Request): Promise<Json> {
  try { return object(await request.json()) } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'valid JSON body required')
  }
}

async function refreshTasks(db: D1Database, taskIds: string[]): Promise<void> {
  const unique = [...new Set(taskIds)].filter(Boolean)
  if (!unique.length) return
  await db.batch(unique.map(taskId => db.prepare(`
    UPDATE tasks
    SET status = CASE
        WHEN EXISTS (
          SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id
          WHERE d.task_id = tasks.id AND p.status <> 'done'
        ) THEN 'waiting_dependency'
        WHEN EXISTS (
          SELECT 1 FROM task_gates g WHERE g.task_id = tasks.id AND g.phase = 'pre' AND g.status <> 'approved'
        ) THEN 'waiting_gate'
        ELSE 'ready'
      END,
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND status IN ('todo', 'waiting_dependency', 'waiting_gate', 'ready')
  `).bind(now(), taskId)))
}

async function taskIdForRun(db: D1Database, runId: string): Promise<string> {
  const row = await db.prepare('SELECT task_id FROM task_runs WHERE id = ?').bind(runId).first<{ task_id: string }>()
  if (!row) throw new ApiError(404, 'run not found')
  return row.task_id
}

async function transitionRun(db: D1Database, runId: string, body: Json, state: string): Promise<Response> {
  const claimToken = textField(body, 'claimToken')
  const stamp = now()
  const workerPid = textField(body, 'workerPid', false) || null
  const sessionId = textField(body, 'sessionId', false) || null
  const promptId = textField(body, 'promptId', false) || null
  const result = await db.prepare(`
    UPDATE task_runs
    SET status = ?, worker_pid = COALESCE(?, worker_pid), session_id = COALESCE(?, session_id),
        prompt_id = COALESCE(?, prompt_id), heartbeat_at = ?
    WHERE id = ? AND claim_token = ?
      AND status IN ('claimed', 'worker_started', 'session_created', 'prompt_dispatched', 'running')
      AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.current_run_id = task_runs.id
          AND t.claim_token = task_runs.claim_token AND t.status = 'running'
      )
  `).bind(state, workerPid, sessionId, promptId, stamp, runId, claimToken).run()
  if (!changes(result)) throw new ApiError(409, 'run ownership or state changed')
  await db.prepare(`
    UPDATE tasks SET claim_expires_at = ?, updated_at = ?, version = version + 1
    WHERE current_run_id = ? AND claim_token = ? AND status = 'running'
  `).bind(new Date(Date.now() + 120_000).toISOString(), stamp, runId, claimToken).run()
  return reply({ ok: true, runId, state })
}

async function snapshot(db: D1Database, boardId: string): Promise<Response> {
  const board = await db.prepare('SELECT * FROM boards WHERE id = ?').bind(boardId).first()
  if (!board) throw new ApiError(404, 'board not found')
  const [agents, groups, tasks, dependencies, gates, decisions, runs, handoffs, events, artifacts] = await db.batch([
    db.prepare('SELECT * FROM agents WHERE board_id = ? ORDER BY created_at').bind(boardId),
    db.prepare('SELECT * FROM task_groups WHERE board_id = ? ORDER BY created_at DESC').bind(boardId),
    db.prepare(`SELECT id, board_id, group_id, agent_id, title, description, status, priority, version,
      max_attempts, attempt_count, claim_owner, claim_expires_at, current_run_id, last_completed_run_id,
      created_at, updated_at FROM tasks WHERE board_id = ? ORDER BY priority DESC, created_at`).bind(boardId),
    db.prepare(`SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.board_id = ? ORDER BY d.created_at`).bind(boardId),
    db.prepare(`SELECT g.* FROM task_gates g JOIN tasks t ON t.id = g.task_id WHERE t.board_id = ? ORDER BY g.created_at`).bind(boardId),
    db.prepare(`SELECT d.* FROM gate_decisions d JOIN task_gates g ON g.id = d.gate_id JOIN tasks t ON t.id = g.task_id WHERE t.board_id = ? ORDER BY d.created_at`).bind(boardId),
    db.prepare(`SELECT r.id, r.task_id, r.agent_id, r.attempt, r.claimed_by, r.worker_pid, r.session_id,
      r.prompt_id, r.status, r.heartbeat_at, r.started_at, r.ended_at, r.outcome, r.summary, r.metadata, r.error
      FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE t.board_id = ? ORDER BY r.started_at DESC LIMIT 300`).bind(boardId),
    db.prepare(`SELECT h.* FROM run_handoff_inputs h JOIN task_runs r ON r.id = h.run_id JOIN tasks t ON t.id = r.task_id WHERE t.board_id = ?`).bind(boardId),
    db.prepare('SELECT * FROM task_events WHERE board_id = ? ORDER BY id DESC LIMIT 500').bind(boardId),
    db.prepare(`SELECT a.id, a.task_id, a.run_id, a.name, a.mime, a.size, a.sha256, a.public_url, a.created_at FROM task_artifacts a JOIN tasks t ON t.id = a.task_id WHERE t.board_id = ? ORDER BY a.created_at`).bind(boardId),
  ])
  return reply({
    board,
    agents: agents.results,
    groups: groups.results,
    tasks: tasks.results,
    dependencies: dependencies.results,
    gates: gates.results,
    decisions: decisions.results,
    runs: runs.results,
    handoffs: handoffs.results,
    events: [...events.results].reverse(),
    artifacts: artifacts.results,
  })
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (request.method === 'GET' && path === '/health') {
    await env.DB.prepare('SELECT 1').first()
    return reply({ ok: true, service: 'dsh-task-kernel', semantics: 'hermes-inspired-d1' })
  }
  await authorize(request, env)

  let match: RegExpExecArray | null
  if (request.method === 'GET' && (match = /^\/v1\/boards\/([^/]+)\/snapshot$/.exec(path))) {
    return snapshot(env.DB, decodeURIComponent(match[1]))
  }
  if (request.method === 'GET' && (match = /^\/v1\/runs\/([^/]+)\/context$/.exec(path))) {
    const runId = decodeURIComponent(match[1])
    const run = await env.DB.prepare(`SELECT id, task_id, agent_id, attempt, claimed_by, worker_pid, session_id,
      prompt_id, status, heartbeat_at, started_at, ended_at, outcome, summary, metadata, error
      FROM task_runs WHERE id = ?`).bind(runId).first()
    if (!run) throw new ApiError(404, 'run not found')
    const [task, parents, priorRuns] = await env.DB.batch([
      env.DB.prepare(`SELECT id, board_id, group_id, agent_id, title, description, status, priority, version,
        max_attempts, attempt_count, claim_owner, claim_expires_at, current_run_id, last_completed_run_id,
        created_at, updated_at FROM tasks WHERE id = ?`).bind((run as { task_id: string }).task_id),
      env.DB.prepare(`
        SELECT h.parent_task_id, h.parent_run_id, t.title, r.summary, r.metadata, r.outcome, r.ended_at
        FROM run_handoff_inputs h
        JOIN tasks t ON t.id = h.parent_task_id
        JOIN task_runs r ON r.id = h.parent_run_id
        WHERE h.run_id = ? ORDER BY t.created_at
      `).bind(runId),
      env.DB.prepare(`SELECT id, attempt, status, outcome, summary, metadata, error, started_at, ended_at
        FROM task_runs WHERE task_id = ? AND id <> ? ORDER BY attempt DESC`).bind((run as { task_id: string }).task_id, runId),
    ])
    return reply({ run, task: task.results[0] ?? null, parents: parents.results, priorAttempts: priorRuns.results })
  }

  if (request.method === 'POST' && path === '/v1/boards') {
    const body = await bodyOf(request); const boardId = textField(body, 'id', false) || id('board')
    await env.DB.prepare('INSERT INTO boards(id, name) VALUES (?, ?)').bind(boardId, textField(body, 'name')).run()
    return reply({ id: boardId }, 201)
  }
  if (request.method === 'POST' && path === '/v1/agents') {
    const body = await bodyOf(request); const agentId = textField(body, 'id', false) || id('agent')
    await env.DB.prepare(`INSERT INTO agents(id, board_id, name, role, avatar, color) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(agentId, textField(body, 'boardId'), textField(body, 'name'), textField(body, 'role'), textField(body, 'avatar', false) || '🤖', textField(body, 'color', false) || '#7c6cf2').run()
    return reply({ id: agentId }, 201)
  }
  if (request.method === 'POST' && path === '/v1/groups') {
    const body = await bodyOf(request); const groupId = textField(body, 'id', false) || id('group')
    await env.DB.prepare('INSERT INTO task_groups(id, board_id, title, description) VALUES (?, ?, ?, ?)')
      .bind(groupId, textField(body, 'boardId'), textField(body, 'title'), textField(body, 'description', false)).run()
    return reply({ id: groupId }, 201)
  }
  if (request.method === 'POST' && path === '/v1/tasks') {
    const body = await bodyOf(request); const taskId = textField(body, 'id', false) || id('task')
    const dependsOn = Array.isArray(body.dependsOn) ? [...new Set(body.dependsOn.map(String).filter(Boolean))] : []
    const gates = Array.isArray(body.gates) ? body.gates.map(object) : []
    const boardId = textField(body, 'boardId'); const groupId = textField(body, 'groupId'); const agentId = textField(body, 'agentId', false)
    const relationStatements: D1PreparedStatement[] = [env.DB.prepare('SELECT id FROM task_groups WHERE id = ? AND board_id = ?').bind(groupId, boardId)]
    if (agentId) relationStatements.push(env.DB.prepare('SELECT id FROM agents WHERE id = ? AND board_id = ?').bind(agentId, boardId))
    if (dependsOn.length) relationStatements.push(env.DB.prepare(`SELECT id FROM tasks WHERE board_id = ? AND id IN (${dependsOn.map(() => '?').join(',')})`).bind(boardId, ...dependsOn))
    const relations = await env.DB.batch(relationStatements)
    if (!relations[0].results.length || (agentId && !relations[1].results.length)) throw new ApiError(400, 'group or agent does not belong to board')
    if (dependsOn.length && relations[relations.length - 1].results.length !== dependsOn.length) throw new ApiError(400, 'every dependency must belong to board')
    const created = now()
    const statements: D1PreparedStatement[] = [env.DB.prepare(`
      INSERT INTO tasks(id, board_id, group_id, agent_id, title, description, status, priority, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, 'todo', ?, ?, ?, ?)
    `).bind(taskId, boardId, groupId, agentId, textField(body, 'title'), textField(body, 'description', false), integerField(body, 'priority', 0), integerField(body, 'maxAttempts', 3), created, created)]
    for (const parentId of dependsOn) statements.push(env.DB.prepare('INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)').bind(taskId, parentId))
    for (const gate of gates) statements.push(env.DB.prepare(`INSERT INTO task_gates(id, task_id, kind, title, policy, phase) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(textField(gate, 'id', false) || id('gate'), taskId, textField(gate, 'kind', false) || 'human_review', textField(gate, 'title'), safeJson(gate.policy), textField(gate, 'phase', false) || 'completion'))
    statements.push(env.DB.prepare(`
      UPDATE tasks SET status = CASE
          WHEN EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id WHERE d.task_id = tasks.id AND p.status <> 'done') THEN 'waiting_dependency'
          WHEN EXISTS (SELECT 1 FROM task_gates g WHERE g.task_id = tasks.id AND g.phase = 'pre' AND g.status <> 'approved') THEN 'waiting_gate'
          ELSE 'ready' END,
        version = version + 1, updated_at = ? WHERE id = ?
    `).bind(created, taskId))
    await env.DB.batch(statements)
    return reply({ id: taskId }, 201)
  }

  if (request.method === 'POST' && (match = /^\/v1\/tasks\/([^/]+)\/dependencies$/.exec(path))) {
    const taskId = decodeURIComponent(match[1]); const body = await bodyOf(request); const parentId = textField(body, 'dependsOnTaskId')
    const sameBoard = await env.DB.prepare(`SELECT 1 FROM tasks child JOIN tasks parent ON parent.id = ? AND parent.board_id = child.board_id WHERE child.id = ?`).bind(parentId, taskId).first()
    if (!sameBoard) throw new ApiError(400, 'dependency must belong to the same board')
    const cycle = await env.DB.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT ? UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN ancestors a ON d.task_id = a.id
      ) SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1
    `).bind(parentId, taskId).first()
    if (cycle) throw new ApiError(409, 'dependency would create a cycle')
    await env.DB.prepare('INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)').bind(taskId, parentId).run()
    await refreshTasks(env.DB, [taskId])
    return reply({ ok: true })
  }
  if (request.method === 'POST' && (match = /^\/v1\/tasks\/([^/]+)\/gates$/.exec(path))) {
    const taskId = decodeURIComponent(match[1]); const body = await bodyOf(request); const gateId = textField(body, 'id', false) || id('gate')
    await env.DB.prepare('INSERT INTO task_gates(id, task_id, kind, title, policy, phase) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(gateId, taskId, textField(body, 'kind', false) || 'human_review', textField(body, 'title'), safeJson(body.policy), textField(body, 'phase', false) || 'completion').run()
    await refreshTasks(env.DB, [taskId])
    return reply({ id: gateId }, 201)
  }
  if (request.method === 'POST' && (match = /^\/v1\/tasks\/([^/]+)\/claim$/.exec(path))) {
    const taskId = decodeURIComponent(match[1]); const body = await bodyOf(request)
    const version = integerField(body, 'version'); const agentId = textField(body, 'agentId'); const workerId = textField(body, 'workerId')
    const assignment = await env.DB.prepare(`SELECT 1 FROM tasks t JOIN agents a ON a.id = ? AND a.board_id = t.board_id WHERE t.id = ? AND (t.agent_id IS NULL OR t.agent_id = a.id)`).bind(agentId, taskId).first()
    if (!assignment) throw new ApiError(400, 'agent cannot claim this task')
    const runId = id('run'); const claimToken = crypto.randomUUID(); const stamp = now()
    const leaseSeconds = Math.min(900, Math.max(30, integerField(body, 'leaseSeconds', 120)))
    const row = await env.DB.prepare(`
      UPDATE tasks SET status = 'running', version = version + 1, attempt_count = attempt_count + 1, agent_id = COALESCE(agent_id, ?),
        claim_token = ?, claim_owner = ?, claim_expires_at = ?, current_run_id = ?, updated_at = ?
      WHERE id = ? AND status = 'ready' AND version = ? AND attempt_count < max_attempts
        AND (agent_id IS NULL OR agent_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id
          WHERE d.task_id = tasks.id AND p.status <> 'done'
        )
        AND NOT EXISTS (SELECT 1 FROM task_gates g WHERE g.task_id = tasks.id AND g.phase = 'pre' AND g.status <> 'approved')
      RETURNING id, status, version, attempt_count, current_run_id, claim_expires_at
    `).bind(agentId, claimToken, workerId, new Date(Date.now() + leaseSeconds * 1000).toISOString(), runId, stamp, taskId, version, agentId).first()
    if (!row) throw new ApiError(409, 'task was not claimable or CAS version lost')
    return reply({ task: row, runId, claimToken })
  }
  if (request.method === 'POST' && (match = /^\/v1\/tasks\/([^/]+)\/reclaim$/.exec(path))) {
    const taskId = decodeURIComponent(match[1]); const body = await bodyOf(request); const actor = textField(body, 'actor')
    const task = await env.DB.prepare(`SELECT current_run_id, claim_token FROM tasks WHERE id = ? AND status IN ('running', 'blocked') AND claim_expires_at <= ?`)
      .bind(taskId, now()).first<{ current_run_id: string; claim_token: string }>()
    if (!task) throw new ApiError(409, 'task has no stale claim')
    const stamp = now()
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE task_runs SET status = 'reclaimed', outcome = 'reclaimed', error = ?, ended_at = ? WHERE id = ? AND claim_token = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'reclaimed')`)
        .bind(`reclaimed by ${actor}`, stamp, task.current_run_id, task.claim_token),
      env.DB.prepare(`UPDATE tasks SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'ready' END,
        version = version + 1, claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL, current_run_id = NULL, updated_at = ?
        WHERE id = ? AND current_run_id = ? AND claim_token = ? AND claim_expires_at <= ?`)
        .bind(stamp, taskId, task.current_run_id, task.claim_token, stamp),
    ])
    if (!changes(results[1])) throw new ApiError(409, 'claim changed before reclaim')
    return reply({ ok: true })
  }

  if (request.method === 'POST' && (match = /^\/v1\/runs\/([^/]+)\/(worker-started|session-created|prompt-dispatched)$/.exec(path))) {
    const states: Record<string, string> = { 'worker-started': 'worker_started', 'session-created': 'session_created', 'prompt-dispatched': 'prompt_dispatched' }
    return transitionRun(env.DB, decodeURIComponent(match[1]), await bodyOf(request), states[match[2]])
  }
  if (request.method === 'POST' && (match = /^\/v1\/runs\/([^/]+)\/heartbeat$/.exec(path))) {
    const runId = decodeURIComponent(match[1]); const body = await bodyOf(request); const token = textField(body, 'claimToken'); const stamp = now()
    const leaseSeconds = Math.min(900, Math.max(30, integerField(body, 'leaseSeconds', 120)))
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE task_runs SET status = CASE WHEN status = 'prompt_dispatched' THEN 'running' ELSE status END, heartbeat_at = ?
        WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'worker_started', 'session_created', 'prompt_dispatched', 'running')`).bind(stamp, runId, token),
      env.DB.prepare(`UPDATE tasks SET claim_expires_at = ?, updated_at = ?, version = version + 1
        WHERE current_run_id = ? AND claim_token = ? AND status = 'running'`).bind(new Date(Date.now() + leaseSeconds * 1000).toISOString(), stamp, runId, token),
    ])
    if (!changes(results[0]) || !changes(results[1])) throw new ApiError(409, 'run ownership or state changed')
    return reply({ ok: true, expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
  }
  if (request.method === 'POST' && (match = /^\/v1\/runs\/([^/]+)\/complete$/.exec(path))) {
    const runId = decodeURIComponent(match[1]); const body = await bodyOf(request); const token = textField(body, 'claimToken')
    const summary = textField(body, 'summary'); const stamp = now(); const taskId = await taskIdForRun(env.DB, runId)
    const artifacts = Array.isArray(body.artifacts) ? body.artifacts.map(object).slice(0, 20) : []
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE task_runs SET status = 'completed', heartbeat_at = ?, ended_at = ?, outcome = 'done', summary = ?, metadata = ?
        WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'worker_started', 'session_created', 'prompt_dispatched', 'running')
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.current_run_id = task_runs.id AND t.claim_token = task_runs.claim_token AND t.status = 'running')`)
        .bind(stamp, stamp, summary, safeJson(body.metadata), runId, token),
      env.DB.prepare(`UPDATE tasks SET status = 'done', version = version + 1, last_completed_run_id = ?,
          claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL, current_run_id = NULL, updated_at = ?
        WHERE id = ? AND current_run_id = ? AND claim_token = ? AND status = 'running'
          AND EXISTS (SELECT 1 FROM task_runs r WHERE r.id = ? AND r.claim_token = ? AND r.status = 'completed')`)
        .bind(runId, stamp, taskId, runId, token, runId, token),
    ]
    for (const artifact of artifacts) statements.push(env.DB.prepare(`
      INSERT INTO task_artifacts(id, task_id, run_id, name, mime, size, sha256, local_path, public_url)
      SELECT ?, task_id, id, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, '')
      FROM task_runs WHERE id = ? AND claim_token = ? AND status = 'completed'
    `).bind(textField(artifact, 'id', false) || id('artifact'), textField(artifact, 'name'), textField(artifact, 'mime', false) || 'application/octet-stream', integerField(artifact, 'size', 0), textField(artifact, 'sha256', false), textField(artifact, 'localPath', false), textField(artifact, 'publicUrl', false), runId, token))
    const results = await env.DB.batch(statements)
    if (!changes(results[0]) || !changes(results[1])) throw new ApiError(409, 'run ownership or state changed')
    const children = await env.DB.prepare('SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?').bind(taskId).all<{ task_id: string }>()
    await refreshTasks(env.DB, children.results.map(row => row.task_id))
    return reply({ ok: true, taskId, runId })
  }
  if (request.method === 'POST' && (match = /^\/v1\/runs\/([^/]+)\/(block|review)$/.exec(path))) {
    const runId = decodeURIComponent(match[1]); const action = match[2]; const body = await bodyOf(request); const token = textField(body, 'claimToken')
    const summary = textField(body, action === 'block' ? 'reason' : 'summary'); const stamp = now(); const taskId = await taskIdForRun(env.DB, runId)
    const runStatus = action === 'block' ? 'blocked' : 'review'; const taskStatus = action === 'block' ? 'blocked' : 'review'
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE task_runs SET status = ?, heartbeat_at = ?, summary = ?, metadata = ?
        WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'worker_started', 'session_created', 'prompt_dispatched', 'running')`).bind(runStatus, stamp, summary, safeJson(body.metadata), runId, token),
      env.DB.prepare(`UPDATE tasks SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND current_run_id = ? AND claim_token = ? AND status = 'running'`).bind(taskStatus, stamp, taskId, runId, token),
    ]
    if (action === 'review') {
      const completionGate = await env.DB.prepare(`SELECT 1 FROM task_gates WHERE task_id = ? AND phase = 'completion' LIMIT 1`).bind(taskId).first()
      if (!completionGate) statements.push(env.DB.prepare(`INSERT INTO task_gates(id, task_id, kind, title, phase) VALUES (?, ?, 'human_review', '交付验收', 'completion')`).bind(id('gate'), taskId))
      statements.push(env.DB.prepare(`UPDATE task_gates SET status = 'pending', updated_at = ? WHERE task_id = ? AND phase = 'completion' AND status = 'changes_requested'`).bind(stamp, taskId))
    }
    const results = await env.DB.batch(statements)
    if (!changes(results[0]) || !changes(results[1])) throw new ApiError(409, 'run ownership or state changed')
    return reply({ ok: true, taskId, runId, status: taskStatus })
  }
  if (request.method === 'POST' && (match = /^\/v1\/runs\/([^/]+)\/resume$/.exec(path))) {
    const runId = decodeURIComponent(match[1]); const body = await bodyOf(request); const token = textField(body, 'claimToken'); const stamp = now()
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE task_runs SET status = 'running', heartbeat_at = ? WHERE id = ? AND claim_token = ? AND status = 'blocked'`).bind(stamp, runId, token),
      env.DB.prepare(`UPDATE tasks SET status = 'running', version = version + 1, claim_expires_at = ?, updated_at = ? WHERE current_run_id = ? AND claim_token = ? AND status = 'blocked'`).bind(new Date(Date.now() + 120_000).toISOString(), stamp, runId, token),
    ])
    if (!changes(results[0]) || !changes(results[1])) throw new ApiError(409, 'blocked run ownership changed')
    return reply({ ok: true })
  }

  if (request.method === 'POST' && (match = /^\/v1\/gates\/([^/]+)\/decide$/.exec(path))) {
    const gateId = decodeURIComponent(match[1]); const body = await bodyOf(request); const decision = textField(body, 'decision')
    if (!['approved', 'changes_requested', 'rejected'].includes(decision)) throw new ApiError(400, 'invalid gate decision')
    const gate = await env.DB.prepare(`SELECT g.task_id, g.phase, t.status AS task_status, t.current_run_id, t.claim_token FROM task_gates g JOIN tasks t ON t.id = g.task_id WHERE g.id = ? AND ((g.phase = 'pre' AND t.status = 'waiting_gate') OR (g.phase = 'completion' AND t.status = 'review'))`)
      .bind(gateId).first<{ task_id: string; phase: string; task_status: string; current_run_id: string | null; claim_token: string | null }>()
    if (!gate) throw new ApiError(409, 'gate is not awaiting review')
    const stamp = now(); const decisionId = id('decision')
    await env.DB.batch([
      env.DB.prepare('INSERT INTO gate_decisions(id, gate_id, decision, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(decisionId, gateId, decision, textField(body, 'actor'), textField(body, 'note', false), stamp),
      env.DB.prepare('UPDATE task_gates SET status = ?, updated_at = ? WHERE id = ?').bind(decision, stamp, gateId),
    ])
    const finished = await env.DB.prepare(`SELECT status FROM tasks WHERE id = ?`).bind(gate.task_id).first<{ status: string }>()
    if (finished?.status === 'done') {
      const children = await env.DB.prepare('SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?').bind(gate.task_id).all<{ task_id: string }>()
      await refreshTasks(env.DB, children.results.map(row => row.task_id))
    }
    return reply({ ok: true, decisionId })
  }

  throw new ApiError(404, 'not found')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env) }
    catch (error) {
      if (error instanceof ApiError) return reply({ error: error.message }, error.status)
      if (error instanceof Error && /(UNIQUE|FOREIGN KEY|CHECK) constraint failed/i.test(error.message)) return reply({ error: 'constraint violation' }, 409)
      console.error('request failed', error)
      return reply({ error: 'internal error' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
