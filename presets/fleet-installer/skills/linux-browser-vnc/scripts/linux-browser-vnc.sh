#!/usr/bin/env bash
# Install, inspect, verify, repair, or remove one visible browser desktop that
# is reachable through a Cloudflare-fronted tunnel and routed by the machine's
# existing Mihomo TUN policy.
#
# This skill is deliberately separate from linux-clash-skill. It never edits a
# Mihomo configuration, never touches the linux-clash-* units, and can be
# removed without changing proxy behaviour.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ASSET_DIR="${SKILL_DIR}/assets"

INSTALL_ROOT="/usr/local/lib/linux-browser-vnc"
CONFIG_ROOT="/etc/linux-browser-vnc"
STATE_ROOT="/var/lib/linux-browser-vnc"
DESKTOP_USER="linux-browser-vnc"
TUNNEL_USER="linux-clash-tunnel"
CLASH_URL_FILE="/etc/linux-clash-skill/dashboard-public.url"

# Non-instanced units, in dependency order. The browser is a per-instance
# template (linux-browser-vnc-browser@N.service) handled separately.
CORE_UNITS=(
  linux-browser-vnc-xvfb.service
  linux-browser-vnc-openbox.service
  linux-browser-vnc-x11vnc.service
  linux-browser-vnc-novnc.service
  linux-browser-vnc-health.service
  linux-browser-vnc-tunnel.service
)
BROWSER_TEMPLATE="linux-browser-vnc-browser@.service"
PUBLIC_UNIT="linux-browser-vnc-tunnel.service"
# The DevTools watchdog (a oneshot driven by a timer) recovers a browser whose
# process is gone or hung. Installed and removed alongside the core units, but
# it is the .timer that gets enabled, so it is kept out of CORE_UNITS.
WATCHDOG_UNITS=(
  linux-browser-vnc-cdpguard.service
  linux-browser-vnc-cdpguard.timer
)

VNC_DISPLAY=":100"
VNC_GEOMETRY="1440x900x24"
RFB_PORT="5910"
NOVNC_PORT="6080"
HEALTH_PORT="6081"
DEBUG_PORT="9222"
INSTANCES="1"
SEED_PROFILE=""
PUBLIC_NAME=""
PUBLIC_ZONE="chxyka.ccwu.cc"
PUBLIC_URL=""
TUNNEL_TOKEN_FILE=""
EXPECTED_IP=""
BROWSER_BIN=""
BROWSER_START_URL="https://www.google.com/"
BROWSER_LANG="en-US"
# Empty means "derive from this machine's RAM" (see resolve_browser_memory).
BROWSER_MEMORY_HIGH=""
BROWSER_MEMORY_MAX=""
BROWSER_TASKS_MAX="512"
MAX_BROWSER_PROCESSES="60"
BROWSER_SANDBOX="1"
INSTALL_PACKAGES=true
ENABLE_PUBLIC=true

log() { printf '[linux-browser-vnc] %s\n' "$*"; }
die() { printf '[linux-browser-vnc] ERROR: %s\n' "$*" >&2; exit 1; }

# The instance units for the currently configured instance count.
browser_units() {
  local i
  for (( i = 1; i <= INSTANCES; i++ )); do
    printf 'linux-browser-vnc-browser@%s.service\n' "$i"
  done
}

# Every managed unit: core units plus the live browser instances.
all_units() {
  local unit
  for unit in "${CORE_UNITS[@]}"; do printf '%s\n' "$unit"; done
  browser_units
}

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/linux-browser-vnc.sh inspect
  sudo bash scripts/linux-browser-vnc.sh install [options]
  sudo bash scripts/linux-browser-vnc.sh status
  sudo bash scripts/linux-browser-vnc.sh verify [--expected-ip IP]
  sudo bash scripts/linux-browser-vnc.sh harden-egress --expected-ip IP
  sudo bash scripts/linux-browser-vnc.sh repair
  sudo bash scripts/linux-browser-vnc.sh print-url
  sudo bash scripts/linux-browser-vnc.sh uninstall [--purge-profile]

Options:
  --display :100                 X display for the managed desktop
  --geometry 1440x900x24         Xvfb screen geometry
  --rfb-port 5910                loopback x11vnc port
  --novnc-port 6080              loopback noVNC/websockify port
  --health-port 6081             loopback health port
  --debug-port 9222              loopback DevTools base port (instance i uses base+i-1)
  --instances 1                  number of browser instances sharing the display
  --seed-profile FILE|URL        .tgz Chrome profile (local path or HTTPS URL) for every instance
  --public-name vnc-A-B-C-D      public hostname label (derived from the Clash URL)
  --public-zone chxyka.ccwu.cc   zone that serves the desktop hostname
  --tunnel-token-file FILE       Cloudflare connector token from provisioning
  --browser-bin PATH             explicit browser executable
  --start-url HTTPS_URL          first page opened in the desktop
  --browser-memory-max 2G        cgroup memory ceiling for the browser
  --browser-memory-high 1500M    cgroup soft memory limit for the browser
  --browser-tasks-max 512        cgroup task ceiling for the browser
  --max-browser-processes 60     health check fails above this process count
  --allow-no-sandbox             start the browser with --no-sandbox
  --skip-packages                do not install OS packages
  --no-public                    install local services without the public route

inspect is read-only and always safe. Run it before installing on a machine that
may already run a browser or VNC stack.
EOF
}

require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "This command must run as root."; }

parse_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --display) [[ $# -ge 2 ]] || die "Missing value for --display"; VNC_DISPLAY="$2"; shift 2 ;;
      --geometry) [[ $# -ge 2 ]] || die "Missing value for --geometry"; VNC_GEOMETRY="$2"; shift 2 ;;
      --rfb-port) [[ $# -ge 2 ]] || die "Missing value for --rfb-port"; RFB_PORT="$2"; shift 2 ;;
      --novnc-port) [[ $# -ge 2 ]] || die "Missing value for --novnc-port"; NOVNC_PORT="$2"; shift 2 ;;
      --health-port) [[ $# -ge 2 ]] || die "Missing value for --health-port"; HEALTH_PORT="$2"; shift 2 ;;
      --debug-port) [[ $# -ge 2 ]] || die "Missing value for --debug-port"; DEBUG_PORT="$2"; shift 2 ;;
      --instances) [[ $# -ge 2 ]] || die "Missing value for --instances"; INSTANCES="$2"; shift 2 ;;
      --seed-profile) [[ $# -ge 2 ]] || die "Missing value for --seed-profile"; SEED_PROFILE="$2"; shift 2 ;;
      --public-name) [[ $# -ge 2 ]] || die "Missing value for --public-name"; PUBLIC_NAME="$2"; shift 2 ;;
      --public-zone) [[ $# -ge 2 ]] || die "Missing value for --public-zone"; PUBLIC_ZONE="$2"; shift 2 ;;
      --tunnel-token-file) [[ $# -ge 2 ]] || die "Missing value for --tunnel-token-file"; TUNNEL_TOKEN_FILE="$2"; shift 2 ;;
      --browser-bin) [[ $# -ge 2 ]] || die "Missing value for --browser-bin"; BROWSER_BIN="$2"; shift 2 ;;
      --start-url) [[ $# -ge 2 ]] || die "Missing value for --start-url"; BROWSER_START_URL="$2"; shift 2 ;;
      --browser-memory-max) [[ $# -ge 2 ]] || die "Missing value"; BROWSER_MEMORY_MAX="$2"; shift 2 ;;
      --browser-memory-high) [[ $# -ge 2 ]] || die "Missing value"; BROWSER_MEMORY_HIGH="$2"; shift 2 ;;
      --browser-tasks-max) [[ $# -ge 2 ]] || die "Missing value"; BROWSER_TASKS_MAX="$2"; shift 2 ;;
      --max-browser-processes) [[ $# -ge 2 ]] || die "Missing value"; MAX_BROWSER_PROCESSES="$2"; shift 2 ;;
      --expected-ip) [[ $# -ge 2 ]] || die "Missing value for --expected-ip"; EXPECTED_IP="$2"; shift 2 ;;
      --allow-no-sandbox) BROWSER_SANDBOX="0"; shift ;;
      --skip-packages) INSTALL_PACKAGES=false; shift ;;
      --no-public) ENABLE_PUBLIC=false; shift ;;
      --purge-profile) PURGE_PROFILE=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown argument: $1" ;;
    esac
  done
}

# How much memory may one browser instance hold?
#
# This was a flat 1500M, which is enough to browse and not enough to drive
# ChatGPT or Gemini: both are heavy SPAs, and lifting a generated image out
# through a canvas holds a full-resolution bitmap in the browser process.
# Exceeding MemoryHigh does not kill the browser, it sedates it — the kernel
# puts every allocating thread to sleep, so the DevTools port keeps accepting
# connections while answering none. systemd reports the unit active, the fleet
# reports the browser dead, and nothing in between explains why. One machine had
# logged 400 million throttle events by the time it was looked at.
#
# So the budget is derived from the machine instead of guessed: half of RAM
# shared between the instances, clamped to a range where the low end still runs
# a real session and the high end leaves the host its own memory.
resolve_browser_memory() {
  [[ -n "$BROWSER_MEMORY_HIGH" && -n "$BROWSER_MEMORY_MAX" ]] && return 0
  local total_kb share
  total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  share=$(( total_kb / 1024 / 2 / INSTANCES ))
  (( share < 1500 )) && share=1500
  (( share > 3072 )) && share=3072
  [[ -z "$BROWSER_MEMORY_HIGH" ]] && BROWSER_MEMORY_HIGH="${share}M"
  # A margin above MemoryHigh, so reclaim throttling has room to work before the
  # hard limit turns into an OOM kill.
  [[ -z "$BROWSER_MEMORY_MAX" ]] && BROWSER_MEMORY_MAX="$(( share + 512 ))M"
  return 0
}

validate_options() {
  [[ "$VNC_DISPLAY" =~ ^:[0-9]{1,3}$ ]] || die "Display must look like :100"
  [[ "$VNC_GEOMETRY" =~ ^[0-9]{3,5}x[0-9]{3,5}x(16|24|32)$ ]] || die "Invalid geometry"
  local ports=("$RFB_PORT" "$NOVNC_PORT" "$HEALTH_PORT" "$DEBUG_PORT")
  local port
  for port in "${ports[@]}"; do
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || die "Invalid port: $port"
  done
  [[ "$(printf '%s\n' "${ports[@]}" | sort -u | wc -l)" -eq "${#ports[@]}" ]] \
    || die "The loopback ports must differ from each other."
  [[ "$BROWSER_START_URL" =~ ^https:// ]] || die "The start URL must be HTTPS."
  [[ "$MAX_BROWSER_PROCESSES" =~ ^[0-9]+$ ]] || die "Invalid --max-browser-processes"
  [[ "$INSTANCES" =~ ^[0-9]+$ ]] && (( INSTANCES >= 1 && INSTANCES <= 16 )) \
    || die "Invalid --instances (1-16): $INSTANCES"
  resolve_browser_memory
  # Instance i uses DEBUG_PORT + i - 1; the whole span must stay in range and
  # must not collide with the other loopback ports.
  local top=$(( DEBUG_PORT + INSTANCES - 1 ))
  (( top <= 65535 )) || die "The DevTools port span exceeds 65535."
  local other
  for other in "$RFB_PORT" "$NOVNC_PORT" "$HEALTH_PORT"; do
    (( other < DEBUG_PORT || other > top )) \
      || die "Port $other collides with the DevTools range ${DEBUG_PORT}-${top}."
  done
  if [[ -n "$SEED_PROFILE" && ! "$SEED_PROFILE" =~ ^https:// ]]; then
    [[ -r "$SEED_PROFILE" ]] || die "Cannot read --seed-profile: $SEED_PROFILE"
  fi
}

# --seed-profile accepts a local .tgz or an HTTPS URL. A URL is downloaded once
# so a fresh machine can pull a logged-in session straight from the resource host.
resolve_seed_profile() {
  [[ -n "$SEED_PROFILE" ]] || return 0
  [[ "$SEED_PROFILE" =~ ^https:// ]] || return 0
  local downloaded="${STATE_ROOT}/.seed-download.tgz"
  log "Downloading the seed profile from ${SEED_PROFILE}."
  curl --noproxy '*' -fsS --max-time 180 "$SEED_PROFILE" -o "$downloaded" \
    || die "Failed to download the seed profile."
  SEED_PROFILE="$downloaded"
}

# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

inspect() {
  printf '## Machine\n'
  printf 'hostname: %s\n' "$(hostname)"
  printf 'architecture: %s\n' "$(uname -m)"
  printf '\n## Existing browser executables\n'
  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%-22s %s\n' "$candidate" "$(command -v "$candidate")"
    fi
  done
  ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null || true

  printf '\n## Existing desktop/VNC units\n'
  systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null \
    | grep -Ei 'vnc|xvfb|x11|novnc|websockif|chrom|browser|adspower' || printf 'none\n'

  printf '\n## Managed units from this skill\n'
  local unit
  for unit in "${CORE_UNITS[@]}"; do
    printf '%-44s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"
  done
  systemctl list-units --all --no-legend --no-pager 'linux-browser-vnc-browser@*.service' 2>/dev/null \
    | awk '{printf "%-44s %s\n", $1, $3}' || true

  printf '\n## Listening sockets that are not loopback\n'
  ss -lntp 2>/dev/null | awk 'NR>1' | grep -Ev '127\.0\.0\.[0-9]+|\[::1\]' || printf 'none\n'

  printf '\n## Requested resources\n'
  printf 'display %s in use: %s\n' "$VNC_DISPLAY" \
    "$([[ -e "/tmp/.X11-unix/X${VNC_DISPLAY#:}" ]] && echo yes || echo no)"
  for port in "$RFB_PORT" "$NOVNC_PORT" "$HEALTH_PORT" "$DEBUG_PORT"; do
    printf 'port %-6s in use: %s\n' "$port" \
      "$(ss -lnt "sport = :${port}" 2>/dev/null | awk 'NR>1' | grep -q . && echo yes || echo no)"
  done

  printf '\n## Browser process count by user\n'
  ps -eo user:24,comm 2>/dev/null | awk '$2 ~ /chrom/ {count[$1]++} END {for (u in count) printf "%-24s %s\n", u, count[u]; if (length(count)==0) print "none"}'
}

conflict_guard() {
  local blocked=0
  if [[ -e "/tmp/.X11-unix/X${VNC_DISPLAY#:}" ]] \
     && ! systemctl is-active --quiet linux-browser-vnc-xvfb.service; then
    printf '[linux-browser-vnc] Display %s is already served by another process.\n' "$VNC_DISPLAY" >&2
    blocked=1
  fi
  for port in "$RFB_PORT" "$NOVNC_PORT" "$HEALTH_PORT" "$DEBUG_PORT"; do
    if ss -lnt "sport = :${port}" 2>/dev/null | awk 'NR>1' | grep -q .; then
      if ! systemctl list-units --no-legend --no-pager 'linux-browser-vnc-*' 2>/dev/null | grep -q .; then
        printf '[linux-browser-vnc] Port %s is already bound by another service.\n' "$port" >&2
        blocked=1
      fi
    fi
  done
  (( blocked == 0 )) || die "Refusing to install over an existing stack. Run 'inspect', then choose free ports/display or adopt the existing services deliberately."
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  else echo none
  fi
}

install_packages() {
  local manager
  manager="$(detect_package_manager)"
  case "$manager" in
    apt)
      log "Installing desktop packages with apt-get."
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        xvfb openbox x11vnc novnc websockify python3 curl ca-certificates fonts-liberation fonts-noto-cjk \
        >/dev/null
      ;;
    dnf|yum)
      log "Installing desktop packages with ${manager}."
      "$manager" install -y -q epel-release >/dev/null 2>&1 || true
      "$manager" install -y -q \
        xorg-x11-server-Xvfb openbox x11vnc novnc python3 curl ca-certificates \
        liberation-fonts google-noto-sans-cjk-ttc-fonts >/dev/null
      ;;
    *)
      die "No supported package manager was found. Re-run with --skip-packages after installing Xvfb, openbox, x11vnc, novnc and websockify."
      ;;
  esac
}

install_browser_package() {
  local architecture
  architecture="$(uname -m)"
  if [[ "$architecture" == "x86_64" ]] && ! command -v google-chrome-stable >/dev/null 2>&1; then
    local manager
    manager="$(detect_package_manager)"
    if [[ "$manager" == "apt" ]]; then
      log "Installing Google Chrome stable for amd64."
      install -d -m 0755 /etc/apt/keyrings
      curl --noproxy '*' -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
      printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main\n' \
        > /etc/apt/sources.list.d/google-chrome.list
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq google-chrome-stable >/dev/null
    else
      log "Installing Google Chrome stable from the vendor RPM repository."
      cat > /etc/yum.repos.d/google-chrome.repo <<'EOF'
[google-chrome]
name=google-chrome
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=1
gpgcheck=1
gpgkey=https://dl.google.com/linux/linux_signing_key.pub
EOF
      "$manager" install -y -q google-chrome-stable >/dev/null
    fi
  fi
}

# A snap browser cannot start for a system account: it needs a snap session and
# a writable /run/user/<uid>/snap.*, and it fails with
# "cannot create XDG_RUNTIME_DIR folder ... permission denied".
#
# Detection has to cover three shapes. `/snap/bin/chromium` is a symlink whose
# `readlink -f` target is `/usr/bin/snap`, not a path under /snap, so matching
# only the resolved target silently accepts it. `/usr/bin/chromium-browser` on
# Ubuntu is a plain shell script that execs the snap.
is_snap_wrapper() {
  local path="$1" target
  [[ "$path" == /snap/* ]] && return 0
  target="$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")"
  [[ "$target" == /snap/* ]] && return 0
  [[ "$(basename "$target")" == "snap" ]] && return 0
  if [[ -f "$target" && "$(stat -c '%s' "$target" 2>/dev/null || echo 0)" -lt 8192 ]] \
     && head -c 4096 "$target" 2>/dev/null | grep -q '/snap/bin/'; then
    return 0
  fi
  return 1
}

resolve_browser() {
  if [[ -n "$BROWSER_BIN" ]]; then
    [[ -x "$BROWSER_BIN" ]] || die "The supplied --browser-bin is not executable: $BROWSER_BIN"
    return
  fi
  local candidate
  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      local resolved
      resolved="$(command -v "$candidate")"
      if is_snap_wrapper "$resolved"; then
        log "Skipping ${candidate}: it is a snap wrapper and cannot run as a system desktop user."
        continue
      fi
      BROWSER_BIN="$resolved"
      return
    fi
  done
  local playwright
  playwright="$(ls -1d /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$playwright" && -x "$playwright" ]]; then
    log "Falling back to an existing Playwright Chromium build."
    BROWSER_BIN="$playwright"
    return
  fi
  die "No usable browser was found. Install Google Chrome or Chromium, or pass --browser-bin."
}

# A browser under /root is unreadable for the desktop account, and Ubuntu's arm64
# `chromium` is only a snap wrapper, so on those machines the only real build on
# disk usually sits in root's Playwright cache. Copy it somewhere the desktop
# user can actually execute instead of loosening permissions on /root.
stage_browser() {
  if runuser -u "$DESKTOP_USER" -- test -x "$BROWSER_BIN" 2>/dev/null; then
    return
  fi
  local source_dir staged
  source_dir="$(dirname "$BROWSER_BIN")"
  staged="${INSTALL_ROOT}/browser"
  log "The desktop account cannot execute ${BROWSER_BIN}; staging it into ${staged}."
  install -d -m 0755 "$staged"
  # Refresh only when the source is newer, so reinstalls stay fast.
  if [[ ! -x "${staged}/$(basename "$BROWSER_BIN")" || "$BROWSER_BIN" -nt "${staged}/$(basename "$BROWSER_BIN")" ]]; then
    cp -a "${source_dir}/." "$staged/"
  fi
  chown -R root:root "$staged"
  chmod -R a+rX "$staged"
  BROWSER_BIN="${staged}/$(basename "$BROWSER_BIN")"
  runuser -u "$DESKTOP_USER" -- test -x "$BROWSER_BIN" \
    || die "The staged browser is still not executable by ${DESKTOP_USER}."
  log "Staged browser: ${BROWSER_BIN}"
}

# Seed each instance's profile from a tarball, e.g. a logged-in Chrome profile
# copied from another machine. Seeding is skipped for an instance that already
# holds a profile, so a reinstall never clobbers a login the desktop has since
# refreshed. The copied singleton locks are stripped here and again at launch.
seed_profiles() {
  [[ -n "$SEED_PROFILE" ]] || return 0
  local i target
  for (( i = 1; i <= INSTANCES; i++ )); do
    target="$STATE_ROOT/profile-${i}"
    if [[ -e "$target/Local State" || -e "$target/Default/Cookies" ]]; then
      log "Instance ${i} already has a profile; leaving it untouched."
      continue
    fi
    log "Seeding instance ${i} profile from ${SEED_PROFILE}."
    tar xzf "$SEED_PROFILE" -C "$target" 2>/dev/null \
      || die "Failed to extract the seed profile into ${target}."
    rm -f "$target"/Singleton* 2>/dev/null || true
    # A profile copied from a running Chrome carries exited_cleanly=false, which
    # makes the new browser show a "Chrome didn't shut down correctly / Restore
    # pages" bubble on first launch. Mark it clean so the seeded instance starts
    # without that prompt. This touches only the crash-recovery flag.
    python3 - "$target" <<'PY' 2>/dev/null || true
import json, sys
from pathlib import Path
prof = Path(sys.argv[1])
for rel in ("Default/Preferences", "Preferences"):
    p = prof / rel
    if not p.exists():
        continue
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    data.setdefault("profile", {})["exit_type"] = "Normal"
    data["profile"]["exited_cleanly"] = True
    p.write_text(json.dumps(data), encoding="utf-8")
PY
    chown -R "$DESKTOP_USER":"$DESKTOP_USER" "$target"
    chmod 0700 "$target"
  done
}

derive_public_name() {
  # Pairing the desktop hostname with the machine's existing Clash hostname keeps
  # the two fleet links recognisably the same machine.
  if [[ -z "$PUBLIC_NAME" ]]; then
    local clash_url
    clash_url="$(sed -n '1p' "$CLASH_URL_FILE" 2>/dev/null || true)"
    if [[ "$clash_url" =~ ^https://clash-([a-z0-9-]+)\.([a-z0-9.-]+)/?$ ]]; then
      PUBLIC_NAME="vnc-${BASH_REMATCH[1]}"
      PUBLIC_ZONE="${BASH_REMATCH[2]}"
    elif [[ "$ENABLE_PUBLIC" == "false" ]]; then
      # --no-public 明说了"装本地服务、不建公开路由",却因为推导不出一个用不到的
      # 公开名而硬失败 —— 这正是机群的常规装法:一台机器只有一条命名隧道,
      # vnc-* 的 ingress 是在隧道那边配好的,装机时本机还没有 dashboard-public.url。
      log "WARNING: 推导不出公开名(${CLASH_URL_FILE} 不可用),但 --no-public 已指定,继续装本地服务。"
      log "         之后要对外暴露,补 --public-name 重跑或直接在隧道上加 ingress。"
      PUBLIC_URL=""
      return 0
    else
      die "Could not derive the public name from ${CLASH_URL_FILE}. Pass --public-name explicitly."
    fi
  fi
  [[ "$PUBLIC_NAME" =~ ^vnc-[a-z0-9-]{1,48}$ ]] || die "Invalid public name: ${PUBLIC_NAME}"
  PUBLIC_URL="https://${PUBLIC_NAME}.${PUBLIC_ZONE}"
}

ensure_users() {
  if ! id -u "$DESKTOP_USER" >/dev/null 2>&1; then
    log "Creating the dedicated desktop account ${DESKTOP_USER}."
    useradd --system --home-dir "$STATE_ROOT" --create-home \
      --shell /usr/sbin/nologin "$DESKTOP_USER" 2>/dev/null \
      || useradd --system --home-dir "$STATE_ROOT" --create-home \
        --shell /sbin/nologin "$DESKTOP_USER"
  fi
  id -u "$TUNNEL_USER" >/dev/null 2>&1 \
    || die "The ${TUNNEL_USER} account is missing. Install linux-clash-skill first so the tunnel stays excluded from TUN."
}

ensure_layout() {
  install -d -m 0755 "$CONFIG_ROOT" "$INSTALL_ROOT" "$INSTALL_ROOT/scripts"
  install -d -m 0755 -o "$DESKTOP_USER" -g "$DESKTOP_USER" \
    "$STATE_ROOT" "$STATE_ROOT/web"
  local i
  for (( i = 1; i <= INSTANCES; i++ )); do
    install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" "$STATE_ROOT/profile-${i}"
  done
  install -d -m 0750 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "$STATE_ROOT/tunnel"
  # With a named tunnel the hostname is decided during provisioning, so the URL
  # is deterministic and root records it once instead of parsing it out of a
  # connector's log.
  rm -f "$STATE_ROOT/public.url"
  printf '%s\n' "$PUBLIC_URL" > "$STATE_ROOT/public.url"
  chmod 0644 "$STATE_ROOT/public.url"
  ln -sfn "$STATE_ROOT/public.url" "$CONFIG_ROOT/public.url"
}

# Keep the browser's own sandbox working on distributions that restrict
# unprivileged user namespaces. Without this the desktop crash-loops with
# "No usable sandbox!", and the only alternatives are dropping the sandbox
# entirely or lifting the restriction machine-wide.
install_apparmor_profile() {
  [[ -d /sys/kernel/security/apparmor ]] || return 0
  command -v apparmor_parser >/dev/null 2>&1 || return 0
  local restricted
  restricted="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
  [[ "$restricted" == "1" ]] || return 0
  local profile=/etc/apparmor.d/linux-browser-vnc-browser
  log "Installing an AppArmor profile so the browser keeps its sandbox."
  sed -e "s|@BROWSER_BIN@|${BROWSER_BIN}|g" \
    "${ASSET_DIR}/apparmor-linux-browser-vnc-browser" > "${profile}.tmp"
  chmod 0644 "${profile}.tmp"
  mv -f "${profile}.tmp" "$profile"
  if ! apparmor_parser -r -W "$profile" 2>/dev/null; then
    rm -f "$profile"
    log "WARNING: the AppArmor profile was rejected; re-run with --allow-no-sandbox if the browser cannot start."
  fi
}

install_token() {
  [[ "$ENABLE_PUBLIC" == "true" ]] || return 0
  if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
    [[ -r "$TUNNEL_TOKEN_FILE" ]] || die "Cannot read the connector token file."
    install -m 0640 -o root -g "$TUNNEL_USER" "$TUNNEL_TOKEN_FILE" "${CONFIG_ROOT}/tunnel.token"
    log "Stored the connector token with mode 0640."
  fi
  [[ -s "${CONFIG_ROOT}/tunnel.token" ]] \
    || die "No connector token is installed. Provision one with provision_cloudflare_tunnel.py and pass --tunnel-token-file."
}

install_cloudflared() {
  [[ "$ENABLE_PUBLIC" == "true" ]] || return 0
  command -v cloudflared >/dev/null 2>&1 && return 0
  [[ -x /usr/local/bin/cloudflared ]] && return 0
  local architecture asset metadata_url asset_url expected_digest actual_digest temporary
  case "$(uname -m)" in
    x86_64) architecture="amd64" ;;
    aarch64|arm64) architecture="arm64" ;;
    *) die "No cloudflared build is known for $(uname -m). Install it manually and re-run." ;;
  esac
  log "Installing cloudflared for ${architecture}."
  asset="cloudflared-linux-${architecture}"
  metadata_url="https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
  temporary="$(mktemp)"
  trap 'rm -f "$temporary" "${temporary}.json"' RETURN
  # Try without explicit proxy variables first. Transparent TUN routing may still
  # apply; the ordinary retry supports hosts that require an explicit proxy.
  if ! env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
      curl --retry 3 --retry-all-errors --connect-timeout 20 --max-time 420 -fsSL \
      "$metadata_url" -o "${temporary}.json"; then
    curl --retry 3 --retry-all-errors --connect-timeout 20 --max-time 420 -fsSL \
      "$metadata_url" -o "${temporary}.json"
  fi
  read -r asset_url expected_digest < <(python3 - "${temporary}.json" "$asset" <<'PY'
import json, sys
release = json.load(open(sys.argv[1], encoding="utf-8"))
match = next((item for item in release.get("assets", []) if item.get("name") == sys.argv[2]), None)
if not match or not str(match.get("digest", "")).startswith("sha256:"):
    raise SystemExit("official release asset or SHA-256 digest is missing")
print(match["browser_download_url"], match["digest"].split(":", 1)[1])
PY
  ) || die "Could not resolve a checksummed official cloudflared release."
  if ! env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
      curl --retry 3 --retry-all-errors --connect-timeout 20 --max-time 420 -fsSL \
      "$asset_url" -o "$temporary"; then
    curl --retry 3 --retry-all-errors --connect-timeout 20 --max-time 420 -fsSL \
      "$asset_url" -o "$temporary"
  fi
  actual_digest="$(sha256sum "$temporary" | awk '{print $1}')"
  [[ "$actual_digest" == "$expected_digest" ]] || die "cloudflared SHA-256 verification failed."
  install -m 0755 "$temporary" /usr/local/bin/cloudflared
  rm -f "$temporary" "${temporary}.json"
  trap - RETURN
}

populate_web_root() {
  local source=""
  for candidate in /usr/share/novnc /usr/share/webapps/novnc /opt/novnc; do
    [[ -f "$candidate/vnc.html" ]] && { source="$candidate"; break; }
  done
  [[ -n "$source" ]] || die "noVNC web assets were not found. Install the novnc package or pass --skip-packages after providing them."
  log "Linking noVNC assets from ${source}."
  local entry
  for entry in "$source"/*; do
    ln -sfn "$entry" "$STATE_ROOT/web/$(basename "$entry")"
  done
  # `/` must land on the viewer; some distributions ship no index.html.
  [[ -e "$source/index.html" ]] || ln -sfn "$source/vnc.html" "$STATE_ROOT/web/index.html"
  # A placeholder keeps the public /healthz route valid before the first probe.
  if [[ ! -e "$STATE_ROOT/web/healthz" ]]; then
    printf '{"ok": false, "checks": {}, "checked_at": "", "note": "health service has not reported yet"}\n' \
      > "$STATE_ROOT/web/healthz"
  fi
  chown -R "$DESKTOP_USER":"$DESKTOP_USER" "$STATE_ROOT/web"
}

write_environment() {
  local temporary="${CONFIG_ROOT}/desktop.env.tmp"
  cat > "$temporary" <<EOF
# Managed by linux-browser-vnc. Edit through the installer, not by hand.
VNC_DISPLAY=${VNC_DISPLAY}
DISPLAY=${VNC_DISPLAY}
VNC_GEOMETRY=${VNC_GEOMETRY}
VNC_RFB_PORT=${RFB_PORT}
VNC_NOVNC_PORT=${NOVNC_PORT}
VNC_HEALTH_PORT=${HEALTH_PORT}
VNC_WEB_ROOT=${STATE_ROOT}/web
VNC_INSTANCES=${INSTANCES}
BROWSER_DEBUG_PORT=${DEBUG_PORT}
BROWSER_DEBUG_PORT_BASE=${DEBUG_PORT}
VNC_MAX_BROWSER_PROCESSES=${MAX_BROWSER_PROCESSES}
BROWSER_BIN=${BROWSER_BIN}
BROWSER_PROFILE_BASE=${STATE_ROOT}/profile
BROWSER_START_URL=${BROWSER_START_URL}
BROWSER_LANG=${BROWSER_LANG}
BROWSER_ACCEPT_LANGUAGES=${BROWSER_LANG}
BROWSER_SANDBOX=${BROWSER_SANDBOX}
HOME=${STATE_ROOT}
LANG=en_US.UTF-8
EOF
  chmod 0644 "$temporary"
  mv -f "$temporary" "${CONFIG_ROOT}/desktop.env"

  # Bound into the connector unit as its private /etc/resolv.conf. Without this
  # the Cloudflare edge hostnames resolve to Mihomo fake IPs that a TUN-excluded
  # process cannot route to.
  temporary="${CONFIG_ROOT}/tunnel-resolv.conf.tmp"
  cat > "$temporary" <<'EOF'
# Managed by linux-browser-vnc for the tunnel connector only.
nameserver 1.1.1.1
nameserver 8.8.8.8
options timeout:2 attempts:2
EOF
  chmod 0644 "$temporary"
  mv -f "$temporary" "${CONFIG_ROOT}/tunnel-resolv.conf"

  temporary="${CONFIG_ROOT}/tunnel.env.tmp"
  cat > "$temporary" <<EOF
# Managed by linux-browser-vnc. The token itself lives in tunnel.token.
NOVNC_PORT=${NOVNC_PORT}
PUBLIC_URL=${PUBLIC_URL}
TUNNEL_TOKEN_FILE=${CONFIG_ROOT}/tunnel.token
EOF
  chmod 0644 "$temporary"
  mv -f "$temporary" "${CONFIG_ROOT}/tunnel.env"
}

install_code() {
  install -m 0755 "${SCRIPT_DIR}/browser_vnc_health.py" "${INSTALL_ROOT}/scripts/browser_vnc_health.py"
  install -m 0755 "${SCRIPT_DIR}/browser_probe.py" "${INSTALL_ROOT}/scripts/browser_probe.py"
  install -m 0755 "${SCRIPT_DIR}/browser_vnc_tunnel.sh" "${INSTALL_ROOT}/scripts/browser_vnc_tunnel.sh"
  install -m 0755 "${SCRIPT_DIR}/browser_vnc_watchdog.sh" "${INSTALL_ROOT}/scripts/browser_vnc_watchdog.sh"
  install -m 0755 "${SCRIPT_DIR}/start_browser.sh" "${INSTALL_ROOT}/scripts/start_browser.sh"
  install -m 0755 "${SCRIPT_DIR}/browser_sync.sh" "${INSTALL_ROOT}/scripts/browser_sync.sh"
  install -m 0755 "${SCRIPT_DIR}/browser_cdpguard.sh" "${INSTALL_ROOT}/scripts/browser_cdpguard.sh"
}

install_units() {
  local unit rendered selinux_nnp_compat=false os_id="" systemd_version=""
  systemd_version="$(systemd --version 2>/dev/null | awk 'NR == 1 {print $2}')"
  if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    if [[ -r /etc/os-release ]]; then
      os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"
    fi
    case "$os_id" in rhel|centos|rocky|almalinux|fedora) selinux_nnp_compat=true ;; esac
  fi
  if [[ "$selinux_nnp_compat" == "true" ]]; then
    install -d -m 0755 "${INSTALL_ROOT}/bin"
    install -m 0755 /usr/bin/x11vnc "${INSTALL_ROOT}/bin/x11vnc"
  fi
  for unit in "${CORE_UNITS[@]}" "${WATCHDOG_UNITS[@]}" "$BROWSER_TEMPLATE"; do
    [[ "$unit" == "$PUBLIC_UNIT" && "$ENABLE_PUBLIC" != "true" ]] && continue
    rendered="$(mktemp)"
    sed -e "s|@BROWSER_MEMORY_HIGH@|${BROWSER_MEMORY_HIGH}|g" \
        -e "s|@BROWSER_MEMORY_MAX@|${BROWSER_MEMORY_MAX}|g" \
        -e "s|@BROWSER_TASKS_MAX@|${BROWSER_TASKS_MAX}|g" \
        "${ASSET_DIR}/${unit}" > "$rendered"
    if [[ "$systemd_version" =~ ^[0-9]+$ ]] && (( systemd_version < 244 )); then
      sed -i -e '/^ProtectClock=/d' -e '/^ProtectHostname=/d' "$rendered"
      log "Removed unsupported sandbox directives from ${unit} for systemd ${systemd_version}."
    fi
    # RHEL-family SELinux labels /usr/bin/x11vnc as xserver_exec_t. Execute a
    # skill-owned copy without that domain transition so NoNewPrivileges stays
    # enabled. systemd-notify has a separate transition in the tunnel watchdog;
    # only that non-root, capability-free service needs the narrow NNP exception.
    if [[ "$selinux_nnp_compat" == "true" && "$unit" == "linux-browser-vnc-x11vnc.service" ]]; then
      sed -i "s|^ExecStart=/usr/bin/x11vnc|ExecStart=${INSTALL_ROOT}/bin/x11vnc|" "$rendered"
      log "Staged x11vnc for enforcing-SELinux compatibility."
    elif [[ "$selinux_nnp_compat" == "true" && "$unit" == "$PUBLIC_UNIT" ]]; then
      sed -i 's/^NoNewPrivileges=true$/NoNewPrivileges=false/' "$rendered"
      log "Applied enforcing-SELinux compatibility to ${unit}."
    fi
    install -m 0644 "$rendered" "/etc/systemd/system/${unit}"
    rm -f "$rendered"
  done
  systemctl daemon-reload
}

# Stop and disable any browser instance beyond the currently requested count,
# so lowering --instances on a reinstall does not leave orphans running.
prune_stale_instances() {
  local unit index
  while read -r unit; do
    [[ -n "$unit" ]] || continue
    index="${unit#linux-browser-vnc-browser@}"; index="${index%.service}"
    if [[ "$index" =~ ^[0-9]+$ ]] && (( index > INSTANCES )); then
      log "Removing stale instance ${index}."
      systemctl disable --quiet --now "$unit" 2>/dev/null || true
    fi
  done < <(systemctl list-units --all --no-legend --no-pager \
    'linux-browser-vnc-browser@*.service' 2>/dev/null | awk '{print $1}')
}

# Retire the pre-multi-instance browser unit. Before templating, a single
# `linux-browser-vnc-browser.service` drove profile-1. The template `@1` unit now
# points at the same profile-1 and DevTools port, so leaving the old unit running
# means two Chromes fight over one login profile: wasted memory and a genuine
# cookie-corruption risk. Remove the legacy unit once; the template instances own
# the desktop from here on. The `-f` guard matches only the real non-template
# file, never the `...browser@.service` template.
LEGACY_BROWSER_UNIT="linux-browser-vnc-browser.service"
retire_legacy_browser_unit() {
  local path="/etc/systemd/system/${LEGACY_BROWSER_UNIT}"
  [[ -f "$path" ]] || return 0
  log "Retiring the legacy single-instance browser unit (${LEGACY_BROWSER_UNIT})."
  systemctl disable --quiet --now "$LEGACY_BROWSER_UNIT" 2>/dev/null || true
  rm -f "$path"
  systemctl daemon-reload
}

start_units() {
  local unit
  for unit in "${CORE_UNITS[@]}"; do
    [[ "$unit" == "$PUBLIC_UNIT" && "$ENABLE_PUBLIC" != "true" ]] && continue
    systemctl enable --quiet "$unit"
  done
  for unit in $(browser_units); do systemctl enable --quiet "$unit"; done
  # Restart in dependency order so an upgrade re-reads the environment file.
  systemctl restart linux-browser-vnc-xvfb.service
  systemctl restart linux-browser-vnc-openbox.service
  systemctl restart linux-browser-vnc-x11vnc.service
  systemctl restart linux-browser-vnc-novnc.service
  prune_stale_instances
  for unit in $(browser_units); do systemctl restart "$unit"; done
  systemctl restart linux-browser-vnc-health.service
  # The watchdog is timer-driven; enabling and starting the timer is enough.
  systemctl enable --quiet linux-browser-vnc-cdpguard.timer
  systemctl restart linux-browser-vnc-cdpguard.timer
  [[ "$ENABLE_PUBLIC" == "true" ]] && systemctl restart "$PUBLIC_UNIT"
  return 0
}

install_all() {
  require_root
  validate_options
  conflict_guard
  [[ "$INSTALL_PACKAGES" == "true" ]] && { install_packages; install_browser_package; }
  resolve_browser
  derive_public_name
  ensure_users
  ensure_layout
  resolve_seed_profile
  seed_profiles
  stage_browser
  install_apparmor_profile
  install_token
  install_cloudflared
  populate_web_root
  write_environment
  install_code
  retire_legacy_browser_unit
  install_units
  start_units
  log "Browser executable: ${BROWSER_BIN}"
  log "Instances: ${INSTANCES} (DevTools ports ${DEBUG_PORT}-$(( DEBUG_PORT + INSTANCES - 1 )))"
  log "Waiting for the desktop to report healthy."
  wait_for_health 60 || die "The desktop did not become healthy. Run 'status' and check journalctl."
  log "Local desktop is healthy."
  if [[ "$ENABLE_PUBLIC" == "true" ]]; then
    log "Public URL: ${PUBLIC_URL}"
    wait_for_public_route 90 \
      || log "WARNING: ${PUBLIC_URL} did not answer yet; check ${PUBLIC_UNIT} and the DNS record."
  fi
}

# ---------------------------------------------------------------------------
# Status and verification
# ---------------------------------------------------------------------------

health_json() {
  curl --noproxy '*' -sS --connect-timeout 3 --max-time 10 \
    "http://127.0.0.1:${HEALTH_PORT}/healthz" 2>/dev/null || true
}

wait_for_health() {
  local deadline=$(( SECONDS + ${1:-60} ))
  while (( SECONDS < deadline )); do
    if health_json | grep -q '"ok": true'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# A recorded URL proves nothing on its own; the route has to answer. An Access
# challenge counts, because a protected hostname is supposed to redirect.
public_route_state() {
  local url="${1:-$PUBLIC_URL}" observed code redirect
  observed="$(curl --noproxy '*' -sS -o /dev/null --connect-timeout 5 --max-time 20 \
    -w '%{http_code} %{redirect_url}' "${url%/}/healthz" 2>/dev/null || true)"
  code="${observed%% *}"
  redirect="${observed#* }"
  case "$code" in
    200) printf 'open %s\n' "$code" ;;
    301|302|303|307|308)
      if [[ "$redirect" == https://*.cloudflareaccess.com/* ]]; then
        printf 'access %s\n' "$code"
      else
        printf 'redirect %s\n' "$code"
      fi
      ;;
    *) printf 'down %s\n' "$code" ;;
  esac
}

wait_for_public_route() {
  local deadline=$(( SECONDS + ${1:-90} )) state
  while (( SECONDS < deadline )); do
    state="$(public_route_state)"
    case "${state%% *}" in
      open|access) return 0 ;;
    esac
    sleep 5
  done
  return 1
}

load_environment() {
  [[ -r "${CONFIG_ROOT}/desktop.env" ]] || return 1
  # shellcheck disable=SC1090
  set -a; source "${CONFIG_ROOT}/desktop.env"; set +a
  RFB_PORT="${VNC_RFB_PORT:-$RFB_PORT}"
  NOVNC_PORT="${VNC_NOVNC_PORT:-$NOVNC_PORT}"
  HEALTH_PORT="${VNC_HEALTH_PORT:-$HEALTH_PORT}"
  DEBUG_PORT="${BROWSER_DEBUG_PORT_BASE:-${BROWSER_DEBUG_PORT:-$DEBUG_PORT}}"
  INSTANCES="${VNC_INSTANCES:-$INSTANCES}"
  VNC_DISPLAY="${VNC_DISPLAY:-:100}"
  if [[ -r "${CONFIG_ROOT}/tunnel.env" ]]; then
    # shellcheck disable=SC1090
    set -a; source "${CONFIG_ROOT}/tunnel.env"; set +a
  fi
  PUBLIC_URL="${PUBLIC_URL:-$(sed -n '1p' "$STATE_ROOT/public.url" 2>/dev/null || true)}"
  return 0
}

status() {
  load_environment || die "This machine has no linux-browser-vnc installation."
  printf '## Units\n'
  local unit
  for unit in $(all_units); do
    printf '%-46s %-10s restarts=%s\n' "$unit" \
      "$(systemctl is-active "$unit" 2>/dev/null || true)" \
      "$(systemctl show "$unit" -p NRestarts --value 2>/dev/null || echo '-')"
  done
  printf '\n## Local health\n'
  health_json
  printf '\n## Public URL\n'
  cat "$STATE_ROOT/public.url" 2>/dev/null || printf 'not assigned\n'
}

print_url() {
  load_environment || die "This machine has no linux-browser-vnc installation."
  local url
  url="$(sed -n '1p' "$STATE_ROOT/public.url" 2>/dev/null || true)"
  [[ -n "$url" ]] || die "No public URL has been assigned yet."
  printf '%s\n' "$url"
}

verify() {
  load_environment || die "This machine has no linux-browser-vnc installation."
  local failures=0
  printf '## 1. Local health endpoint\n'
  local document
  document="$(health_json)"
  printf '%s\n' "${document:-no response}"
  grep -q '"ok": true' <<<"$document" || { printf 'FAIL: local health is not ok\n'; failures=$((failures + 1)); }

  printf '\n## 2. Loopback-only binding\n'
  local sport_expr="sport = :${RFB_PORT} or sport = :${NOVNC_PORT} or sport = :${HEALTH_PORT}"
  local i
  for (( i = 0; i < INSTANCES; i++ )); do
    sport_expr+=" or sport = :$(( DEBUG_PORT + i ))"
  done
  local exposed
  # [::1] is IPv6 loopback and safe; Chrome sometimes binds the DevTools port
  # there in addition to 127.0.0.1. Only a non-loopback address is a failure.
  exposed="$(ss -lnt "$sport_expr" 2>/dev/null | awk 'NR>1 {print $4}' \
    | grep -Ev '^(127\.0\.0\.1|\[::1\]):' || true)"
  if [[ -n "$exposed" ]]; then
    printf 'FAIL: non-loopback listeners: %s\n' "$exposed"
    failures=$((failures + 1))
  else
    printf 'ok: %s, %s, %s and DevTools %s-%s are loopback-only\n' \
      "$RFB_PORT" "$NOVNC_PORT" "$HEALTH_PORT" "$DEBUG_PORT" "$(( DEBUG_PORT + INSTANCES - 1 ))"
  fi

  printf '\n## 3. Public route\n'
  if [[ -z "$PUBLIC_URL" ]]; then
    printf 'FAIL: no public URL is recorded\n'
    failures=$((failures + 1))
  else
    printf 'url: %s\n' "$PUBLIC_URL"
    local state
    state="$(public_route_state "$PUBLIC_URL")"
    printf 'public /healthz: HTTP %s\n' "${state#* }"
    case "${state%% *}" in
      open) printf 'ok: reachable; the hostname is unauthenticated by owner decision (2026-08-03)\n' ;;
      access) printf 'ok: an access gate is enforcing this hostname\n' ;;
      redirect) printf 'FAIL: unexpected redirect target\n'; failures=$((failures + 1)) ;;
      *) printf 'FAIL: the public route did not answer\n'; failures=$((failures + 1)) ;;
    esac

    printf '\n## 3b. noVNC WebSocket upgrade through the public hostname\n'
    local ws_status=0
    python3 "${INSTALL_ROOT}/scripts/browser_probe.py" --websocket-check "$PUBLIC_URL" \
      || ws_status=$?
    if (( ws_status != 0 )); then
      printf 'FAIL: the public hostname did not complete a noVNC WebSocket upgrade\n'
      failures=$((failures + 1))
    fi
  fi

  printf '\n## 4. Browser process budget\n'
  local count ceiling
  count="$(pgrep -u "$DESKTOP_USER" -c -f 'chrom' 2>/dev/null || echo 0)"
  ceiling=$(( ${VNC_MAX_BROWSER_PROCESSES:-60} * INSTANCES ))
  printf 'desktop browser processes: %s across %s instance(s) (ceiling %s)\n' \
    "$count" "$INSTANCES" "$ceiling"
  if [[ "$count" =~ ^[0-9]+$ ]] && (( count > ceiling )); then
    printf 'FAIL: the browser process count exceeds its budget\n'
    failures=$((failures + 1))
  fi

  printf '\n## 5. Proxy separation\n'
  local tunnel_uid excluded
  tunnel_uid="$(id -u "$TUNNEL_USER" 2>/dev/null || echo '')"
  excluded="$(grep -A20 'exclude-uid' /etc/mihomo/config.yaml 2>/dev/null | grep -c -- "- ${tunnel_uid}\$" || true)"
  printf 'tunnel uid %s excluded from TUN: %s\n' "${tunnel_uid:-unknown}" \
    "$([[ "${excluded:-0}" -gt 0 ]] && echo yes || echo no)"
  if [[ "${excluded:-0}" -eq 0 ]]; then
    printf 'FAIL: the tunnel account is not excluded from TUN routing\n'
    failures=$((failures + 1))
  fi
  local desktop_uid
  desktop_uid="$(id -u "$DESKTOP_USER" 2>/dev/null || echo '')"
  if [[ -n "$desktop_uid" ]] && grep -A20 'exclude-uid' /etc/mihomo/config.yaml 2>/dev/null | grep -q -- "- ${desktop_uid}\$"; then
    printf 'FAIL: the desktop user is excluded from TUN and would bypass the proxy\n'
    failures=$((failures + 1))
  else
    printf 'desktop uid %s routed through TUN: yes\n' "${desktop_uid:-unknown}"
  fi

  printf '\n## 6. Measurements taken inside each desktop browser\n'
  local inst port probe_status
  for (( inst = 1; inst <= INSTANCES; inst++ )); do
    port=$(( DEBUG_PORT + inst - 1 ))
    printf -- '--- instance %s (DevTools %s) ---\n' "$inst" "$port"
    probe_status=0
    python3 "${INSTALL_ROOT}/scripts/browser_probe.py" \
      --debug-port "$port" \
      ${EXPECTED_IP:+--expected-ip "$EXPECTED_IP"} || probe_status=$?
    if (( probe_status != 0 )); then
      printf 'FAIL: instance %s in-browser probe reported a problem (exit %s)\n' "$inst" "$probe_status"
      failures=$((failures + 1))
    fi
  done

  printf '\n## Result\n'
  if (( failures == 0 )); then
    printf 'PASS: every automated check succeeded.\n'
    return 0
  fi
  printf 'FAIL: %s check(s) failed.\n' "$failures"
  return 1
}

# Upgrade an existing managed browser in place to the IPv4-only egress policy,
# then prove every browser instance from inside Chromium. This is intentionally
# narrower than `install`: it preserves profiles, ports, instance count, public
# tunnel and every Mihomo setting. Repeating it is safe.
harden_egress() {
  require_root
  load_environment || die "This machine has no linux-browser-vnc installation."
  [[ -n "$EXPECTED_IP" ]] || die "harden-egress requires --expected-ip."
  python3 - "$EXPECTED_IP" <<'PY' >/dev/null || die "--expected-ip must be IPv4."
import ipaddress, sys
ipaddress.IPv4Address(sys.argv[1])
PY

  local browser_unit="/etc/systemd/system/${BROWSER_TEMPLATE}"
  [[ -r "$browser_unit" ]] || die "The managed browser unit is missing."
  grep -q '^Description=Visible desktop browser instance' "$browser_unit" \
    || die "Refusing to edit an unrecognized browser unit."

  if grep -Eq '^RestrictAddressFamilies=.*(^|[[:space:]])AF_INET6([[:space:]]|$)' "$browser_unit"; then
    local rendered
    rendered="$(mktemp)"
    awk '
      /^RestrictAddressFamilies=/ {
        output = ""
        count = split($0, fields, /[[:space:]]+/)
        for (i = 1; i <= count; i++) if (fields[i] != "AF_INET6") {
          output = output (output == "" ? "" : " ") fields[i]
        }
        print output
        next
      }
      { print }
    ' "$browser_unit" > "$rendered"
    grep -q '^RestrictAddressFamilies=' "$rendered" \
      || { rm -f "$rendered"; die "The browser address-family policy could not be rendered."; }
    if grep -Eq '^RestrictAddressFamilies=.*(^|[[:space:]])AF_INET6([[:space:]]|$)' "$rendered"; then
      rm -f "$rendered"
      die "The browser address-family policy still permits IPv6."
    fi
    install -m 0644 "$rendered" "$browser_unit"
    rm -f "$rendered"
    systemctl daemon-reload
    log "Restricted managed browser sockets to proxied IPv4."
  else
    log "Managed browser is already restricted to IPv4; keeping the existing policy."
  fi

  local unit inst port probe_status
  for unit in $(browser_units); do systemctl restart "$unit"; done
  systemctl restart linux-browser-vnc-health.service
  wait_for_health 60 || die "The desktop is unhealthy after applying the egress policy."

  for (( inst = 1; inst <= INSTANCES; inst++ )); do
    port=$(( DEBUG_PORT + inst - 1 ))
    probe_status=0
    python3 "${INSTALL_ROOT}/scripts/browser_probe.py" \
      --debug-port "$port" --expected-ip "$EXPECTED_IP" || probe_status=$?
    (( probe_status == 0 )) \
      || die "Browser instance ${inst} failed the IPv4/WebRTC egress gate."
  done
  log "Every browser instance passed the IPv4/WebRTC egress gate."
}

repair() {
  require_root
  load_environment || die "This machine has no linux-browser-vnc installation."
  log "Restarting the desktop stack in dependency order."
  systemctl restart linux-browser-vnc-xvfb.service
  systemctl restart linux-browser-vnc-openbox.service
  systemctl restart linux-browser-vnc-x11vnc.service
  systemctl restart linux-browser-vnc-novnc.service
  local unit
  for unit in $(browser_units); do systemctl restart "$unit"; done
  systemctl restart linux-browser-vnc-health.service
  systemctl is-enabled --quiet "$PUBLIC_UNIT" 2>/dev/null \
    && systemctl restart "$PUBLIC_UNIT"
  wait_for_health 60 || die "The desktop is still unhealthy after a restart."
  log "The desktop recovered."
}

uninstall() {
  require_root
  log "Removing only this skill's units, files and desktop account."
  local unit
  # Discover live browser instances rather than assuming a count.
  while read -r unit; do
    [[ -n "$unit" ]] || continue
    systemctl disable --quiet --now "$unit" 2>/dev/null || true
  done < <(systemctl list-units --all --no-legend --no-pager \
    'linux-browser-vnc-browser@*.service' 2>/dev/null | awk '{print $1}')
  for unit in "${CORE_UNITS[@]}" "${WATCHDOG_UNITS[@]}"; do
    systemctl disable --quiet --now "$unit" 2>/dev/null || true
    rm -f "/etc/systemd/system/${unit}"
  done
  rm -f "/etc/systemd/system/${BROWSER_TEMPLATE}"
  systemctl daemon-reload
  systemctl reset-failed 2>/dev/null || true
  if [[ -f /etc/apparmor.d/linux-browser-vnc-browser ]]; then
    apparmor_parser -R /etc/apparmor.d/linux-browser-vnc-browser 2>/dev/null || true
    rm -f /etc/apparmor.d/linux-browser-vnc-browser
    log "Removed the AppArmor profile."
  fi
  rm -rf "$INSTALL_ROOT" "$CONFIG_ROOT"
  if [[ "${PURGE_PROFILE:-false}" == "true" ]]; then
    rm -rf "$STATE_ROOT"
    if id -u "$DESKTOP_USER" >/dev/null 2>&1; then
      userdel "$DESKTOP_USER" 2>/dev/null || true
    fi
    log "Removed the browser profile and the desktop account."
  else
    log "Kept ${STATE_ROOT} so the browser profile survives. Use --purge-profile to delete it."
  fi
  log "Mihomo, /etc/mihomo/config.yaml and every linux-clash-* unit were left untouched."
}

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift || true
case "$COMMAND" in
  inspect) parse_options "$@"; inspect ;;
  install) parse_options "$@"; install_all ;;
  status) parse_options "$@"; status ;;
  verify) parse_options "$@"; verify ;;
  harden-egress) parse_options "$@"; harden_egress ;;
  repair) parse_options "$@"; repair ;;
  print-url) parse_options "$@"; print_url ;;
  export-login|import-login)
    exec bash "${SCRIPT_DIR}/browser_sync.sh" "$COMMAND" "$@" ;;
  uninstall) parse_options "$@"; uninstall ;;
  -h|--help|"") usage; [[ -z "$COMMAND" ]] && exit 1 || exit 0 ;;
  *) die "Unknown command: $COMMAND" ;;
esac
