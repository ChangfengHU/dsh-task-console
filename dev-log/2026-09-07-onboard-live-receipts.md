# Onboarding live receipts and capability alignment

The installer has four native intent tools and no model-facing generic Vault MCP.
Its host owns scoped Vault resolution; the copied Skill incorrectly described a
direct Vault capability. The canonical Skill now distinguishes those environments.
Do not broaden secret access or rotate working credentials to fix a download error.

The original 63 session stopped after repeated running receipts. Its Cloud job had
already ended with `machine-request-failed`, while the ledger remained running until
the next resume. Status/report now GET the exact deterministic Cloud operation and
return a separate timestamped `async_operation`; they never submit, probe, mutate
the ledger, or treat a Cloud success as signed host acceptance. Unavailable reads
are unknown, not success. The actual pending stage selects continuation policy,
not an old higher-stage attempt after reopening an earlier stage.

The preset no longer considers three unchanged polls a failed installation. It
follows the durable executor's terminal state/timeout, with a bounded 30-minute
no-progress tracking limit and immediate cancellation/policy stops.

Validation: 29 focused onboarding tests pass, including GET-only receipts,
wrong-target rejection, no repeated dispatch/probe/ledger writes, and secret-safe
read failures. The full serial plugin suite passes 121 tests and the build passes.
This is not evidence of completed target installation.
