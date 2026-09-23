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
