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
