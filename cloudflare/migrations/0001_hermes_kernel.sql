PRAGMA foreign_keys = ON;

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🤖',
  color TEXT NOT NULL DEFAULT '#7c6cf2',
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'blocked', 'waiting_review', 'offline')),
  current_task_id TEXT,
  current_run_id TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (board_id, name)
);

CREATE TABLE task_groups (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'done', 'failed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
    'todo', 'waiting_dependency', 'waiting_gate', 'ready', 'running',
    'blocked', 'review', 'done', 'failed', 'cancelled'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claim_owner TEXT,
  claim_expires_at TEXT,
  current_run_id TEXT,
  last_completed_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE task_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'human_review' CHECK (kind IN ('human_review', 'policy', 'test')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected')),
  policy TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE gate_decisions (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES task_gates(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  claimed_by TEXT NOT NULL,
  worker_pid TEXT,
  session_id TEXT,
  prompt_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN (
    'claimed', 'worker_started', 'session_created', 'prompt_dispatched', 'running',
    'blocked', 'review', 'completed', 'failed', 'timed_out', 'reclaimed', 'cancelled'
  )),
  heartbeat_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  summary TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE TABLE run_handoff_inputs (
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, parent_task_id)
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES task_groups(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  local_path TEXT,
  public_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tasks_group_status ON tasks(group_id, status);
CREATE INDEX idx_tasks_agent_status ON tasks(agent_id, status);
CREATE INDEX idx_dependencies_parent ON task_dependencies(depends_on_task_id);
CREATE INDEX idx_runs_task_started ON task_runs(task_id, started_at DESC);
CREATE INDEX idx_events_board_id ON task_events(board_id, id);
CREATE INDEX idx_events_task_id ON task_events(task_id, id);
CREATE INDEX idx_gates_task_status ON task_gates(task_id, status);

CREATE TRIGGER task_created_event
AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, agent_id, kind, payload)
  VALUES (NEW.board_id, NEW.group_id, NEW.id, NEW.agent_id, 'task_created', json_object('status', NEW.status, 'version', NEW.version));
END;

CREATE TRIGGER dependency_linked_event
AFTER INSERT ON task_dependencies
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, kind, payload)
  SELECT board_id, group_id, id, 'dependency_linked', json_object('dependsOnTaskId', NEW.depends_on_task_id)
  FROM tasks WHERE id = NEW.task_id;
END;

CREATE TRIGGER dependency_unlinked_event
AFTER DELETE ON task_dependencies
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, kind, payload)
  SELECT board_id, group_id, id, 'dependency_unlinked', json_object('dependsOnTaskId', OLD.depends_on_task_id)
  FROM tasks WHERE id = OLD.task_id;
END;

CREATE TRIGGER task_claim_creates_run
AFTER UPDATE OF status ON tasks
WHEN OLD.status = 'ready' AND NEW.status = 'running' AND NEW.current_run_id IS NOT NULL AND NEW.claim_token IS NOT NULL
BEGIN
  INSERT INTO task_runs(
    id, task_id, agent_id, attempt, claim_token, claimed_by, status,
    heartbeat_at, started_at
  ) VALUES (
    NEW.current_run_id, NEW.id, NEW.agent_id, NEW.attempt_count, NEW.claim_token,
    COALESCE(NEW.claim_owner, NEW.agent_id, 'unassigned'), 'claimed', NEW.updated_at, NEW.updated_at
  );
END;

CREATE TRIGGER run_claimed_projection
AFTER INSERT ON task_runs
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  SELECT t.board_id, t.group_id, t.id, NEW.id, NEW.agent_id, 'claimed',
         json_object('attempt', NEW.attempt, 'claimedBy', NEW.claimed_by)
  FROM tasks t WHERE t.id = NEW.task_id;

  INSERT INTO run_handoff_inputs(run_id, parent_task_id, parent_run_id)
  SELECT NEW.id, parent.id, parent.last_completed_run_id
  FROM task_dependencies dep
  JOIN tasks parent ON parent.id = dep.depends_on_task_id
  WHERE dep.task_id = NEW.task_id AND parent.last_completed_run_id IS NOT NULL;

  UPDATE agents
  SET status = 'running', current_task_id = NEW.task_id, current_run_id = NEW.id,
      heartbeat_at = NEW.heartbeat_at
  WHERE id = NEW.agent_id;
END;

CREATE TRIGGER run_status_event
AFTER UPDATE OF status ON task_runs
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  SELECT t.board_id, t.group_id, t.id, NEW.id, NEW.agent_id, NEW.status,
         json_object('from', OLD.status, 'outcome', NEW.outcome, 'error', NEW.error)
  FROM tasks t WHERE t.id = NEW.task_id;
END;

CREATE TRIGGER run_heartbeat_event
AFTER UPDATE OF heartbeat_at ON task_runs
WHEN OLD.heartbeat_at <> NEW.heartbeat_at
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  SELECT t.board_id, t.group_id, t.id, NEW.id, NEW.agent_id, 'heartbeat',
         json_object('at', NEW.heartbeat_at)
  FROM tasks t WHERE t.id = NEW.task_id;

  UPDATE agents SET heartbeat_at = NEW.heartbeat_at WHERE id = NEW.agent_id;
END;

CREATE TRIGGER task_status_event
AFTER UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  VALUES (
    NEW.board_id, NEW.group_id, NEW.id, NEW.current_run_id, NEW.agent_id,
    CASE NEW.status
      WHEN 'ready' THEN 'promoted'
      WHEN 'waiting_dependency' THEN 'waiting_dependency'
      WHEN 'waiting_gate' THEN 'waiting_gate'
      WHEN 'blocked' THEN 'blocked'
      WHEN 'review' THEN 'review_requested'
      WHEN 'done' THEN 'completed'
      WHEN 'failed' THEN 'failed'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE 'status_changed'
    END,
    json_object('from', OLD.status, 'to', NEW.status, 'version', NEW.version)
  );

  UPDATE agents
  SET status = CASE NEW.status
      WHEN 'blocked' THEN 'blocked'
      WHEN 'review' THEN 'waiting_review'
      WHEN 'running' THEN 'running'
      ELSE 'idle'
    END,
    current_task_id = CASE WHEN NEW.status IN ('running', 'blocked', 'review') THEN NEW.id ELSE NULL END,
    current_run_id = CASE WHEN NEW.status IN ('running', 'blocked', 'review') THEN NEW.current_run_id ELSE NULL END
  WHERE id = NEW.agent_id;
END;

CREATE TRIGGER gate_created_event
AFTER INSERT ON task_gates
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, kind, payload)
  SELECT board_id, group_id, id, 'gate_created', json_object('gateId', NEW.id, 'kind', NEW.kind, 'title', NEW.title)
  FROM tasks WHERE id = NEW.task_id;
END;

CREATE TRIGGER gate_decided_event
AFTER INSERT ON gate_decisions
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, kind, payload)
  SELECT t.board_id, t.group_id, t.id,
         CASE NEW.decision WHEN 'approved' THEN 'gate_approved' ELSE 'changes_requested' END,
         json_object('gateId', NEW.gate_id, 'decision', NEW.decision, 'actor', NEW.actor, 'note', NEW.note)
  FROM task_gates g JOIN tasks t ON t.id = g.task_id WHERE g.id = NEW.gate_id;
END;

CREATE TRIGGER artifact_registered_event
AFTER INSERT ON task_artifacts
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  SELECT t.board_id, t.group_id, t.id, NEW.run_id, r.agent_id, 'artifact_registered',
         json_object('artifactId', NEW.id, 'name', NEW.name, 'mime', NEW.mime, 'publicUrl', NEW.public_url)
  FROM tasks t JOIN task_runs r ON r.id = NEW.run_id WHERE t.id = NEW.task_id;
END;
