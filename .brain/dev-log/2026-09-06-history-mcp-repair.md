# Empty tool identities: preserve stream IDs and restore old reads

The running host is the user-installed `@deepseek-ai/dsh` 0.1.1-rc.2, managed by
`sop-dsh-web.service`. The adjacent `deepseek-harness` source checkout is not this
service's runtime. Keep the reviewed host compatibility patch in this repository;
do not deploy unrelated upstream checkout commits to repair an installed bundle.

## Cause and scope

Compatible model continuation chunks supplied an empty tool-call ID after an
earlier valid ID. The provider adapter overwrote the valid value, leaving empty
IDs in final assistant messages, calls and result sources. Chat/Trajectory then
matched multiple starts to the same identity. A cold service restart also exposed
strict persistence validation rejecting the old empty result sources; a warm-page
test alone was insufficient.

The version-locked host patch now preserves nonempty streamed IDs and rejects
tool completion without an ID. Existing read migrations reconstruct legacy IDs
only from original streamed tool blocks and exact result `sourceEventSeqs` links.
Missing evidence still fails validation. Raw request snapshots and output content
remain unchanged; original session bytes are not rewritten. UI fallback identities
are display-only. Code backups are retained beside all four patched bundles.

No target-machine browser operations were rerun during this repair. The idle DSH
host was restarted to reload server code; existing browser instances were untouched.

## Verification

- Focused history and existing model-selection compatibility tests: 9/9.
- Full plugin suite: 114/114 on rerun. The initial full run had one failure; that
  run's truncated output did not retain the failing assertion, so its cause is not
  established. Do not describe the full suite as a consistently clean baseline.
- Actual installed stream adapter retained distinct IDs for two simulated parallel
  SSE tool calls followed by empty-ID fragments.
- Exact installed bundle syntax and repeat application checked; repeated patch
  returned no changes. Package dry-run includes all three host-patch scripts.
- Stored browser-manager session: 40 calls and 40 results recovered uniquely,
  with every source link verified and all 2302 decoded events schema-valid.
- Public Chrome cold-start check after service restart: final report visible in
  28.59 seconds without a history error. A later fresh-browser check took 17.55
  seconds, loaded all 40 cards, expanded the create receipt, and rendered Chat,
  Trajectory and Trace with no page errors. These timings are observations, not a
  performance guarantee.
- The original compressed log prefix remained byte-identical. Normal session
  reattachment appended one `session/end-seed` event; no prior event was deleted
  or rewritten.

Acceptance URL:
https://dsh-152-32-214-95.vyibc.com/?session=agent-browser-manager-mtpw5zxx

## Separate local Codex MCP launcher failure

All five vyibc connectors shared the local `vyibc-mcp-auth` launcher. Its transient
`npx` dependency tree lacked `math-intrinsics/abs.js`, causing initialization to
exit before connecting. The missing-file error also reproduced under Node 22;
changing Node alone was not the fix. How the cache file disappeared is unknown.

The local launcher now uses an independent pinned `mcp-remote` 0.8.3 installation
under `/home/claude/.local/lib/vyibc-mcp-runtime`, explicitly invoked by
`/usr/bin/node`. Only the five connector startup timeouts changed to 30 seconds.
Credentials were not changed or rotated; the previous launcher and cache remain.
Real SDK initialization and tools/list passed for Vault (5), Fleet (10), Browser
(2), WeCom (3), and YouTube (9), taking 8.2–9.7 seconds concurrently. No business
tools were invoked by that smoke test. Existing failed Codex connections require
a fresh process; resume the original conversation after restarting Codex.

These local launcher/config files are outside this repository and are not shipped
by the DSH compatibility patch.
