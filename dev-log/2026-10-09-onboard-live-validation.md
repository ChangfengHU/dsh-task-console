# Full Fleet acceptance continuation

Target: 79.72.76.64. Developer modifies DSH/plugin only; machine operations remain
within the reviewed Task and its scoped role tools. Preserve healthy profiles,
accounts, credentials and old execution evidence.

Verified live `65deb80`, zero native running sessions and zero Task claims before
deploying the previously tested `8766aa4` host index (SHA256
`486857c5948f1f3fe2e408ef954a4bbc0c41d593e17bf33d54e1a88c25b2ce03`).
No UI assets, presets, grants or Task definitions were replaced.

Public browser initially saw a Cloudflare HIT of a 404 for the lazy heavy script;
local origin returned 200 for the exact URL. The cached 404 naturally expired and
subsequent public requests returned 200/MISS. No Cloudflare mutations were made.
The execution UI loaded with no page errors. Wait on actual current labels such
as the New Execution button; the former `数据库有向无环图` label is no longer present.

Read-only Fleet MCP found both native browsers with fresh verified Gemini
identities. This does not certify the Task's independent stability window or
Runner. Its capability endpoint reports base profile and zero slots, although
the Fleet MCP node projection labels it image-worker; keep these distinct.

One Console unblock of old Batch `b-chat-64b786d09dc45ff9607e` created Run 1391 and
immediately timed out: the full-Fleet batch-wide budget (three role timeouts) had
already expired. Checking role timeout alone before this retry was insufficient.
Old failure and cancelled successor evidence are retained. Do not extend the
batch deadline, rewrite timestamps or fabricate completion to recover it.

Added an expiry check to unblockCard before any state transition/session creation.
The regression proves expiry is rejected, original block remains, no new Run or
Session appears and waiting successors are not cancelled. Existing unexpired
unblock semantics remain intact. All 149 targeted regression tests pass.

Next: deploy this small guard during verified idleness, then use the public
Console New Execution action for the same reviewed Task and explicit target.
Preserve existing healthy logins; let the three roles collect fresh base,
20-minute browser stability and signed Runner acceptance evidence.

## Live execution and startup follow-up

Expiry guard `fb28b2e` deployed with another zero-session/zero-claim check; live
host bundle SHA256 `060b66d4c1caccc567d11b00323e99f6be9e6c6eae32c5e0338aee1c3403f051`.
Browser clicked New Execution and accepted the native parameter prompt. New Batch
`b-chat-7dab101c8d552d55baf8`; screenshot
`/tmp/dsh64-fresh-execution-20261009.png`, no page errors. No alternate Task or
extra role was created. Installer Run 1392 completed with a host-validated v3
handoff: central run `onb-0535ec2e-a7c4-4e1b-83bf-74ecf8b939dd`, stages 1–8/10 reused,
stage 9 repaired and independently passed. Browser-manager then started.

The transient script 404 is reproducible during startup: route registration came
after `taskConsole.ready`, which waits for runtime recovery. Moved only static
route registration ahead of that wait; missing files and invalid methods now
return `no-store`. Regression holds recovery pending and proves the route already
exists without enabling any business operation. No UI redesign or CF config edit.
This follow-up is staged at `/tmp/dsh-onboard-continuation-mc4EWe/index.lazy-route.js`
(SHA256 `f431b68b096ce39ecfefe53b99db352726557649a7d0760c780668bc51d21baf`), pending
the next verified idle window; do not restart while current acceptance runs.

Startup patch committed/pushed as `fa2292b`; 150 targeted tests passed including
the actual deferred-ready startup regression. Production remains `fb28b2e` to
avoid interrupting the current Task. Test-only dsh-agent/dsh-llm/dsh-scope symlinks
were removed; no dependencies downloaded. Test TAP and screenshots remain evidence.

Browser-manager session:
`task-t-chat-b4c6fcb369f0c20a9739-b-chat-7dab101c8d552d55baf8-2`.
Both provision receipts completed with `reused=true` and `loginVerified=true`:
instance 1 `39d11c87d83eb731ab558253eee6b934`,
instance 2 `e98e99ce23ef5af7f609cc0a9c69f638`. No new account copying in this run.
The role started `browser_login_acceptance` operation
`71434bf7662b035d9c43cc1332100777`; real MCP status at 2026-10-09T13:15:27Z reported
running, requiredMs=1200000, both instances awaiting initial samples. Continue
observing this exact operation/Task; a single probe success is not full acceptance.
Runner remains dependency-blocked (todo). Do not retry/restart this live operation.

## Completed acceptance

The same browser operation completed at 2026-10-09T13:36:39Z with `stable=true`,
requiredMs=1200000, and 21/22 independent samples. Instance 1 observed 1201231ms;
instance 2 observed 1256891ms. Both original identities were retained. The host
recorded `operation_resumed` (event 23525), woke the same session automatically,
validated its handoff and promoted Runner. No developer message or direct target
operation was used to force that transition.

Runner Run 1394 installed the missing service through its scoped tool, published
the route and completed signed job `job-mv10hgnw-fcac041bfc26` at 13:39:16Z.
The receipt reports signatureVerified, runnerCoverageHealthy and nodeHealthy all
true, with all eight checks passing. Final host validation at 13:39:57Z recorded
`fleet-base-v3`, scope `node-and-login`. All three cards are done; the public UI
shows 3 completed, 0 incomplete and "已结束 · 已通过". Original failed executions
remain unchanged.

Public Fleet browser verification found the node online, continuous reachability
initialized, hourly Runner verification, fresh host/five-target latency telemetry,
both verified Gemini identities and real line probes. Desired line 100 passes;
alternate line 92 still reports upstream rejection (previously accepted exclusion),
while line 82 passes. Do not claim every alternative proxy is healthy. Evidence:
`/tmp/fleet64-final-acceptance-20261009.png` and
`/tmp/dsh64-completed-before-deploy-20261009.png`; both pages had no page errors.

After native session.list reported zero running sessions and SQLite zero running
claims, deployed startup patch `fa2292b` (SHA256 f431b68b096ce39ecfefe53b99db352726557649a7d0760c780668bc51d21baf).
Only the host lib/index.js changed. Static script returned 200 11.07 seconds after
restart; POST returned 405/no-store. Post-restart taskGraph retains all completed
roles and the same events. The 150 targeted tests passed before deployment.

Removed only obsolete intermediate build files `index.js` and
`index.async-continuation.js` under `/tmp/dsh-onboard-continuation-mc4EWe` after
verifying neither was open and production resolves outside that directory.
Freed 2912256 allocated bytes. They can be rebuilt from pushed commits 8766aa4 and
65deb80 using the existing host-only esbuild command. Retain the original/live
rollback and final bundle until deployment verification is complete; screenshots
and test TAP are acceptance evidence, not disposable caches.

Post-restart browser recheck shows the same completed Task and all role names,
with no page errors, failed requests or sidebar abort message. A first request
during recovery transiently showed a sidebar abort; a fresh check recovered.
Observed task-page readiness was 33.7s on this cold browser, so this is not a
claim that all DSH startup latency is eliminated. Final screenshot:
`/tmp/dsh64-final-verified-20261009.png`. Also removed the now-deployed
`index.lazy-route.js` after matching the production hash and checking no open
users; total temporary build cleanup is 4370432 allocated bytes (about 4.17 MiB).
Retain `index.before.js` and `index.expiry-guard.js` as explicit deployment rollback
copies until the next stable release supersedes this rollout; they are not caches.
