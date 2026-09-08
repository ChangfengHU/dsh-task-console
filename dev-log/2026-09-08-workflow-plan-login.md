# Workflow composition and explicit login acceptance

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
