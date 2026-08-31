DROP TRIGGER run_status_event;
DROP TRIGGER task_status_event;

CREATE TRIGGER run_status_event
AFTER UPDATE OF status ON task_runs
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  SELECT t.board_id, t.group_id, t.id, NEW.id, NEW.agent_id,
         CASE NEW.status WHEN 'review' THEN 'review_requested' ELSE NEW.status END,
         json_object('from', OLD.status, 'outcome', NEW.outcome, 'error', NEW.error)
  FROM tasks t WHERE t.id = NEW.task_id;
END;

CREATE TRIGGER task_status_event
AFTER UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO task_events(board_id, group_id, task_id, run_id, agent_id, kind, payload)
  VALUES (
    NEW.board_id, NEW.group_id, NEW.id, NEW.current_run_id, NEW.agent_id,
    CASE NEW.status
      WHEN 'ready' THEN 'task_promoted'
      WHEN 'waiting_dependency' THEN 'task_waiting_dependency'
      WHEN 'waiting_gate' THEN 'task_waiting_gate'
      WHEN 'blocked' THEN 'task_blocked'
      WHEN 'review' THEN 'task_review_state'
      WHEN 'done' THEN 'task_completed'
      WHEN 'failed' THEN 'task_failed'
      WHEN 'cancelled' THEN 'task_cancelled'
      ELSE 'task_state_changed'
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
