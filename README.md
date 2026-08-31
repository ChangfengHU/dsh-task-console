# dsh-task-console

任务台 for DeepSeek Harness (dsh).

**This release (0.1):** author agents as real dsh presets. The editor's tool / MCP / skill choices are written to `~/.dsh/.agent-presets/<id>/agent.cordis.yml` — the composition dsh mounts — so a tool that is not ticked has no schema at all. "试跑" starts a real session on the preset and reports the exact tool list dsh handed the model (`request/header`), not what the model claims.

**Next:** tasks (brief + ordered participants + once / cron trigger) → run ledger → board.

```sh
dsh plugin --profile web add github:ChangfengHU/dsh-task-console
```

Opens from the sidebar footer button 「任务台」; screens live in the URL hash (`#/tc/agents`, `#/tc/agents/<id>`, `#/tc/tasks`, `#/tc/tasks/<id>`).

**Talk to an agent from the composer:** type `@` in any composer, pick an agent, type the ask, Enter. That starts a new session on the agent's preset (a session's preset is fixed at creation in dsh, so "@agent" means "a fresh session with that agent") with your text as the first message, pins a readable title, files it under the current workspace, and switches to it. Agent cards also have 「开新会话」.

**Tasks (0.5):** the model follows hermes' kanban tables, minus process spawning:

- **Task** — a template: brief + ordered participants + trigger (once / cron).
- **Batch** — one firing of a task; it creates one **Card** per participant, chained by `deps` (a DAG underneath; the wizard makes a chain).
- **Run** — one attempt at a card = one real dsh session on that agent's preset. Retries add runs.
- **Event** — `~/.dsh/task-console/events.jsonl`, append-only; every screen is `fold(events)`, on the host and in the browser alike (the replay scrubber folds a prefix).

Each card's session gets three tools nobody else sees — `task_complete(summary)`, `task_block(reason, kind)`, `task_request_review(summary)` — registered on the agent's own scope after its preset is mounted. A run must end with one of them; a run that stops without one is nudged once, then fails as `protocol_violation`. `task_block(kind="needs_input")` parks the card; the person's next message in that session resumes it. Failures count toward a per-card breaker (`maxTries`), same-reason blocks recur at most 3 times, and a failed card cancels the rest of its chain.

The dispatcher ticks every minute (and on every settled run): promote cards whose deps are done → claim up to 3 in flight → start sessions → watchdog. On restart, runs that were live are marked `crashed`.

CLI-backed providers: `codex-local` calls the terminators fine; `claude-local` treats dsh tools as deferred and cannot, so agents on it should not take part in tasks (the wizard says so).

## Known limits

- MCP servers are ticked whole (no per-tool subset yet).
- If the host composition still runs an MCP server with the same `serverName`, the preset mounts it under `<server>-<id>` — every agent can still see the host copy until that row is removed.
- CLI-backed providers (`claude-local`, `codex-local`) bring their own Bash / Edit; dsh's fence cannot remove those. Provider-side sandboxing is the next step.
