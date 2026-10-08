# Action intake repair and 79.72.76.64 preflight

Code: `de04c8d` (main, pushed). Scope: restore onboarding Action candidate discovery,
manual IP/account input and the previously implemented background operation bridge.
No target SSH or machine operation was performed by the developer or test scripts.

## Findings and changes

- The live `mcp-fleet-browser`, `mcp-fleet-proxy-read`, `mcp-fleet-proxy` entries
  lacked `transport: stdio`. Native MCP Config did not infer it. A configured,
  active plugin could therefore have zero registered tools. Explicit transport
  was added to those three entries only; filtered child clients now normalize
  unambiguous legacy transports without mutating source config.
- Account input previously required the entire suggestion string. Exact unique
  email/accountId now resolves to the canonical Vault selection, with disabled,
  absent and ambiguous identities rejected. Task submission resolves again on
  the host before freezing intent; accepted request retries do not query a new
  account or lose idempotency.
- Filled/pasted Actions recover field ranges only against the original literal
  template. Parameter whitespace does not change an IP's identity or invalidate
  its selected account. Missing specified-account placeholders still block.
- Main retained `onboard-background.ts` but lost its tool/service/runner wiring.
  Restored that wiring without changing Studio/image workflows or the reviewed
  Fleet recipe, Tasks, historical Runs, Actions, presets or their grants.

## Verification

- 167 unit/runner tests pass across action-options, action-snippet,
  filtered-mcp-client, vault-action-options, task-actions, onboard-background,
  fleet-onboard-tools, action-submission and runner tests.
- Final whitespace repair reran all 167 tests with zero failures.
- Native MCP client with explicit stdio registered all 16 browser tools, zero
  warnings/errors and zero target tool calls. Its test child was disposed.
- `scripts/test-task-action-manual-input-browser.py` passed against staged assets
  on the public page. It mocks candidate metadata and intercepts ALL business
  submissions: candidate outage + manual IP, manual email, pasted/newline input,
  exact accountId, unchanged session/Task. This is not an installation receipt.
- After deployment, `scripts/test-task-actions-live-browser.py` passed against
  the real public UI/catalog/Vault candidates (desktop and mobile screenshots).
  All writes were blocked, original session totals/catalog unchanged.
- Live RPC candidate search finds `79.72.76.64` in Vault and three eligible
  Gemini account choices. Browser MCP has 16 live tools; proxy read/write have
  three/four. Browser preset no longer reports missing dependencies; its legacy
  capability lock status is still unverified-legacy, not live-certified. The
  existing runner explicitly permits matching legacy fences; not regenerated.

## Deployment and recovery

Waited for BOTH native `session.list` running count and SQLite running claims
to reach zero, rechecked, stopped `sop-dsh-web.service`, then applied the scoped
deployment and started it. Task Console RPC and native tool catalogs are healthy.

The active package is resolved by:
`readlink -f /home/claude/.dsh/profiles/web/node_modules/dsh-task-console`.
Only its `lib/index.js`, `filtered-mcp-client.js`, `client.js`, `client-heavy.js`
were replaced. UI copies at `/home/claude/.dsh/main-ui/task-console/` received
the same two client assets. Existing Studio/publisher modules and the scoped
installer override remain untouched. The override already has the shared
background observer; main service now consumes it again.

Rollback bundles (no credentials) are retained in
`/tmp/dsh-action-runtime-backup-rnTzgy` until the next full onboarding acceptance.
Restore those exact four files and the two UI copies ONLY at a zero-session/
zero-claim maintenance boundary. Do not revert the corrected stdio transport.

Temporary build `/tmp/dsh-action-fix-20261008-yVK5T4` is rebuildable with
`DTC_BUILD_OUT=<staging-with-node_modules-link> /usr/bin/node scripts/build.mjs`.
The task-only dependency symlinks `node_modules/@deepseek-ai/dsh-agent` and
`dsh-llm` reused the existing global DSH install; no dependency download/install.
They and the temporary build are cleaned after tests; production has independent
dependency resolution. Success screenshots in `/tmp/task-action-manual-input.png`
and `/tmp/dtc-task-actions-live-*.png` are retained as unique acceptance evidence.

## Outstanding user decision

The user's earlier input selected explicit Gemini account mode but left
`【金库账号】` empty. Asked whether to use automatic allocation or a specific email;
no answer yet. Do not silently choose/change account or report installation done.
No new 64 Batch has been created. Once confirmed, use the existing reviewed Task
`T-chat-b4c6fcb369f0c20a9739`, Action `onboard-node`, target `79.72.76.64`, Vault
SSH access. All installation work must be performed by its DSH role Sessions.
Track base ten-stage receipts, independent Gemini acceptance and signed Runner
first probe/public Fleet readback before claiming complete installation.
