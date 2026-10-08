# Onboarding async continuation repair

Code: `65deb80` (main, pushed). Fixes Task orchestration, not target-machine commands.

## Reproduced defect

Task `T-chat-b4c6fcb369f0c20a9739`, Batch `b-chat-cb3721ec1fd1a7ce7de2`,
installer Run 1355 used central transaction `onb-10658b22-0bb5-4a7b-a23f-d67da9408e43`.
The central ledger passed stages 1–5. Stage 6's durable operation returned
`succeeded/readback-verified`, but the Task terminated with `protocol_violation`
and cancelled downstream roles before reconciling that receipt.

Two races shared the cause: a terminal receipt already present at model turn end
was discarded as no longer pending; a later polled completion used the same
one-nudge budget as a genuinely missing completion/block tool call.

## Change and evidence

- Preserve a verified terminal edge until the runner consumes it once.
- Follow up after an operation receipt without spending protocol nudges,
  replacing the Run/CAS lock, extending its watchdog or declaring success.
- Reject missing/unknown running-operation evidence; retain normal missing-tool
  protocol failure after a consumed receipt. Failure receipts instruct the
  Agent to reconcile/report, not declare success.
- Record `operation_resumed` in canonical task events.
- 134 tests passed across `runner`, `onboard-background`, `fleet-onboard-tools`.
  Coverage includes fast completion, waited completion, several consecutive
  stages, failed receipt, same Run/claim/watchdog and later protocol failure.

## Deployment / continuation

Confirmed zero native running sessions and zero running SQLite claims before
restarting `sop-dsh-web.service`. Replaced only the resolved live package's
`lib/index.js`; no UI assets, presets, permissions, Task definitions or database
records were edited. Rollback is `/tmp/dsh-onboard-continuation-mc4EWe/index.before.js`.
The existing installer override shares the same observer map and was preserved.

Public browser UI submitted the existing reviewed onboarding Action with target
79.72.76.64, Vault SSH access and automatic Gemini account allocation. New Batch:
`b-chat-64b786d09dc45ff9607e`. Browser screenshots:
`/tmp/dsh64-onboard-retry-ready.png`, `/tmp/dsh64-onboard-retry-running.png`.
No page errors. Installer starts with the same central transaction, correctly
receives `ledger-explicit-handoff-required`, then calls `fleet_onboard_resume`.
Old failed history is retained; no direct developer SSH/target installation.

Full node acceptance remains subject to the real downstream browser and Runner
receipts. Inspect the exact Batch via paginated `taskGraph` / `sessionTurns`, then
central stage receipts and public Fleet readback; do not infer success from
`operation_resumed`, a tool exit, or a base-only completion.

## Live continuation evidence

The new Batch emitted `operation_resumed` twice, retained its live role while
waiting, reconciled stage 7 and reached stage 8 with zero `protocol_violation`.
Stage 8 then returned a genuine `downstream-write-failed`; the installer read the
report and called `task_block`, keeping both downstream roles waiting instead
of cancelling them. This is separate from the repaired orchestration bug.

Read-only Cloudflare checks using the existing Vault configuration found the
new exact-node tunnel healthy, but no ingress configuration and neither public
DNS record. The adapter's connector installation request has a 20-second
timeout; a timeout is suspected, not proven, because the remote error projection
discards the specific exception. No Cloudflare credentials/config were changed.

One explicit Console `unblockCard` retry was submitted through the public browser
for this Batch's installer card. The Agent independently read failed status and
called `fleet_onboard_start`, opening `onb-f59bdc7a-1ab0-403a-9afe-35d318d6210e`.
Already healthy stages 1–7 passed on fresh evidence; the prior failed central
transaction remains immutable. No direct developer machine commands were used.

The retry passed all ten base stages, including Cloudflare publication and Fleet
readback. Installer completed; browser-manager started and prepared the native
browser API without replacing profiles. Public Fleet browser verification shows
the exact node online, resource metrics and browser-1:9222 / browser-2:9223.
Screenshot: `/tmp/fleet64-registered-live.png`. The offscreen node uses deferred
rendering: scroll its `.node` container before reading visible child text.

The first Gemini import ended `gemini-login-not-verified`. A legitimate
`browser_login_resume` was rejected by Task Action middleware before dispatch:
it incorrectly read `args.operationId` as an acceptance receipt, although the
resume MCP schema only accepts target/instance/platform/session/request ID.
Automatic allocation must not require that nonexistent argument. For explicit
account Actions, correlate the latest confirmed import using trusted host
receipts for the same live session, IP and instance, then retain account checks.
Cross-session/target/instance receipts remain rejected. This is not permission
to skip fresh login verification or the independent 20-minute stability check.

Regression run: 148 tests passed (runner, onboarding background/tools, Task
Actions and workflow acceptance). The public Task remains unaccepted while the
browser role is blocked; Runner has not executed. Do not call this full node
acceptance. The separate stage-8 timeout suspicion was not changed in code.
