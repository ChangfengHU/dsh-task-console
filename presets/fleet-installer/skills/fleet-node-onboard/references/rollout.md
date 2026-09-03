# Rollout gates

## Naming

- Node id: `host-<full dashed IPv4>`, for example `host-129-146-125-187`. Never use one octet.
- Display name: full direct IPv4.
- Public names: `clash-<dashed-ip>`, `vnc-<dashed-ip>`, `imggen-<dashed-ip>`.

## Order and rollback

1. Run the password/key bootstrap SSH preflight read-only. It must pass before creating an account.
2. Create the standard account, install the Fleet key and validated sudoers entry, then prove the new
   login from outside and read its record back from the vault.
3. Capture OS, architecture, resources, routes, listeners, services, TUN state, and public direct IP.
4. Plan and install Mihomo with the existing skill's timed rollback. Prove TCP/UDP exit equality.
5. Install the controller/Dashboard, then two browser instances and VNC. Keep secrets only in 0600 files.
   Before this stage passes, restrict the managed browser cgroup to IPv4 sockets and prove every
   instance's HTTPS and WebRTC measurements match the planned proxy IPv4.
6. Install the named tunnel under the TUN-excluded service UID and confirm SSH remains direct.
7. Validate local endpoints, then named public endpoints, then register and read the node back from Fleet.
8. Only for an explicitly requested image worker, install the capability service, enforce finite
   per-instance cgroups and active recycle, publish `imggen-*`, and run a pinned real generation.

Back up pre-existing service directories and units before replacement. Never overwrite an
untracked runtime tree merely because `git pull` is blocked; compare or deploy only reviewed
files and retain a dated rollback copy.

## Required evidence

- Base node: `mihomo`, controller/Dashboard, browser, VNC, and Cloudflare connector services active.
- Transparent HTTPS plus two STUN checks share the planned exit.
- Every managed browser is unable to create an IPv6 socket and its CDP HTTPS/WebRTC checks match
  the planned IPv4 before public DNS work begins.
- Clash and VNC hostnames answer publicly; Fleet lists the node as reachable with zero image slots.
- Image-worker extension only: `/capabilities` reports host disk, five latency targets, expected
  browsers and truthful identities; `imggen-*` answers publicly and a pinned image task returns a
  reachable URL. `verify-golden-node.sh` proves the declared browser count, all ChatGPT/Gemini Worker pairs,
  loopback listeners, cgroup bounds, active recycle, telemetry, and canonical public endpoints.

## First production use: node 84

`84.8.217.45` proved the gates matter: the initial `claude` account had no sudo rights, a
temporary non-TUN Mihomo occupied 9090, the preferred proxy source failed full SOCKS5 checks,
and the alternate source passed with equal TCP/UDP exits. The rollout preserved the temporary
config, pinned the successful endpoint, installed ARM64 Playwright Chromium, used one named
tunnel for VNC/Dashboard/imggen, and registered only after all public endpoints responded.

The copied Google profile still rendered Gemini's visible `Sign in` action on the new device.
Cookie presence therefore remained insufficient: when a Gemini tab is open, identity detection
must let the visible signed-out page override imported `*PSIDTS` cookies. Keep the node registered
but with zero dispatch slots until the operator completes the real login through VNC.

An absent Gemini tab is also not evidence of login. Fail closed when no Gemini page is open;
otherwise a copied YouTube-domain `*PSIDTS` cookie can turn a browser containing only Google and
diagnostic tabs into a false dispatch slot.

## Low-memory CentOS single-browser use

Node `107.150.119.232` has 3.6 GiB RAM, 4 GiB swap, and CentOS 8 with enforcing SELinux. The owner
explicitly accepted one browser. It uses only CDP `9222`, a 1.4 GiB hard browser ceiling, and no
fabricated second Fleet slot.

CentOS 8 exposed two portability gaps now covered by the skills: enforcing SELinux requires a
Skill-owned x11vnc copy plus a narrow tunnel-watchdog NNP exception, and cgroup v1 requires
controller-specific process/memory paths. The system Node was 18 while `/usr/local/bin/node` was
24, so the capability service unit pins the compatible absolute path. Its three public hostnames
share one remotely managed named tunnel.

The rollout also exposed five repeatability requirements now encoded in the scripts: password SSH
preflight uses `SSHPASS`/`sshpass -e` without argv disclosure; production control-plane installs
skip anonymous auto-domain publication; Cloudflare zone/account ownership is checked read-only
before mutation; cloudflared downloads retry safely and require the official SHA-256 digest; and
systemd releases older than 244 omit only the two unsupported sandbox directives when rendering
units.
