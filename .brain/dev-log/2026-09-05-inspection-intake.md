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
