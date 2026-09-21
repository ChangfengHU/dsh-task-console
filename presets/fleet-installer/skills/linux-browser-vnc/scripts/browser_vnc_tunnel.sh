#!/usr/bin/env bash
# Run the Cloudflare named tunnel for one desktop and hold a systemd watchdog
# lease only while the desktop is reachable end to end.
#
# A named tunnel is used instead of the auto-domain agent because noVNC requires
# a WebSocket upgrade. The auto-domain agent deletes the `upgrade` and
# `connection` headers and answers with a single buffered response, so it can
# serve the Clash dashboard but can never serve a remote desktop.
#
# The connector deliberately runs as `linux-clash-tunnel`, whose UID is already
# in Mihomo `tun.exclude-uid`. That keeps the control path direct without
# editing a live proxy configuration.
set -Eeuo pipefail

: "${NOVNC_PORT:?NOVNC_PORT is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"
: "${TUNNEL_TOKEN_FILE:?TUNNEL_TOKEN_FILE is required}"

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
WATCHDOG_RUNNER="${VNC_WATCHDOG_RUNNER:-/usr/local/lib/linux-browser-vnc/scripts/browser_vnc_watchdog.sh}"

[[ -x "$CLOUDFLARED_BIN" ]] || {
  printf '[linux-browser-vnc] cloudflared is missing: %s\n' "$CLOUDFLARED_BIN" >&2
  exit 2
}
[[ -r "$TUNNEL_TOKEN_FILE" ]] || {
  printf '[linux-browser-vnc] The connector token file is unreadable.\n' >&2
  exit 2
}
[[ "$PUBLIC_URL" =~ ^https://[a-z0-9-]+\.[a-z0-9.-]+/?$ ]] || {
  printf '[linux-browser-vnc] Refusing an unexpected public URL.\n' >&2
  exit 2
}

tunnel_pid=""
watchdog_pid=""

cleanup() {
  [[ -n "$watchdog_pid" ]] && kill "$watchdog_pid" 2>/dev/null || true
  [[ -n "$tunnel_pid" ]] && kill "$tunnel_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --metrics on a random loopback port keeps cloudflared's diagnostics local.
"$CLOUDFLARED_BIN" tunnel --no-autoupdate --metrics 127.0.0.1:0 \
  run --token-file "$TUNNEL_TOKEN_FILE" &
tunnel_pid=$!

PUBLIC_URL="$PUBLIC_URL" NOVNC_PORT="$NOVNC_PORT" "$WATCHDOG_RUNNER" &
watchdog_pid=$!

# If either side dies the unit must restart as a whole: a connector whose
# process is alive but whose connection is dead is exactly the failure the
# watchdog exists to catch.
wait -n "$tunnel_pid" "$watchdog_pid"
status=$?
printf '[linux-browser-vnc] Tunnel supervisor exiting with status %s.\n' "$status" >&2
exit "$status"
