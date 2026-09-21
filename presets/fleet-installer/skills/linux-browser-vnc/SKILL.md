---
name: linux-browser-vnc
description: Install and operate one visible Chrome/Chromium desktop per Linux machine, reachable from the public internet through a Cloudflare named tunnel, while the browser's own traffic keeps using the machine's existing Mihomo/Clash TUN exit. Use when a fleet of Linux machines needs a remote browser next to its proxy dashboard, when a browser session must prove its real exit IP, WebRTC address, timezone and language from inside the browser, or when an existing unauthenticated VNC stack must be replaced with a loopback-bound, resource-bounded one.
---

# Linux Browser VNC Desktop

This skill is a sibling of `linux-clash-skill`, not an extension of it. It owns
the desktop account, the X session, the visible browser, the RFB server, the
noVNC bridge, its own health endpoint and its own public hostname. It never
edits a Mihomo configuration and never touches a `linux-clash-*` unit, so it can
be removed without changing proxy behaviour.

## Safety rules

- Run `inspect` before `install` on any machine that might already run a browser
  or VNC stack. Machines `168.110.217.45` and `152.32.214.95` do. Installing a
  second parallel stack is a defect, not a fallback.
- Every local service binds `127.0.0.1`. The RFB port, the noVNC bridge, the
  health endpoint and the browser DevTools port are never exposed directly.
- Public reach comes only from the tunnel unit. The desktop hostname is
  **unauthenticated by owner decision (2026-08-03)**: anyone who learns the URL
  gets full control of that desktop and browses as the machine's proxy exit.
  Certificate Transparency publishes every new hostname, so obscurity is not a
  control. If that decision is ever revisited, the two supported gates are a
  Cloudflare Access application on the hostname and an x11vnc `-rfbauth`
  password; `verify` already treats an Access challenge as a healthy edge.
- Never put a token, password or session cookie in a public URL, in the noVNC
  query string, or in fleet JSON.
- The tunnel connector runs as `linux-clash-tunnel` because that UID is already
  in Mihomo `tun.exclude-uid`. Do not run it as root and do not add a new
  exclusion for it; that would mean editing a live proxy configuration.
- The desktop user must **not** be excluded from TUN. Its traffic is supposed to
  use the machine's proxy exit.
- A unit reporting `active` is not evidence. Use `verify`, which measures the
  loopback health document, the public route, the process budget, the TUN
  separation, and the browser's real exit from inside the browser.

## Inspect first

`inspect` is read-only and safe on any machine:

```bash
sudo bash scripts/linux-browser-vnc.sh inspect
```

It reports existing browser executables, every existing VNC/desktop unit, all
non-loopback listeners, whether the requested display and ports are already
taken, and the browser process count per user. Read it before deciding whether
to adopt, replace, or install alongside an existing stack.

## Install

```bash
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh install
```

The installer is idempotent and:

1. refuses to start if the requested display or any requested port is already
   held by something that is not this skill;
2. installs Xvfb, Openbox, x11vnc, noVNC/websockify, and Google Chrome stable on
   amd64. Google publishes no Linux arm64 Chrome and Ubuntu ships `chromium`
   only as a snap, which cannot start for a system account, so on arm64 the
   installer stages an existing Chromium build (typically root's Playwright
   cache, unreadable to the desktop user) into
   `/usr/local/lib/linux-browser-vnc/browser` and installs a narrow AppArmor
   profile granting `userns` to that one binary. Without the profile the browser
   aborts with "No usable sandbox!" on Ubuntu 23.10+; with it, the sandbox is
   preserved rather than disabled;
   on enforcing RHEL-family SELinux, it also applies a narrow systemd
   compatibility path: x11vnc is copied into the Skill-owned tree to avoid its
   `xserver_t` transition while retaining `NoNewPrivileges=true`; the tunnel
   watchdog's required `systemd_notify_t` transition receives a narrow NNP
   exception. Both services remain non-root, capability-free and
   filesystem-restricted;
3. creates the non-root `linux-browser-vnc` account with a persistent profile
   under `/var/lib/linux-browser-vnc/profile`;
4. derives the requested public hostname from the machine's existing Clash
   hostname, so `clash-161-35-60-232` yields `vnc-161-35-60-232`;
5. installs seven bounded systemd units and waits for a healthy local desktop
   and an assigned public URL.

Useful options:

| Option | Purpose |
| --- | --- |
| `--display :100` | avoid an existing `:99`/`:98` session |
| `--rfb-port` / `--novnc-port` / `--health-port` / `--debug-port` | avoid existing `5900`/`1006` style ports |
| `--public-name vnc-A-B-C-D` | override the derived hostname |
| `--browser-bin PATH` | use a specific browser build |
| `--browser-memory-max 2G` | cgroup ceiling for the whole browser tree |
| `--max-browser-processes 60` | health fails above this many browser processes |
| `--allow-no-sandbox` | last resort when the sandbox cannot start |
| `--no-public` | install local services without requesting a hostname |

Provision the Cloudflare side first, from the operator's machine, so no account
credential ever reaches a node:

```bash
export CLOUDFLARE_EMAIL='...' CLOUDFLARE_API_KEY='...' CLOUDFLARE_ACCOUNT_ID='...'
python3 skills/linux-browser-vnc/scripts/provision_cloudflare_tunnel.py check \
  --zone vyibc.com --name vnc-161-35-60-232
python3 skills/linux-browser-vnc/scripts/provision_cloudflare_tunnel.py create \
  --zone vyibc.com --name vnc-161-35-60-232 --token-file /root/.vnc-tunnel.token
```

`check` is read-only and must succeed before `create`; a zone from another Cloudflare account is a
hard stop. The installer accepts only a cloudflared binary whose official release SHA-256 digest
matches, with a proxy-aware retry for restricted networks. It also renders compatible units on
systemd versions older than 244 without weakening the remaining sandbox directives.

That creates the named tunnel, its ingress to the loopback bridge, a proxied
CNAME, and a Worker route bound to no script. The last step matters: the zone
carries a `*.chxyka.ccwu.cc` Worker route for the auto-domain service, and
without a more specific empty route that Worker answers first and the WebSocket
upgrade never reaches the tunnel.

The hostname is deterministic, so the recorded URL is the requested one:

```bash
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh print-url
```

## Verify

```bash
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh verify \
  --expected-ip '155.103.255.246'
```

`verify` checks the following and fails on any of them:

1. the loopback health document reports `ok: true`;
2. the RFB, noVNC, health and DevTools ports are loopback-only;
3. the public route answers — either `200`, or a redirect to
   `*.cloudflareaccess.com` if an access gate is ever added;
3b. a real noVNC WebSocket upgrade completes through the public hostname and the
   RFB greeting arrives. A `200` on `/healthz` does not imply this: the previous
   auto-domain transport answered 200 while dropping every upgrade;
4. the desktop browser process count is inside its budget;
5. the tunnel account is excluded from TUN while the desktop account is not;
6. the browser itself reports its Cloudflare exit IP, its Claude-facing exit IP,
   its WebRTC reflexive address, its timezone and its language.

Step 6 is the one a node-side probe cannot perform. A machine can have perfect
HTTP egress while the browser still leaks a different UDP address through
WebRTC, so record every component rather than a single score.

The managed browser unit permits `AF_INET` but not `AF_INET6`. The Fleet Mihomo
profile intentionally proxies IPv4; allowing the browser to create IPv6 sockets
would give both HTTPS and WebRTC a direct host route around that TUN. Keep host
IPv6 available for services that need it, including cloudflared, and enforce the
boundary on the browser cgroup instead.

For an older managed installation, or whenever an in-browser probe reports an
IPv6 address, apply and verify that boundary idempotently:

```bash
sudo bash scripts/linux-browser-vnc.sh harden-egress --expected-ip EXPECTED_IPV4
```

This command preserves profiles, instance count, ports, tunnel and Mihomo. It
updates only the recognized managed browser unit, restarts the managed browser
instances and health service, and requires every CDP probe (HTTPS and WebRTC) to
match the expected IPv4 before it succeeds.

## Health contract

The health service answers `http://127.0.0.1:<health-port>/healthz` and mirrors
the same document to two places:

- `/var/lib/linux-browser-vnc/status.json`, read by the Clash node Controller so
  the fleet can show desktop state without probing the desktop hostname at all;
- `<web-root>/healthz`, served by the noVNC bridge so the public route can be
  probed end to end.

```json
{
  "ok": true,
  "checks": {"display": true, "browser": true, "rfb": true, "novnc": true, "process_budget": true},
  "browser_processes": 13,
  "browser_headless_processes": 0,
  "browser_memory_bytes": 204574720,
  "browser_rss_sum_bytes": 1054134272,
  "public_url": "https://vnc-161-35-60-232.chxyka.ccwu.cc",
  "checked_at": "2026-08-03T18:00:00Z"
}
```

`checked_at` must keep moving. A document whose timestamp is frozen means the
health loop died even if the file still says `ok: true`.

`browser` is not a process count. A browser that fails to start leaves its
crash-looping wrapper inside the unit's cgroup, and counting that reported a
healthy desktop while nothing was running. The check therefore also requires the
loopback DevTools endpoint to answer, which only happens when the browser is
genuinely up.

`browser_processes` is counted from the browser unit's cgroup, which is what
`TasksMax` enforces and what a leak would inflate. Do not count by matching
`argv[0]`: Chrome rewrites its own argv, so a live renderer reports
`...profile --change-stack-guard-on-fork=enable` instead of its executable path
and a naive match sees a fraction of the real processes.

`browser_memory_bytes` is the cgroup's charged memory. `browser_rss_sum_bytes`
is the sum of per-process RSS and runs roughly five times higher because Chrome's
shared pages are counted once per process; prefer the cgroup figure.

## Status and repair

```bash
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh status
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh repair
```

`status` prints each unit's state and restart count plus the live health
document. `repair` restarts the stack in dependency order and fails if the
desktop does not become healthy again.

## Resource behaviour

Every unit declares `MemoryHigh`, `MemoryMax`, `TasksMax`, `Restart` and
`RestartSec`. The browser unit additionally uses `KillMode=control-group` and a
start-limit burst, so a crash loop cannot accumulate orphaned renderers. This is
the direct countermeasure to the 144 leaked headless Chrome processes previously
observed on `152.32.214.95`; the health endpoint fails closed above the
configured process budget instead of hiding the problem.

## Uninstall and rollback

```bash
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh uninstall
sudo bash skills/linux-browser-vnc/scripts/linux-browser-vnc.sh uninstall --purge-profile
```

Read [references/rollback.md](references/rollback.md) before removing anything
from a machine that had its own browser/VNC services before this skill arrived.
