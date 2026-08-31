ALTER TABLE task_gates ADD COLUMN phase TEXT NOT NULL DEFAULT 'completion'
  CHECK (phase IN ('pre', 'completion'));
