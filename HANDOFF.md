# Task Console runtime contracts

## Session capability facts and standard-chat loop protection (0.30.29)

`session_capabilities` and `environment_capabilities` are host-owned, read-only
tools. The conversation's Capabilities tab calls `sessionCapabilities`, sharing
the same runtime reader. Separate the authored preset from current scoped tool
registrations/Skill discovery and environment inventory. An absent Task Console
definition is not proof that a built-in or CLI Agent has no tools. Label inherited,
restricted, configured-but-unregistered and last-failure states; never probe a
business tool to answer an inventory question. No headers, commands, prompt bodies,
tool arguments or credentials enter the capability snapshot.

`dsh_session_capability_snapshots` stores the latest safe facts plus the exact
tool-name list/provider/model from native `request/header`. Cold sessions expose
historical snapshots without restoring or starting an Agent. Skill history loading
is distinct from current retained context. CLI-internal extra discovery is unknown
until independently observed; the host catalog cannot certify it.

The plugin's `standardMcpInheritance` and `standardSkillInheritance` accept
`inherit` (preserve deployment defaults) or `discover-only`. These control native
standard-chat model exposure and ToolRuntime dispatch, not a CLI's private loader.
Default empty exclusions preserve the native Skill/MCP surface, including browser
tools. No business name or role is hardcoded as forbidden for standard chat.
`standardExcludedSkills` accepts exact skill names, `standardExcludedMcpServers`
accepts native serverName values, and `standardExcludedTools` accepts exact public
tool names. Configure these in the existing plugin configuration, not AgentSpec.
Server exclusions cover late registration and hashed long raw tool names. Model
exposure, execution guards and capability facts share this policy. The prepended
pre-step listener filters excluded native Skill catalog/instruction injections
after native middleware; tool dispatch separately rejects excluded skill loads.
Already-loaded historical instructions are not erased; use a new session after a
policy change when clean context is required. Skill exclusion is not a filesystem
sandbox or CLI-private loader policy. Do not claim it prevents arbitrary file reads.
Authored Agent fences, native approval and server-side target/identity checks remain.
Removing a plugin exclusion is not a credential or target authorization grant.

Only standard native chat has the new `standardMaxSteps` budget (default 24).
Four identical non-status tool/argument/result observations, including interleaved
calls, halt progress at the next step. Changed results reset that key; status/wait
polling retains its normal semantics within the total budget. Existing Task budgets,
durable waits and rework are not replaced. Guard termination is an explicit error,
not a fabricated successful completion. User follow-ups start a fresh turn budget.

Automatic cross-Agent delegation is not implemented by these directory tools.
Recommend an actual configured Agent without claiming a handoff happened. Search
authentication remains independent of model chat authentication. Qwen Flash's
menu entry still requires a matching host model route; the local deployment adds
qwen-flash beside qwen-plus-latest through its existing provider, without changing
the model chosen by any existing Task or rotating credentials.

Acceptance: `test/session-capabilities.test.ts` covers default native inheritance,
explicit exclusions/removal via native ToolRuntime, native middleware order,
unchanged authored roles/permissions, repeat limits and safe persistence;
`scripts/test-session-capabilities-browser.py` inspects the public tab without
starting a chat. Production prompt acceptance must separately prove the original
inventory request terminates without business-tool calls. Deploy only at the
existing two-part zero-active boundary.

Initialize the capability reader only after `runner.start()` has loaded SQLite;
plugin activation waits for service readiness before registering capability hooks.
Native complete role prompts replace assembled sections after middleware, so
capability guidance belongs in runtime contexts, not a new system section. Verify
its presence in actual session context events, not merely a mocked hook result.

## Session module: pinned and favorite shortcuts

Recent (0.30.30) is a metadata-only cross-folder projection in the same sidebar
slot, below Pinned and above Favorites. Sort native `updatedAt` descending with
session ID as deterministic tie-breaker, unknown timestamps last. Show ten rows,
expand by ten, and retain collapse/less controls. It does not track last opened
time, move folders, persist another session table or load transcripts for sorting.
Native metadata subscriptions update it; existing archived/internal/subagent/blank
filters remain. Selecting a row uses the existing native open and session query.

The deployment alias `dsh.vyibc.com` points to the same backend as
`dsh-152-32-214-95.vyibc.com`. In the Vault `service:cloudflare` forwarding account,
the exact DNS CNAME follows the original tunnel target and its exact `/*` Worker
route uses existing `dsh-loopback-proxy`. No duplicate service or separate session
store exists. The Worker already rewrites Origin/Referer and forwards WebSockets
through the existing loopback-origin tunnel. Do not add another auth bypass or
change the original hostname route to implement aliases. Query live CF records
before changes; preserve all unrelated DNS, Worker routes and tunnel ingress.
Browser-local preferences remain origin-specific even though backend sessions and
shortcut marks are shared. Verify deep links and WebSocket/history on both names.

The package remains `dsh-task-console`. Session enhancements are a small module,
not a third top-level menu or another session database. `dsh_session_shortcuts`
in the existing local SQLite database stores only session ID and independent
pin/favorite timestamps. The native metadata index supplies titles, selection and
running state; lists never load transcripts. Original workspace membership,
Task history, schedules, drafts and session content are unchanged.

`sessionShortcuts` and `setSessionShortcut` are Console RPCs, not Agent tools.
Writes validate a known non-archived/non-internal session, a fixed flag and an
explicit desired/expected boolean; retries are idempotent. The browser also hides
blank/subagent/missing sessions. Archiving hides shortcuts without deleting their
marks; a subsequent native restore makes the same marks eligible again.
Flags persist server-side across reloads, browser clients and hostname aliases.
Open pages refresh metadata on focus/visibility and every 30 seconds while visible.
Failures keep the last confirmed state with an explicit retry notice.

The original session ellipsis menu gains Pin/Unpin and Add/Remove Favorites.
Pinned rows appear directly above native folders; Favorites is a collapsible
virtual group. Neither action moves or copies a session. Both reuse host theme
tokens, and opening uses the native session plus its exact `?session=` URL.
The original search, grouping, rename/fork/archive actions and Agent/Board menus
remain. Native search is not expanded to include hidden task sessions.

`scripts/patch-session-shortcuts.mjs` provides an additive, DSH 0.1.1-rc.2-fenced
menu/slot bridge. It ships with `host:patch`, keeps an exact-file
`.dtc-session-shortcuts-backup`, rejects unknown anchors and is idempotent. The
plugin owns behavior/storage; no official workspace schema is rewritten for this
feature. Verify this bridge after reinstalling/upgrading the host. Deploy server
changes only after both native running sessions and running Task Runs reach zero.
Use `scripts/test-session-shortcuts-browser.py` for candidate read-only fixtures
or opt-in live marker/restore acceptance. Never send a prompt or archive/delete
business data to test shortcut UI.

## Browser MCP execution identity

The filtered MCP adapter removes sessionId from the model-facing parameters of
browser tools that declare it, then binds the actual exec.agent.session identity
before existing argument/Task guards and transport. Missing live identity or an
explicit different identity fails without dispatch. Read-only tools and unrelated
MCPs are unchanged. The raw MCP still receives its required canonical sessionId;
Task scopes, exact purge evidence, requestId idempotency and output receipts remain.
Never solve a standalone chat's missing identity by asking the model to guess an
ID or putting one particular session ID into its reusable Action/preset.

Read-only inventory/inspect/candidate and draft-only UI checks cannot establish
create/provision/purge acceptance. Run an explicitly authorized lifecycle canary
through the actual public browser composer and native ToolRuntime; delete only
the newly created test instance, verify its owned files are gone, and preserve
all original profiles, PIDs and shared services. Keep the failed attempts too.

## Browser delivery receipts

`dsh_browser_operation_outcomes` appends host-authenticated Vault v2 outcomes to existing
reservations. Only final `not_started` reduces effective mutation attempts; preflight
has a separate per-Batch bound. Unknown/imported stay charged and require independent
review/stability. Missing receipts cannot refund attempts. This extension preserves
Task/AgentSpec hashes, schedules and all history. Node execution remains visible DSH/MCP.

## Agent Actions

Vault-v2 account suggestions use a stable `accountId` per stored authorized account,
with version/current holder metadata, including inventory without an online source.
The browser-manager starter passes this ID to the MCP's exact selector, not just an
email preference. Unknown/denied/changed selections never fall back. Node scope is
owned by linux-clash/browser-manager: `registered-fleet` dynamically covers enabled
registered machines; existing Task role/action/review boundaries still narrow it.
Actions/preset sidecars do not grant permissions or alter AgentSpec review hashes.

`actions.json` is an optional preset sidecar for parameterized user prompts; never
merge it into AgentSpec, generated tool composition or Task roster review hashes.
User-preset saves preserve it under the same in-process write lock. Action edits
use revision-CAS and an atomic file rename. No defaults are re-created after deletion.
Manage shortcuts in the separate Actions tab; Configuration remains the default
identity/capability editor. Tab changes preserve unsaved drafts. Invocation has no
Action modal: fill the native composer, select inline placeholders, Enter/Tab to
advance (Shift+Tab back), then a separate Enter/Send to submit. Unfilled markers
block both keyboard and button sends; IME confirmation must not advance a field.
The `@` entry checks the currently selected session and its actual header role,
discards stale async candidates and closes stale menus when that role changes.
An inherited/reused blank session's preset is not explicit role selection: bare
`@` must not expose its Actions. Both the new-session `@` Agent choice and a
successfully applied native hero chip choice are explicit. The latter exposes
same-session Actions directly, including reselecting the displayed blank role.
The supported-host patch bridges that native event, with original backup
`.dtc-action-role-backup`. Tab-local `dtc:action-role:<sessionId>` stores only the
Agent ID; refresh preserves it, New Session or owner change clears it. This is
not a permission grant; native/backend role checks remain. Keyboard candidate
mounting must wait for the matching native input revision, like text selection.
Visible default parameters remain placeholders until accepted/edited. Refresh
reclaims the native Action before sending; tab-local metadata retains only range
coordinates/Action identity, never a second prompt copy. Missing metadata recovers
literal remaining markers. Both Enter and Send must block unresolved drafts.
The supported-host `scripts/patch-input-menu.mjs` now patches native menu async
focus and plugin-scoped `@` submit adjudication (DSH otherwise only re-adjudicates
`/`). Reapply/check after a supported reinstall; preserve its exact-file backups.
Unknown host versions/anchors fail closed. See `docs/agent-actions.md` for these
receiving contracts and the no-business-write keyboard/recovery browser tests.
Existing-role Actions queue
a native user turn in that same Session; Agent → Action before starting uses the
normal preset session creator only after explicit confirmation. Preview/selection
never executes. Actions confer no tools or host grants; the original Agent/MCP/Task
policies still apply. See `docs/agent-actions.md` for APIs, starter pack installation,
limits, uncertain-send behavior and the opt-in tool-free public UI smoke test.

Action parameters also support configurable Enter-default acceptance, static
choices, integer/minimum limits, registered metadata sources and simple earlier-
parameter conditions/dependencies. Conditional slots are skipped, not submitted as
unfilled markers; changing their parent invalidates the old selection. The browser
starter defaults count to 1 and login to the existing allocation policy. Specified
accounts display email/source IP/browser and remain intent, not login evidence.
Candidate reads use the configured browser MCP's existing read/policy modules;
they must never call discovery refresh, SSH, verification or copy while editing.
Keep its optional adapter layout and read-tool visibility checks; do not replace
it with arbitrary config-provided tool/URL execution. Late replies cannot cross
roles. See the schema, stale-identity semantics and candidate browser tests in
`docs/agent-actions.md`. Merge starter updates through sidecar CAS only after
checking for user edits, never by rewriting AgentSpec or its Task review hash.

The version-fenced history patch also shields DeepSeek-compatible model requests from
previously rejected malformed tool-argument JSON. Raw session/Trace records and tool
execution stay unchanged; only request serialization carries the invalid input as
explicit non-executed evidence, allowing the model to correct it after the tool error.
Do not silently repair and execute malformed arguments. Reapply through the existing
`scripts/patch-history-ids.mjs` host patch after a supported host reinstall.

Package remains `dsh-task-console`; Agent and Board are modules of the same plugin.
Database execution reports live at `#/tc/tasks/:id/runs/:batch/report`, with a
return-to-workflow button. Keep the same Batch's replay/selection/canvas mounted
while showing the separate report; report navigation pauses autoplay, not the
business execution. Refreshing the report opens the current state of that Batch.
Historical views must identify their replay step and never add future evidence.
Console Escape closes the visible top layer via its explicit close control,
otherwise closes the center like X. Preserve disabled-close and IME guards;
never let one Escape dismiss both Sessions/fullscreen and the whole center.
Task-owned Actions use the same native composer, with configuration at
`#/tc/tasks/:id/actions`. Keep their SQLite catalog separate from TaskSpec/reviewed
workflow hashes and cron bindings. Submission is `launchTaskAction`, not a normal
session prompt; preserve its stable request ID, safe frozen `turn.action` and
private credential mechanism. Creator-generated Actions are independently reviewed;
never seed over a nonempty catalog or bypass the existing Fleet login acceptance.
See `docs/agent-actions.md` for APIs, bindings, recovery and browser test boundaries.
Use the installed DSH service's actual executable/configuration to identify the host,
not an adjacent source checkout. Its generated `lib/` plugin assets are tracked.

The optional `lib/proxy-mcp.js` stdio entry is documented in `docs/proxy-mcp.md`.
It reuses existing managed Clash operations behind a protected node/line policy;
no policy, Agent grant or startup connection is created on plugin upgrade. No-config
startup supports discovery but denies every target. Its SQLite/node receipts and
unknown-outcome locks are separate from Task history and must not be blindly removed.
MCP availability alone is not proof of repaired machines. Reviewed browser-patrol-v2
designs may opt into `design.proxy` as described below.

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

Planner handoff must not wait for its own downstream notifier's `sent` receipt.
Delegated `task_notify` returns `nextAction`; queueing is enough to call the planner's
`task_plan_round` or `task_finalize`, not enough to declare the Batch successful.
The actual notifier still runs afterward and failed delivery keeps the Batch unresolved.
`completed-patrol` checks sent receipts only at schedule activation, not planner handoff.
A dependency block without an unfinished parent parks instead of immediately re-claiming.
For hourly browser-patrol-v2 Batches, a blocked card beyond its original time budget
ends failed when no active/scheduled work, user-input wait or uncertain operation remains.
This preserves old Runs/receipts, does not replay missed hours, change cron or reset
repair budgets; the next due occurrence independently checks current state.

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

Paused chat-created cron Tasks support `decision=revise` through the same Creator
draft/review flow. It updates the same Task, never creates a replacement Task or
Batch. Review CAS checks the original definition, current roster, paused state and
absence of unfinished work; historical Batches without frozen definitions prohibit
revision. A single SQLite transaction updates the definition, reviewed schedule
binding and review state and appends `task/revised` with the previous definition.
Original creation time, Batch inputs, role Runs, evidence and outcomes stay intact.
Cron remains disabled; the latest manual trial must match the new reviewed definition.
Browser-patrol-v2 revisions cannot remove its evidence contract, shorten observation
or change the approved notification scope. Unsupported design fields fail closed.
The optional `design.proxy={agentId,lineId,maxAttempts}` adds a real per-round proxy
role before the existing Gate. `task_plan_round` atomically freezes both browser items
and matching proxyItems. Definite per-node failures may be handed off; the host denies
login writes for unverified nodes while healthy nodes continue. Running/unknown
operations cannot be abandoned or retried with another ID. A shared proxy ledger
namespaces idempotency by actual Session and keeps node reservations and repair budgets
across Task rounds. This is not a universal mutex against unrelated SSH/legacy tools.
The dedicated proxy Agent has only proxy MCP grants; main business roles have read-only
proxy grants. Login copy/provision/resume requires a real network receipt no older than
15 minutes. Final acceptance also requires independent reviewer receipts; historical
independent acceptance does not expire during downstream stability waits, but later
adverse evidence or repair invalidates it. Original browser and notification gates stay.
`task_create_status` separates active/queued/waiting/blocked and returns blocked card
reasons, rather than treating every unsettled Batch as actively running.

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

Patrol follow-up/liveness (0.30.25): Fleet reads the allowlisted SQLite projection
through `GET /dsh-task-console/api/patrol-followup`, authenticated with the existing
`DSH_TASK_INTAKE_TOKEN`. Configure `DSH_PUBLIC_ORIGIN` for exact execution links in
notifications. No second status database or scheduler is introduced. A real blocked
business card can enqueue an independent `blocked` notifier without depending on
the blocked card. Explicit operator resend uses `scripts/resend-patrol-report.ts`
with a stable request ID; original notices and ambiguous-send protection remain.

Completed local browser/proxy operations must be read by the owning resumed role,
not mistaken for still-running work or restarted under a new operation ID. Proxy
ownership errors show only that card's own exact IDs; the host does not guess an
ID or query the remote on the Agent's behalf.

New reviewed cron plans may explicitly provide top-level `recurringObjective`.
Review compares it with the original request and full definition: preserve all
business restrictions but omit Creator-only staging instructions. Older plans and
bindings keep their original semantics; upgrades do not rewrite them.

Optional reviewed `browserPatrol.resumeAfterCopyLimit:1` permits one normal
continuation of a confirmed prior import for the same Task/open issue. It requires
`actions` to include `resume`, fresh signed-out proof and the original account's
current authorization. Copy counters/history remain; this does not grant another
import, deletion, rebuild or challenge bypass. Browser MCP resolves the original
import across sessions via SQLite, not candidate ranking. Repaired targets still
need 20-minute/4-sample independent verification. Older frozen executions do not
acquire this extra budget.

0.30.26 counts actual continuations separately from explicit `not_started` preflight
refusals. Raw issue counters/operations never decrement. The Browser MCP may append
that classification only from its private authenticated adapter receipt showing
the exact pre-apply `main -> idle` refusal, matching the original Task role/target.
Timeouts, unknown outcomes, target-control errors and post-apply errors retain the
reservation. This does not authorize another copy or bypass a busy browser.

Opt-in reviewed patrol extensions (0.30.10): `browserPatrol.excludedNodeIds`
contains exact user-approved node IDs. Inventory remains intact and replay reports
exclusions with their observed reachability; excluded nodes cannot enter round actions
or proxy acceptance. Never hardcode an IP or silently exclude an unauthorized node.
`actions: [...,"recover"]` permits only a fresh native `cdp-unavailable` observation
to produce a frozen recovery action. The Browser MCP additionally intersects its exact
host `recover` instance grant, re-verifies before writing, and preserves profile/other
instances. This is not retire/purge/reinstall authority. Its mutation counts against
the same persistent issue budget and requires the unchanged independent stability window.
`scheduleActivation: "completed-patrol"` separates operational trial acceptance from
fleet health: an explicitly unresolved manual Batch may activate only when every
canonical role is done, the native final patrol snapshot permits unresolved closure,
the reviewed definition/roster still match, and all notification receipts are sent.
Crashed/blocked/incomplete roles, missing evidence and unknown delivery still fail.
Absent this opt-in, the original all-passed activation rule below remains unchanged.
No existing plan/history/schedule is changed by upgrading the plugin.

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
Other business contracts retain generic durable waits. Healthy targets need one valid
independent check in this Batch; expiry during other targets' repair windows does not
require repeating those checks or long stability observations.

New recurring login workflows opt into `browser-patrol-v2`; legacy v1 remains intact.
Planner, browser-manager and independent read-only reviewer use native tool receipts,
not model counts. A round freezes exact instance/action items together with its Gate
and links. The Browser MCP intersects these with host grants at execution time and
reserves repair attempts in `dsh_browser_issues/operations` across later Sessions and
Batches. Repeating an ambiguous mutation reservation requires reconciliation, not
another copy. No lifecycle/rebuild authority is granted by this contract.

Only repaired/unresolved instances need the reviewed stability window. Patrol
`assessmentMode=point-in-time-v1` separates `accepted` (this Batch's independent
check/stability result) from `freshness` (receipt validity at `assessedAt`). A receipt
must be valid when actually observed, from this Batch and the real reviewer's paired
tool result. Its original checkedAt/expiresAt are never extended. Later expiry alone
does not erase that successful historical check or authorize copy/rebuild. Subsequent
negative/unknown evidence, identity changes or new mutation reservations invalidate
older review; executor success alone cannot reinstate it. Independent sample counts
and the full repair window remain, including after this Batch's issue is resolved.
New copy plans still require fresh explicit signed-out evidence, never stale evidence
or a check superseded by a failed verification. Coverage gaps remain separate blockers.

Same-session blocked/interrupted Browser status receipts append deduplicated
`patrol_verification_unavailable` events using the operation's actual updatedAt.
They invalidate earlier checks but are not fabricated login samples or logout proof.
Only a subsequent independent check restores acceptance; model summaries and another
Session's failures cannot supply these facts. Source sessions/operations are preserved.

`task_patrol_status` exposes scope, budgets, samples, freshness, precise independent
receipt times and categorized reasons. `patrol_snapshot` events drive the evidence
panel at the selected replay position; an assessment-clock change alone creates no
new event. Replay never reads today's Fleet state or re-evaluates against today's
clock. Older snapshots retain their original accepted/ready/outcome/summary and are
explicitly labelled historical; display explains expired evidence without changing
it to passed or signed-out. Notification text uses the same reason vocabulary;
previously queued/sent outbox reports remain frozen. A supported `unresolved`
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
