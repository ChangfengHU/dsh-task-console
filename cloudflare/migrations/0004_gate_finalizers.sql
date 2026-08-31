CREATE TRIGGER completion_gate_approved_finalizer
AFTER UPDATE OF status ON task_gates
WHEN NEW.phase = 'completion' AND NEW.status = 'approved' AND OLD.status <> NEW.status
  AND NOT EXISTS (
    SELECT 1 FROM task_gates other
    WHERE other.task_id = NEW.task_id AND other.phase = 'completion' AND other.status <> 'approved'
  )
BEGIN
  UPDATE task_runs
  SET status = 'completed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), outcome = 'done'
  WHERE id = (SELECT current_run_id FROM tasks WHERE id = NEW.task_id AND status = 'review')
    AND status = 'review';

  UPDATE tasks
  SET status = 'done', version = version + 1, last_completed_run_id = current_run_id,
      claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL, current_run_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.task_id AND status = 'review';
END;

CREATE TRIGGER completion_gate_rework_finalizer
AFTER UPDATE OF status ON task_gates
WHEN NEW.phase = 'completion' AND NEW.status IN ('changes_requested', 'rejected') AND OLD.status <> NEW.status
BEGIN
  UPDATE task_runs
  SET status = 'failed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      outcome = NEW.status, error = 'gate ' || NEW.status
  WHERE id = (SELECT current_run_id FROM tasks WHERE id = NEW.task_id AND status = 'review')
    AND status = 'review';

  UPDATE tasks
  SET status = CASE NEW.status WHEN 'rejected' THEN 'failed' ELSE 'ready' END,
      version = version + 1, claim_token = NULL, claim_owner = NULL,
      claim_expires_at = NULL, current_run_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.task_id AND status = 'review';
END;

CREATE TRIGGER pre_gate_finalizer
AFTER UPDATE OF status ON task_gates
WHEN NEW.phase = 'pre' AND OLD.status <> NEW.status
BEGIN
  UPDATE tasks
  SET status = CASE
      WHEN NEW.status = 'rejected' THEN 'failed'
      WHEN EXISTS (
        SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id
        WHERE d.task_id = NEW.task_id AND p.status <> 'done'
      ) THEN 'waiting_dependency'
      WHEN EXISTS (
        SELECT 1 FROM task_gates g
        WHERE g.task_id = NEW.task_id AND g.phase = 'pre' AND g.status <> 'approved'
      ) THEN 'waiting_gate'
      ELSE 'ready'
    END,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.task_id AND status IN ('waiting_dependency', 'waiting_gate', 'ready');
END;
