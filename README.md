# dsh-task-console

任务台 for DeepSeek Harness (dsh).

**This release (0.14):** makes dynamic rounds database-first. A new run initially inserts only `Planner₁`; `task_plan_round` then atomically inserts the real `Gateₙ → Executorₙ → Reviewerₙ → Plannerₙ₊₁` tasks and links. Gates are durable Task rows without Agent Runs. The live graph reads `tasks`, `task_links`, and `task_runs` directly, while playback rebuilds the same frame one canonical `task_events.id` at a time—there are no inferred future roles or decorative dependency edges.

The plugin remains local-first: `~/.dsh/task-console/task.db` is the only runtime database, and no Cloudflare account or network database is required. An existing `events.jsonl` or pre-0.11 SQLite event table is imported once and retained for rollback and audit. The D1 experiment remains in the source repository for research only and is excluded from the npm package.

```sh
dsh plugin --profile web add github:ChangfengHU/dsh-task-console
```

Opens from the sidebar footer button 「任务台」; screens live in the URL hash (`#/tc/agents`, `#/tc/agents/<id>`, `#/tc/tasks`, `#/tc/tasks/<id>`).

**Talk to an agent from the composer:** type `@` in any composer, pick an agent, type the ask, Enter. That starts a new session on the agent's preset (a session's preset is fixed at creation in dsh, so "@agent" means "a fresh session with that agent") with your text as the first message, pins a readable title, files it under the current workspace, and switches to it. Agent cards also have 「开新会话」.

**Task runtime:** the model follows Hermes' durable Kanban vocabulary while keeping DSH's template and Session layers:

- **Task** — a template: brief + ordered participants + trigger (once / cron).
- **Batch** — one firing of a task. Dynamic mode starts with only the first Planner and materializes later rounds after real decisions; fixed-chain mode remains for compatibility.
- **Run** — one attempt at a card = one real dsh session on that agent's preset. Retries add runs.
- **Event** — core lifecycle audit in `task_events`; the separate `dsh_events` projection powers browser replay without becoming a second scheduler.

Ordinary card Sessions get `task_complete`, `task_block`, `task_request_review`, and `task_request_changes`. Dynamic Planner Sessions instead get `task_plan_round`, `task_finalize`, and `task_block`, so the decision that creates a round is explicit and auditable. A run that stops without a terminal tool is nudged once, then fails as `protocol_violation`. An explicit `task_block` closes the current Run; unblocking performs a fresh CAS claim and creates a new Run and Session. In contrast, DSH's native `ask_user_question` pauses and resumes the same live Run.

`task_request_review` is a real gate. With a `reviewer` preset it hands the same card to that Agent in a separate review Run; without one it creates a human decision gate. `task_request_changes` closes the review Run, restores the original implementer, and creates a fresh rework Run. Successful review releases downstream dependencies. Every claim uses `BEGIN IMMEDIATE` plus a conditional update, is renewed by heartbeat, and can be reclaimed after its lease expires.

The Task Studio UI is intentionally DSH-native: the dependency DAG is the primary workspace, gates are first-class control nodes rather than fake Agents, reviewers are visible role nodes, and each attempt shows its actual preset. Rework edges are visually distinct from dependency edges so the graph remains honest about what is schedulable. A playback bar directly below the DAG supports event-by-event seek, autoplay, speed control, and return-to-live; the event stream remains the detailed claim, Session, handoff, review, rework, block, and completion evidence.

Public HTML publishing reads `DSH_TASK_CONSOLE_UPLOAD_TOKEN` on the host. Optional overrides are `DSH_TASK_CONSOLE_UPLOAD_URL` and `DSH_TASK_CONSOLE_PUBLIC_DOMAIN`; no upload credential is sent to the browser or written into a task prompt.

Normal DSH sessions also receive `publish_public_html(path, name?, publicPath?)`. It accepts only HTML files below `DSH_TASK_CONSOLE_PUBLISH_ROOTS` (the host home directory by default), uploads at most 20 MiB, and returns only the public HTTPS URL. The bearer token remains inside the host process.

## Source-only D1 experiment

The Worker source and migrations live in `cloudflare/` for research. They are not loaded or packaged by the local plugin and must not be configured as a second authoritative state machine.

The dispatcher ticks every minute (and after every terminal transition): promote cards whose dependencies are done → CAS claim up to 3 in flight → start Sessions → heartbeat/watchdog. On restart, runs that belonged to the old host process are atomically marked `crashed` before retry.

## Upstream compatibility

The compatibility target and attribution are recorded in `NOTICE`. This is a semantic TypeScript port of the small durable kernel—not a copy of Hermes' UI or process launcher. DSH-specific tables use a `dsh_` prefix so upstream-compatible core rows remain separable from plugin extensions.

CLI-backed providers: `codex-local` calls the terminators fine; `claude-local` treats dsh tools as deferred and cannot, so agents on it should not take part in tasks (the wizard says so).

## Known limits

- MCP servers are ticked whole (no per-tool subset yet).
- If the host composition still runs an MCP server with the same `serverName`, the preset mounts it under `<server>-<id>` — every agent can still see the host copy until that row is removed.
- CLI-backed providers (`claude-local`, `codex-local`) bring their own Bash / Edit; dsh's fence cannot remove those. Provider-side sandboxing is the next step.
