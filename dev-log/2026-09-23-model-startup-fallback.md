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
