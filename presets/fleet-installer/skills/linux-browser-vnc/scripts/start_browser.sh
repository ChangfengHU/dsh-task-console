#!/usr/bin/env bash
# Launch one visible browser instance inside the shared managed X display.
#
# Multiple instances share one Xvfb display, so a single VNC view shows every
# window. Each instance gets its own profile directory, its own loopback
# DevTools port and its own tiled window, so they can be driven independently.
#
# The browser is deliberately NOT given any --proxy-server flag: the machine's
# Mihomo TUN already routes this user's TCP and UDP, and adding a second proxy
# layer would produce a proxy-through-proxy path that the node probes cannot
# reason about.
set -Eeuo pipefail

: "${VNC_DISPLAY:?VNC_DISPLAY is required}"
: "${BROWSER_BIN:?BROWSER_BIN is required}"

# Instance number comes from the systemd template (%i) as the first argument.
INSTANCE="${1:-${INSTANCE:-1}}"
[[ "$INSTANCE" =~ ^[0-9]+$ ]] && (( INSTANCE >= 1 && INSTANCE <= 32 )) || {
  printf '[linux-browser-vnc] Invalid instance number: %s\n' "$INSTANCE" >&2
  exit 2
}

VNC_GEOMETRY="${VNC_GEOMETRY:-1440x900x24}"
VNC_INSTANCES="${VNC_INSTANCES:-1}"
BROWSER_START_URL="${BROWSER_START_URL:-https://www.google.com/}"
BROWSER_LANG="${BROWSER_LANG:-en-US}"
BROWSER_ACCEPT_LANGUAGES="${BROWSER_ACCEPT_LANGUAGES:-$BROWSER_LANG}"
BROWSER_SANDBOX="${BROWSER_SANDBOX:-1}"
BROWSER_PROFILE_BASE="${BROWSER_PROFILE_BASE:-${BROWSER_PROFILE_DIR:-/var/lib/linux-browser-vnc/profile}}"
BROWSER_DEBUG_PORT_BASE="${BROWSER_DEBUG_PORT_BASE:-${BROWSER_DEBUG_PORT:-9222}}"

[[ "$VNC_INSTANCES" =~ ^[0-9]+$ ]] && (( VNC_INSTANCES >= 1 )) || VNC_INSTANCES=1

profile_dir="${BROWSER_PROFILE_BASE}-${INSTANCE}"
debug_port=$(( BROWSER_DEBUG_PORT_BASE + INSTANCE - 1 ))
(( debug_port >= 1024 && debug_port <= 65535 )) || {
  printf '[linux-browser-vnc] Computed debug port out of range: %s\n' "$debug_port" >&2
  exit 2
}

resolution="${VNC_GEOMETRY%x*}"
screen_w="${resolution%x*}"
screen_h="${resolution#*x}"
[[ "$screen_w" =~ ^[0-9]+$ && "$screen_h" =~ ^[0-9]+$ ]] || {
  printf '[linux-browser-vnc] Invalid geometry: %s\n' "$VNC_GEOMETRY" >&2
  exit 2
}

# Tile windows left-to-right across the display so every instance is visible in
# one VNC view. A single instance fills the screen.
if (( VNC_INSTANCES <= 1 )); then
  win_w="$screen_w"; win_h="$screen_h"; win_x=0; win_y=0
else
  win_w=$(( screen_w / VNC_INSTANCES ))
  win_h="$screen_h"
  win_x=$(( win_w * (INSTANCE - 1) ))
  win_y=0
fi

[[ "$BROWSER_START_URL" =~ ^https://[A-Za-z0-9./?=_%:-]+$ ]] || {
  printf '[linux-browser-vnc] The start URL must be a plain HTTPS URL.\n' >&2
  exit 2
}

export DISPLAY="$VNC_DISPLAY"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

mkdir -p "$profile_dir"
# A profile copied from another machine carries that machine's singleton locks,
# which make Chrome refuse to start with "profile appears to be in use by another
# computer". These files hold no login data; clearing them on launch is safe.
rm -f "$profile_dir"/Singleton* 2>/dev/null || true

# Chrome's session restore reopens whatever tabs were open at the last exit. If a
# driver ever leaves stray tabs, or is killed mid-run, those tabs pile up across
# restarts and eventually make the DevTools/CDP attach time out (Playwright's
# connectOverCDP attaches every target). Generated tabs hold no login data —
# logins live in Cookies/Login Data — so clearing the tab-restore state on every
# launch keeps each instance lean without logging anyone out.
default_dir="$profile_dir/Default"
rm -rf "$default_dir/Sessions" "$default_dir/Current Session" "$default_dir/Current Tabs" \
       "$default_dir/Last Session" "$default_dir/Last Tabs" 2>/dev/null || true

printf '[linux-browser-vnc] instance %s: port %s, window %sx%s+%s+%s, profile %s\n' \
  "$INSTANCE" "$debug_port" "$win_w" "$win_h" "$win_x" "$win_y" "$profile_dir" >&2

args=(
  --user-data-dir="$profile_dir"
  --window-position="${win_x},${win_y}"
  --window-size="${win_w},${win_h}"
  --lang="$BROWSER_LANG"
  # `--lang` controls Chrome's UI locale but some builds retain an older
  # profile Accept-Language. Pin the HTTP/navigator preference separately so a
  # Chinese site does not render its international login UI after migration.
  --accept-lang="$BROWSER_ACCEPT_LANGUAGES"
  --no-first-run
  --no-default-browser-check
  --hide-crash-restore-bubble
  --disable-background-networking
  --disable-breakpad
  --disable-component-update
  --disable-features=Translate,MediaRouter
  --password-store=basic
  --use-mock-keychain
  # The DevTools endpoint is how `verify` measures the browser's real exit IP,
  # WebRTC address, timezone and language. It is pinned to loopback; never
  # publish it through the tunnel.
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="$debug_port"
  # Renderers must die with the cgroup. This is the direct countermeasure to a
  # leaked-process pile-up like the 144 headless Chrome processes seen on 95.
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
)

if [[ "$BROWSER_SANDBOX" != "1" ]]; then
  printf '[linux-browser-vnc] Starting the browser without its sandbox by explicit configuration.\n' >&2
  args+=(--no-sandbox)
fi

exec "$BROWSER_BIN" "${args[@]}" "$BROWSER_START_URL"
