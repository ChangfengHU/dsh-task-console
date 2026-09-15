# Session shortcuts in the existing plugin

## Scope and ownership

User approved a Session module inside the existing `dsh-task-console`, initially
for pinning and Favorites. Do not rename/split the plugin, restore a separate
Session menu, move conversations or duplicate their transcripts. Agent Actions,
Board, native folders, task-owned-session hiding and all historical records remain.
Fleet Gemini filters and the additional public hostname are separate earlier
requests, not changes made by this Session slice.

## Implementation

- Small `session-shortcuts` host/client modules and two Console-only RPCs.
- Independent timestamp flags in the existing SQLite `dsh_session_shortcuts` table.
  Explicit desired-state writes are idempotent; changed expected values are refused.
  Native titles/statuses are read from existing lightweight metadata, not history.
- Additive native menu/slot bridge, fenced to DSH 0.1.1-rc.2, with original backup,
  idempotence and exact-anchor checks. No official workspace storage schema change.
- Pinned rows above existing folders; collapsible virtual Favorites; remove one
  flag without altering the other. Archived/internal/subagent/blank/missing rows
  do not appear. Original rename/fork/archive/search/grouping remain available.
- Metadata refresh on focus and every30s when visible. Failed/uncertain writes
  retain last confirmed state and expose retry; no automatic mutation retry.
- Entry overhead about8KB uncompressed. No new dependency or eager Board/Trace load.

## Verification before deployment

-308 full tests passed with zero skips under Node22 and the real supported DSH
  installation; SQLite serialization/reopen, independent flags, idempotence,
  target validation, visibility, non-mutation and host bridge syntax covered.
  An additional isolated client regression verifies exact RPC envelopes, pending
  write exclusion, failed-write reporting, stale-read suppression and disposal.
- Public Chrome candidate interception exercised real native rows/menu with only
  the two new marker RPCs mocked. Pin/favorite, reload, collapse, direct session
  URL, independent removal and simulated503 failure passed, with zero business
  writes/page errors. 1440px/390px and dark/light screenshots were inspected.
- One repeat initially failed after native sidebar auto-collapse on viewport
  changes. Test now explicitly opens the native sidebar before screenshots and
  clicks, rather than assuming a transient hover expansion is a pinned-open state.
- Candidate startup was20.22s/21.27s in successful runs; one run37.32s. Existing
  public baseline20.47s. These few samples do not establish a performance percentile
  or resolution of the known overall HARNESS cold-start problem.

## Deployment status

Source-only preparation commit; generated production lib stays unchanged until
the existing hourly Task reaches an idle boundary. No restart, Task
schedule change or business operation was performed during candidate testing.
The staging directory `/tmp/dsh-session-shortcuts-DTBT3y` is reconstructible from
source and the existing lockfile; remove its owned build files after publishing
and final browser acceptance. PNGs/test logs are acceptance evidence, not runtime
dependencies. Production tracked `lib/` is not a disposable build directory.
