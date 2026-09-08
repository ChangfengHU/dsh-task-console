# Generic chat workflows — 2026-09-07 (acceptance crosses UTC midnight)

Scope: implement the owner's Task Creator plan and test existing node 63 through
visible DSH agents. No developer SSH mutation, destructive reinstall, login import,
credential rotation, image worker or unrelated history cleanup was authorized or
performed. The selected Fleet Skill guided healthy-component reuse and independent
public acceptance. Boss continuity is recorded here after code commits.

## Implementation

0.24.0 adds `task-create-agent`, three scoped native composition tools, a durable
accepted-message ledger, fresh per-Batch inputs and restricted bootstrap resolution.
The roster and existing Task kernel determine agents/scheduling; no new executor or
IP-bound task catalog was added. @ selection supports existing workflows; native @
history references are conditionally suppressed without deleting ordinary history.
Fleet inspection task-intake behavior remains unchanged.

Browser MCP accepts active browser-manager Task bindings using readonly SQLite
proof (companion linux-clash-skill bd5eec8). Static business-role tasks now use the
existing canonical DB replay, not the old decorative gate graph. Completed sessions
and plain text reports remain visible. Original ancestor handoffs are supplied to
the final role so it can consolidate all responsibilities.

Code: 058a66d, 04175b4, 6e5ded1 and eb33951, all pushed before this record.
125 serial Node tests pass; companion browser MCP: 28 Node + 14 Python tests pass.
Build and diff checks pass. No Worker redeploy was necessary.

## Real first execution

Creator Session: `agent-task-create-agent-mts24uel`.
Task: `T-chat-af090739b8c20765c932`.
Batch: `b-chat-af090739b8c20765c932`.
Created 2026-09-08 02:36:05 UTC; final role completed at 02:43:53 UTC.

Exactly three canonical tasks and two links: fleet-installer -> browser-manager ->
fleet-runner-operator, with Runs 177/178/179. Creator submitted once; no developer
continuation messages were needed for these business roles. All finished done.

Installer receipt `onb-361754c6-f029-48ff-85ca-257b4719c268`: all ten stages pass,
8 reused and 2 reported repaired-and-verified (resource snapshot/final acceptance),
zero blocked. This is not a claim of zero host updates in the first execution.
Browser inspection preserved both active profiles and existing PIDs. Runner signed
job `job-mts2dram-e67fe4a539b2` independently passed all eight fixed checks.

The last role honestly reported missing original installer handoff; only direct
dependencies were supplied. Fixed ancestor-summary propagation without rewriting
that old result, then started a second real invocation through @existing workflow.

## Real same-Task repeat

Native browser @ selection submitted fresh parameters and opened Batch
`b-chat-69621b7fc21efc5fff77` on the same Task at 02:49:38 UTC. Runs 180/181/182
completed automatically; the last role finished 02:54:57 UTC. No developer messages
were sent to the worker roles. The first execution remains intact; the enabled
chat-workflow catalog has one Task, not two IP-specific cards.

Installer receipt `onb-58745741-bd0a-4be8-86d1-4f20e81f11bb` is verify-only,
ten passed/reused stages, changed=0, blocked=0. The raw ledger report confirms
those numbers (the Agent's textual execution_type says adopt; do not treat its
label as more authoritative than the runtime's mode). Both browser PIDs and
profiles were preserved. Runner signed job `job-mts2sl5o-e7d94f40d611` is fresh,
signature verified, coverage healthy and all eight node checks ok. Its final
report explicitly incorporates both original upstream handoffs; the first-run
traceability gap is not repeated. No component reinstall or credential changes.

## Browser evidence

Unmocked public Chrome: Board interactive in 22.56s (another load 25.58s), no page
errors. Three nodes/two links/three sessions; step zero shows no nodes, step one one
node/no links. Auto playback advances. Fullscreen selection updates the visible
inspector. Text report includes all roles. Trace loads real Skill/native-tool data,
and opening the original session changes the URL and loads history without error.
Loading latency was measured, not claimed resolved by this change.

Fleet full card ready in 15.09s, independent telemetry complete, two browser ports,
fresh Runner exit 63.124.160.54 and successful line-100/92/82 observations. Runner UI
shows the actual signed job, its fixed probes and event stream. VNC connected to a
rendered two-browser desktop in 12.3s. Screenshots were inspected, not only captured.
An initial Fleet assertion failed because exits were still loading after 5 seconds;
waiting for that actual async field (bounded 45s) passed, without mocking data.

## Preserved failed tests and limits

An early UI script erased the selected @ prefix and submitted to an existing browser
Agent chat; it performed a scoped idempotent browser prepare on 63. This is not Task
orchestration evidence. Corrected the script to preserve the claimed token.

The first real Creator attempt selected a time-context plugin message as the user
request and returned undefined JSON fields after dispatch. Two resulting no-IP
Tasks (38d20fe24749beaf8fb5 and 24be57689754a6b0e9e2 suffixes) stopped for missing IP
without calling onboarding start. Cancelled via Board and disabled via normal API;
sessions/runs/events were retained. Fixed source filtering, lossless results and
stable deduplication with regressions before the successful runs above.

The test workflow is preservation-first readiness/repair, not proof of installing
a bare machine, browser login transfer, or uninstall/reinstall. The generic Creator
can select other registered roles/workflows within their grants. A chosen workflow
retains its own responsibility constraints; a materially different goal should be
submitted to the Creator, not silently broaden an existing workflow's authority.
