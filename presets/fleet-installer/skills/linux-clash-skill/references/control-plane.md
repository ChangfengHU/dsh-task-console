# Local control-plane reference

## Ownership

- Keep proxy credentials and the active source URL on each node in `/etc/linux-clash-skill/controller.json` mode `0600`.
- Keep the Dashboard node registry in local `nodes.json` and audit history in local SQLite.
- Keep reviewed scripts, templates, defaults, and operational documentation in GitHub.
- Use Cloudflare only for persistent Tunnel/DNS unless the user explicitly chooses an edge control plane later. Worker and D1 are not dependencies of this release.

## Node Controller

The Controller binds `127.0.0.1:8788`, authenticates every management request with a root-owned bearer token, serializes actions, and returns an operation ID immediately. Supported actions are `enable`, `disable`, `verify`, and `replace`.

`enable` and `disable` are idempotent. Managed installs with `current-backup` use exact rollback on disable. An adopted legacy install without that pointer uses the explicit `disable` command once: stop Mihomo, restore direct routing, and retain files. Its next enable creates a proper disabled-state backup, after which exact rollback semantics resume. `replace` preserves the previous settings until the new source passes a direct SOCKS5 TCP/UDP preflight. Persist the plan's exact server IP and matching exit before installation so candidate ordering cannot change between phases. When the proxy was on, replacement restores direct networking first, installs and verifies the new source, and attempts to reinstall the pinned old proxy on failure. If recovery also fails, leave the host direct and report both failures.

Controller-managed installs align the system timezone to validated exit intelligence by default. The pre-install timezone is stored in the same rollback snapshot and restored on disable/rollback. Treat a missing or invalid third-party timezone response as non-fatal and preserve the current timezone. After every enable, disable, or replace result, including rollback failures, probe the Dashboard's current public health URL. Keep a healthy connector, but restart an unhealthy one and wait for public health recovery. If the anonymous registry still reserves the prior name, retry with a random suffix and update `dashboard-public.url`.

Do not put a configuration URL, controller token, Tunnel token, username, or password in operation/audit logs. Status may return only a redacted source origin and the safe fields from `result.json`.

## Isolated machine Dashboard (default)

Deploy one Dashboard on every machine with `install-machine`. It binds `127.0.0.1:8787`, calls only that machine's Controller over loopback, and on first install requests `clash-<direct-IPv4-with-hyphens>`. Detect that address before Mihomo TUN is active; never substitute the proxy exit. Fall back to sanitized hostname plus machine ID when a safe direct lookup is unavailable, and preserve the recorded request name on upgrades. Machines behind the same NAT rely on the tunnel registry's collision suffix. Read-only status and diagnostics are public; mutations and audit access use a Secure/HttpOnly/SameSite session cookie plus CSRF. Browsers receive neither node URLs nor token paths.

The actual assigned public URL is stored in `/etc/linux-clash-skill/dashboard-public.url`. The connector reuses the last successful name. If that name is still reserved during recovery, it adds a random suffix and atomically updates both the effective name and actual URL instead of remaining in a `409` loop.

## Central aggregation (optional)

When one UI must manage a fleet, deploy `install-node` on each machine and one `install-dashboard` on a stable central host. Controllers then use unique HTTPS Named Tunnel hostnames. Register each node with `control_plane.sh add-node`; do not hand-edit registry secrets into the public repository. This is an advanced alternative, not the default per-machine topology.

The local SQLite database is execution history, not a source definition.

## Tunnel survival

Run named Tunnel connectors as the dedicated `linux-clash-tunnel` user. Ensure that UID is present in Mihomo `tun.exclude-uid` before considering the management path direct and stable. On a machine upgraded from an older release, install the Controller without starting its Tunnel, perform one controlled rollback/install cycle from a provider console or second SSH session with the Tunnel UID excluded, verify TCP/UDP, and only then start the Tunnel service.

Never bind the Controller, Dashboard, or Mihomo `external-controller` to `0.0.0.0`. A Named Tunnel is outbound-only connectivity, but Controller bearer authentication and Dashboard mutation/session authentication remain mandatory.

`assets/linux-clash-dashboard-public.service` runs `auto-domain` as the excluded `linux-clash-tunnel` UID. It requires no Cloudflare API token. Treat an anonymous hostname as best-effort; use a Named Tunnel when a stable contract, custom DNS zone, or Cloudflare Access policy is required.

## When to add Worker or D1

Add a stateless Worker only when the Dashboard host must no longer be an availability dependency, a single edge API is needed, or node topology must be hidden behind an edge gateway. Add D1 only when commands must wait for offline nodes, nodes self-register dynamically, or multiple operators require shared durable state. Keep file-shaped definitions in GitHub and node secrets local even then.
