# Paged query layer, first delivery

Task Board uses taskPage: at most ten summaries with the latest execution,
counts, result links and server-side filters/order. Complete workflow prompts,
handoffs, sessions and old executions are not list data. Legacy tasks remains for
compatibility, but the Board no longer calls it. Bulk selection/cleanup traverses
pages only after an explicit user action; it does not silently target page one.

Agent management uses agentPage, ten summaries plus the selected full definition.
Its list no longer scans session history. Existing Agent activity and execution
history queries already default to ten rows; full DAG/replay/Trace refactoring is
still pending and must preserve complete edges and replay prerequisites.

Memory-only API-scoped cache is bounded, rejects stale in-flight cache writes
after invalidation, and deduplicates requests. Board polls serially every ten
seconds and pauses while hidden. Host page cache expires after two seconds and
invalidates on SQLite changes. No shared CDN caching of private query data.

Read-only comparison on the same production database, isolated service projection:
legacy tasks 3,214,446 bytes / 39.6 ms (68 executions); taskPage 8,676 bytes /
2.98 ms (4 task summaries); cached 0.11 ms. These are not public-browser timings.
Pagination/no-overlap/filter/summary/cache tests pass. Deployment and public browser
acceptance will be recorded separately; this does not claim all RPCs are paginated.

## Deployment and browser acceptance

0.31.7 deployed at a zero-running-Task window using the isolated studio host and
UI packages, preserving the active studio source changes. Live taskPage RPC is
8,680 bytes (4 rows), 68 ms first HTTP request / 7 ms next. Agent pages return
10/10/6 rows for 26 registered Agents. No credentials/config exports were changed.

Actual Chrome against the local service: initial Board visible in 3.33 seconds;
Task -> Agent -> Task navigation 0.03 seconds with cached rows. Search, select all
matching tasks (no delete), Agent paging with non-overlapping IDs, and mobile
390px no-horizontal-overflow passed. No JS errors and no legacy tasks RPC calls.
Agent selection now keeps listPage/listQuery so selecting a result does not reset
the sidebar filter/page. Execution histories, Actions and existing layouts remain.

Public-origin cold browser navigation still timed out at 60 seconds before any
taskConsole RPC. Thus the query fix is deployed, but the separate public bootstrap
transport/cache problem is NOT closed. Full DAG/event/Trace incremental paging and
remaining legacy full-roster selectors are also NOT claimed complete.
