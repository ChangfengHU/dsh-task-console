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
module or dependency was rebuilt. Existing lib artifacts are production dependencies, retained.

## Actual host/Agent acceptance

After verifying no active Task/native turns, restarted the linked DSH host once.
Reused the same Task with Batch b-chat-619ec90823195dd9e78b, explicitly read-only:
inspect/acceptance/status, no further prepare/copy/restart. Receipt
184ed525f46073ad02f819988f8f5e88 completed 03:22:42 UTC, stable=true, 21 distinct
samples per browser. The host retained its binding, issued the normal terminal
nudge, and browser-manager itself called task_complete with the actual receipt.
No developer prompt during this execution; first failed Run remains intact.
Public Chrome Task/Fleet checks passed (21.40s/3.93s including assertions), no page
errors. Screenshots retained in /tmp/browser-login-recovery-*-readonly*.png.

Owner clarified: developer improves/tests DSH Agent capabilities, not day-to-day
machine login monitoring. Account-pool policy/tool changes belong to linux-clash;
five discovered accounts are not proof of five currently eligible sources. One
owner-excluded account must not be copied; valid existing logins remain preserved.

Account-pool policy and browser-manager preset are now updated by the owning
linux-clash project. New-generation session agent-browser-manager-mttkrxrj used only
two candidate queries: all five discovered accounts were explained, the owner denial
was respected, allowed-but-unverified was kept distinct, and valid target logins were
preserved. This is a read-only Agent decision test, not another cookie transfer or
multi-account allocation test. No new DSH core change or restart was necessary;
75 relevant Node tests passed in the owning project. Target-independent role rules
and the existing host policy own this behavior, not a second account database here.
