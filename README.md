# dsh-task-console

任务台 for DeepSeek Harness (dsh).

**This release (0.6):** the run detail is evidence-first: final handoff and delivered files come first, followed by the role/dependency graph, selected session/tool ledger, and an always-visible activity stream. Files declared through `task_complete(..., artifacts)` are snapshotted under `~/.dsh/task-console/artifacts`, hashed, and can be previewed or downloaded in the browser. HTML files have a separate, explicit public-publish action; upload credentials stay on the host.

```sh
dsh plugin --profile web add github:ChangfengHU/dsh-task-console
```

Opens from the sidebar footer button 「任务台」; screens live in the URL hash (`#/tc/agents`, `#/tc/agents/<id>`, `#/tc/tasks`, `#/tc/tasks/<id>`).

**Talk to an agent from the composer:** type `@` in any composer, pick an agent, type the ask, Enter. That starts a new session on the agent's preset (a session's preset is fixed at creation in dsh, so "@agent" means "a fresh session with that agent") with your text as the first message, pins a readable title, files it under the current workspace, and switches to it. Agent cards also have 「开新会话」.

**Tasks (0.6):** the model follows Hermes' durable kanban vocabulary while keeping DSH's template and session layers:

- **Task** — a template: brief + ordered participants + trigger (once / cron).
- **Batch** — one firing of a task; it creates one **Card** per participant, chained by `deps` (a DAG underneath; the wizard makes a chain).
- **Run** — one attempt at a card = one real dsh session on that agent's preset. Retries add runs.
- **Event** — `~/.dsh/task-console/events.jsonl`, append-only; every screen is `fold(events)`, on the host and in the browser alike (the replay scrubber folds a prefix).

Each card's session gets three tools nobody else sees — `task_complete(summary, artifacts, metadata)`, `task_block(reason, kind)`, `task_request_review(summary, artifacts, metadata)` — registered on the agent's own scope after its preset is mounted. A run must end with one of them; a run that stops without one is nudged once, then fails as `protocol_violation`. `task_block(kind="needs_input")` parks the card; the person's next message in that session resumes it. Failures count toward a per-card breaker (`maxTries`), same-reason blocks recur at most 3 times, and a failed card cancels the rest of its chain.

`task_request_review` is a real gate: a card remains `review`, downstream dependencies stay closed, and the batch cannot settle until a person approves it. Returning changes records the reason and starts a new attempt on the same card. New runs also distinguish `run/claimed`, `run/session_created`, and `run/prompt_dispatched`; old event logs remain readable and valid file paths found in old handoffs appear as read-only "历史路径" artifacts.

Public HTML publishing reads `DSH_TASK_CONSOLE_UPLOAD_TOKEN` on the host. Optional overrides are `DSH_TASK_CONSOLE_UPLOAD_URL` and `DSH_TASK_CONSOLE_PUBLIC_DOMAIN`; no upload credential is sent to the browser or written into a task prompt.

The dispatcher ticks every minute (and on every settled run): promote cards whose deps are done → claim up to 3 in flight → start sessions → watchdog. On restart, runs that were live are marked `crashed`.

CLI-backed providers: `codex-local` calls the terminators fine; `claude-local` treats dsh tools as deferred and cannot, so agents on it should not take part in tasks (the wizard says so).

## Known limits

- MCP servers are ticked whole (no per-tool subset yet).
- If the host composition still runs an MCP server with the same `serverName`, the preset mounts it under `<server>-<id>` — every agent can still see the host copy until that row is removed.
- CLI-backed providers (`claude-local`, `codex-local`) bring their own Bash / Edit; dsh's fence cannot remove those. Provider-side sandboxing is the next step.
