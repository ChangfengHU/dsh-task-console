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

After Stage 5 passed, the live Stage-6 installer returned a generic failure. The
host probe now supplies fixed Dashboard startup reason enums. Start/resume project
those allowlisted codes with the original observation time and an explicit
pre-execution boundary while Stage 6 is pending; they cannot be mistaken for new
execution results. Raw logs or unknown strings never reach the tool response.
# Browser prerequisite diagnostics

After the original run passed stages 4/5/6, stage 7 failed generically. The
timestamped pre-execution diagnostic projection now also accepts four fixed
browser prerequisite enums. It does not expose command output or claim that
the observation happened after installation. Unknown text/canary remains hidden.

## Real acceptance — 2026-09-07 10:59:41 UTC

The original session `agent-fleet-installer-mtqvs1cv`, transaction
`onb-77432c6f-d12b-4f30-92e5-301ba14dec65`, reached complete at revision 79:
the latest attempt of all ten stages passed and fresh final signed inventory
was verified. The final-attempt report has 6 reused, 2 repaired, 2 installed,
zero blocked; historical failed attempts remain. These counts are the final
attempts, not a claim that the earlier repairs never happened.

The developer changed code/published artifacts and sent maintenance through
that exact visible DSH session; target mutations belonged to DSH. No passwords
or tokens were rotated. The host adapter still uses the original v1 ledger
executor binding so this transaction can resume; actual machined is 0.15.8.

Public browser checks: the original DSH session loads current maintenance/tool
history (25.4 seconds, no history/page error); VNC connects and renders both
headed browsers (11.2 seconds); Fleet shows the node online, both browsers,
memory/disk and the VNC link (6 seconds). Public Clash/VNC health return 200.
Fleet telemetry uses the independent Controller, not an image service.

Known boundary: Fleet's API still carries an optional legacy image capability
HTTP 521 diagnostic while the base-node desktop fallback is healthy. The UI
does not show it as a node failure; this run does not add the separate browser
account-control service or image-worker extension. Do not claim those extensions
were accepted, or that initial history loading latency was solved here.

Final plugin code: 90fa41d; 122 serial tests and build passed. Companion code:
linux-clash-skill 4c29521; sop-ui 0c55ee0 (machined 0.15.8);
a2a-studio 518a521, deployed Worker 61e51509-9b42-45bb-8802-d9c241d40af0.
