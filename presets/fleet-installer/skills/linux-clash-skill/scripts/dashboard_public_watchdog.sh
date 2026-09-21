#!/usr/bin/env bash
set -Eeuo pipefail

: "${DASHBOARD_PORT:?DASHBOARD_PORT is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"

CHECK_INTERVAL_SECONDS="${AUTO_DOMAIN_WATCHDOG_INTERVAL_SECONDS:-15}"
MAX_TEST_CYCLES="${AUTO_DOMAIN_WATCHDOG_MAX_TEST_CYCLES:-0}"
CURL_BIN="${CURL_BIN:-curl}"
NOTIFY_BIN="${SYSTEMD_NOTIFY_BIN:-systemd-notify}"

[[ "$DASHBOARD_PORT" =~ ^[0-9]+$ ]] && (( DASHBOARD_PORT >= 1 && DASHBOARD_PORT <= 65535 )) || {
  printf '[linux-clash-watchdog] Invalid dashboard port.\n' >&2
  exit 2
}
[[ "$PUBLIC_URL" =~ ^https://[a-z0-9-]+\.chxyka\.ccwu\.cc/?$ ]] || {
  printf '[linux-clash-watchdog] Refusing an unexpected public URL.\n' >&2
  exit 2
}
[[ "$CHECK_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || exit 2
[[ "$MAX_TEST_CYCLES" =~ ^[0-9]+$ ]] || exit 2

local_health="http://127.0.0.1:${DASHBOARD_PORT}/healthz"
public_health="${PUBLIC_URL%/}/healthz"
failures=0
cycles=0

notify() {
  "$NOTIFY_BIN" "$@" >/dev/null
}

check_url() {
  "$CURL_BIN" --noproxy '*' -fsS --connect-timeout 3 --max-time 10 "$1" >/dev/null
}

# WatchdogSec starts only after READY=1. The first lease gives the newly
# assigned public route time to propagate before end-to-end checks begin.
notify READY=1 WATCHDOG=1 "STATUS=Tunnel assigned; waiting for the first health check"

while :; do
  sleep "$CHECK_INTERVAL_SECONDS"
  cycles=$((cycles + 1))

  local_ok=0
  public_ok=0
  check_url "$local_health" && local_ok=1
  check_url "$public_health" && public_ok=1

  if (( local_ok == 1 && public_ok == 1 )); then
    failures=0
    notify WATCHDOG=1 "STATUS=Tunnel healthy: local and public /healthz passed"
  else
    failures=$((failures + 1))
    # Deliberately omit WATCHDOG=1. A later successful cycle renews the lease;
    # otherwise systemd restarts the whole tunnel cgroup after WatchdogSec.
    notify "STATUS=Tunnel health failure ${failures}: local=${local_ok} public=${public_ok}"
  fi

  if (( MAX_TEST_CYCLES > 0 && cycles >= MAX_TEST_CYCLES )); then
    exit 0
  fi
done
