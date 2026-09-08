# Agent mentions and history — 0.25.0

Implementation: `5502c42`. Same dsh-task-console package, no separate Session
module, no Fleet-node operations and no submitted business task during acceptance.
Installed plugin is the repository symlink; updated bundles served through the
actual sop-dsh-web.service runtime. Host RPC additions needed a restart, performed
only after confirming no active Task Runs. Native DSH package files were not edited.

## Behavior

- @ sorts by immutable createdAt, five defaults, native expand/collapse, full
  roster search. Existing workflow and file-reference choices remain available;
  native historical-session @ suggestions remain suppressed only with the plugin.
- Agent has Configuration, Sessions and Tasks tabs. Pages are host-side, 10 rows
  by default, max 50, with counts, empty/error/retry handling and shareable tab/page.
- Sessions include direct ownership and actual task execution. Tasks union creator
  origins, original/dynamic participants, cards and actual Run profiles. A Task is
  unique even with multiple executions or simultaneous creator/participant roles.
- Date labels use Asia/Shanghai. Context links choose the Agent's relevant Batch;
  creator conversation links do not duplicate a generic Task link beside its Batch.
- Lightweight headers plus page-only title projection cache: no transcript reads,
  no Agent activation, no full-history response. Missing title cache uses an honest
  fallback; missing session file disables Open while retaining the Run evidence.
- New presets persist agent-meta.json. Legacy creation dates were never recorded;
  they are not fabricated from filesystem modification dates or save time. Earliest
  retained session is explicitly first-use metadata, not proof of creation.

## Verification

140 serial Node tests pass; esbuild passes; git diff --check passes. Coverage
includes creator-only Tasks, actual reviewers, dynamic participants, Task reuse,
deduplication, stable multi-page boundaries, deleted files, invalid query arguments,
immutable creation/copy/legacy handling, page-only cache reads and retry failures.
Un-injected Cordis access and missing browser popstate refresh were found in live
testing, corrected and covered by additional regression tests.

Real public Chrome, 1600x1000 and 390x844, verified:

- Five Agent choices, expand to the full roster, collapse, search for an Agent
  outside the first five, and pick a claim without submitting a message.
- task-create-agent: two own sessions, three created Tasks (including preserved
  cancelled attempts); no executor sessions attributed to the creator.
- The reusable Fleet acceptance Task appears once; creator relation links to its
  originating execution, workers see both their own executions.
- browser-manager: 11 sessions, pages of 10 + 1 with no overlap; its three Tasks
  are correctly labeled participant. fleet-installer API: 47 sessions, five pages.
- Task detail opens with real database nodes; direct and hidden task sessions
  open without Failed to load history; Back restores the exact Agent page.
- A browser-local mocked read failure shows Retry and recovers; unsaved persona
  text survives switching tabs without saving. No business configuration changed.
- Light/dark narrow screenshots inspected; no horizontal document overflow.
  Browser pageerror collection remained empty.

Observed local history RPC latency: 4–32 ms after the header index was warm; roster
metadata initially about 364 ms. Public full Harness cold startup observations
were about 18–26 seconds, not a claim that general host startup is now instant.

Evidence scripts/screenshots are local temporary files prefixed
`/tmp/agent-history-`, plus `/tmp/agent-picker-*.png`,
`/tmp/agent-created-tasks.png` and `/tmp/agent-sessions-page2.png`.
Standard unit tests remain in the repository. Standalone ad-hoc full tsc was not
clean: the repository has no tsconfig and relies on host-provided React/Cordis
peers, alongside existing cross-module type diagnostics. No unrelated type-system
refactor or package installation was attempted; build/test/browser are the verified
gates for this release, not a claim of full-project typecheck success.
