# dsh-task-console

任务台 for DeepSeek Harness (dsh).

**Task Signal intake (since 0.21.0):** an authenticated producer such as Fleet submits facts and intent, never an Agent choice. A capability-free internal Task Agent reads the current Task candidates and registered Agent roster, proposes `create`, `reuse`, or `triage`, and the host independently validates that it selected only existing capabilities. Task identity is the durable goal/root cause—not an IP or other target. Every accepted Signal becomes its own auditable Turn and Batch, while later signals in the same Incident can reuse the Task without overwriting its objective, team, targets, or provenance. Deterministic Signal and Batch IDs make producer retries idempotent.

The Board shows the source Signal, Incident, Task Agent decision, routing Session, Turn objective, and target metadata directly above the database DAG. The SQLite projection adds dedicated Signal, Incident-link, and target tables; core task, link, run, gate, CAS, handoff, artifact, and replay semantics remain unchanged. The intake endpoint is fail-closed unless `DSH_TASK_INTAKE_TOKEN` is configured:

```sh
npm run build
npm run preset:intake
# POST /dsh-task-console/api/task-signals
# Authorization: Bearer $DSH_TASK_INTAKE_TOKEN
```

The managed Task Agent has zero business tools, zero MCP access, and zero Skills. It can only read one frozen routing context and submit one validated decision; it cannot execute the requested work or enlarge a selected Agent's permissions.

Signals may also declare `requiredExecutorTools`: exact tool names, not an Agent selection. The
host validates that the selected executor actually exposes every required schema before any Task
is started. The roster includes expanded native tool names and descriptions. A generic Fleet label,
base onboarding tool, or arbitrary shell is not a substitute for a Runner deployment capability.

Runner deployment is provided by `fleet-probe-runner/operator`, not by the onboarding runtime.
`node scripts/install-runner-presets.mjs` installs the bounded Runner operator and read-only reviewer
after building. The DSH adapter takes only an IP and tracks real asynchronous stages; it exposes no
credentials or arbitrary commands. The operator root is host configuration, and absence fails closed.
Task cancellation stops only session-owned host operations; external state must be inspected before
retry. Ordinary onboarding and coding Agents retain their existing permissions.

Per-Agent DSH session permission presets remain tool-granular. `workspace-write` is the safe default; trusted system operators such as `装机者` can pin `danger-full-access`, and the plugin writes that sandbox/approval bundle before the first user message is dispatched. A missing permission service fails closed. The inherited-tool fence hides every currently unselected host schema and guards later registrations, while preserving the preset's exact native/runtime/MCP/Skill capabilities.

Native and MCP tools still live in one capability matrix; MCP servers are only grouping labels, while each advertised tool is independently selectable. Generated presets deny the complete live inherited host surface (including host tools added after the preset was saved), then merge only their own native/runtime/Skill registrations and chosen MCP definitions. Filtered MCP presets persist a host entry reference rather than copying its URL or authorization headers, and may enforce per-tool argument policies such as required arguments, key prefixes, and Fleet hostname patterns. A real try-run reports the exact request header and uses the same session permission path as a normal Agent chat.

The managed `装机者` source lives under `presets/fleet-installer/`. It exposes `ask_user_question`, `todo_write`, Skill discovery, and the four typed `fleet_onboard_*` runtime tools; it does not expose host Bash/filesystem/jobs, Schedule, Vault, or Fleet MCP tools. The model supplies only the target IP. Trusted inventory and provenance belong to the host runtime, so a planning-only runtime cannot be presented as a completed repair. Base onboarding remains SSH/`claude`, Clash/Mihomo, Controller/Dashboard, browser/VNC, Cloudflare hostnames, Fleet registration and evidence; image-worker provisioning is a separate extension.

The managed preset also pins its Skill source repository and revision in `presets/fleet-installer/skills.sources.json`. Every copy receives `skills.lock.json` with content hashes. Check or explicitly refresh an existing copy from the pinned clean checkout with:

```sh
npm run build
npm run preset:skills -- --check --source-root /exact/path/to/linux-clash-skill
npm run preset:skills -- --sync --source-root /exact/path/to/linux-clash-skill
```

The sync refuses a different remote, revision, dirty Skill tree, or incomplete Skill set. It changes only the copied `skills/` tree and its lock; it never reads or rewrites MCP headers.

Task-owned Sessions remain internal evidence: they stay out of ordinary DSH navigation and search without being archived, and remain directly openable from the task's Related Sessions drawer, Trace, and exact `?session=` links. Historical task-session relationships are reconciled from the append-only event log; logs, task evidence, workspace files, and deliverables are retained.

The task list supports search-aware pagination and guarded cleanup of completed or all task records; bulk cleanup never removes DSH sessions or workspace files. The list, Agent editor, task detail, replay DAG, delivery area, and Related Sessions drawer inherit the same DSH light/dark design tokens instead of rendering a hard-coded white cartoon island inside the host shell.

The explicit final-delivery contract from 0.15 remains: `task_finalize(summary, artifact)` records which registered file is the approved result; byte-identical executor submissions and reviewer snapshots render as one immutable version, with round, producer, review, and final-state evidence. Existing completed tasks receive a clearly labelled compatibility selection instead of fabricated history. The task list and detail page expose the final result directly, with sandboxed in-panel preview, download, optional public publishing, and event-faithful replay of artifact registration/finalization.

Dynamic rounds remain database-first. A new run initially inserts only `Planner₁`; `task_plan_round` then atomically inserts the real `Gateₙ → Executorₙ → Reviewerₙ → Plannerₙ₊₁` tasks and links. Gates are durable Task rows without Agent Runs. The live graph reads `tasks`, `task_links`, and `task_runs` directly, while playback rebuilds the same frame one canonical `task_events.id` at a time—there are no inferred future roles or decorative dependency edges.

The plugin remains local-first: `~/.dsh/task-console/task.db` is the only runtime database, and no Cloudflare account or network database is required. An existing `events.jsonl` or pre-0.11 SQLite event table is imported once and retained for rollback and audit. The D1 experiment remains in the source repository for research only and is excluded from the npm package.

```sh
dsh plugin --profile web add github:ChangfengHU/dsh-task-console
```

Opens from the sidebar footer buttons Agent and Board. Screens live in the URL hash (`#/tc/agents`, `#/tc/agents/<id>`, `#/tc/tasks`, `#/tc/tasks/<id>`). Session evidence is subordinate to a task and opens from its Related Sessions drawer or Trace instead of a third top-level screen. The SQLite data directory intentionally remains `~/.dsh/task-console/` across the package rename so existing tasks and audit history stay available.

Dynamic DAG reviewers submit their verdict through `task_complete`; only the next planner creates rework rounds. Same-card review tools are not mounted in dynamic DAG sessions. Session URL selection consumes its pending request before publishing the synchronous session-list update.

## DSH host compatibility

DSH `0.1.1-rc.2` needs a small host compatibility patch for internal task Sessions and the lightweight session-list projection. Run `npm run host:patch` after installing or updating DSH. The command is idempotent and fails loudly on any unverified DSH version instead of silently changing unknown bundles. This compatibility layer can be removed once those capabilities ship upstream.

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

- The DSH fence governs model-facing DSH tools. CLI-backed providers (`claude-local`, `codex-local`) bring their own Bash/Edit, which require provider-side process sandboxing when those capabilities must also be constrained.
- Exact-tool and argument policies are enforced in the Agent scope. An upstream MCP should still issue scoped credentials when it needs a security boundary against a compromised host process.

## Fleet operations roles

Runner deployment and base-node repair use distinct executor capabilities. Task Intake selects
the team from the live preset roster; it must also match planner/reviewer expertise, not just the
executor tool names. Operational tasks deliver actual runtime reports, not invented code or CLI
self-tests. For tool-constrained Signals, each planner/reviewer must declare `taskExpertise`
covering the required executor tool contracts. This metadata is routing eligibility, not tool
authorization; overlapping read tools alone do not make the two operational domains interchangeable.
`fleet-onboard-read` exposes only status/report, while `fleet-runner-read` exposes
inspection/report; neither grants deployment or repair tools.

After building, `node scripts/install-runner-presets.mjs` installs the Runner and Fleet operations
roles. It refuses to overwrite a differing user preset. Task completion is separate from Incident
closure: Fleet must issue a new signed job after completion and independently verify recovery.

An idempotent onboarding start may return a run owned by an earlier DSH session. Validate that
record against the prior ledger identity before CAS resume; only after the revision/lease epoch
advance must the record belong to the new session. Requiring the new session before takeover
rejects legitimate recovery; skipping identity verification entirely would weaken the lock.

For a running onboarding transaction, `can_resume` and `next_tool` explicitly direct the executor
to continue with `fleet_onboard_resume`. Status/report are ledger-only reads, not async-operation
polls. Running work cannot be handed off as completed; repeated unchanged attempts must block
with evidence instead of creating empty rework rounds. Signal receipts distinguish `blocked`
from active execution. External Signal tasks cannot rerun their original template: the source
must submit a new Signal for fresh intent/team validation, retaining the previous batch history.
