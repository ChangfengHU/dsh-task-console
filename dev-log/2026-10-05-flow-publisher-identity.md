# Scoped Flow publication adapter

Implementation commit d4fc893 was pushed immediately after tests. The native
publisher now accepts the independently reviewed original Flow private package
as well as Personal Trace. It retains USER/PRIVATE identity, App binding, default
prompts, source inventory, endpoint/auth, expected release and readback checks.
Only known harmless empty compatibility fields normalize; actual changes fail.
No creation capability, ordinary Apps access or new credential was enabled.

16 publisher tests passed using the existing host packages through a read-only
resolver fallback; no dependency installation. Native Codex app-server independently
read Flow0.3.0 and its23-file inventory without upload. The one publisher-tools
bundle was activated in the existing pinned production package after all native
sessions reported running:false and unfinished claims were zero. The old bundle
is retained alongside it as plugin-publisher-tools.before-flow-task-20261005.js.
Active service remained healthy. Source and active bundle hashes matched.

This proves the native read path and scoped adapter, NOT a live Flow publication
Task, canonical cloud App registration, Try in chat or business MCP execution.
Do not upload unchanged content to fabricate that acceptance. New App bindings
need a real registration and a separately reviewed mapping on both ends.

Fleet counterpart implementation7e2a971, source/dev log in linux-clash-skill.
Rebuild publisher-tools with the repository's existing esbuild environment; only
activate that owned bundle at a fresh idle boundary. Preserve the rollback file
and do not overwrite other runtime bundles.
