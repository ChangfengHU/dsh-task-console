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
