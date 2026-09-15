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

## Deployment and real acceptance

Source preparation was committed/pushed as935485d while the previous build kept
serving the active hourly Task. No Task schedule change or business operation was
performed to force a deployment window. Native running Sessions and running Task
Runs were both zero at07:17:39Z and again at07:18:22/23Z. Built tracked `lib/`,
installed the single tested sidebar bridge and restarted DSH at07:18:24Z.
New native `taskConsole/sessionShortcuts` RPC returned an empty real catalog.

Public Chrome live mode then used the existing native menu for
`agent-task-create-agent-mu25ngup`, confirmed initially unmarked. Four real
marker-only writes added pin/favorite and removed them independently after reload,
fold/unfold, direct-session navigation and desktop/mobile/dark/light checks.
Startup24.82s, zero page errors or business mutation calls, no eager heavy bundle.
Final shortcut table count0 confirms the test left no unwanted mark. No Sessions
were created/deleted/archived and no new crashed Run appeared after deployment.

The original public execution-report regression also passed: deep-link report,
return preserving DAG/zoom/pan/cursor, responsive sizing, layered Escape and
Agent/Board dismissal, no mutation calls. Its two existing read-only test guards
now allow the new metadata-read RPC; no mutation permission was widened.

Before/after SHA256s matched for all32 task specs
`3233e77f334eeed70d16730a845c08f68cc5247da4b27837e5b25d7b452b687f`,
two schedule bindings
`6da023c4aa31392c0895418fb0206b2bdf82b31bcbf3c5265aa3e454e87084e2`,
and the existing Task Actions catalog
`c17db6c04ff827cd063064378c8b1b82cb5883744c87eb230545680d580492db`.
Runtime task progress is independent of this UI release; this is not a claim
that any fleet repair or login acceptance changed.

## Cleanup

All13 generated files in `/tmp/dsh-session-shortcuts-DTBT3y` were individually
validated against the known build names and removed after browser processes
finished and `fuser` reported no users; the empty staging directory was removed,
freeing1,594,887 bytes (about1.52MiB).
Rebuild with the existing lockfile/environment and `DTC_BUILD_OUT=<new temporary
directory> node scripts/build.mjs`; regenerate the native candidate through
`patchSessionShortcuts`. No dependencies were installed. Production tracked
`lib/`, the exact native rollback backup, source, databases and histories remain.
Small `/tmp/session-shortcuts-*.png` and the test log are retained acceptance
evidence, not runtime caches; remove only after that evidence is no longer needed.
