# Safety and routing reference

## What “all traffic” means

The generated Mihomo configuration sends all public IPv4 traffic through the selected SOCKS5 node with a final `MATCH,PROXY` rule. It deliberately leaves these paths outside the TUN:

- loopback and RFC1918 private networks;
- carrier-grade NAT (`100.64.0.0/10`) and link-local networks;
- the pinned SOCKS5 server address, which prevents a proxy loop;
- Mihomo's own UID, which prevents its upstream connection from re-entering TUN;
- the current IPv4 SSH peer when the installer can discover it.

These exclusions are control-plane safety, not country-based split routing. There is no `GEOIP,CN,DIRECT` rule in the generated configuration.

An excluded process cannot use a Mihomo fake-IP directly. The generated DNS configuration therefore places the anonymous Dashboard Tunnel API in `fake-ip-filter`, so the dedicated excluded connector UID receives a real Cloudflare address. Without this exception the connector can work before TUN starts, then time out against `198.18.0.0/16` immediately after the proxy is enabled.

## Why the endpoint is pinned

A proxy hostname can resolve to several CDN addresses, and a TCP-open address may still reject SOCKS authentication or yield a different exit. Planning therefore performs a complete SOCKS5 negotiation, optional username/password authentication, TLS validation, Cloudflare trace request, UDP ASSOCIATE, and STUN request for each candidate. It accepts only a candidate whose TCP and UDP exits match. That candidate is written to a managed `/etc/hosts` block and excluded from TUN.

Before probing, the planner checks the effective route to each candidate. A candidate routed through an existing Linux TUN device is skipped because a nested request does not prove that the candidate will remain reachable after the old transparent proxy is replaced. If no directly routed candidate remains, planning fails with instructions to stop the existing TUN or provide a verified direct route.

`--expected-ip` constrains both TCP and UDP candidate selection and the final transparent verification. Without it, the matching preflight exit becomes the expected exit for that installation run. Rendering forces `udp: true` on the selected SOCKS5 node; a provider without working UDP relay fails before installation rather than leaking through DIRECT.

## Failure and rollback model

Before modifying Mihomo files, the installer records whether the previous files existed and whether `mihomo.service` was active/enabled. It then arms a transient systemd rollback timer. Any script error invokes rollback immediately; loss of the controlling process still leaves the timer available to restore the prior state.

The timer is cancelled only after:

1. Mihomo's configuration check passes as the unprivileged service user.
2. The systemd unit validates and starts.
3. The `Mihomo` TUN interface exists.
4. Generic, Cloudflare, and Claude HTTPS requests plus Cloudflare and Google STUN requests agree on one exit IPv4 address. A Chinese-site exit is also recorded and must agree when either of its two probe targets is available.
5. The exit satisfies `--expected-ip`, or matches the preflight result.

## Remote-machine precautions

Run the plan before a maintenance window and keep a second console when the hosting provider offers one. SSH peer exclusion protects the current client route, but unusual policy routing, IPv6-only administration, nested VPNs, containers, and provider firewalls still deserve an out-of-band recovery path.

If the host already runs a different TUN/VPN, inspect `ip rule`, `ip route show table all`, and the existing service before installing. Do not casually stack transparent proxies.

## Secrets

The downloaded source exists only in a root-only temporary directory and is deleted on exit. The installed Mihomo config necessarily contains the upstream credentials and is installed as `root:mihomo` mode `0640`. Result files contain node metadata and exit IP, never username or password.

An access token embedded in a configuration URL may still appear in shell history or process metadata when passed with `--config-url`. Prefer `--config-url-file` pointing to a root-owned `0600` file for tokenized URLs, and avoid pasting them into public logs. The node Controller always uses a protected temporary URL file for plan/install subprocesses.

## `external-controller`

`external-controller: 127.0.0.1:9090` provides a local Mihomo management API. It does not route applications into the proxy. TUN plus auto-routing is what transparently captures eligible traffic. The generated configuration forces the controller to loopback if the source asks to expose it elsewhere.
