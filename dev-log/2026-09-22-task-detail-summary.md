# Task detail bounded summary

## Scope

Modern task details opt into a summary response rather than replaying every
execution's event history. The response contains the task, at most ten execution
headers, full selected execution parameters, and total/archive counts. Explicit
old execution links remain supported; cross-task execution IDs are rejected.
Legacy clients retain their old event contract. Full history remains available
through the existing paginated execution-history page.

The browser uses a bounded 15-second memory cache with background revalidation,
in-flight deduplication and archive invalidation. Sessions counts now derive only
from actual runs in the displayed live/replay frame. Authoring sessions remain
separately accessible in the drawer; historical replay cannot expose future runs.

## Verification

- Eight targeted tests passed: summary, batch archive, execution history, task and
  agent list, query cache and serial polling.
- Host/client build passed with `/usr/bin/node scripts/build.mjs`.
- Summary test proves historical event storage is not scanned, selection older
  than the first page retains its request, and other batch requests are omitted.

## Not yet delivered

Not deployed or browser-accepted. Production has a running Agent Run (1072) and
the active Studio bundle changed concurrently to c06a39c94fe8. Integrate with the
latest Studio source and use the documented zero-active deployment boundary;
do not overwrite that host with this repository's non-Studio build.

Canonical graph events still load for the selected execution; cursor pagination,
incremental graph transport, Trace pagination and optional plugin boot isolation
are not implemented by this change. Do not claim the whole performance program
complete or infer a public loading-time improvement from unit tests.

## Follow-up: bounded graph transport and Trace

Graph RPC now accepts an event cursor, reads up to 200 canonical events per page
and sends only new events on subsequent polls. Run evidence uses narrow metadata
queries rather than parsing every historical payload. The UI renders the current
graph immediately and disables historical playback until the complete prefix is
loaded; it rejects mismatched graphs/cursors and never invents missing events.
Older hosts/clients retain the full-response contract.

Trace RPC optionally pages by ten model steps, including within a single long
turn, retaining full-session totals. All three Trace entry points expose paging.
This bounds transfer/rendering, not native persistence's session log inspection.

Ten targeted tests pass, including 431-event page reconstruction, incremental
tail, zero-frame replay, stale cursor rejection and 23-step single-turn paging.
Build passes. Deployment/browser evidence is still pending; boot isolation remains
a separate uncompleted native-host change.

## Candidate browser verification

Read-only preview uses production SQLite with `readonly:true`, no TaskRunner and
an allowlist of snapshot/graph/Trace reads. Chrome verified zero sessions at replay
step zero, next-step/automatic replay, return to live, the session drawer and Trace
pagination. Local initial detail took 1.55–2.60 seconds; summary envelope 33,149
bytes, Trace page 14,779 bytes. Public candidate interactions passed but cold
startup took 43.73 seconds: not claimed fixed by this detail optimization.

Full integrated Studio suite: 469 passed, one failed, three skipped on the second
run. The failure requires an external speech calibration fixture missing from the
merge worktree's expected sibling directory. All seven studio-host tests passed
when run with the existing deployment's proof files at that expected test path;
no Studio business logic or calibration evidence was changed. First full run had
one additional non-reproducing failure; no blanket full-suite-green claim.

Added a bounded graph cache so opening Trace/returning to a recently visited run
reuses its canonical prefix and requests only the tail. Cache is memory-only,
15 seconds, ten graphs; current live rows are revalidated, never persisted.
