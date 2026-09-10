# Task Console runtime contracts

The version-fenced history patch also shields DeepSeek-compatible model requests from
previously rejected malformed tool-argument JSON. Raw session/Trace records and tool
execution stay unchanged; only request serialization carries the invalid input as
explicit non-executed evidence, allowing the model to correct it after the tool error.
Do not silently repair and execute malformed arguments. Reapply through the existing
`scripts/patch-history-ids.mjs` host patch after a supported host reinstall.

Package remains `dsh-task-console`; Agent and Board are modules of the same plugin.
Use the installed DSH service's actual executable/configuration to identify the host,
not an adjacent source checkout. Its generated `lib/` plugin assets are tracked.

Execution-level archival uses the Console-only `setBatchArchived(taskId,batchId,archived)`
API and an append-only `batch/archived` event, projected to `dsh_batches.archived_at`.
Only ended/blocked role sets without active claims or pending/scheduled roles qualify.
It hides that Batch from default selection and prevents claim, wake, unblock, cancel
or settlement; it never deletes native Sessions or rewrites the original outcome.
The one-line execution picker opens recent records on demand; archive/restore lives
in its more menu. Full Beijing timestamps and IDs appear in the popover/history, not
stacked controls in the header. `#/tc/tasks/executions` supports task/status/query/page
and archived-execution filters; `executionHistory` performs ten-row SQLite pagination,
returning only row metadata and task titles, never prompts or session transcripts.
Archived Tasks stay hidden from the global history unless explicitly task-scoped.
The execution picker can show archived history; explicit old URLs remain readable.
Restoring visibility does not unblock or rerun it. A new execution reuses the Task
definition with a fresh input, Batch and Sessions. The latest manual acceptance check
still includes archived attempts, so hiding a failed trial cannot enable a schedule.
Fleet-base-v2 prompts require fresh observations, not reuse of historical challenge
claims or acceptance receipts. Manual rerun is explicit recovery, not an automatic
Google-challenge watcher; only a real task_wait/trigger can justify an auto-resume claim.
After a real async wait ends, the runner's `operationOutcome` callback appends fresh,
same-session terminal facts to the continuation message. It explicitly asks the Agent
to read browser_status and actually invoke its terminator; it never calls task_complete
on the Agent's behalf. Raw private job payloads are not forwarded and all existing
receipt/Fleet checks, deadlines and protocol budgets remain. A completion tool present
in request/header is distinct from a model actually invoking it.
Base-node browser preparation uses default browser_prepare without component; the
login-observation component is specifically for an already-installed legacy image
observer, not a prerequisite to install image services on a base node.

## Chat-created workflows

For browser-patrol-v2, `design.notifications.agentId` selects an independently
reviewed auxiliary notifier without replacing any of the three business roles.
The managed `wecom-notifier` preset uses the existing ordinary tool-based model
and only WeCom group/status/send MCP grants (no CLI backend, browser or Vault tools).
Install it through the existing Agent save API, which resolves the actual host MCP
entry rather than copying credentials. Preserve existing models/grants when updating
the Creator/planner personas. Notify participants are included in roster hashes,
schedule preflight, review/plan display and Agent task history.

Some host-injected schedule_* schemas can still appear after preset mounting. A
schema name is not an execution grant: the selected-tool guard rejects those calls.
Verify permissions using the actual tool receipt, not the model's tool-list summary.
The notifier's retained read-only schedule_list probe confirmed that denial; it did
not create a schedule or send a message. Do not remove the guard to hide this UI issue.

With delegation configured, planner `task_notify` atomically creates a real SQLite
Task/link/event side card, dependent only on that planner. Its notification_requested
event freezes the report. After planner handoff, the notifier gets its own Run and
Session and calls task_notify against that frozen stage. Receipt deduplication and
unknown-send protection still use the existing outbox. The notification branch has
a five-minute worker budget and one worker attempt; definite pre-send failures may
retry transport up to three times, never ambiguous sends. Failed/blocked notifications
make overall acceptance unresolved without cancelling repair descendants. No second
queue service or scheduler is introduced. Older designs without agentId keep the
planner-direct path; their historical receipts are not rewritten.

WeCom connection recovery belongs to the independent Fleet MCP service, not a DSH
Agent activation prerequisite. Keep hourly schedules disabled until an actual manual
Batch passes both business evidence and notification receipts. Creating the Agent,
approving a plan, or passing unit tests is not a passed fleet patrol.

Creator submissions now prepare a structured decision contract in SQLite
`dsh_task_plans`; they do not create a Task/Batch or start a worker. Each plan records
scope, evidence-based branches, coordination, bounded failure policy and acceptance.
`#/tc/tasks/plans` pages the retained drafts/reviews; `task_create_plan_status` reads
them. Only the separate Console `reviewTaskPlan` action approves/rejects with a reason
and matching hash. Creator has no approval, shell or business-operation tool.
Approval checks the selected preset/profile hashes and reused definition, claims the
pending row with CAS and dispatches the existing TaskRunner using a fixed Batch ID.
Duplicate approval is idempotent; rejection/supersession never executes or erases history.
Changed Agent configuration needs a newly generated/reviewed draft. The roster check
is at approval, not a new version-pinned per-card deployment system.

The accepted TaskTurn freezes the design and references its reviewPlanId. Existing
direct @ workflow runs and Fleet TaskIntake remain unchanged; no second scheduler is
introduced. Conditions are evaluated by the business Agent from tool evidence, not
an arbitrary executable conditional-DAG language. Static role handoff and Hermes-style
dynamic-rounds retain their existing semantics. Creator context includes the stored
design for exact reuse; resource IPs belong in turn input, not the reusable design.
Host review release distinguishes the original creation-stage wait from the approved
execution phase without lifting any other permissions. A completed Run is still an
Agent claim unless the relevant business evidence gate verifies it; independent review
must not confuse a green status with correct per-target results.

For a Gemini Fleet patrol requiring verification/necessary login, Creator selects
`design.evidenceContract=browser-patrol-v1` from context.evidenceContracts. This
explicit business adapter (not the generic DAG kernel) joins actual native tool-call
and tool-result events from the current worker Session. It retains the first inventory
baseline and last normalized inspect per instance; model-authored counters are ignored.
Unknown or authorized signed-out targets reject task_complete and give an evidence-linked
block reason. Completed patrol summaries are derived from those observations, not LLM
prose. A copy needs a subsequent inspect with real verification. List-only, legacy,
other-role and other-business tasks do not acquire this opt-in requirement. This is
point-in-time patrol evidence, not another 20-minute stability requirement.
The gate also accepts completed browser_status receipts from this exact Session,
operation and target for login-verify/provision/copy. It uses actual verifier
checkedAt/expiresAt, not status polling time, and chooses newer proof over legacy
inspect metadata. All-login acceptance cannot pass empty inventory or skipped grants.
Correct blocking is not all-browser login completion; fix capabilities and continue
actual DSH execution, retaining failed attempts and the original authorization boundary.

`task-create-agent` is an installed, scoped Agent preset. It reads the trusted Agent
roster and manually available chat workflows, chooses create/reuse and delegates to the existing
TaskRunner. It has no SSH, shell or business MCP grants. Install/update the managed
preset with `npm run preset:creator` after building; a differing existing preset
requires inspection before explicit `--force`. Do not overwrite unrelated presets.

Task identity represents a reusable goal, never an IP. Each new submission has its
own Batch/TaskTurn and input; accepted-message retries return the same receipt in
`dsh_task_requests`. Direct workflow submissions use a stable client request UUID:
changing its payload is rejected. A direct workflow invocation has no invented
intake Session URL. Only actual user-source messages may supply the request;
time-context plugin messages can also have role=user and must be excluded.

New Session `@` offers Agents and manually available chat workflows, not historical sessions.
For a cron Task, enabled controls automatic scheduling only: false still permits
manual @ reuse and the card's manual action. Disabled once-only Tasks and archived
Tasks remain unavailable. Both direct @ and Creator reuse of cron Tasks validate
the original reviewed input, workflow definition and role hashes via scheduledTurn;
new manual parameters never alter the saved cron binding or enable cron. Stable
request UUIDs retain deduplication. Bootstrap passwords are still forbidden in cron
input. Full business/notification acceptance remains required to enable a schedule.
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

Chat workflow executions store the redacted `userRequest` separately and a
content-addressed `TaskTurn.workflow` definition (goal, role briefs, graph mode and
failure limits) in the existing SQLite turn JSON. Execution and the plan viewer use
that frozen definition. Legacy turns are labelled without a fabricated snapshot.
Creation/routing sessions appear separately from execution Runs, including on direct
workflow reuse; never invent another Creator invocation or a fourth execution node.
The compact creation header opens the original conversation and expands role plans,
input and saved JSON on demand. Full transcripts/Trace remain lazy.

The Creator preset includes login as an explicit business requirement, distinct from
base-node health. The browser role must verify existing as well as newly created
instances when requested. It selects only authorized Gemini sources, preserves valid
target logins and reports unknown/challenge/no-source honestly. No prompt expands the
host browser policy; per-node/instance authorization stays Fleet-owned.

`workflow-recipes.ts` advertises the managed `fleet-base-v2` business recipe. The
Creator sees its required Agent IDs and selects `preserve` or `provision-gemini`;
recipe submissions cannot also supply rewritten role briefs or graph mode. The
recipe is target-independent, checked against the live roster and materialized by
the existing scheduler. Save its ID/policy in the frozen definition. Unmatched
business goals still use normal dynamic composition; do not force Fleet roles onto
other tasks. Updating a recipe never changes already-saved execution definitions.

The old v1 definition remains readable/compatible, but is not the current login
acceptance recipe. V2 orders installer → Runner → browser-manager so the role with
account tools performs final business acceptance. For provision-gemini, it requires
browser-1/2's independent background checks across 20 minutes (at least 8 distinct
timestamps each). The browser role submits browserAcceptanceOperationId(s), not a
self-authored stable flag. A host completion callback validates private Browser MCP
receipts (current Session/target, regular owner-only file, criterion, window, account
fingerprint, freshness), then reads current Fleet. It rejects mismatches before
recording completion. This business callback is separate from the generic kernel;
legacy/preserve/unrelated Tasks have no Gemini gate. Host receipt storage follows
FLEET_BROWSER_STATE_DIR or ~/.local/state/fleet-browser-manager. Retain receipts;
MCP status returns only recent acceptance events to avoid growing model context.

Fresh running Browser MCP receipts keep their owning browser-manager Run alive
when the model ends a turn, including custom workflows without a Fleet recipe.
The host polls receipts every 30 seconds without LLM calls, retains the CAS
heartbeat and original watchdog deadline, then uses the existing terminator nudge
after the operation ends. Completion/block calls cannot abandon a running browser
operation. This is operation lifecycle protection, not a new generic Gemini gate;
other Agents and stale/unrelated receipts retain their existing behavior.

The collapsed execution control shows actual Asia/Shanghai firedAt to the minute
and outcome. Its popover and history list show full seconds, Beijing UTC+8 and an
eight-character display code. Full Batch IDs remain navigation identifiers and
hover text; display codes are not database keys. Both legacy and DB-replay pickers
share this presentation. Search accepts the displayed code including its leading #.

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

Task list cleanup uses `setTasksArchived({ids,archived})`, not deletion. The host
validates the entire exact-ID selection and rejects claimed/running work, then
atomically appends per-Task `task/archived` events. `archivedAt` and disabled state
persist in the existing spec JSON; no new store or table is introduced. The normal
`tasks` listing/search/counts exclude archived definitions and their batches;
`board`, snapshots, Agent history and original detail links retain the evidence.
Archived definitions cannot be fired, claimed, resumed by durable waits, enabled,
or selected by Task Intake. Restore removes the archive marker but does not enable
cron; restoring an unfinished definition may resume its ready cards on the next tick.
Do not restore an old unfinished workflow without explicit execution authorization.
The original sessions, notification receipts, plans and execution rows are never
deleted by archival. Archive is a current-work selection, not a declaration that
old failed/blocked work succeeded.
Select explicit Task IDs from the current inventory; never infer an archive target
from age, status, a directory name or a blanket rule that hides disabled schedules.

Run `NODE_ENV=test node --import tsx --test --test-concurrency=1 test/*.test.ts`
under the supported Node runtime, then `node scripts/build.mjs`. Check real @
selection/submission, reuse without a new Task, handoffs, DB step replay, fullscreen
inspector, Trace, original history links and the final report in a browser.

Never restart DSH with active Task Runs: existing recovery marks interrupted runs
as crashed. Target node changes must be executed by visible DSH Agents, not the
developer's direct SSH. Healthy profiles, credentials and unrelated services are
preserved. Current live acceptance is existing-node idempotence; fresh bare-metal
and destructive uninstall/reinstall require their own evidence.

## Durable scheduled browser patrol (0.29)

Keep one reviewed Task and one Batch per cron/manual occurrence. `dsh_schedule_state`
stores the next due instant and IANA time zone; `dsh_schedule_fires` records durable
claims, skipped overlaps, coalesced downtime and bounded dispatch failures. Batch
insertion consumes its claim in the same SQLite transaction. New Creator cron approval
creates a paused Task in `awaiting_trial`; it neither enables cron nor immediately fires.
Run it manually first. Enabling checks the latest manual Batch passed against the reviewed
definition, has no active Batch, and all requested notification receipts are sent. A failed,
unresolved or unknown-delivery trial cannot activate cron. The reviewed input and roster
hash live in `dsh_schedule_bindings`; changed roles require another review. Query
`taskSchedule(id,page)` for ten-row SQL pagination, not session transcripts.

`task_wait(until,reason)` ends the current worker, stores `dsh_task_wakeups`, and
resumes the same card/Batch with a new Run. It does not consume rework rounds, cannot
overlap an unfinished Browser operation, and retains the original card deadline.
Do not manually unblock a timer early. Dynamic executor handoffs traverse the Gate
to include the actual planner's instructions.
For browser-patrol-v2 only the independent reviewer may defer. Executor completion
is a factual handoff after its frozen actions end, not a requirement that the whole
Task is ready. Waiting for downstream reviewer samples would deadlock the DAG.
Other business contracts retain generic durable waits. Reviewer refreshes expired
healthy-target evidence at the end of a repair window without repeating its stability test.

New recurring login workflows opt into `browser-patrol-v2`; legacy v1 remains intact.
Planner, browser-manager and independent read-only reviewer use native tool receipts,
not model counts. A round freezes exact instance/action items together with its Gate
and links. The Browser MCP intersects these with host grants at execution time and
reserves repair attempts in `dsh_browser_issues/operations` across later Sessions and
Batches. Repeating an ambiguous mutation reservation requires reconciliation, not
another copy. No lifecycle/rebuild authority is granted by this contract.

Only repaired/unresolved instances need the reviewed stability window; healthy
instances need current independent evidence, not another long observation run.
When an unreachable zero-observation node already prevents full coverage, unchanged
independently checked targets whose evidence expires during handoff may close as
unresolved. They remain unaccepted; this neither extends evidence expiry nor waives
repair stability, missing independent checks or the manual-before-cron gate.
`task_patrol_status` exposes scope, budgets and samples. `patrol_snapshot` events
drive the evidence table at the selected replay position. A supported `unresolved`
final disposition settles a FAILED Batch, retains the issue budget and permits the
next scheduled check; it is not business success.

Notifications belong to the planner's `task_notify`, which invokes the existing
WeCom MCP under the real Agent tool scope. Configure explicit reviewed `chatIds`;
never default to every subscriber. Creator has only `vyibc-wecom_list_groups`: query
active subscribers, prefill the actual sole group for independent review, or ask the user
to select when multiple groups exist. Do not request existing bot credentials/chatId by
hand or use Vault secrets as model context. `dsh_task_notifications` persists per-stage/group
deduplication and receipts. Definite pre-send failures can be retried up to three
times; ambiguous sends stay `unknown` for human reconciliation by notification ID.
The Fleet sender's structured connection refusal (`delivery=not_sent`, `sent=0`)
is retryable within that same cap; a timeout after dispatch remains ambiguous.
There is no exactly-once delivery claim or automatic replay of browser work. For the
vyibc deployment the credential-file stdio adapter is maintained in
`linux-clash-skill/browser-manager/wecom-mcp.mjs`; it reads the existing host credential
at request time. Neither bot secrets nor bearer values belong in Agent presets.
