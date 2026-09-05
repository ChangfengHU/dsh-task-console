# One report, one Task Intake Session

Owner boundary: Fleet inspection is complete at durable delivery to a visible `task-intake`
Session. The operator can inspect inputs, dialogue and tools and tune the preset separately.
No direct machine operations are authorized for this development session.

Version 0.23.0 adds a generic flat report Signal (`items`) and batch decision validation. Every
new actionable item retains its own candidate Tasks and exact executor capability requirements;
already accepted Signals must be kept, never silently retried because a scan recurs. The report
Session has only the two routing tools. Empty reports do not create Tasks. Session and consumed
input IDs are persisted before LLM routing finishes; failures therefore retain a real link.
Restart recovery reuses a previously validated decision and does not launch child intake Agents.

Tests cover routing, duplicate reports, input conflicts, retained existing items, no-business-action
triage, visible receipts before/following failure, and actual preset/tool lifecycle. Deployment and
production browser acceptance will be appended after verification.

## Deployment and real browser verification

Source `58b0710` was committed and pushed as 0.23.0. The existing profile's plugin symlink
already points at this checkout; only the task-intake preset display fields were updated after
verifying all other preset settings matched. Restarted the DSH control-plane service with no
running Tasks; public authenticated capability returned the expected bundle protocol.

Fleet's real manual scan `scan-d10cf6e6-cb97-4179-8363-0521ee221312` delivered one summary
to `task-intake-5755daa7fda3-mtp0tv2r`. Consumed input ID
`03841826-d164-44bd-994e-257a00f9a07d`, delivery `2026-09-05T23:35:45.000Z`.
Chrome opened the native Session through Fleet and verified the role, exact original Signal,
`task_intake_context`, `task_intake_decide` and Chinese conclusion. All four old Signals were
kept, no new Task or Batch was created (204 / 42 unchanged); only the report Signal was new.
The Agent explicitly distinguished blocked from repaired. No target machine was modified.

Full DSH suite: 106/106. Fleet suite: 85/85 plus 17/17 post-UI-change focused checks.
Fleet report ready 2.35 s, DSH Session ready 14.96 s in this measurement. Direct Session URL:
https://dsh-152-32-214-95.vyibc.com/?session=task-intake-5755daa7fda3-mtp0tv2r
