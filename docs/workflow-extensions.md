# Trusted workflow extension foundation

Status: locally tested foundation; no production business adapter is bundled yet.
Studio/browser legacy contracts keep their existing handlers. This is not a
second scheduler and does not grant an Agent tools, filesystem isolation, or
permission to publish.

## Definition and binding

A trusted single-file ESM module exports a default definition with `id`, exact
`version`, `hostApi: 1`, `validatePolicy`, mandatory `beforeComplete`, and optional
`beforeStart` / `beforePlanRound`. The loader supplies implementationSha256 from
the actual verified bundle bytes. Modules may use Node builtins; other dependencies
must be bundled. Loading trusted code is an administrator operation, never RPC.

Tasks select `design.extension: {id, version, policy}`. createTask and chat Creator
both validate the policy and freeze implementation/policy SHA-256 before saving or
reviewing. Creator includes that binding in its review fingerprint and only
revalidates at approval. A missing or changed adapter fails closed. Exact versions
may coexist; running batches retain their frozen definition. Extension selection
cannot be mixed with legacy Studio/browser/proxy/notification fields.

## Startup and deployment

`lib/workflow-compat.json` contains schemaVersion 1, hostApi 1, and extensions with
`id`, `version`, `implementationSha256`, and relative `bundle` (.mjs) path. This is
both the deployment compatibility declaration AND the startup loader input.
Every bundle must be covered by DEPLOY_MANIFEST.json in managed deployments.
Startup verifies bundle bytes and identity before registering them, before the
runner loads durable state or dispatches any ready card. Verified bytes are
imported directly, avoiding a path-read/import race.

The current build writes `extensions: []`: do not interpret host API support as
having installed an audit or video adapter. A future release packager must build
and declare real adapters. Trusted hosts may additionally supply workflowModules
in Cordis configuration or register when idle, but the managed upgrade script does
not yet support arbitrary extra module configuration. Prefer declared bundles.

The managed upgrade guard checks all retained Task templates (including paused and
archived), unfinished frozen batches (including blocked/archived), and pending or
approved Creator plans. It rejects missing versions/implementation digests and
unbound definitions before changing the profile. Missing declaration is legacy
host API 0. This does not provide a cross-process lock: actual old runner disposal,
profile CAS, quiescence, and a maintenance window remain required.

## Completion and lifecycle

The host adapter must return a nonempty evidence-based decision. Model metadata
cannot replace it. Static extension cards cannot use task_request_review or human
approve to bypass the gate; historical review cards require changes and a fresh
host-validated submission. Dynamic task_finalize uses the same completion hook.
Missing exact adapter versions block before model dispatch.

Unregister refuses while calls or unfinished batches use the version. This is not
an automatic Cordis unload veto; the integrating host must manage disposal.
No current adapter verifies audit semantics, independent scripts, or media quality.

## Verification scope

Local tests exercise actual EventStore/TaskRunner with a fake DSH host: Creator
freeze/approval, ready-batch restart, missing adapter, model spoofing, human-review
bypass, bundle identity/hash drift, exact-version preservation, JSON boundaries,
and registration exposure. Python deployment fixtures cover blocked/frozen batches,
paused definitions, pending plans, tampered bundles, malformed storage, and legacy
compatibility. Tests do not establish a real DSH business E2E or artistic quality.
