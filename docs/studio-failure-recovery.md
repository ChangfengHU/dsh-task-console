# Studio platform failure recovery

`taskConsole/recoverStudioCard` is an operator RPC, not an agent tool. Use after diagnosing and repairing a platform fault; it does not certify film quality.

Payload: `{taskId,batchId,cardId,expectedRunId,recoveryId,reason}`. All fields required. Use a unique recoveryId; preserve the identical payload when retrying an uncertain HTTP response. The exact failed card and latest failed/crashed/timed-out run must match.

Only studio-video-v1 failed, unarchived batches qualify. Active nodes, other active batches of the same Task, successful/cancelled batches, unrelated failures/cancellations, missing budgets and nonterminal/unknown paid operations are rejected. Reconcile existing job IDs first; never create another batch to evade limits.

One kernel transaction restores only the failed triage node and dependency descendants whose latest kernel event explicitly records automatic upstream-failure cancellation. Manually cancelled nodes are rejected atomically. Completed upstream cards remain unchanged. An append-only batch/studio_recovered event reopens the batch projection. Old runs, assets, frozen studio state, limits and paid receipts remain intact. Consecutive failure counters reset for repaired nodes; previous values remain in kernel recovery events. Normal dispatch creates a new run/session. This is operator-directed recovery, not an infinite retry policy.

Deployment must update the runtime AND independently loaded `studio-schema.js` RPC registration. Dispatch is asynchronous after durable recovery. Accepted recoveryId replay is a no-op including after restart; conflicting payload reuse fails.

Validation: 10 focused tests, plus kernel/fold regression (26 total passed); build passed. No live recovery invoked. Initial invocation mistakenly named nonexistent test/wire.test.ts and ran no tests; corrected invocation passed.
