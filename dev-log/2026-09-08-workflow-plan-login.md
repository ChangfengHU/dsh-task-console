# Workflow composition and explicit login acceptance

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
