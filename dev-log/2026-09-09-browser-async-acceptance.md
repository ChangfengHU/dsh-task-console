# Retain live browser acceptance across idle model turns

Owner requested both existing Gemini browsers on 63 logged in, with actual DSH
Task execution and no developer SSH, deletion or repeat-copy loop. The browser
Task T-chat-61d84a0199aabbe795dc successfully prepared the bounded verifier,
copied browser-1 once and reused browser-2. Public Chrome showed both in.

At 02:52:43 UTC its model ended twice without a terminator while operation
91185dca8c5efb52c300c449332b5852 remained running. TaskRunner marked protocol_violation;
at 02:52:58 the acceptance job consequently failed dsh-session-required. This is
not evidence of logout and its failed Run/receipt must remain unchanged.

0.27.4 adds a host pending-operation callback. Same-session fresh Browser MCP jobs
retain the Run/heartbeat across idle turns, without extra LLM polling or extending
the watchdog. On terminal/stale receipt, the existing nudge/termination protocol
resumes. Running browser jobs also prevent premature complete/block in custom
workflows; unrelated Agents and managed-recipe acceptance semantics stay unchanged.

164 tests pass with /usr/bin/node (Node 22), build and diff checks pass. The first
test invocation used shell-default Node 20 and failed SQLite ABI loading; no native
module or dependency was rebuilt. Live retry/stability acceptance remains pending
at this code commit. Existing lib artifacts are production dependencies, retained.
