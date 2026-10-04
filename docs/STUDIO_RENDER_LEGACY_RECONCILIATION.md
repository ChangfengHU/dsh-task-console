# Legacy render intents: read-only reconciliation draft

This is an operator review recipe, not an automatic migration or authority to
change a production task. The new preflight-before-reservation path prevents new
false reservations. It deliberately leaves existing `submitting` / `unknown`
rows unresolved. A missing `jobId`, an error string, or absence of an MP4 alone
never proves that dispatch did not happen.

For the trial07 report, the observed request supplied a storyboard JSON file as
`composition`. The deployed TypeScript bridge checks for a composition directory
before invoking its Python helper. This is a candidate explanation for that
specific call; it is not proof that no other call dispatched the same intent.

1. Capture an immutable evidence bundle: exact task/batch/card, intent ID, full
   original ledger row and its SHA, origin run/session, tool call/result IDs and
   timestamps, composition/output arguments, source file kind/SHA at that time,
   deployed bundle identity, and the row's pinned helper path/SHA/runtime. Do not
   include credentials. Preserve the original row and all existing artifacts.
2. Read every matching invocation across the original and later runs. Verify the
   exact deployed source control flow, not current source or a matching error
   message. Establish whether any call could have reached the bridge execution
   boundary. An execute-time error with the same text remains ambiguous.
3. Inspect the task's `.studio-render-jobs` records for this exact intent, original
   job IDs, output reservations and worker logs. Check associated processes with
   process-start identity, not PID alone. Inspect without starting or deleting a
   job. If any matching dispatch/job/worker exists, retain pending protection and
   reconcile that original job; never use a new composition/output as its repair.
   Missing job files alone are insufficient because a worker or reply can be lost.
4. Only if trusted evidence proves **all** matching invocations stopped before
   external execution, prepare a separate, explicitly authorized maintenance
   change. Require no active owner/worker, back up the row, and CAS against its
   exact captured bytes/revision. Record the evidence and terminal rejection in
   an append-only audit; retain the original intent, origin, helper pins and
   history. Do not delete the row, fabricate a job receipt, clear unrelated paid
   reservations, or mark the production card complete. This patch provides no
   such maintenance command and has not performed this action.
5. Any changed observation or missing evidence cancels that proposed mutation:
   keep the original intent unresolved. A task resume/new task is a separate
   authorized decision after reconciliation and proper composition validation.

Rendering is not quality approval. This recipe does not establish a valid MP4,
repair the storyboard or choose replacement creative content.
