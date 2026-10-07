# Owner-scoped Fleet plugin publisher

## Boundary

Fleet Hub owns product source, immutable release archives, approval and jobs.
DSH uses its existing Task Signal/planner/executor/reviewer pipeline; it is not
a second scheduler. A dedicated native Codex app-server client calls three official
Plugin Creator tools. The ordinary Codex model adapter is not changed or granted
Apps access. The user's Mac is not required to stay online.

The adapter updates the reviewed original Personal Trace and Flow private packages.
It cannot create plugins, change ownership/discoverability, replace cloud App
bindings, delete omitted files, or publish arbitrary archives. More products need
explicit reviewed identity mappings and their actual source/permissions.

Flow's private package and a canonical cloud App are different identities. Its
private-package update must not be reported as cloud App registration, Try in
chat, user installation or authorized business execution. Fleet and the native
publisher both validate the approved package/name/App tuple. New cloud App
bindings require actual registration and a separately reviewed identity mapping;
typing an App ID into a Fleet draft does not register or authorize it.

Portable products import the complete verified package, retaining Skill reference
and script trees, README and MCP declarations. Changed associations cannot replace
the source inventory. Host-only empty keywords/headers and compatible HTTP
transport spelling normalize for readback; changed endpoints and nonempty headers
still fail. Native text reads use bounded batches rather than assuming one read
can accept an entire plugin. Core/entry annotations do not execute a Skill.

## Install and activate

The source repo is `ChangfengHU/dsh-task-console`, checked out on 95 at
`/home/claude/dsh-task-console`. The running `sop-dsh-web.service` uses the
existing profile's symlink to this checkout. Build with `node scripts/build.mjs`.
Install only the dedicated roles with:

```sh
node scripts/install-plugin-publisher.mjs
```

The installer refuses to overwrite a differing user-authored preset. It creates
`plugin-publisher-planner`, `plugin-publisher`, and `plugin-publisher-reviewer`.
Use Task Console catalog/agents to confirm both groups and all three roles.
The write group exposes only `fleet_plugin_publish` and
`fleet_plugin_publish_status`; the review group exposes status only.
When the signal declares required executor tools, intake first returns matching
tool-capable or domain-declared roles. `includeAllAgents:true` retrieves the
full roster; routing validation still uses the complete context. This prevents
unrelated large tool inventories from hiding the three eligible roles.

Before replacing runtime bundles or restarting the service, check BOTH native
`session.list` running flags and SQLite `task_runs` unfinished active claims.
Wait for a zero-active boundary. Live Cordis YAML is hot-reloaded and must not
be treated as staging. Preserve unrelated frontend/model bundles and presets.

## Credentials and protocol

The host already receives `DSH_TASK_INTAKE_TOKEN` from its service environment
file `~/.config/dsh/task-intake.env`. Fleet has the matching Worker secret and
`DSH_TASK_SIGNAL_URL`. The publication credential is an in-memory HMAC-SHA256
derived with domain `fleet-hub-plugin-publisher-v1`, never the raw intake token.
No new credential is saved or passed to model prompts.

Native Codex is `~/.local/bin/codex`, under the existing owner's ChatGPT login.
The client uses documented app-server JSON RPC and authenticates through that
runtime, not copied browser cookies or a desktop IPC shim. It verifies ChatGPT
account type, Plugin Creator installation and live tool discovery. Only
`plugin_creator.get_plugin_files`, `plugin_creator.get_owned_plugin_archive`,
and `plugin_creator.update_plugin` are called.
Interactive server requests are denied. Source reads use direct tool calls;
upload uses one low-effort native Codex turn so its host performs
`openai/fileParams` conversion. Raw `mcpServer/tool/call` accepts the rewritten
path schema but sends a string to the connector, whose actual archive parameter
is an uploaded-file object. Do not implement private upload HTTP endpoints to
work around that mismatch. The native turn disables ambient Apps/MCP servers,
shell and web search and enables only Plugin Creator read/update tools. Its
single actual update invocation must match the exact approved three arguments.
The turn resolves the executable tool name from its own `ALL_TOOLS` inventory;
MCP protocol names and code-mode JavaScript names are not interchangeable.
The host logs only allowlisted tool identity/status/count and safe typed failure
diagnostics: stage/event, a fixed category/reason, numeric error code/HTTP status and
elapsed time. It never logs raw error messages, result content, arguments,
archive paths, signed URLs, credentials or stderr. Unknown error labels remain
`unknown`, not an arbitrary string copied from the connector.
App-server MCP item errors expose only a message, not typed code/HTTP fields.
The diagnostic accepts bounded fixed invalid-parameter phrases and standard
MCP/JSON-RPC code prefixes from that message without storing the original text.
Diagnostic v3 also extracts fixed `reason` enums from the CLI 0.160.1 uploader's
known error fragments: `local_file_open_failed`, `upload_response_parse_failed`,
`blob_upload_failed`, `upload_finalization_failed`, and
`upload_download_url_missing`. These classify the upload boundary as
`file_upload`, not proof that a platform write did or did not happen. Exact
public archive-validation codes (for example `archive_format_not_zip` and
`archive_member_unreadable`) retain their allowlisted code as `reason` and map
to `invalid_arguments`; `plugin_version_unchanged` maps to `release_conflict`.
Typed HTTP/error classifications retain precedence when present. Matching is
bounded to the first 4096 message characters and uses fixed token boundaries;
unknown labels, connector-provided `reason` fields and marker suffixes are not
copied. The complete public archive-code reference is
[Plugin submission errors](https://developers.openai.com/plugins/deploy/submission-errors).
These safe reasons are visible in existing receipt/failure journal events and
do not change retries, interactive-request denial, or full-file readback.
Turn errors separately expose `codexErrorInfo`: the official
`httpConnectionFailed`, `responseStreamConnectionFailed`,
`responseStreamDisconnected` and `responseTooManyFailedAttempts` variants retain
only their numeric HTTP status, while `internalServerError` maps to `upstream`.
Denied server requests emit `native server request rejected` with the fixed
`server_request_rejected` event and an allowlisted method or `unknown`, never
request parameters. Its `authorization` category identifies the local denial
boundary; it is not proof that connector credentials failed. The rejection
policy is unchanged and never automatically approves these requests.
Independent source readback, not the model's final text, determines success.
Do not treat this private-owner flow as a supported commercial/multi-tenant API;
check OpenAI authentication terms and supported grants before broadening it.

The model provides only the approved release UUID. The executor claims a durable
Fleet lease, downloads that immutable archive, verifies SHA-256 and current
platform identity/scope/App/default prompts, then updates using the frozen
`expected_release_id`. Temporary ZIPs are mode0600 and removed afterward.
Successful readback compares version, release ID and every imported text file,
including scripts and references. JSON is structurally compared because the
platform may normalize manifests. Binary icons/resources are independently
verified from the same owner's official current-release archive, fetched with
bounded HTTPS, no forwarded credentials or filesystem extraction. File listing
and text reads are paginated/batched within official tool limits. Missing old
Skill files stop publication with `platform_file_delete_unsupported` because
official updates overlay rather than delete. Never report an omission as deletion.
Use deep JSON equality, not `JSON.stringify(JSON.parse(...))`: the latter still
compares insertion order. Arrays and values remain order/value sensitive.

## Recovery and acceptance

- A failed native `update_plugin` receipt is not a successful publication.
  Its safe category is retained in `[plugin-publisher] native upload receipt`,
  `native upload failed` and `publish failed` journal entries. It still records
  `unknown_outcome` after a mutation was attempted: a connector failure alone
  cannot prove that no platform write occurred. Do not loosen the exact call,
  identity, frozen release ID or independent full-file readback guards.
- Native process exit/error/stdout EOF (including stdin/stdout errors) rejects
  the outstanding upload wait immediately, rather than waiting for the
  120-second turn timer. Turn failure, interruption and timeout have distinct
  allowlisted events/categories. Raw process/authentication stderr remains
  discarded. These diagnostics do not expose new credentials or grant retries.
- `queued` is submitted, not published; follow the DSH Task link.
- `needs_triage` before Task creation can be retried by its authenticated
  producer using the same immutable Signal and `?retry=1`. This appends a
  `retry_requested` event with the previous session/decision; ordinary duplicate
  POSTs do not restart it. Materialized Tasks and report children cannot be
  retried this way. Both planner and reviewer must declare the required
  `taskExpertise`; that declaration never grants the reviewer write tools.
- `running`/`verifying` are unfinished. An ambiguous upload is never retried
  blindly. After lease expiry call publish for the SAME UUID; readback can
  reconcile an already-completed upload without creating another release.
- If that Task turn has already ended, use Fleet's **继续更新**. Fleet checks
  the terminal Task and expired lease, then issues a fresh Signal for the same
  Incident/release. Intake can reuse the original goal Task for another Turn.
  Do not invoke `fireTask` on an external-signal Task or delete its old rounds.
- `blocked` means inspect the exact error/task. Do not override identity,
  archive or platform-conflict guards to make a green result.
- `verified` means official package/version/full-file readback completed. It does not
  prove an existing ChatGPT conversation refreshed or a business MCP call ran.
- For initial acceptance, use Fleet administrator login and click
  Personal Trace > 更新插件 > 刷新 Skill > 生成版本 > 更新到 ChatGPT.
  Generation and publishing are separate explicit operations. Record the real DSH Task ID,
  original plugin ID, platform release ID and matching Fleet digest/receipt.
  Unit/fixture tests and read-only capability probes are not this acceptance.

Regression entrypoints: `test/plugin-publisher.test.ts`, task-intake tests,
capability-contract/readiness and agent-tool-fence tests. Fleet counterpart:
`/home/claude/linux-clash-skill/docs/hub-plugin-publishing.md`
(`ChangfengHU/linux-clash-skill`, private).

For a read-only native platform probe (no upload), run
`/usr/bin/node --import tsx scripts/verify-plugin-publisher-readonly.ts` on 95.
It verifies current package identity, text files and official owned-archive icon
readback; outputs metadata/counts only, not credentials or signed URLs.
Stage with `DTC_BUILD_OUT=/tmp/dsh-hub-skills-stage /usr/bin/node scripts/build.mjs`
and compare output to lib before activation. For this change only
`lib/plugin-publisher-tools.js` differs; preserve all other runtime bundles and
activate only after both running sessions and unfinished claims are zero.
# 2026-10-04 canonical Skill acceptance

The first full-path read exposed PNG being sent to the text-only read API. Both
baseline and post-upload reads now receive binaryPaths; baseline owned-archive
reads select only already-existing paths, allowing new binary assets. Fifteen
publisher tests pass. Same immutable Fleet release reached verified at
2026-10-04T21:34:52.292Z and official0.1.5 release
pluginrel_6ac2c66f88e48191b5e97f2cbc4ea3ae. Independent no-upload probe confirms
the original USER/PRIVATE package, nine files and9936-byte icon. Legacy extra
files are preserved by overlay. Task state alone is never a platform receipt.
