#!/usr/bin/env bash
# Renew the systemd watchdog lease only while the desktop is reachable both
# locally and through its public hostname.
#
# Unlike the Clash dashboard watchdog, the public probe must treat a Cloudflare
# Access challenge as a healthy edge: once the hostname is protected, an
# unauthenticated probe is *supposed* to be redirected to the Access login
# domain. A 200 and a redirect to `*.cloudflareaccess.com` both prove the route
# reaches Cloudflare; anything else (connection failure, 502, 530, 1033) does
# not.
set -Eeuo pipefail

: "${NOVNC_PORT:?NOVNC_PORT is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"

CHECK_INTERVAL_SECONDS="${VNC_WATCHDOG_INTERVAL_SECONDS:-15}"
MAX_TEST_CYCLES="${VNC_WATCHDOG_MAX_TEST_CYCLES:-0}"
CURL_BIN="${CURL_BIN:-curl}"
NOTIFY_BIN="${SYSTEMD_NOTIFY_BIN:-systemd-notify}"

[[ "$NOVNC_PORT" =~ ^[0-9]+$ ]] && (( NOVNC_PORT >= 1 && NOVNC_PORT <= 65535 )) || {
  printf '[linux-browser-vnc-watchdog] Invalid noVNC port.\n' >&2
  exit 2
}
# Accept the desktop's known public zones. The connector may live under
# chxyka.ccwu.cc (core account) or vyibc.com (forwarding account).
[[ "$PUBLIC_URL" =~ ^https://[a-z0-9-]+\.(chxyka\.ccwu\.cc|vyibc\.com)/?$ ]] || {
  printf '[linux-browser-vnc-watchdog] Refusing an unexpected public URL.\n' >&2
  exit 2
}
[[ "$CHECK_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || exit 2
[[ "$MAX_TEST_CYCLES" =~ ^[0-9]+$ ]] || exit 2

local_health="http://127.0.0.1:${NOVNC_PORT}/vnc.html"
public_health="${PUBLIC_URL%/}/healthz"
failures=0
cycles=0

notify() {
  "$NOTIFY_BIN" "$@" >/dev/null
}

check_local() {
  "$CURL_BIN" --noproxy '*' -fsS --connect-timeout 3 --max-time 10 "$local_health" >/dev/null
}

# Prints "<http_code> <redirect_host>" so an Access challenge stays distinguishable
# from an origin failure.
check_public() {
  local observed
  observed="$("$CURL_BIN" --noproxy '*' -sS -o /dev/null \
    --connect-timeout 5 --max-time 15 \
    -w '%{http_code} %{redirect_url}' "$public_health" 2>/dev/null)" || return 1
  local code="${observed%% *}"
  local redirect="${observed#* }"
  case "$code" in
    200) return 0 ;;
    301|302|303|307|308)
      [[ "$redirect" == https://*.cloudflareaccess.com/* ]] && return 0
      return 1
      ;;
    *) return 1 ;;
  esac
}

# WatchdogSec starts only after READY=1. The first lease gives the newly
# assigned public route time to propagate before end-to-end checks begin.
notify READY=1 WATCHDOG=1 "STATUS=Desktop tunnel assigned; waiting for the first health check"

while :; do
  sleep "$CHECK_INTERVAL_SECONDS"
  cycles=$((cycles + 1))

  local_ok=0
  public_ok=0
  check_local && local_ok=1
  check_public && public_ok=1

  if (( local_ok == 1 && public_ok == 1 )); then
    failures=0
    notify WATCHDOG=1 "STATUS=Desktop tunnel healthy: local noVNC and public route passed"
  else
    failures=$((failures + 1))
    # Deliberately omit WATCHDOG=1. A later successful cycle renews the lease;
    # otherwise systemd restarts the whole tunnel cgroup after WatchdogSec.
    notify "STATUS=Desktop tunnel failure ${failures}: local=${local_ok} public=${public_ok}"
  fi

  if (( MAX_TEST_CYCLES > 0 && cycles >= MAX_TEST_CYCLES )); then
    exit 0
  fi
done
