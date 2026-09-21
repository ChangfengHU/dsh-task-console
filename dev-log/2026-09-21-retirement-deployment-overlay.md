# Retirement deployment overlay

Root cause verified with runtime script inspection: the web profile disables the
main task-console plugin and loads a studio migration copy. Main commit fb7168b
was not present in that active implementation; merely restarting could not fix
the notification workflow. Always resolve the effective Cordis patch path before
deploying, and compare it again before activation when other sessions are working.

This change limits the retirement preset to the candidates array: empty means a
summary-only no-op, not repeated status/audit reads. Regression now explicitly
rejects notification completion without a task_notify receipt.

Integrated studio runtime source is preserved on branch
`fix/retirement-studio-integration-20260921` (4b0ec18), preserving studio changes
through b64162c73535. Its runner/design/studio-tool regression rerun passed 67/67.
Actual deployment, notification receipt and schedule acceptance are separate
checks and remain pending until reported with a real batch ID.
