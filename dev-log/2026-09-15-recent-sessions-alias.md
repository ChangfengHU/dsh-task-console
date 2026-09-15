# Recent sessions and public alias

Authorized: independent cross-folder recent sessions plus dsh.vyibc.com serving
the existing DSH/session URL. Assumption stated: recent means native last activity,
not last opened. Preserve Pinned, Favorites, folders and all Task/session history.

- Recent uses native session metadata only, filters existing hidden categories,
  sorts deterministically, shows ten with expand/less/collapse. No new RPC or DB.
- Initial alias returned 521 through wildcard DNS. Vault forwarding account and
  zone ownership verified using read-only Cloudflare API; exact alias DNS absent.
- Verified existing original DNS CNAME and dsh-loopback-proxy Worker route, read
  Worker code and origin tunnel ingress. Added only exact alias CNAME and route;
  original Worker code, originRequest, ingress, original route and auth unchanged.
- New DNS record ID: `8fbffdf77d7619175f9fa5636e07e781`.
  New route ID: `b6ef0cf2c16545918a9cd3e2cd9e90a4`.
  If explicitly reverting this feature, remove only those verified alias records;
  do not delete the shared Worker or tunnel. No credentials persisted.
- Before UI deployment, public alias loaded existing sidebar and retained requested
  session query. This alone did not prove history completion; final browser test
  separately checks it.
- Full suite 314/314, zero skips, 43.51s (`/tmp/dsh-recent-tests.log`).
  Build and restart occurred only after native Session/Task dual-zero observation.
- No dependency install or temporary candidate build; screenshots/test logs retained.

Final browser acceptance recorded below when complete.

- `scripts/test-recent-sessions-browser.py`: both original and alias deep links,
  history loading completion, Recent collapse/expand/more/less, exact session URL
  selection and reload, desktop1440/narrow390 screenshots. Original complete test
  39.43s, alias33.69s (includes reload/interactions, not a single page-load metric).
  Each had zero JS errors/business writes and four native WebSocket events.
- Screenshots `/tmp/dsh-recent-<hostname>-{1440,390}.png` visually inspected.
  Narrow sidebar preserves existing native sidebar behavior; close it to read chat
  at full width. No native responsive layout rewrite was included.
- Initial test failed on a Playwright Python argument-signature mistake, corrected
  to keyword arg and fully rerun. A separate urllib health probe got HTTP403; it
  is not evidence of browser failure and no security settings were weakened.
- Task specs/schedule bindings/Action catalog hashes exactly match prior baseline.
