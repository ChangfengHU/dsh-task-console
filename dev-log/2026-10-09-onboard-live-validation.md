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
