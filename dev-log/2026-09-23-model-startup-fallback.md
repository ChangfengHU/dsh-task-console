# Controlled Task model startup fallback

Failure under investigation: Task `T-chat-b4c6fcb369f0c20a9739`, Batch
`b-chat-70d2a9aac267e53c183f`, Run 1103. Persisted request selected
`codex-local/gpt-5.6-terra`; it failed before tools. Root cause is the pinned
Codex CLI/global model catalog mismatch, not Qwen credentials.

Host configuration adds optional `taskFallbackModel` (`provider/model`) and
`taskFallbackFromProvider` (default `codex-local`). Empty fallback disables it.
Only TRANSPORT/AUTH/RATE_LIMIT/PROTOCOL_VERSION errors before any tool call or
terminal submission qualify, once per worker Run. The same session, CAS claim,
deadline, role, tool fence and Task inputs are retained. Provider-specific effort
and output budget are re-resolved. Canonical `model_fallback` records the switch;
business failures, approval requirements and cancellation do not trigger replay.

Tests cover scoped prompt/request selection, no duplicate session/run, one-shot
fallback, preserved permission preset, cleanup and no fallback after tools.
Production still requires a zero-active deployment window and actual model/Task
and browser verification; no target-machine operations by the developer.

## Live verification

- Main `aa8eaee`; live Studio integration `c683d2d`, both pushed.
- Deployed Task runtime at `dsh-studio-migration/task-console-fallback-c683d2d`
  during zero native sessions / zero running SQLite claims; existing Studio kept.
- Live route is `deepseek-official/qwen-plus-latest`, not the plugin package name.
- New Batch `b-chat-48a47c2f21fe61a23551`, Run 1104, one same session:
  request/header changed from codex-local/gpt-5.6-terra to Qwen Plus after startup
  TRANSPORT. Canonical event 14955 records model_fallback. Actual Qwen dispatched
  fleet_onboard_start then fleet_onboard_status, with the original role tools.
- Tool returned probe-transport-failed/run_created=false. This is not proof of bad
  credentials and not onboarding success. The verification Batch was cancelled
  through Task API, retaining its records, without developer target operations.
- Public Chrome 1440x1000 passes workflow + replay STEP 10 model switch text and
  provider destination, no page errors. Screenshot `/tmp/dsh-model-fallback-run-1440.png`.
- Tests: main 53, integrated Studio 59, CLI 137 and CLI typecheck passed.

## Remaining deployment boundary

The initial CLI module-path override was rejected by the profile name guard;
that was NOT a successful primary-route deployment. Corrected the patch to keep
`name: dsh-codex-claude-cli`, configured modelCatalogPath and staged patched host
code in its installed lib/index.js. Old bundle backup is in
`dsh-studio-migration/codex-startup-0289358/previous-index.js`.
Composed config now includes the catalog. Standalone pinned runner gets a genuine
MODEL_OK response, no tools. The running host still holds the old imported CLI
module until restart. Another Studio Task became active; do not interrupt it.
Re-check BOTH native session.list running and SQLite task_runs running before
restarting sop-dsh-web.service, then test a no-tool fleet-installer session.
The Qwen fallback already runs in the current host. The separate 236 SSH probe
transport blocker remains unresolved; do not claim Fleet onboarding completed.

## Safe probe diagnostic propagation

Linux-clash SSH probe/host adapter now report fixed error codes instead of
discarding every failure cause. Task Console accepts only that finite diagnostic
vocabulary; unknown/raw/oversized stderr stays generic. All 33 onboarding tool
tests passed with NODE_ENV=test (the initial invocation without that required
test environment failed loopback fixtures). Live deployment is pending the
zero-active boundary; target installation is still delegated exclusively to DSH.

## Deployment correction and impact

Integrated diagnostic revision 55ea995 is pushed and staged in
`dsh-studio-migration/task-console-onboard-55ea995`. Editing the live profile
triggered a hot reload BEFORE the planned restart. This interrupted Studio Run
1105 and our verification Run 1106 even though systemd PID remained unchanged.
This was a developer error, disclosed to the user; never treat configuration
editing as harmless staging. Both failed histories remain. We cancelled only our
Batch b-chat-8d581e4fe0dd30541381; no explicit Studio retry/cancel was performed.

After independently verifying native sessions=0 and SQLite running=0, restarted
the host to load the corrected CLI catalog and integrated diagnostics. New
authorized onboarding Batch b-chat-c80f18f2b92cf417a283 / Run1108 starts on Codex,
loads fleet-node-onboard and calls fleet_onboard_start. Target acceptance remains
pending. No developer SSH operation to 236. All source changes have been pushed.

## Actual 236 Agent outcome

Run1108 uses Codex successfully (no fallback event). It loaded the Skill, started
onboarding and called resume/report itself. Ledger onb-6e02b413-20f7-4281-8c15-7f935e9df64e
records stages1–3 reused, stage4 repaired-and-verified, stage5 reused and stage6
installed/passed. Stage7 stopped with machine-browser-stack-conflict and
browser-startup-unconfirmed. This is not installation completion. The installer
refuses occupied display/ports not attributed to its managed units; do not bypass
this guard or delete existing browsers. Exact conflicting service ownership is not
yet established. Registration and subsequent Runner/login acceptance remain pending.
Public Chrome opened the actual execution in31.4s, with three roles/one session
and no page errors. Screenshot /tmp/dsh-onboard-probe-retry-236.png.
Temporary diagnostic worktree/build removed after pushed-source bundle verification;
1.7MiB build output freed, deployed runtime and evidence retained.

## Read-only onboarding ownership tool

`fleet_onboard_inspect` accepts only an IP and uses the host-owned credential and
fixed SSH probe. It projects fresh, bounded ownership observations and discards
unknown output fields. It cannot create a ledger, install, or infer permission to
kill/uninstall an unknown service. Missing credentials use normal intake; probe
failures use bounded diagnostics. Added to the installer runtime tool group, not
to the review-only role. Unit/browser deployment acceptance is recorded below as
it occurs;236 is still blocked and deletion scope/target require confirmation.

Verification:36 onboarding-tool and12 preset tests passed. Inspections make zero
ledger calls, never invoke the installer, and cannot leak fixture credentials.
Host probe5 + SSH/readiness17 + onboarding67 tests also passed.

### Scoped live/browser verification

Built only the88KiB onboarding module into the versioned runtime above, retaining
existing Studio/Task frontend assets and the global profile. Verified preset
generation behavior in the installed harness before changing only the idle
fleet-installer composition; Studio Run1110 remained running. Host81cf5bb scripts
installed root-owned, matching SHA256; prior two scripts retained in root-only
upgrade-backup-81cf5bb. Both source commits pushed.

Chrome clicked the real Agent page's new-session button and sent one read-only
request in agent-fleet-installer-mudto47m. The Agent loaded its Skill and invoked
fleet_onboard_inspect exactly once. It found unmanaged novnc.service/websockify
PID45314 on6080, no managed desktop config, other default ports/display free.
No installer, SSH by developer, deletion, or global restart occurred. Public
Chrome rendered the actual response in31.72s without page errors, screenshot
/tmp/dsh-installer-inspect-public-result.png. The initial submission assertion
timed out because the composer placeholder changed after send; persisted user
input, actual tool result and a separate browser reread establish submission.

Chrome also created fleet-node-retirer session agent-fleet-node-retirer-mudtrsm2
and requested only deletion preflight. The Agent queried fleet_status once,
correctly found236 absent and performed zero lifecycle mutations. This is NOT
real deletion acceptance. User confirmation of deletion scope/target and the
existing novnc service's replacement/adoption boundary remains necessary.
Installer success, Fleet registration and complete two-capability acceptance
are still pending. The older host's catalog/full integrated deployment remains
pending a dual-zero window. New test fixtures now clean only paths they create
after all tests finish;36 onboarding tests pass again with that cleanup.

Deletion preflight public browser reread passed in39.97s with no page errors,
screenshot /tmp/dsh-retirement-preview-public.png. It proves the read-only
preflight and report, not deletion. Runtime88KiB and screenshots are retained as
active service dependency and acceptance evidence, not temporary cleanup targets.

## User-approved replacement and manual membership removal

User authorized236's exact old noVNC replacement, but clarified that manual removal
only removes Fleet membership, preserving ALL Vault/access and remote data.
Automatic168h retirement remains separate. Fleet c3ff0b7 was pushed and deployed
as four source-preserving module deltas with unchanged bindings and matching
readback SHA;31 targeted Fleet tests passed. No production node removed yet.

Browser testing found legacy fleet-ops could not mount its copied-header vault
client. Regenerated only that preset through saveAgent using current vyibc-vault
host references, retained its existing role tools, enabled the already-authorized
SSH execution permission and added browser Skill. No global profile/restart.
The manual `移出集群` Action is saved through the revision-checked Action API.
Chrome created agent-fleet-ops-mue2yyrn and submitted bounded noVNC preparation;
execution remains under observation, not accepted as completed installation.

22 Action/preset tests passed. Public Chrome opened the existing fleet-ops Actions
tab in29.18s with no page errors; screenshot /tmp/dsh-manual-withdraw-action.png.
The earlier test used a button locator for a tab and timed out; the corrected real
tab click and screenshot establish visibility, not deletion acceptance.
DSH ops backed up236's exact novnc unit at /root/novnc-recovery-20260923T123219Z,
disabled only that unit and verified6080 free. Installer session
agent-fleet-installer-mudto47m resumed the existing transaction, stage7 attempt2
passed, then stage8 failed with downstream-read-failed. A subsequent DSH read-only
probe confirms8792/health reports0.15.8 and the authenticated publication-endpoints
route returns424; old8787/8080 probes were wrong-service evidence and explicitly
corrected in the same session. Do not restore the legacy noVNC over the healthy new
listener. No Fleet registration or actual manual removal is claimed yet.

## Actual236 installation and manual withdrawal accepted

DSH read-only inspection isolated root0700 control_plane.sh: matching pinned SHA,
but the ordinary user verifier could not read it. SOP8839764 introduced privileged
digest verification; follow-up98badcc added the exact manifest paths to its existing
allowlist. Initial digest-mocked tests missed that guard boundary;46 machine tests
now include real guard/metadata/digest-chain coverage. R2 machined0.15.17 and host
linux-clash8b01bf3 deployed with matching SHA;17 focused host tests passed,67 core
onboarding tests passed before the final version-only pin follow-up.

Installer session agent-fleet-installer-mudto47m used its own start/resume/report.
Ledger onb-92f512d5-0bf2-4e0b-b3b1-66426c0c4b7e completed10 stages at13:12:32Z:
stages1–7 reused,8/9 repaired,10 registered. Older failed ledgers remain immutable.
Public Chrome history loaded15.64s, zero errors; Fleet visible236 card showed online,
two desktop browsers, telemetry, proxy and VNC. Hidden duplicate text initially
fooled the test locator; corrected test selected the visible card, not hidden DOM.
This is base-node acceptance, not a Gemini login or Runner installation claim.

In the existing fleet-ops session agent-fleet-ops-mue2yyrn, browser selected the
actual @移出集群 Action and filled236. First Enter commits placeholders; second
Enter really submits. Verified new turn9 before claiming execution. Agent called
status/node_detail/recycle_node/status/node_audit, not retirement or direct SSH.
Audit6088 at13:19:24Z: changed, registered=false, runnerDisabled=true,
vaultPreserved/accessInventoryPreserved/remoteUntouched=true. Independent D1 reads:
membership0 and enabled matching runners0. Exact node Vault inventory and value
digest match before/after; machine_access absent both before and after (not a
claim that a row existed). Public Chrome confirms Fleet card absent, zero errors;
VNC page200/title noVNC and Clash health200 remain. VNC websocket login was not
tested; no remote service/data mutation was performed by manual withdrawal.

Final236 state: intentionally withdrawn from Fleet after successful installation;
all credentials/services/profiles/DNS/tunnels retained for later re-enrolment.
Developer never SSHed the target and did not globally reload DSH. Failed Task/ledger
history remains. Ops turn8 falsely said stdout was unavailable despite a persisted
health result; final acceptance uses actual tool receipts and independent reads,
not that prose claim. Broader CLI rendering behavior is not declared fixed here.

Evidence retained: /tmp/dsh-236-verifier-history.png,
/tmp/fleet-236-agent-installed.png, /tmp/dsh-236-withdraw-submitted.png,
/tmp/fleet-236-agent-withdrawn.png, /tmp/fleet-236-vnc-preserved.png.
Two host-only temporary backup directories under /var/backups named
dsh-onboard-verifier-yWzEPP and dsh-onboard-verifier-h1BZSD were byte-matched to
linux-clash895b4b9/1beeb77, checked unused, then removed (126232 bytes). Restore
scripts from those commits if needed. Remote legacy noVNC backup is retained.
No dependencies installed; unrelated lib/client-heavy.js, lib/client.js and
lib/index.js edits preserved. Source changes already pushed; this records outcome.

## 2026-09-24: full-node acceptance correction — development, not deployment

The owner subsequently re-enrolled236 through installer session
agent-fleet-installer-mudto47m. The earlier withdrawal snapshot above remains a
historical acceptance result, not today's membership state. Today's public Fleet
read confirms236 online with desktop-only browser rows and unknown reachability;
Vault directory still has no browser:host-129-213-30-236 entry. These observations
do not prove the standalone browser service is physically absent on disk.

Root cause: the base ten-stage contract is narrower than the requested complete
node. The existing v2 recipe names all three roles, but its host business gate
only enforces Gemini acceptance on browser-manager. Standalone base completion
does not prove browser management or Runner readiness.

Source changes in this slice:
- Explicit base-provisioning/not_evaluated scope on model-facing start/resume/
  status/report results; report availability is visible on status too.
- Separately reviewed fleet-base-v3 orders installer, browser-manager, Runner.
  Paired native same-Batch tool receipts prove fresh base execution/report and
  session-owned signed Runner execution. Fleet readback rejects desktop-only,
  unknown/stale login detection, absent continuous observation, incomplete host/
  proxy metrics, and missing same-job exit/line observations. Preserve-login
  permits explicit signed-out; provision-gemini retains the v2 20-minute gate.
- No human-review shortcut around v3 business evidence.
- Paused once Task revisions reuse existing review/CAS/history, do not create
  another Task or schedule; v2→v3 cannot weaken its login policy.
- Managed installer persona distinguishes base completion from full acceptance.

Verification: focused initial110 tests passed; after revision and review-bypass
coverage,73 focused tests passed. A full357-test run had353 pass/3 existing skips
and one timing failure in an existing rework test (it selected the disposed
previous session after a fixed80ms sleep). That test now waits boundedly for
the expected new ready Session instead of assuming startup latency; full rerun
passed354/357 with3 existing skips and0 failures. Subsequent exact-hostname legacy
node-ID support and retained v3 Gemini stability passed18 focused tests. Staged
build succeeds using existing dependencies; no dependency installation occurred.

Not deployed: live DSH has unrelated Studio Runs (1117 then1118 observed with
fresh heartbeats). Do not edit live profile/restart until both native and Task
activity are zero. Main's dirty lib/client-heavy.js, lib/client.js, lib/index.js
are pre-existing unrelated changes and must not be staged or overwritten.
Build /tmp/dsh-fleet-v3-build-yj8sdf is a temporary1.6MB candidate, not referenced
by production; rebuild from source, remove after integration evidence is retained.

Remaining: update authoritative Skill contract, inspect actual role capabilities
and operator receipts, integrate source into the Studio deployment lineage,
upgrade the existing Task through Creator review (old unsettled Batch must be
handled visibly without deleting history), update scoped installer preset safely,
run236 through actual Task/Agents, browser-check Fleet/Board/report, then repeat
for idempotence. A controlled targeted-rework path must be verified too; current
v3 reports responsible-role capability blocks and is not claimed autonomous recovery.
No target machine operations, live Task revisions or deployments in this slice.
Boss binding retained the task; linux-clash Brain initialization reported ignored
metadata, so no portability claim is made for that Brain (use its tracked TASKS/
dev-log/HANDOFF when changing that repository).

### 2026-09-24: bounded component-owner rework

Added a host-evidence-only repair transition for the final v3 Runner readback.
It materializes Gate → responsible owner → independent Runner (Runner-only
observation faults do not rerun browser/installer). The original verification
Run retains the failure and `decision=rework`; normal CAS dispatch creates child
Sessions only after dependencies finish. Two repair rounds and the original
three-role total timeout bound retries; missing/untrusted receipts and explicit
human/capability blocks are not converted to automatic repair. Later failed or
malformed native receipts now invalidate earlier successful tool receipts.

New tests exercise actual normalized tasks/links, Gate with zero Runs, delayed
Session creation, healthy installer reuse, final settlement, stale source CAS,
time/round ceilings and failed receipt precedence. Focused four-test rerun
passes; full suite rerun exits0 (existing skips retained). Two test-only assertion
fixes used the actual `batch.settled.outcome` / `graph.live` API; production kernel
timestamps remain epoch seconds, covered explicitly. Live SQLite claims were0
when checked, but this is not enough to authorize hot reload without a fresh
native session check. Integration, Skill/preset rollout and actual236 verification
remain pending; no target-machine actions occurred in this slice.

### 2026-09-24: Skill packaging and live baseline recheck

Authoritative linux-clash Skill7a7e59a separates base provisioning from full Task
acceptance and corrects managed SSH writeback to its dedicated key, preserving
bootstrap records. The installed local Skill and packaged installer copy match;
Skill validator passes. Existing stage gates and privileges are unchanged.

Isolated Studio integration on55ea995 built and passed528/531 tests,3 existing
skips. Its first full test run exposed a test-only hardcoded sibling calibration
path; the test now accepts an explicit existing evidence path, without changing
production calibration logic or fabricating proofs. Rechecked live configuration
then discovered newer deployed Studioff7eed66461f. The55ea995 candidate MUST NOT be
deployed over it. Import the live source.bundle, merge its newer stage/UI logic,
repeat tests, and recheck zero native/SQLite activity before any live edit.
No target action, live Task revision or production switch has occurred.

### 2026-09-24: integrated deployment, live Creator failures and reviewed defaults

Integrated the actual ff7eed Studio baseline, deployed6157899 at a verified zero
native/SQLite activity boundary, then deployed9ecf721/7e38e84 fixes without
overwriting main's unrelated dirty lib files. The scoped installer Skill/persona
now distinguishes base provisioning from full acceptance. Creator's old v2
persona and invalid object-vs-string design guidance were corrected while
preserving its custom suffix, grants, model and Actions. Original Task
T-chat-b4c6fcb369f0c20a9739 remains paused v2. Old unsettled
b-chat-c80f18f2b92cf417a283 was cancelled through the normal Console API; no
Task, native Session or failed evidence was deleted.

Actual Creator execution exposed undefined workflowRecipe fields rejected by
native lossless JSON serialization. Conditional field emission fixes this; a
paused non-recipe context round-trip regression and actual successful context
call verify it. Shared Studio DAG labels were also incorrectly applied to Fleet
cards; labels now depend on the actual Studio evidence contract. Public Chrome
Task checks loaded in46.36s/49.13s with zero page errors and verified non-Studio
role labels. Public cold loading remains slow, not declared solved.

Creator session agent-task-create-agent-mufarotk produced plans
P-chat-9034da23fcaf9e409e75 and P-chat-4de6a7854fa5fd158047. Both were independently
rejected: they mixed unrelated patrol roles/waits or invented tool evidence fields.
No target operation was released. d2dd457 adds an explicitly selectable host
default design for fleet-base-v3 only: omitting design selects the matching
preserve/provision-gemini contract; explicit custom designs remain validated and
unchanged. All plans still require independent approval. This is not a prompt-only
claim that arbitrary plans become executable.

Concurrent Studio6b8e1a4 (which already contains7e38e84) and laterb1c3c04 were
imported from their release source bundles and merged, not rolled back. Candidate
a089737846a6d55adf2458d443aee40e67164e45 is pushed on
fix/model-fallback-studio-20260923; staged release lives at
/home/claude/dsh-studio-migration/task-console-fleet-a089737846a6.
It preserves the newer Studio host configuration and recovery logic. Current
live host remains task-console-studio-b1c3c04fb9f4 with the9ecf721 Fleet frontend;
installer and Creator scoped tool paths still reference7e38e84. Do not infer that
staging a089 activated its default-plan support.

Verification: the6b8e1a4 merge passed618 tests (615 pass,3 existing skips) serially.
Test-only fixture fixes supplied the real frozen voice script and replaced a fixed
80ms notification sleep with a bounded ready-state wait. b1c3c04 then passed27
focused recovery/fold tests, build, and a final all-test serial dot-reporter run
with exit0. Tests use the existing installed compiler/calibration fixtures and
Node22; no dependency installation occurred. Live capability audits for the four
roles have no missing/unexpected tools or dependencies, but remain explicitly
unverified-legacy, not business readiness proof.

Next deployment was correctly deferred: unrelated Studio Run1119 and native
task-t-mue3kz9c-b-mue73n1r9ck-2-t3 remain running with advancing heartbeat.
Recheck both native Sessions and SQLite claims before any profile edit. Preserve
any newer live release before activation. After a safe switch, continue the same
Creator session using the explicit default design, independently review the
same-Task revision, then launch236 through the public browser and repeat once.
Fresh public Fleet read still showed desktopOnly browser rows, missing browser
service/HTTP521 and unknown reachability; no full-node success has been observed.
The developer never SSHed236. Build/worktree/release candidates and screenshots
are retained for deployment/acceptance/rollback, not safe to clean while pending.

### 2026-09-24: reviewed v3 Task and latest integrated candidate

Integration branch fix/model-fallback-studio-20260923 now contains f2d312d:
the real /api/fleet/exits envelope uses exits, not rows; validator and tests
were corrected without weakening signed-job/freshness/target checks. Full serial
regression:621 passed of624,3 existing skips,0 failures.

Continued the same Creator session with the exact tested explicit design. One
response invented a plan ID without calling submit; native events/database
caught it, and no fabricated plan was approved. A real subsequent submit produced
P-chat-81237bbff2216cf72aff, independently byte/field-compared against the recipe.
Public Chrome approved it (35.37s load,0 errors). Original Task is now v3 with
provision-gemini, remains disabled, with original trigger/Actions and eight listed
execution IDs unchanged. No236 execution began.

Latest integration1a14133 additionally corrects review UI's misleading execute/
cron/absent-gate wording and links back to the actual Task, without changing
layout or removing functionality. Seven focused tests, build, and candidate
asset interception in real public Chrome at1440/390px passed. Screenshots:
/tmp/dsh-fleet-review-81237-before.png and -approved.png;
/tmp/dsh-fleet-review-candidate-1440.png and -390.png.
These candidate screenshots do not mean production UI is updated.

Staged task-console-fleet-1a14133cad86 is not activated: live remains Studio
b1c3c04 with unrelated Runs1120/1121 and real active native Sessions. Before
switching recheck both activity sources and any newer live source. Preserve
existing participant preset/module pins so the reviewed roster remains valid;
installer7e38e84 code is byte-identical to candidate installer. Then enable the
same once Task, supply236 as fresh run input through the public UI, track full
three-role evidence, and repeat for idempotence. No developer SSH to236 occurred.

### 2026-09-24: live v3 run and independent custody regression discovery

After native Sessions AND SQLite claims reached zero, activated integrated
1a14133cad869de1a76c79142e5328f07f4f6a1f from its staged release. No process restart
or participant preset rewrite; served heavy asset digest matched candidate.
Public Chrome enabled/launched the original reviewed once Task with fresh236
input: Batch b-chat-5d944930d2d8c1582400. Actual DAG/fullscreen screenshots are
/tmp/dsh-fleet-236-v3-board.png and -fullscreen.png; all three role cards are
visible, future roles have no fabricated Run/Session, zero page errors. Cold
public load remains36.74s and is not declared fixed.

Installer Run1122/session suffix-1 completed base ledger
onb-c9ed757e-80b7-489b-866e-e8eb949de60d at09:49:33Z; host accepted its paired
native start/report evidence at09:50:02Z. Stages mostly reused; stage9 repaired.
This is base handoff only, not full acceptance. Browser Run1123/session suffix-2
called default prepare b45a92512170f55534cabb37a62a7830, complete09:53:49Z:
independent browser control published, CDP1/2 working, profiles preserved and
original browser PIDs retained by prepare; imageInstalled=false.
Real login-provision jobs7bc528af0886a6c821ceac2926def40e and
7d44784ab7f9c697d171c639b41896f3 completed09:57:03Z/10:00:06Z with verification.
These imports can restart only their own target browser; do not generalize the
prepare no-restart receipt to the entire execution. Full stability/Runner and
second-run idempotence remain pending. Native raw browser tool names include the
expected MCP prefix; Trace strips it for display, not an evidence mapper fault.

New live evidence contradicts the requested Vault delivery path: authenticated
login-accounts returns contract=login-vault-v2, usable stored credentials, but
deliveryEnabled=false. Read-only CF settings confirm the binding is ABSENT, not
an invalid account. Current version bee06404-80a7-4d3c-b928-f407b5311560 and prior
1ce74cc2-7efe-47da-9efd-ada16ed4a73c both lack it. The linux-clash browser-node-create
log documents actual activation on2026-09-14 (version2e54774d-4fb5-40ba-9630-105c0ad64453).
The checked-in wrangler vars omit the flag; exact first removal/caller is not yet
proven. Current MCP therefore legitimately selected its legacy live-copy path,
and only one source was eligible, so both targets received the same account.
Do not call this Vault delivery acceptance, overwrite these now-healthy logins,
or broaden account grants to force diversity. Next: preserve current live Task,
finish real verification, repair lost rollout configuration/persistence through
the owning Fleet project after its deployment checks, and independently prove
the requested custody path. No CF or target write was performed for this diagnosis.

### 2026-09-24: restore custody setting and resume the same browser card

First acceptance a096aa1f5a45573c1503d1643483c143 failed on browser1 signed_out
at10:01:53Z; native Agent1123 called task_block and ended, retaining evidence.
In linux-clash-skill, e916027 persists the accepted rollout flag in Wrangler vars
with35 passing related tests. Historical CF version2e54774d independently proves
prior activation. Settings-only restoration preserved actual live source and all
other bindings; both fleet.vyibc.com and fleet-console.2513120790.workers.dev now
return deliveryEnabled=true. See that project's2026-09-24-vault-delivery-persistence
log for restoration checks. Actual candidate reader now returns delivery=vault,
three eligible accounts, existing exclusion intact. This is not logout causality
proof or permission to overwrite healthy login.

Console unblockCard resumed the SAME Batch/card as Run1125/session suffix-2-t2;
failed1123 remains, base1122 remains done and Runner has no premature Session.
Second browser prepare44538f72af1c1b287dd6cfd080483676 completed10:11:55Z with
changed=[], profilesPreserved=true, browserProcessesRestarted=false. Native Agent
then started f502be401d1087fd037bc4d2b1807fb0 for the freshly signed-out browser1.
Its real10:13:26Z vault_delivery_requested event selects gemini_648190cc from
stored inventory, not live-copy; terminal login/stability evidence remains pending.
Do not force re-copy healthy browser2 to test the restored transport.

Public Chrome rechecked DAG/fullscreen in26.25s with0page errors. Public Fleet
desktop/mobile screenshots /tmp/fleet-236-vault-restored-{desktop,mobile}.png show
real9222/9223 browser rows, base host metrics, browser1 signed-out and browser2
verified, with Runner continuity/lines still pending. This is intermediate truth,
not full-node acceptance. A first browser fixture had an ambiguous duplicate name
selector; scoping it to the actual nodeList fixed the test, not the production UI.
No developer target SSH, browser import or process restart occurred.

### 2026-09-24: actual Vault receipt and scoped Browser MCP accounting fix

f502be401d1087fd037bc4d2b1807fb0 ended locally blocked with
task-repair-receipt-mismatch, but authenticated GET of the original Fleet delivery
returned terminal verified/mutation imported, gemini_648190cc, version19112,
check10:14:24.386Z. Do not repeat delivery. In linux-clash e0f7291 (pushed), align
recordTaskRepairOutcome with reserveTaskRepair: only frozen browser-patrol-v2
contracts require patrol reservations; live binding remains mandatory. Preserve
safe remote evidence before local accounting.115 Browser MCP tests pass, including
frozen-contract/stale-session/cross-target/no-duplicate-POST regressions. New workers
use the source directly, no global DSH restart or active-session interruption.
Readback through the corrected function and actual live binding returns
not-applicable for patrol accounting; no production budget rows were written.

Visible diagnostic queued to the SAME1125 session. Agent independently verified
and launched d1adda7c3da4cdba3b9cc920aacfdb1c stability operation. At10:24:40Z it is
running with9/8 distinct samples, only482/425seconds, not20minutes. Public Chrome
Fleet1440/390 shows both real9222/9223 and distinct verified accounts, zero page
errors/no horizontal overflow. DAG/fullscreen took20.68s, no page errors;1122done,
1125running, Runner no Run yet. Original1123 remains blocked. Screenshots reuse
the existing /tmp/dsh-fleet-236-v3-* and /tmp/fleet-236-vault-restored-* evidence paths.
Full stability, Runner signed readback and second idempotent run remain pending.

### 2026-09-24: native sleep timeout interrupted otherwise live acceptance

At10:31:07Z native1125 ended with Codex TIMEOUT; Batch5d944930 settled failed and
unstarted Runner was cancelled by the existing dependency policy. Background
d1adda7c3da4cdba3b9cc920aacfdb1c then correctly refused the no-longer-live binding
at10:31:18Z (dsh-session-required). Both logins had15 independent verified samples
and only14minutes before interruption, not a completed20-minute acceptance.

Native seq482 proves the model ran Code Mode setTimeout(600000), followed by wait
yield_time_ms360000. The default Codex provider has a300000ms per-request cap;
seq473–489 lasts exactly that cap. This is not target logout, a failed copy,
DSH's7200-second role watchdog or a live profile reload (mtime10:06:09Z).
The installed fleet-installer copied Skill SHA256 matches the canonical source
a08611dc92a23b8de262b4ebd8b3098e328e8dac13eebc81ef7799ecb6e7abe3.

Fix the Task host, not global model timeout/permissions: explicitly instruct browser
workers to end ordinary turns during running async jobs. On one model TIMEOUT after
tool dispatch, retain the same Run/Session/lease only with a verified pending host
operation, append model_wait_interrupted, and enter the existing30-second host wait.
Preserve the original watchdog, no tool replay or model switch. Resume after terminal
observation for actual receipt reading and original acceptance checks. Duplicate
timeout notifications cannot cancel the waiter; cancellation/business errors,
unknown liveness and repeated timeout fail normally. Failed1125 is not rewritten.

The first all-tests command accidentally omitted the package's NODE_ENV=test and
failed loopback/mock-schema checks; rerun with the declared test environment.
Two new regression assertions initially used Batch.outcome instead of settled.outcome;
corrected the fixture assertions, not production settlement. Focused69 tests pass.
Integration/deployment and fresh original-Task execution are pending; another
Studio Run1126/native session remains active, so no live reload is permitted.

Further review found normal async completion used the missing-terminator nudge
budget, so a multi-operation browser workflow could fail despite making progress.
Scoped operation outcomes now wake the same Agent without consuming submission
nudges. Empty completed turns retain the bounded correction/failure policy. Tests
cover three sequential operations, caller cancellation during the async liveness
check, unchanged deadline/lease, duplicate timeout notifications and one recovery
only. Replay labels model_wait_interrupted explicitly without creating nodes/Runs
or marking acceptance passed.

Full-suite runs exposed pre-existing 80ms fixture races (review handoff, Fleet
repair claim and notifier scheduling). Wait for the exact asynchronous transition
with a finite bound rather than changing production scheduling or weakening CAS.
The notifier fix is the same as the existing integration branch. Full recheck
remains pending at this edit. The current public Related Sessions test originally
looked for anchors, but the UI uses real Open/Trace buttons; correct the fixture
to exercise the actual Trace navigation, not claim missing production links.

Recheck: declared NODE_ENV=test full main suite completed exit0; separate graph
replay tests3/3 passed after adding the wait-event test. Real public Chrome opened
the existing failed Batch's Sessions drawer and navigated1125 via Trace, exact
session URL and zero page errors. No target mutation or live reload. The screenshot
initially captured Trace loading, so payload-render acceptance is checked separately.
