# Trusted workflow extensions

The build includes the `release-audit@1.0.0` adapter and host API 2. Studio/browser
legacy contracts retain their existing handlers. This adds business-specific
validation and scoped tools to the existing TaskRunner, not a second scheduler.
Local tests and isolated deployment checks do not establish a production E2E or
media quality. See `release-audit.md` for the adapter's deliberately limited scope.

## Definition and binding

A trusted single-file ESM module exports an exact id/version, `hostApi` (1 or 2),
`validatePolicy`, mandatory `beforeComplete`, and optional lifecycle hooks.
API 2 adds run-scoped `registerTools` and the host evidence port. The loader derives
implementationSha256 from verified bundle bytes; modules cannot choose their own
trusted digest. Node builtins are supported; other dependencies must be bundled.
Loading adapter code is an administrator operation, never an Agent RPC.

Tasks select `design.extension: {id, version, policy}`. Both direct creation and
chat Creator validate and freeze policy/implementation SHA-256 before approval.
API 2 bindings additionally pin `hostApi: 2`; legacy API 1 bindings remain readable.
Creator includes bindings in its approval fingerprint. Changed or missing adapters
fail closed. Exact versions may coexist. Extension selection cannot be mixed with
legacy Studio/browser/proxy/notification contracts.

## Tool access and evidence

`toolAccess: scoped-only` requires every participant's saved capability contract to
be ready/in-sync, with only the `workflow-runtime` marker, no skills and no MCPs.
The marker itself exposes no ambient tools. The generated preset pins this release's
tool fence. An adapter registers tools through the host facade; grants match exact
session and tool names and expire when the run finishes or the host stops. Shared
process-local grant state works across separately bundled host/fence modules.

The evidence port binds receipts to task, batch, card, role, round, session,
projection run, kernel run, attempt, current unexpired claim, policy and adapter.
Commit checks these bindings transactionally. Checks before and after asynchronous
operations reject stale runs. This is an integrity boundary against model-authored
claims, NOT an OS sandbox against another process with the same Unix identity.
External orphan files can remain after cancellation; they are not accepted receipts.

`beforeComplete` can require exact artifact paths and hashes. The runner captures
files and checks those copies before registration, then rechecks the active run.
Model metadata, human approval, or a generic task completion cannot replace adapter
acceptance. Finalization uses the same hook and can require the current approved
artifact. Adapters must define any business-specific final-artifact binding.

## Packaging and upgrade

`lib/workflow-compat.json` declares schemaVersion 1, hostApi 2, and adapter entries
with id/version/hostApi/actual implementation hash/relative .mjs bundle path. The
build packages the release-audit adapter. Managed deployment covers the declaration
and bundles in DEPLOY_MANIFEST.json. Startup verifies bytes and identity before
runner dispatch and imports those verified bytes directly.

The upgrade guard checks retained Task templates, unfinished frozen batches and
pending/approved Creator plans, including paused/archived definitions. It rejects
missing adapter versions, changed digests and API downgrades that cannot honor
existing bindings. This can intentionally prevent rollback to a legacy release.
Retain compatible adapter bytes in a rollback build instead of deleting history.

There is no cross-process maintenance lock. Global quiescence, full-profile CAS,
actual old-runner disposal and a maintenance window remain required. Staging is
inert. Unregister refuses active calls or unfinished batches; this does not itself
veto Cordis unload. The integrating host must manage safe disposal.

## Verification boundaries

Tests use the real EventStore/TaskRunner with a fake DSH host and actual Python
archive verifier. They cover binding, claim fencing/recovery, drift, completion
bypasses, exact session grants, tool disposal, independent role reports, artifact
mutation and final selection. Python fixtures cover upgrade/rollback compatibility.
Actual DSH tool exposure and unattended business completion require a separate E2E;
these tests are not a substitute for that evidence.
