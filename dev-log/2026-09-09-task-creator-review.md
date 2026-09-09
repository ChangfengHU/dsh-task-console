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
