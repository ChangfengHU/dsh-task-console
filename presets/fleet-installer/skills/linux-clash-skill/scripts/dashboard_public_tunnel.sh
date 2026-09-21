#!/usr/bin/env bash
set -Eeuo pipefail

: "${DASHBOARD_PORT:?DASHBOARD_PORT is required}"
: "${PUBLIC_NAME:?PUBLIC_NAME is required}"

STATE_ROOT="/var/lib/linux-clash-tunnel"
URL_FILE="${STATE_ROOT}/dashboard-public.url"
NAME_FILE="${STATE_ROOT}/dashboard-public.name"
RUNNER="/usr/local/lib/linux-clash-auto-domain/scripts/run.sh"
WATCHDOG_RUNNER="/usr/local/lib/linux-clash-skill/scripts/dashboard_public_watchdog.sh"

# Always start from the stable configured name so a machine reclaims its own
# hostname after any restart. Preferring the recorded name instead made a single
# 409 permanent: node 45 restarted once, took `clash-168-110-217-45-0d2d`, and
# kept it, which orphaned its fleet registration and turned the card into a 502.
#
# The previously assigned name is still tried before minting a new random one, so
# a machine that genuinely collides (for example two hosts behind one NAT) reuses
# its existing suffix instead of churning through new hostnames on every restart.
previous_name="$(sed -n '1p' "$NAME_FILE" 2>/dev/null || true)"
[[ "$previous_name" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || previous_name=""
effective_name="$PUBLIC_NAME"

run_candidate() {
  local candidate="$1" temporary temp_root fifo agent_pid watchdog_pid="" assigned_url="" line exit_status=0 conflict=0
  temp_root="$(mktemp -d)"
  fifo="${temp_root}/agent.log"
  mkfifo "$fifo"
  "$RUNNER" --port="$DASHBOARD_PORT" --name="$candidate" >"$fifo" 2>&1 &
  agent_pid=$!
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ "$line" =~ Public[[:space:]]URL[[:space:]]*:[[:space:]]*(https://[a-z0-9-]+\.[a-z0-9.-]+/?) ]]; then
      assigned_url="${BASH_REMATCH[1]}"
      temporary="${URL_FILE}.tmp"
      printf '%s\n' "$assigned_url" > "$temporary"
      chmod 0644 "$temporary"
      mv -f "$temporary" "$URL_FILE"
      temporary="${NAME_FILE}.tmp"
      printf '%s\n' "$candidate" > "$temporary"
      chmod 0644 "$temporary"
      mv -f "$temporary" "$NAME_FILE"
      if [[ -z "$watchdog_pid" ]] || ! kill -0 "$watchdog_pid" 2>/dev/null; then
        PUBLIC_URL="$assigned_url" DASHBOARD_PORT="$DASHBOARD_PORT" \
          "$WATCHDOG_RUNNER" >/dev/null 2>&1 &
        watchdog_pid=$!
      fi
    fi
    if [[ "$line" == *"Unexpected server response: 409"* ]]; then
      conflict=1
      kill "$agent_pid" 2>/dev/null || true
      break
    fi
  done < "$fifo"
  wait "$agent_pid" || exit_status=$?
  if [[ -n "$watchdog_pid" ]]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
  rm -f "$fifo"
  rmdir "$temp_root"
  [[ "$conflict" == "0" ]] || return 75
  return "$exit_status"
}

for attempt in {1..10}; do
  if run_candidate "$effective_name"; then
    exit 0
  else
    status=$?
  fi
  [[ "$status" == "75" ]] || exit "$status"
  if [[ -n "$previous_name" && "$previous_name" != "$effective_name" ]]; then
    effective_name="$previous_name"
    previous_name=""
    printf '[linux-clash-control] Stable name is reserved; retrying with the previously assigned %s.\n' "$effective_name"
  else
    suffix="$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
    effective_name="${PUBLIC_NAME:0:48}-${suffix}"
    printf '[linux-clash-control] Public name is still reserved; retrying as %s.\n' "$effective_name"
  fi
  sleep 1
done

printf '[linux-clash-control] Unable to obtain a public Dashboard hostname after conflict retries.\n' >&2
exit 1
