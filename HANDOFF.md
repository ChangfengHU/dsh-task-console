# Task Console runtime contracts

Package remains `dsh-task-console`; Agent and Board are modules of the same plugin.
Use the installed DSH service's actual executable/configuration to identify the host,
not an adjacent source checkout. Its generated `lib/` plugin assets are tracked.

## Chat-created workflows

`task-create-agent` is an installed, scoped Agent preset. It reads the trusted Agent
roster and enabled chat workflows, chooses create/reuse and delegates to the existing
TaskRunner. It has no SSH, shell or business MCP grants. Install/update the managed
preset with `npm run preset:creator` after building; a differing existing preset
requires inspection before explicit `--force`. Do not overwrite unrelated presets.

Task identity represents a reusable goal, never an IP. Each new submission has its
own Batch/TaskTurn and input; accepted-message retries return the same receipt in
`dsh_task_requests`. Direct workflow submissions use a stable client request UUID:
changing its payload is rejected. A direct workflow invocation has no invented
intake Session URL. Only actual user-source messages may supply the request;
time-context plugin messages can also have role=user and must be excluded.

New Session `@` offers Agents and enabled chat workflows, not historical sessions.
The version-guarded host patch suppresses only native @ history suggestions while
the plugin is active; it does not remove the sidebar history or file references.
After a host upgrade revalidate the exact patch; never guess a replacement anchor.

The @ Agent picker orders by immutable authoring time, shows five by default and
uses native input-trigger text/continue outcomes for expand/collapse. Search
considers the complete roster. `agent-meta.json` is an authoring sidecar, preserved
on edits and created fresh for a new ID; it is not part of user-editable AgentSpec.
Legacy presets have no proven creation timestamp: use explicitly labelled earliest
session-header creation time as a first-use fallback, unknown dates last. Never use
directory mtime/birthtime (preset saves atomically replace the entire directory).

Agent detail exposes configuration, paginated sessions and paginated tasks through
`taskConsole/agentHistory`. Tabs/page are in the hash query. The host joins actual
SessionHeader.agentPreset, Task/TaskTurn.origin.intakeSessionId, dynamic cards and
Run.profileId (reviewers need not own the card). Creator and participant relations
are unioned once per Task; each link prefers that Agent's latest relevant Batch.
Creator sessions never inherit executor sessions. Removed session files remain
visible through retained Run metadata, but their Open button is disabled.

Listing reads the host's lightweight header index, briefly coalesced, and enriches
only the requested page from live/cached title projections. Never call inspect,
load or coldSnapshot to fill a listing. Pagination is host-side, not a full-list
browser slice. Optional Cordis services must be resolved through ctx.get; direct
access without a declared inject fails at runtime. Browser popstate re-notifies
console hash readers so returning from a session preserves the Agent tab/page.

Business-role chains use existing static scheduling and canonical DB rows. Their
final role receives original ancestor summaries from the same Batch, not only a
rewritten immediate handoff. The existing planner/Gate/executor/reviewer dynamic
protocol remains separate; do not invent Gate nodes for static business chains.
The Board reuses database-truth replay for both. Session Trace stays in a drawer;
operations may deliver a text report without an HTML artifact.

Execution-history pickers show the actual firedAt date/time in Asia/Shanghai
(explicit Beijing UTC+8), followed by an eight-character display code. Full Batch
IDs remain the select values, route identifiers and hover text; display codes are
not database keys. Both legacy and DB-replay pickers share this presentation.

Bootstrap credentials are resolved by the host, scrubbed from Task/event/handoff
data and held in owner-only per-Batch `private-inputs` files with a 24-hour read
expiry. Only the active Task-bound fleet-installer Run can resolve its exact IP.
Expired material is unreadable by the resolver; there is not yet an automatic file
retention sweeper. This does not erase the user's original chat message.

Browser MCP Task sessions require a live canonical binding to browser-manager,
not just a matching session prefix. See linux-clash-skill/browser-manager. Agent
tool fences and node/instance grants remain in force; creating a Task grants no
additional business capabilities. Completed task sessions remain indexed through
the latest retained Run even when tasks.current_run_id has been cleared.

## Verification and boundaries

Run `NODE_ENV=test node --import tsx --test --test-concurrency=1 test/*.test.ts`
under the supported Node runtime, then `node scripts/build.mjs`. Check real @
selection/submission, reuse without a new Task, handoffs, DB step replay, fullscreen
inspector, Trace, original history links and the final report in a browser.

Never restart DSH with active Task Runs: existing recovery marks interrupted runs
as crashed. Target node changes must be executed by visible DSH Agents, not the
developer's direct SSH. Healthy profiles, credentials and unrelated services are
preserved. Current live acceptance is existing-node idempotence; fresh bare-metal
and destructive uninstall/reinstall require their own evidence.
