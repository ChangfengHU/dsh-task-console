# Release audit adapter

Contract: `trusted-verifier-independent-sessions-v1`.
The planner schedules an executor and a reviewer in separate sessions. Each calls
the same pinned, trusted host verifier against frozen archive bytes and submits its
interpretation. The reviewer must cite the exact registered executor report. This
is independent execution of one algorithm, not two independent implementations.
Older shell-based audit Tasks retain their original contracts and results.

Policy pins `candidate.tgz`, its SHA-256 and the expected Git commit. The verifier
uses Python's standard library, does not execute archive contents or extract them
to disk, and checks compressed bytes, safe unique regular members, exact manifest
coverage, each member hash, and SOURCE_REVISION content. A revision file's raw hash
is recorded separately from the commit text stored inside it.

Limits include 32 MiB compressed input, 32 MiB per member, 96 MiB total member bytes,
256 members, 512-character paths, bounded metadata/output, 60-second subprocess
timeout, 512 MiB address space and 20 CPU seconds on Linux. Unsupported environments
fail visibly. Python 3 is a runtime dependency; no Python package download is needed.

Tools:
- `release_audit_status`: frozen policy and host-recorded evidence in this batch.
- `release_audit_verify`: actual current-run calculation, available to workers.
- `release_audit_report`: host-generated facts plus Agent interpretation, only for
  the worker's own proof. Identical sequential retries reuse the saved report.

Reports are private files under generated report directories. Workers submit all
returned paths through task_complete. The host verifies exact captured bytes.
Finalization requires both current-round reports to pass, distinct role sessions,
matching calculated facts and the current executor REPORT.md as final artifact.

A pass establishes byte integrity only. It says nothing about package functionality,
installation, license compliance, runtime security or artistic/video quality.
These roles have no shell, arbitrary filesystem, network, MCP or skill tools. This
restriction is not an operating-system sandbox against other same-user processes.
