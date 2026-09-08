# Workflow composition and explicit login acceptance

## 0.27.3: custom workflow catalog must be lossless JSON

The owner waived browser/config backups and authorized only 63 browser-2's scoped
Task-driven deletion/recreation. Prior Task T-chat-1fbeb6ef25796ace7e13 required a
backup and correctly remained blocked; keep its immutable plan and all previous runs.
Companion browser MCP 9a163e9 supports purged native-slot creation without the optional
image service and read-only exact instance grants. No browser data has been deleted at
this checkpoint.

Creator agent-task-create-agent-mtso55u3 failed twice before task creation because its
context returned undefined workflowRecipe for the first custom non-recipe workflow.
The native tool protocol requires lossless JSON; ordinary RPC JSON.stringify hid this
defect. Reproduced against the real catalog at context.tasks.1.workflowRecipe. Omit
absent optional fields and test the next Creator context after both custom and managed
workflow submissions. No database rewrite, invented plan or direct node operation.
All 162 regression tests and the existing build pass; the live catalog also survives
an exact JSON round-trip with the source fix. Production retry remains pending here.

Production retry must reuse the original Creator session and carry the complete updated
user scope as a new message; do not let a short maintenance message replace task input.
Only the new immutable no-backup plan may execute. Browser-1, shared services, account
source grants, existing Tasks and all failed sessions remain preserved.

## Live fifth attempt reaches provider verification; not an accepted Task

Run -3-t5 prepared only the verifier; browser PIDs/profiles stayed unchanged.
318fe4e36d174c71da3fc6825de92897 found two matching nested elements representing
one authorized account, selected it successfully, then reached Google's challenge
route. No visible email/password input was present; the exact required challenge
type is not established. This is real interactive-verification-required evidence,
not a timeout, missing tool, or permission request. No additional copy was made.

There is also a finalization race: a job can finish after the last poll but before
task_block. The host now uses a fresh terminal receipt's reason/kind instead of
persisting stale model prose. Raw tool calls remain in session history. 162 tests
and the build pass. Public Chrome plan/input/JSON, Creator Trace/native session,
back-navigation and mobile width pass in 35.18 s, zero page errors; screenshots
use /tmp/workflow-v272-*.png. This is interaction-test duration, not load time.

Remaining external step: the owner must complete Google verification in browser-2;
then resume this same Task and run the unchanged 20-minute two-browser acceptance.
Installer and Runner are complete, but the workflow and login outcome are NOT.

Final diagnosis-only Run -3-t6 read inspect/status without a new mutation job and
recorded needs_input. All five login attempts remain. Its model's claim that login
will automatically unblock the Task was corrected visibly in that same conversation:
no such trigger exists; an explicit unblock/new attempt is required. Public Chrome
confirmed Fleet browser-1 verified / browser-2 signed_out and the Task blocked DAG,
6.36 s / 17.79 s including assertions, zero page errors and no mobile overflow.
The other 21 Tasks and selected-Task recovery backup remain present. Removed only
/tmp/workflow-login-resume-tests.kZPIZL (19,624,417 bytes), after a privileged /proc
check found no open references. Fixtures regenerate from tests; production lib,
databases, backups, sessions and unique screenshots are retained.

## 0.27.2 pending-operation terminal guard

Third browser attempt submitted task_block while its real login-resume operation
was still running; it mistook a minute of waiting for a terminal failure. The job
later independently failed, but that does not justify the premature Task terminal.
The fleet-base-v2 browser role now checks same-session fresh durable operations
before accepting task_block. The worker must keep polling until terminal; expired
operations remain blockable. Other roles/workflows are unchanged. 160 tests pass.
The first three failed Runs remain intact. Actual login recovery is not complete.

## Same-Task second attempt remains blocked — live evidence, not success

Canonical unblock created browser Run -3-t2 without rerunning installer/Runner or
discarding the first failure. It upgraded the node verifier to v3, reused browser-1,
copied the previously authorized account to browser-2 once, and then failed
acceptance f6464437bae8cd6028be2ab22a412aee after five positive samples per browser.
The redundant explicit-copy call returned reused and did not transfer again.

Browser-2 later appeared verified without another copy, then signed_out again.
The original DSH role performed fixed read-only normal/cache-bypass/default-account
comparisons. All showed signed_out with actual network responses and no reported
cookie-delivery blocking. This is not proof of Google's rejection reason. The Task
is still capability-blocked; no completed final acceptance report is claimed.

Public Chrome verified browser-1's positive and browser-2's negative labels, mobile
width, and the Task's two completed roles / blocked browser node with both failed
Runs visible. Initial assertions took 4.69 s on Fleet and 22.23 s on DSH, no page
errors. Screenshots are retained as failure evidence, not successful acceptance.
Companion changes pass 50 Node / 18 Python tests. DSH runtime remains 0.27.1 with
the previously verified 158 tests/build. Recovery backups, the other 21 Tasks and
all seven old execution session directories are retained.

## Fresh Task created; real stability failure and 0.27.1 rework

Creator agent-task-create-agent-mtsh4qw9 created T-chat-b4c6fcb369f0c20a9739 and Batch
b-chat-b4c6fcb369f0c20a9739 using fleet-base-v2/provision-gemini. Exactly three roles:
installer → Runner → browser-manager. Public Chrome passed plan/input/JSON, original
Creator Trace/conversation, return navigation and mobile overflow checks (38.31 s,
zero page errors). This is whole interaction-test duration, not plugin load time.
Installer onb-bfaddaca-a1a6-4669-90e8-c4509458ad96 passed ten stages (eight reused,
resource snapshot and acceptance reverified). Runner job-mtshgbi1-9dfd73af1322 passed
signed independent checks with existing service/route reused. Browser-1 login reused;
browser-2 got one authorized copy and a same-fingerprint positive proof.

The real 20-minute observation f0d3f28c0c25d8a29ef3d169272c59fc failed at 09:54:49 UTC
on browser-2 signed_out, so the workflow did NOT complete. A subsequent Agent copy
contradicted the prompt-only retry rule; visible maintenance stopped further retries
after its already-started import completed. The same browser session performed only
read-only source/target expiry diagnostics and the canonical Task stays blocked.
Companion runtime now fences replacement IDs after failed stability; probe v3 waits
the complete negative readiness window. 0.27.1 requires v3 receipt/current Fleet
proof, preserving the original failed Run. All 158 Node 22 tests/build pass; companion
49 Node/17 Python pass. New-attempt live acceptance is still pending.

## Acceptance reopened; fresh v2 workflow requested

The owner later observed browser-1 unknown/page-not-ready and browser-2 signed_out.
Read-only public Chrome/API checks reproduced browser-2 changing between unknown
and signed_out. Earlier success receipts remain historical facts, not proof of
stable login. Runner's eight checks do not verify Gemini authentication. The old
"completed" subsection below records that execution, not final business acceptance.

The owner explicitly requested deletion and a redesigned fresh Task. Verified only
T-chat-31436d3176dc1fb2eb0c (two settled Batches, no active runs), made an owner-only
online SQLite backup with integrity_check=ok and copied the legacy event file into
`~/.dsh/task-console/workflow-restart-backup-0qcrtg`. Normal deleteTask removed exactly
that Task; all other 21 Task IDs and all 7 execution-session directories remained.
No machine data was cleared. Restore selected records if needed, never roll back
the entire live database over later work.

V2 separates installer, Runner and final browser acceptance; the Creator still
creates exactly three real role nodes and keeps a frozen plan. A generic host
beforeComplete callback delegates only this recipe's account requirement to
workflow-acceptance.ts. It validates same-session private MCP receipts, both default
instances, the 20-minute observation span and current Fleet identity before accepting
the browser's task_complete. Missing/fabricated/stale receipts, a repeated old sample
and current disagreement are rejected without finalizing the Run. V1, preserve and
unrelated tasks retain their original contracts. All 158 Node 22 tests/build pass;
companion MCP 46 Node and 15 Python tests pass. Production v2 acceptance is pending.

## Completed live acceptance

Source fixes `cf1a1cd` (DSH 0.26.3) and companion `fc9c697` were pushed and applied.
Only the supported dsh-llm-deepseek host module changed. Restart occurred with no
running sessions. The previously failed browser session then returned a real model
response to a read-only diagnostic prompt, without HTTP 400 or target/tool actions.
This did not retroactively accept its rejected completion.

Normal launchWorkflow reused Task `T-chat-31436d3176dc1fb2eb0c` and created execution
`b-chat-7e0edd5787c21b8ef851`; no extra Task or fictional Creator session. Original
Creator `agent-task-create-agent-mtsbx06u` and frozen plan fingerprint
`2f0b14f2b4f9bbe501d129a7bbecad05a82504e54f3573ea0a2f7cd9ac511e2f` remain visible.
The three real role runs completed and the Batch settled `done` at 08:41:31 UTC.
The previous failed Batch `b-chat-31436d3176dc1fb2eb0c` and all its sessions remain.

- Installer receipt `onb-1e49db14-1fa0-4f1e-9479-f66b47070227`: ten stages passed;
  nine reused, acceptance evidence reverified/repaired, blocked zero.
- Browser 1 operation `38dc9e5c9c2bde88b7159f2b0cdcd48e`: existing valid account
  reused with fresh verification at 08:36:57 UTC; no transfer or restart.
- Browser 2 operation `e320345d2334128605e4dc98a1131ac4`: a fresh signed_out result
  at 08:37:43 UTC authorized one transfer from the existing 84/browser-1 grant.
  loginVerified and matchesSource true at 08:38:17 UTC, fingerprint `98caccf3`.
  This is separate from its earlier successful observation; an older receipt was
  not substituted for the current check. Unknown was never treated as signed-out.
- Runner receipt `job-mtsf61g3-2e2735a47cf8`: action reused, publicRouteChanged false,
  signatureVerified/runnerCoverageHealthy/nodeHealthy true. All eight fixed checks
  passed, including fresh TCP/UDP exit verification. No source grant, credential,
  browser deletion or developer SSH mutation was introduced.

Unmocked public Chrome acceptance: Fleet showed both verified Gemini account rows
and working responsive layout (8.47 s, zero page errors). Reused workflow plan/input/
JSON, original Creator Trace/native-session links and back navigation passed in
36.03 s. Completed Task's "查看执行报告" button scrolled to the actual three-role
summary and signed receipt; desktop/mobile passed in 21.14 s, zero page errors.
These are full test durations, not plugin-load-only benchmarks.
Screenshots and command logs under `/tmp/workflow-*` are retained as local acceptance
evidence; durable operation receipts and session logs remain the primary evidence.
The private pre-deletion backup is retained for selected-record recovery. Existing
Node/Chrome/Playwright dependencies were reused; no disposable dependency tree was
installed. Test-created SQLite directories now close/remove themselves after tests.

## Browser recovery and malformed completion history (0.26.3)

Browser MCP fc9c697 recovered browser-1's original receipt: `page-not-ready` at
07:32:07 UTC, before any import. The recovered Task run completed browser-1 operation
35ef856a96d3fa3812c87c40555d28c1: one authorized transfer, loginVerified/matchesSource
true at 08:23:30 UTC. Browser-2's still-valid login and PID 255049 were preserved.
Public workflow plan/input/JSON/Creator Trace/native-session/mobile checks passed
again in 39.38 seconds with zero page errors.

The browser Agent then generated malformed task_complete arguments (one missing outer
closing brace). Tool validation correctly rejected it; no completion was accepted.
The host forwarded the malformed raw arguments in the next model request, causing
Qwen HTTP 400 before it could self-correct. The Batch truthfully failed and cancelled
its unstarted Runner. Existing history/stream patch now wraps only invalid historical
arguments as non-executed evidence on the model request wire; it neither modifies
raw session logs nor repairs/executes rejected tool inputs. This is a version-fenced
DSH host compatibility fix, not an override of Task completion or account validation.
All 151 Node 22 tests, build and diff checks pass. A dry run against the installed
supported host selects only dsh-llm-deepseek; no other host package needs rewriting.

## Live handoff regression (0.26.2)

The corrected recipe created Task `T-chat-31436d3176dc1fb2eb0c` with exactly three
roles and the `provision-gemini` policy. Public-browser acceptance passed plan/input/JSON,
Creator Trace/native-session navigation, return navigation and mobile light/dark layouts.
The installer exposed a second genuine defect: an interrupted transaction still had a
15-minute lease. Fleet correctly refuses a new session's start and premature resume,
but the host adapter collapsed both into `adapter-result-validation-failed`.

Start now returns the verified existing transaction and explicit resume instructions;
an unexpired lease also exposes its retry time without allowing takeover. Resume retains
the existing run id on error and fixed allowlisted ledger conflicts are visible even in
MCP error envelopes. Unknown upstream error text remains hidden. CAS, identity checks,
lease duration and Fleet ledger logic are unchanged. Tests cover expired/live handoff
and sensitive upstream error suppression. The real Task remains pending acceptance;
browser login and Runner completion have not yet occurred at this commit.
Verification: all 149 tests pass under the production Node 22 ABI; esbuild and
`git diff --check` pass. No global Node or native SQLite installation was changed.

Owner scope: delete the generated onboarding test workflows and restart the complete
Creator-to-three-role process on existing node 63, including account selection/login.
The developer may enhance DSH/MCP and trigger visible DSH sessions, never directly
mutate the target host. Healthy browsers/profiles and all original sessions remain.

## Scope and implementation

Read the live Board before removal. Exactly three task-chat Tasks were owned by the
previous test: T-chat-38d20fe24749beaf8fb5, T-chat-24be57689754a6b0e9e2 and
T-chat-af090739b8c20765c932. None had an active Run. A private SQLite online backup
passed integrity_check; the legacy event file was also retained under
`~/.dsh/task-console/workflow-backup-fM1QVLbW`. Normal deleteTasks removed only those
three. Readback retained all other twenty Task IDs. No session files were deleted.
Restore selected records from the backup if needed; do not overwrite future work
with a whole-database rollback.

0.26.0 adds frozen workflow definitions and redacted separate user input to existing
TaskTurn JSON; no new scheduler or database engine. The viewer shows saved role briefs,
order/contract and policy limits, with source session and lazy Trace. Direct reuse
retains the original Creator entry while explicitly saying no new Creator ran.
Creator sessions are separate from the real three-node execution DAG.

Managed Creator/browser personas now require existing-browser account acceptance when
the user asks for login provisioning. Existing valid logins are reused; unknown is not
signed-out. Gemini-only support, source grants, serial provisioning, verification
receipts and challenge/owner questions remain mandatory. The exact node 63 login
targets were authorized for instances 1/2; no source grant or other node was added.

## Verification before live execution

144 serial DSH Node tests and esbuild pass. Companion browser MCP passes 32 Node and
14 Python tests. Tests cover source-session deduplication/direct reuse, missing legacy
metadata, separate redacted input, stable plan hashes and immutable execution values.
Current source privacy checked: dsh-task-console is public; linux-clash-skill private.
No passwords, cookies, tokens or private runtime policy files are committed.

Production re-execution and real-browser acceptance are pending at this commit.

## First live plan failure and correction

Public Chrome submitted one short user request through a fresh Creator session
`agent-task-create-agent-mtsbjp7s`. It created T-chat-c7d9f568d7f413d9930f with four
roles, adding fleet-ops-reviewer, and the generated browser brief contradicted itself
(provision requested, but also a blanket prohibition on automatic copy). The plan
snapshot makes that error inspectable. This is failed composition, not acceptance.

Cancelled batch b-chat-c7d9f568d7f413d9930f through the normal API while only the
installer was running; browser and Runner had not started. Disabled the Task and
retained its sessions/records. Installer had called fleet_onboard_start; do not
claim the test did nothing or reset its shared runtime ledger.

0.26.1 introduces a target-independent managed Fleet recipe instead of asking the
model to rewrite fixed safety/role boundaries every run. Creator chooses an explicit
login policy; the recipe fixes three responsibilities and final reporting. Mixed
recipe/free-form proposals are rejected before materialization, actual Agent IDs
are still validated, and no business permissions are granted by selecting a recipe.
Both recipe and free-form workflows retain the same Task/Batch scheduling/kernel.
146 tests and build pass. Fresh live recipe execution remains pending here.
