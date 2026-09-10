# Execution-history labels

Owner wants business-readable execution choices, not a raw b-chat ID list. Commit
cb91565 adds fixed Asia/Shanghai firedAt date/time to seconds and short display
codes; full IDs remain unchanged in option values, URLs and hover titles. Both
legacy and database replay share the picker. Existing records were not rewritten,
no new execution was submitted and no DSH/node service was restarted.

127 serial tests and build passed, including UTC/local-offset equivalence,
cross-year midnight, DST-independent Beijing formatting, invalid timestamps and
unchanged identities. Real public Chrome configured to America/New_York displayed
2026-09-08 10:49:38 / #69621B7F and 10:36:05 / #AF090739 correctly. Selecting each
record changed the full-ID URL and loaded its own original signed-job report.
390px mobile picker and header fit without overflow. Screenshots were inspected;
a small balanced-caption style avoids an isolated last character on narrow screens.
No page errors. Evidence is presentation/navigation only, not a new node acceptance.

## 2026-09-10 — Compact selection, execution history and manual cron reuse (0.30.5)

Owner requested all discussed execution-entry improvements. Scope: DSH UI and
manual workflow routing only; no node operations, new production Task/Batch,
history deletion, permission changes or patrol schedule activation.

ExecutionPicker now uses a single34px-high date/status button and a fixed34px
more button. The popover shows full Beijing timestamps, short codes, selected state,
optional archived records and a full-history link; archive/restore is in the more
menu. Escape restores trigger focus, outside-click closes, and fixed placement
stays within the mobile viewport. Existing archive checks are unchanged. Reviewed
screenshots exposed inherited checkbox width and mobile flex rules; narrowly scoped
overrides corrected both instead of changing the global input/button system.

Added `#/tc/tasks/executions`, reachable from the Board header, task cards and picker.
Task/status/search/archive/page filters are shareable hash parameters. The read-only
`executionHistory` RPC uses ten-row SQL LIMIT/OFFSET and extension-table indexes;
only lightweight row metadata/task names are returned, with no transcript/prompt or
tool payload. Search accepts visible short codes (including leading #). Global
history still hides archived Task definitions; explicit task-scoped history remains
readable. No new state machine or execution table was introduced.

The cause of the missing patrol @ entry was catalog/dispatch sharing enabled with
the cron switch. Paused cron Tasks are now manually eligible when unarchived;
disabled once-only Tasks and non-chat Signals remain excluded. Direct @ and Creator
reuse validate the same reviewed definition/input and current role hashes as the
existing manual card action. Manual parameters, reviewPlanId and stable request UUID
are preserved; no fake Creator Session is created. Bootstrap passwords remain
forbidden in cron input. Neither manual execution nor catalog access enables cron.
The existing business+notification trial guard still rejects premature activation.

210 serial tests pass. New tests use temporary SQLite/fake-host fixtures for paging,
archive/status/search filters, no metadata leakage, request deduplication, overlap
rejection, paused manual execution, unchanged cron state, changed-role rejection and
archived-task exclusion. Existing failed-trial archive/cron guards still pass.
Production builds reuse installed Node22/esbuild/Playwright/Chrome; no dependencies
were installed. DSH service restarts were guarded by zero live Task Runs AND native
Sessions. Existing tracked lib/ assets remain production dependencies.

Real public Chrome checks:
-1600px current Task: collapsed picker202.7x34px, header88.6px; archive action absent
 until the more menu opens. Current/failed/archived deep-links and restore-display
 entry work; no archive or restore was executed. Cold page20.6s is measured, not a
 startup-performance claim.
-History: four current executions, five when including the one archived execution;
 task and done filters selected the real completed Batch. Full-ID row links work.
-390px: no horizontal overflow, popup within x16..374, more button34px, checkbox14px;
 light/dark surfaces were visually reviewed. Screenshots retained under
 `/tmp/dsh-0305-{compact,picker,executions}-*.png` and picker-dark-mobile.png.
-New-session @Fleet shows both real workflow candidates. Selecting the patrol and
 submitting a harmless test instruction produced the correct Task ID/text/stable UUID.
 The browser intercepted launchWorkflow and returned a navigation-only fixture;
 no actual patrol, notification or machine operation was started. Backend dispatch
 was exercised independently with the fake-host test above, not claimed as a live
 fleet acceptance. Real input typing was used after plugin readiness; the earlier
 fill-with-spaces automation did not open the native picker.
-Browser-only13-row response fixture verified next/previous requests1,2,1 and row
 counts10,3,10. Actual backend pagination is covered by the28-Batch SQLite fixture;
 production records were not fabricated to fill pages.

Final live readback verified the original32Task definitions unchanged by hash and
the same63Batches; short-code search matched the actual completed Batch. Patrol remains
disabled/awaiting_trial with its prior failed results and coverage gap, not newly
accepted. Generated browser profiles and test stores are cleaned by their test
lifecycles; retain screenshots and the existing pre-archive database backup as
acceptance/recovery evidence, not disposable caches.
