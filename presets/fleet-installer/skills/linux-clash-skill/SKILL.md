---
name: linux-clash-skill
description: Safely plan, install, verify, roll back, or remotely control a system-wide Mihomo (Clash-compatible) transparent TUN proxy on Debian-, Ubuntu-, RHEL-, CentOS-, Rocky-, AlmaLinux-, or Fedora-based Linux from an HTTPS Clash YAML URL. Use when Codex, Claude Code, shells, and other applications must share one verified SOCKS5 TCP/UDP exit without per-process proxy variables, when public traffic must be proxied while private/SSH/Cloudflare Tunnel control paths remain direct, or when giving each Linux machine its own recoverable public Dashboard with proxy on/off and transactional source replacement.
---

# Linux Clash Transparent Proxy

Use the included scripts instead of assembling a live network configuration by hand. The installer validates TCP and UDP through the remote SOCKS5 node, pins a working endpoint, enables Mihomo TUN routing, verifies five required transparent exit checks plus a best-effort China-site path, and automatically restores the prior state if verification fails.

## Safety rules

- Never print, quote, commit, or summarize usernames/passwords from the source YAML.
- Require an HTTPS configuration URL. Do not copy the downloaded YAML into the workspace.
- Use `--config-url-file` with a root-owned `0600` file when the URL contains a token; the Controller already does this for subprocesses.
- Run `plan` before `install`. Planning is read-only and exposes only non-secret node metadata.
- When the user requires a stable exit, always pass `--expected-ip`. A mismatch must fail closed.
- Require the SOCKS5 TCP and UDP preflight exits to match. Never accept direct UDP fallback or report “all traffic” when STUN disagrees.
- For a remote machine, keep the timed rollback enabled. The installer also excludes the current SSH peer from TUN routing when `SSH_CONNECTION` or `SSH_CLIENT` is available.
- Do not claim that `external-controller` enables proxying. It only exposes Mihomo's local control API.
- Read [references/safety-and-routing.md](references/safety-and-routing.md) before changing the scripts or handling an unusual network topology.
- Read [references/control-plane.md](references/control-plane.md) before installing the Dashboard, node Controller, or Cloudflare Tunnel services.

## Plan

Planning makes no system changes and can run without root when the required commands and `/dev/net/tun` are visible. The examples use `sudo` so planning and installation see the same host environment:

```bash
sudo bash scripts/linux-clash-skill.sh plan \
  --config-url 'https://resource.example/proxy.yaml'
```

If the user supplied a required exit:

```bash
sudo bash scripts/linux-clash-skill.sh plan \
  --config-url 'https://resource.example/proxy.yaml' \
  --expected-ip '203.0.113.10'
```

Report the selected proxy name, hostname, pinned server IP, and observed TCP and UDP exit IPs. Do not install if they differ or do not match the user's intent.

If planning reports that every endpoint candidate is captured by an existing TUN, stop there. Do not treat a nested proxy probe as direct reachability. Stop the old transparent proxy or arrange a verified direct endpoint route before planning again.

Use `--proxy-name NAME` when the source contains multiple nodes. Use `--server-ip IP` only when the user or provider supplied a specific endpoint; the script otherwise tests all system-DNS and regional-DNS candidates.

## Install

Proceed when the user has explicitly asked to configure/install the proxy and the plan passes:

```bash
sudo bash scripts/linux-clash-skill.sh install \
  --config-url 'https://resource.example/proxy.yaml' \
  --expected-ip '203.0.113.10' \
  --align-timezone
```

Omit `--expected-ip` only when any exit produced by the supplied node is acceptable. In that case the installer still requires the post-install transparent exit to equal the preflight exit.

The default rollback window is 180 seconds. Change it only within the supported 60–900 second range:

```bash
sudo bash scripts/linux-clash-skill.sh install \
  --config-url 'https://resource.example/proxy.yaml' \
  --rollback-seconds 300
```

Installation writes only these managed locations:

- `/usr/local/bin/mihomo`
- `/usr/local/sbin/linux-clash-skill-rollback`
- `/etc/mihomo/config.yaml`
- `/etc/systemd/system/mihomo.service`
- one marked block in `/etc/hosts`
- state and backups under `/var/lib/linux-clash-skill`

Pass the dedicated `cloudflared` UID every time the host uses a management Tunnel:

```bash
sudo bash scripts/linux-clash-skill.sh install \
  --config-url 'https://resource.example/proxy.yaml' \
  --exclude-uid "$(id -u linux-clash-tunnel)"
```

## Verify

Verify the service, TUN interface, and exit consistency without relying on `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`:

```bash
sudo bash scripts/linux-clash-skill.sh verify --expected-ip '203.0.113.10'
```

Success requires generic HTTPS, Cloudflare HTTPS, Claude HTTPS, Cloudflare STUN, and Google STUN to return the same IPv4 address. The command creates `result.json` and `manifest.json` under `/var/lib/linux-clash-skill`, or under `$SOP_OUTPUT_DIR` when set.

## Roll back

Restore the exact files and service state captured before the latest install:

```bash
sudo bash scripts/linux-clash-skill.sh rollback
```

After rollback, confirm the previous network path and service state. Keep the backup until the machine is known healthy.

For an adopted legacy node that has no `current-backup`, use `disable` to stop Mihomo and return to direct routing while retaining its files. The next Controller `enable` creates a valid disabled-state backup; later disables use exact rollback.

## Install one isolated machine Dashboard (default)

Use `control_plane.sh`; never expose Mihomo's port `9090` or either Python service directly to a LAN/public interface.

```bash
sudo bash scripts/linux-clash-skill.sh plan \
  --config-url 'https://resource.example/proxy.yaml'

bash <(curl -fsSL https://skill.vyibc.com/install-auto-domain.sh) codex

sudo bash scripts/control_plane.sh install-machine \
  --config-url 'https://resource.example/proxy.yaml'
```

`install-machine` installs the local Controller and Dashboard, registers only the loopback Controller, and exposes only the Dashboard through anonymous `auto-domain`. On a fresh host it does not start Mihomo, enable the proxy, or change routing. The user explicitly authorizes the network change later by turning the Dashboard switch on; the Controller then repeats direct TCP/UDP preflight inside the timed rollback transaction.

For every Controller `enable` or `replace`, persist the exact server IP selected by the successful plan and pin the observed matching TCP/UDP exit when the user did not supply one. Reuse both values for install and later enables; never plan with one candidate and install with a newly selected candidate. Align the Linux IANA timezone to verified exit intelligence by default and restore the prior timezone on rollback. After every route-changing action, keep a healthy Dashboard tunnel untouched; otherwise restart it, require its public health check to recover, and escape a stale anonymous-name `409` with a recorded random suffix. The `auto-domain` agent must terminate a WebSocket that misses its application-level `pong`, and the public Dashboard systemd unit must renew its watchdog lease only after both local and public `/healthz` succeed. This prevents a live process with a dead tunnel from remaining falsely active. The replacement form starts both IP overrides empty so stale values from an old provider cannot leak into a new transaction; `expected_ip` and `server_ip` are advanced overrides only.

On a fresh machine, derive the requested hostname as `clash-<direct-IPv4-with-hyphens>` before Mihomo TUN is active; `168.110.217.45` becomes `clash-168-110-217-45`. Never derive it from the shared proxy exit IP. Fall back to `clash-<sanitized-hostname>-<machine-id-prefix>` when the direct IPv4 cannot be obtained safely, and preserve an existing recorded name during upgrades. Read the actual assigned URL from `/etc/linux-clash-skill/dashboard-public.url`. NAT peers or another machine may cause a collision, in which case the server adds a random suffix. Use `--public-name` for an explicit migration or valid override. Anonymous hostnames are best-effort, not contractual DNS; use a Named Tunnel when guaranteed hostname ownership is required.

The isolated Dashboard registry contains only its local machine. It does not require a Cloudflare API token, Worker, or D1. Status and diagnostics are public read-only; a Dashboard session plus CSRF is required for mutations and audit access, while the local node bearer token remains mandatory server-side. Use the `replace` action instead of editing `controller.json`: a live replacement disables the old TUN, preflights TCP/UDP directly, pins the successful selection, installs the new source, aligns timezone, verifies the public tunnel, and attempts to recover the old proxy if the new source fails. If the new proxy starts but its settings cannot be committed, roll it back to direct before reinstalling the old pinned source.

## Optional central multi-node control

Use `install-node` on every node and `install-dashboard` on exactly one stable central machine only when the user explicitly wants aggregation. Create remotely managed Cloudflare Named Tunnels separately. Give every node a unique hostname, configure its origin as `http://127.0.0.1:8788`, and configure the single Dashboard hostname origin as `http://127.0.0.1:8787`; supply Connector tokens only through root-owned files and `--tunnel-token-file`, then register nodes with `add-node`.

## Supported boundary

The current release supports systemd Linux distributions listed in the description, IPv4 proxy endpoints, and SOCKS5 nodes in Clash YAML. The control services are loopback-only. Anonymous `auto-domain` is suitable for isolated previews and daily access; use a persistent named tunnel when a contractual hostname or Cloudflare-owned access policy is required.
