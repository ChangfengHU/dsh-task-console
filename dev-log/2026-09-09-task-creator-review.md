# Structured Creator plans and independent review

The owner requested a development loop: improve task-create-agent, give it the real
Fleet login-patrol objective, review its generated design before execution, observe
the actual browser-manager, and fix the responsible plan/Agent/tool. Developer does
not SSH or operate targets. Keep current grants, valid logins and all history; no
browser rebuild, token/service change or repeated 20-minute stability test.

0.28.0 adds typed design validation, SQLite draft/review state and paginated review UI.
Native Creator submit only prepares; it cannot approve. Approval uses frozen input,
hash/profile checks, CAS and existing TaskRunner idempotency. Original inputs, role
contracts, review links and Creator sessions remain visible. A draft creates no Task,
Batch or executor. Dynamic conditional behavior remains Agent interpretation of the
reviewed contract, not a new arbitrary conditional-DAG execution engine.

Corrected string-content credential extraction uncovered by the secret-redaction
fixture. The reusable catalog now exposes design; exact reuse adds a Batch, not a
Task. Target IP substitution also covers the stored decision contract.

## Real design and UI checks

- Creator session agent-task-create-agent-mttpzawn received the business goal without
  a hand-authored expected plan. It corrected a branch-ID schema error and prepared
  P-chat-afdd64ece2f6ea107a06 without execution.
- Independent review rejected that draft: missing out-of-scope report items, conflated
  unknown/permission errors, potential mid-loop human-input block and ambiguous status
  tool use. The real browser rejection preserved the old draft and started nothing.
- Creator session agent-task-create-agent-mttq50hw revised these points in
  P-chat-35bca5aa1f9efd6396bc. Actual Chrome approval required reason/checkbox, created
  T-chat-83e51d0cc5ade0e11b86 / b-chat-83e51d0cc5ade0e11b86 and navigated to its Run.
  Plan list/detail took 22.49/20.97 seconds in these public cold-start checks; no page
  errors. This change does not claim to fix total HARNESS cold startup time.

## Execution review: first Run did not pass

The browser-manager independently discovered 7 nodes/11 instances and performed only
inventory, inspect and candidates. It respected write grants and made no login copy.
However it treated cookie presence/lifetime as fresh verified login and submitted an
incorrect completed summary (reused=10, skipped=1). That native completed Run is retained
as failed acceptance evidence, not rewritten or presented as successful patrol.

The owning Browser MCP now returns normalized inspect loginAssessment: cookie/PID/old
identity hints cannot turn unknown into verified. Its preset explicitly distinguishes
read time from verification time and unsupported legacy probes. This is a tool/Agent
evidence error, not a reason to operate target machines or widen grants. New Creator
session agent-task-create-agent-mttqkuyc is reviewing a repeat after the capability fix.

168 DSH regressions passed, including pending/no-execution, reject/supersede, hash and
preset drift, approval idempotency and redaction. The final targeted 25-test run also
covers exact workflow reuse and creation-stage release in the worker prompt. Builds
pass. No dependencies installed; tracked lib assets remain production dependencies.
Unique public-browser screenshots under /tmp/task-creator-* are retained evidence.

## Deterministic completion boundary (0.28.1)

Creator chose a stronger frozen design in P-chat-b2ca9d5f0bed2699f59b and corrected
two rejected submissions (changed design cannot exact-reuse; create needs reason).
Review approved the new version T-chat-0246030798dff00850bc. Its Agent correctly
kept six instances unknown, but again submitted a contradictory all-authorized-valid
summary. Independent acceptance rejects that completed claim too. Prompt changes
alone are insufficient; retain the full evidence rather than rewriting either Run.

Add opt-in design.evidenceContract=browser-patrol-v1, advertised to Creator. The host
joins the current Session's real paired inventory/inspect call/results, computes
instance outcomes and ignores model counters. Unknown/authorized signed-out targets
reject completion; final block reasons retain concrete instance/event/time evidence.
Successful completion uses the computed summary/metadata. Other tasks retain their
existing gates. This is a business adapter, not a rewrite of the generic kernel or
a new verifier/SSH action. Third real Creator session agent-task-create-agent-mttr2njm
is preparing an explicitly guarded plan. 173 DSH regressions pass; build passes.

Public desktop/390px tests confirm no horizontal overflow, Task → review → Creator
session navigation and no page errors. Retained screenshots include
/tmp/task-creator-first-run-rendered.png, /tmp/task-creator-mobile-plan.png and
/tmp/task-creator-final-session-navigation.png. Removed only the premature blank
/tmp/task-creator-approved-task.png (14,317 bytes; about16KiB allocated), superseded
by the rendered evidence; it is regenerable by opening the same Task page. No new
dependencies were installed or production dependencies removed.

The first evidence-contract draft P-chat-22e43b350f13dcc59c0b mentioned the contract
only in prose; independent review rejected it without execution. The same Creator
session corrected the actual JSON field and submitted P-chat-302a4f7a5135763e960b.
This is why review checks effective configuration, not merely explanatory prose.
The public UI now distinguishes selected/no dedicated host evidence gate.

Replaying the second Run's unmodified native events exposed the real MCP namespace
prefix (unlike the display projection); the parser and fixtures now use that exact
registered namespace and reject another server's lookalike tool. The resulting
computed counts are 11 total, 3 verified, 6 unknown, 2 skipped, rejecting the previous
all-valid claim. The unreachable node with no browser rows remains separately reported.
Tests include native result pairing, missing/failed inventory, stale proof, untrusted
namespace, opt-in isolation and actual Runner replacement of fabricated completion
summary/metadata. All 173 DSH tests pass after these changes.
