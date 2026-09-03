#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_TOOL="${SCRIPT_DIR}/config_tool.py"
ENVIRONMENT_TOOL="${SCRIPT_DIR}/environment_tool.py"
SERVICE_TEMPLATE="${SKILL_DIR}/assets/mihomo.service"
ROLLBACK_SOURCE="${SCRIPT_DIR}/rollback.sh"

STATE_ROOT="/var/lib/linux-clash-skill"
BACKUP_ROOT="${STATE_ROOT}/backups"
CURRENT_BACKUP="${STATE_ROOT}/current-backup"
SAFETY_UNIT="linux-clash-skill-safety"

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift || true
CONFIG_URL=""
CONFIG_URL_FILE=""
PROXY_NAME=""
SERVER_IP=""
EXPECTED_IP=""
ROLLBACK_SECONDS=180
ALIGN_TIMEZONE=0
EXCLUDE_UIDS=()
TMP_WORK=""
ROLLBACK_ARMED=0
SELECTED_PROXY_NAME=""
SELECTED_PROXY_SERVER=""
SELECTED_PROXY_PORT=""
SELECTED_SERVER_IP=""
PROBED_EXIT_IP=""
PROBED_UDP_EXIT_IP=""
VERIFIED_EXIT_IP=""
VERIFIED_UDP_EXIT_IP=""
VERIFIED_GENERIC_IP=""
VERIFIED_CHINA_IP=""
VERIFIED_CLOUDFLARE_IP=""
VERIFIED_CLAUDE_IP=""
VERIFIED_UDP_CLOUDFLARE_IP=""
VERIFIED_UDP_GOOGLE_IP=""
VERIFIED_TIMEZONE=""

log() { printf '[linux-clash-skill] %s\n' "$*"; }
die() { printf '[linux-clash-skill] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/linux-clash-skill.sh plan --config-url HTTPS_URL [--proxy-name NAME] [--server-ip IP] [--expected-ip IP]
  sudo bash scripts/linux-clash-skill.sh install --config-url HTTPS_URL [--proxy-name NAME] [--server-ip IP] [--expected-ip IP]
  sudo bash scripts/linux-clash-skill.sh verify [--expected-ip IP]
  sudo bash scripts/linux-clash-skill.sh disable
  sudo bash scripts/linux-clash-skill.sh rollback

Options:
  --config-url URL       Clash YAML URL. HTTPS is required.
  --config-url-file FILE Read the Clash YAML URL from a protected file instead of process arguments.
  --proxy-name NAME      Select a named SOCKS5 proxy. Defaults to the first proxy used by a group.
  --server-ip IP         Pin the proxy hostname to a verified IPv4 endpoint.
  --expected-ip IP       Fail unless the observed or transparent exit matches this IPv4 address.
  --exclude-uid UID      Keep this local user's traffic outside TUN. Repeatable; intended for cloudflared.
  --rollback-seconds N   Automatic safety rollback delay. Default: 180.
  --align-timezone       Set the Linux timezone to the verified exit timezone after validation.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-url) [[ $# -ge 2 ]] || die "Missing value for --config-url"; CONFIG_URL="$2"; shift 2 ;;
    --config-url-file) [[ $# -ge 2 ]] || die "Missing value for --config-url-file"; CONFIG_URL_FILE="$2"; shift 2 ;;
    --proxy-name) [[ $# -ge 2 ]] || die "Missing value for --proxy-name"; PROXY_NAME="$2"; shift 2 ;;
    --server-ip) [[ $# -ge 2 ]] || die "Missing value for --server-ip"; SERVER_IP="$2"; shift 2 ;;
    --expected-ip) [[ $# -ge 2 ]] || die "Missing value for --expected-ip"; EXPECTED_IP="$2"; shift 2 ;;
    --exclude-uid) [[ $# -ge 2 ]] || die "Missing value for --exclude-uid"; EXCLUDE_UIDS+=("$2"); shift 2 ;;
    --rollback-seconds) [[ $# -ge 2 ]] || die "Missing value for --rollback-seconds"; ROLLBACK_SECONDS="$2"; shift 2 ;;
    --align-timezone) ALIGN_TIMEZONE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

if [[ -n "$CONFIG_URL" && -n "$CONFIG_URL_FILE" ]]; then
  die "Use only one of --config-url or --config-url-file."
fi
if [[ -n "$CONFIG_URL_FILE" ]]; then
  [[ -f "$CONFIG_URL_FILE" && -r "$CONFIG_URL_FILE" ]] || die "Cannot read --config-url-file: $CONFIG_URL_FILE"
  IFS= read -r CONFIG_URL < "$CONFIG_URL_FILE" || [[ -n "$CONFIG_URL" ]] || die "--config-url-file is empty."
fi

cleanup() {
  if [[ -n "$TMP_WORK" && "$TMP_WORK" == /var/tmp/linux-clash-skill.* && -d "$TMP_WORK" ]]; then
    rm -rf -- "$TMP_WORK"
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && "$ROLLBACK_ARMED" == "1" ]]; then
    log "Installation failed; restoring the previous network state."
    systemctl stop "${SAFETY_UNIT}.timer" 2>/dev/null || true
    /usr/local/sbin/linux-clash-skill-rollback || true
  fi
  cleanup
  exit "$status"
}
trap on_exit EXIT

require_root() {
  [[ $EUID -eq 0 ]] || die "Run this command as root (sudo)."
}

validate_ipv4() {
  python3 - "$1" <<'PY' >/dev/null
import ipaddress, sys
value = ipaddress.ip_address(sys.argv[1])
if value.version != 4:
    raise SystemExit(1)
PY
}

check_platform() {
  [[ -r /etc/os-release ]] || die "Cannot identify the Linux distribution."
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-}" in
    ubuntu|debian|centos|rhel|rocky|almalinux|fedora) ;;
    *) die "Supported distributions are Ubuntu, Debian, CentOS, RHEL, Rocky, AlmaLinux, and Fedora; found: ${ID:-unknown}" ;;
  esac
  [[ -c /dev/net/tun ]] || die "/dev/net/tun is unavailable."
  command -v systemctl >/dev/null || die "systemd is required."
  command -v ip >/dev/null || die "iproute2 is required."
}

ensure_dependencies() {
  local need_install=0
  for tool in curl gzip python3 timeout getent; do
    command -v "$tool" >/dev/null || need_install=1
  done
  python3 -c 'import yaml' >/dev/null 2>&1 || need_install=1
  if [[ "$need_install" == "1" ]]; then
    log "Installing required packages."
    if command -v apt-get >/dev/null; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gzip python3 python3-yaml iproute2 util-linux passwd
    elif command -v dnf >/dev/null; then
      dnf install -y ca-certificates curl gzip python3 python3-pyyaml iproute util-linux shadow-utils
    else
      die "apt-get or dnf is required to install dependencies."
    fi
  fi
  python3 -c 'import yaml' >/dev/null 2>&1 || die "PyYAML is unavailable after dependency installation."
}

check_dependencies_without_writes() {
  for tool in curl python3 timeout getent; do
    command -v "$tool" >/dev/null || die "$tool is required for plan mode."
  done
  python3 -c 'import yaml' >/dev/null 2>&1 || die "python3-yaml is required for plan mode."
}

make_workspace() {
  TMP_WORK="$(mktemp -d /var/tmp/linux-clash-skill.XXXXXX)"
  chmod 0700 "$TMP_WORK"
}

fetch_source_config() {
  [[ "$CONFIG_URL" == https://* ]] || die "--config-url must use HTTPS."
  local output="${TMP_WORK}/source.yaml"
  log "Downloading and validating the Clash YAML source."
  curl -fsSL \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --connect-timeout 15 \
    --max-time 60 \
    --max-filesize 1048576 \
    -o "$output" \
    "$CONFIG_URL"
  chmod 0600 "$output"
  local proxy_args=()
  [[ -n "$PROXY_NAME" ]] && proxy_args+=(--proxy-name "$PROXY_NAME")
  python3 "$CONFIG_TOOL" inspect --source "$output" "${proxy_args[@]}" >/dev/null
}

proxy_field() {
  local field="$1"
  local proxy_args=()
  [[ -n "$PROXY_NAME" ]] && proxy_args+=(--proxy-name "$PROXY_NAME")
  python3 "$CONFIG_TOOL" field --source "${TMP_WORK}/source.yaml" --field "$field" "${proxy_args[@]}"
}

route_uses_tun() {
  local destination="$1" route_line route_device
  route_line="$(ip -4 route get "$destination" 2>/dev/null | head -n 1)" || return 1
  route_device="$(awk '{for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}' <<< "$route_line")"
  [[ -n "$route_device" ]] || return 1
  ip -d link show dev "$route_device" 2>/dev/null | grep -Eq '(^|[[:space:]])tun type tun([[:space:]]|$)'
}

resolve_proxy_endpoint() {
  if [[ -n "$EXPECTED_IP" ]]; then
    validate_ipv4 "$EXPECTED_IP" || die "Invalid --expected-ip: $EXPECTED_IP"
  fi
  SELECTED_PROXY_NAME="$(proxy_field name)"
  SELECTED_PROXY_SERVER="$(proxy_field server)"
  SELECTED_PROXY_PORT="$(proxy_field port)"

  local candidates=()
  local value
  add_candidate() {
    local candidate="$1"
    validate_ipv4 "$candidate" 2>/dev/null || return 0
    local existing
    for existing in "${candidates[@]:-}"; do
      [[ "$existing" == "$candidate" ]] && return 0
    done
    candidates+=("$candidate")
  }

  if [[ -n "$SERVER_IP" ]]; then
    validate_ipv4 "$SERVER_IP" || die "Invalid --server-ip: $SERVER_IP"
    add_candidate "$SERVER_IP"
  else
    while read -r value; do
      [[ -n "$value" ]] && add_candidate "$value"
    done < <(getent ahostsv4 "$SELECTED_PROXY_SERVER" | awk '!seen[$1]++ {print $1}')

    local doh_file="${TMP_WORK}/dns-google.json"
    if curl -fsS --get \
      --connect-timeout 10 \
      --max-time 20 \
      --data-urlencode "name=${SELECTED_PROXY_SERVER}" \
      --data 'type=A' \
      --data 'edns_client_subnet=223.5.5.0/24' \
      -o "$doh_file" \
      https://dns.google/resolve 2>/dev/null; then
      while read -r value; do
        [[ -n "$value" ]] && add_candidate "$value"
      done < <(python3 - "$doh_file" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
for answer in data.get("Answer", []):
    if answer.get("type") == 1:
        print(answer.get("data", ""))
PY
      )
    fi
  fi

  [[ ${#candidates[@]} -gt 0 ]] || die "No IPv4 candidates were found for the proxy endpoint."
  local proxy_args=() probe_ip udp_probe_ip working_candidate=0 expected_candidate=0 udp_candidate=0 captured_candidate=0 direct_candidate=0
  [[ -n "$PROXY_NAME" ]] && proxy_args+=(--proxy-name "$PROXY_NAME")
  for value in "${candidates[@]}"; do
    if route_uses_tun "$value"; then
      captured_candidate=1
      log "Skipping endpoint candidate ${value}: its current route is captured by an existing TUN."
      continue
    fi
    direct_candidate=1
    if probe_ip="$(python3 "$CONFIG_TOOL" probe \
      --source "${TMP_WORK}/source.yaml" \
      --server-ip "$value" \
      "${proxy_args[@]}" 2>/dev/null)"; then
      working_candidate=1
      if [[ -n "$EXPECTED_IP" && "$probe_ip" != "$EXPECTED_IP" ]]; then
        continue
      fi
      expected_candidate=1
      if ! udp_probe_ip="$(python3 "$CONFIG_TOOL" probe-udp \
        --source "${TMP_WORK}/source.yaml" \
        --server-ip "$value" \
        "${proxy_args[@]}" 2>/dev/null)"; then
        continue
      fi
      if [[ "$udp_probe_ip" != "$probe_ip" ]]; then
        continue
      fi
      udp_candidate=1
      SELECTED_SERVER_IP="$value"
      PROBED_EXIT_IP="$probe_ip"
      PROBED_UDP_EXIT_IP="$udp_probe_ip"
      break
    fi
  done
  if [[ -z "$SELECTED_SERVER_IP" && "$working_candidate" == "1" && "$expected_candidate" == "0" ]]; then
    die "The SOCKS5 proxy is reachable, but no candidate produced the expected exit IP ${EXPECTED_IP}."
  fi
  if [[ -z "$SELECTED_SERVER_IP" && "$expected_candidate" == "1" && "$udp_candidate" == "0" ]]; then
    die "The SOCKS5 proxy passed TCP checks, but no candidate produced the same exit over UDP."
  fi
  if [[ -z "$SELECTED_SERVER_IP" && "$captured_candidate" == "1" && "$direct_candidate" == "0" ]]; then
    die "No directly routed candidate is available. Stop the existing transparent TUN or add a direct route for the proxy endpoint, then run plan again."
  fi
  [[ -n "$SELECTED_SERVER_IP" ]] || die "No endpoint candidate passed SOCKS5 authentication, TLS, and exit-IP checks."
}

show_plan() {
  printf 'Proxy name:       %s\n' "$SELECTED_PROXY_NAME"
  printf 'Proxy type:       socks5\n'
  printf 'Proxy hostname:   %s\n' "$SELECTED_PROXY_SERVER"
  printf 'Proxy port:       %s\n' "$SELECTED_PROXY_PORT"
  printf 'Pinned server IP: %s\n' "$SELECTED_SERVER_IP"
  printf 'Observed TCP exit: %s\n' "$PROBED_EXIT_IP"
  printf 'Observed UDP exit: %s\n' "$PROBED_UDP_EXIT_IP"
  printf 'Routing mode:     transparent TUN, public traffic -> PROXY\n'
  printf 'Failure policy:   fail closed, automatic timed rollback\n'
}

backup_current_state() {
  local stamp backup_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -o root -g root -m 0700 "$BACKUP_ROOT"
  backup_dir="$(mktemp -d "${BACKUP_ROOT}/${stamp}.XXXXXX")"
  chown root:root "$backup_dir"
  chmod 0700 "$backup_dir"

  local hosts_existed=0 config_existed=0 service_existed=0 binary_existed=0
  [[ -f /etc/hosts ]] && hosts_existed=1
  [[ -f /etc/mihomo/config.yaml ]] && config_existed=1
  [[ -f /etc/systemd/system/mihomo.service ]] && service_existed=1
  [[ -f /usr/local/bin/mihomo ]] && binary_existed=1

  [[ "$hosts_existed" == "1" ]] && install -o root -g root -m 0600 /etc/hosts "$backup_dir/hosts"
  [[ "$config_existed" == "1" ]] && install -o root -g root -m 0600 /etc/mihomo/config.yaml "$backup_dir/config.yaml"
  [[ "$service_existed" == "1" ]] && install -o root -g root -m 0600 /etc/systemd/system/mihomo.service "$backup_dir/mihomo.service"
  [[ "$binary_existed" == "1" ]] && install -o root -g root -m 0700 /usr/local/bin/mihomo "$backup_dir/mihomo"

  local service_active service_enabled timezone_before
  service_active="$(systemctl is-active mihomo.service 2>/dev/null || true)"
  service_enabled="$(systemctl is-enabled mihomo.service 2>/dev/null || true)"
  timezone_before="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  [[ -n "$timezone_before" ]] || timezone_before="UTC"
  printf '%s\n' \
    "hosts_existed=${hosts_existed}" \
    "config_existed=${config_existed}" \
    "service_existed=${service_existed}" \
    "binary_existed=${binary_existed}" \
    "service_active=${service_active:-inactive}" \
    "service_enabled=${service_enabled:-disabled}" \
    > "$backup_dir/state.env"
  printf 'timezone_before=%q\n' "$timezone_before" >> "$backup_dir/state.env"
  chmod 0600 "$backup_dir/state.env"
  printf '%s\n' "$backup_dir" > "$CURRENT_BACKUP"
  chmod 0600 "$CURRENT_BACKUP"
  log "Saved rollback state in $backup_dir"
}

install_mihomo_binary() {
  local machine arch release_json asset_data tag asset_name asset_url digest expected_sha archive binary
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "Unsupported CPU architecture: $machine" ;;
  esac

  release_json="${TMP_WORK}/mihomo-release.json"
  curl -fsSL --connect-timeout 15 --max-time 60 \
    -o "$release_json" \
    https://api.github.com/repos/MetaCubeX/mihomo/releases/latest
  asset_data="$(python3 - "$release_json" "$arch" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
tag = data.get("tag_name", "")
wanted = f"mihomo-linux-{sys.argv[2]}-{tag}.gz"
for asset in data.get("assets", []):
    if asset.get("name") == wanted:
        print("\t".join([tag, wanted, asset.get("browser_download_url", ""), asset.get("digest", "")]))
        break
PY
  )"
  [[ -n "$asset_data" ]] || die "Official Mihomo release does not contain the expected Linux asset."
  IFS=$'\t' read -r tag asset_name asset_url digest <<< "$asset_data"
  [[ "$digest" == sha256:* ]] || die "Official release asset does not provide a SHA-256 digest."
  expected_sha="${digest#sha256:}"
  archive="${TMP_WORK}/${asset_name}"
  binary="${TMP_WORK}/mihomo"

  log "Downloading official Mihomo ${tag} for linux/${arch}."
  curl -fL --connect-timeout 15 --max-time 180 --retry 3 --retry-delay 2 -o "$archive" "$asset_url"
  printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c - >/dev/null
  gzip -dc "$archive" > "$binary"
  chmod 0755 "$binary"
  install -o root -g root -m 0755 "$binary" /usr/local/bin/mihomo
  /usr/local/bin/mihomo -v | head -n 1
}

install_runtime_files() {
  if ! id mihomo >/dev/null 2>&1; then
    local nologin_shell
    nologin_shell="$(command -v nologin || true)"
    [[ -n "$nologin_shell" ]] || nologin_shell="/sbin/nologin"
    useradd --system --home-dir /var/lib/mihomo --create-home --shell "$nologin_shell" mihomo
  fi
  local mihomo_uid
  mihomo_uid="$(id -u mihomo)"
  install -d -o root -g mihomo -m 0750 /etc/mihomo
  install -d -o mihomo -g mihomo -m 0750 /var/lib/mihomo

  local proxy_args=() exclude_args=() ssh_peer=""
  [[ -n "$PROXY_NAME" ]] && proxy_args+=(--proxy-name "$PROXY_NAME")
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    ssh_peer="${SSH_CONNECTION%% *}"
  elif [[ -n "${SSH_CLIENT:-}" ]]; then
    ssh_peer="${SSH_CLIENT%% *}"
  fi
  if [[ -n "$ssh_peer" ]] && validate_ipv4 "$ssh_peer" 2>/dev/null; then
    exclude_args+=(--exclude-address "${ssh_peer}/32")
    log "Preserving the current SSH peer route outside the TUN."
  fi
  local excluded_uid
  for excluded_uid in "${EXCLUDE_UIDS[@]}"; do
    [[ "$excluded_uid" =~ ^[0-9]+$ ]] || die "--exclude-uid must be a non-negative integer: $excluded_uid"
    exclude_args+=(--exclude-uid "$excluded_uid")
  done
  python3 "$CONFIG_TOOL" render \
    --source "${TMP_WORK}/source.yaml" \
    --output "${TMP_WORK}/config.yaml" \
    --server-ip "$SELECTED_SERVER_IP" \
    --mihomo-uid "$mihomo_uid" \
    "${exclude_args[@]}" \
    "${proxy_args[@]}"
  install -o root -g mihomo -m 0640 "${TMP_WORK}/config.yaml" /etc/mihomo/config.yaml

  python3 "$CONFIG_TOOL" set-host \
    --path /etc/hosts \
    --hostname "$SELECTED_PROXY_SERVER" \
    --ip "$SELECTED_SERVER_IP"
  chown root:root /etc/hosts
  chmod 0644 /etc/hosts

  install -o root -g root -m 0644 "$SERVICE_TEMPLATE" /etc/systemd/system/mihomo.service
  install -o root -g root -m 0700 "$ROLLBACK_SOURCE" /usr/local/sbin/linux-clash-skill-rollback
  runuser -u mihomo -- /usr/local/bin/mihomo -t -d /var/lib/mihomo -f /etc/mihomo/config.yaml
  systemd-analyze verify /etc/systemd/system/mihomo.service
}

arm_safety_rollback() {
  [[ "$ROLLBACK_SECONDS" =~ ^[0-9]+$ ]] || die "--rollback-seconds must be an integer."
  (( ROLLBACK_SECONDS >= 60 && ROLLBACK_SECONDS <= 900 )) || die "--rollback-seconds must be between 60 and 900."
  systemctl stop "${SAFETY_UNIT}.timer" 2>/dev/null || true
  systemctl reset-failed "${SAFETY_UNIT}.timer" "${SAFETY_UNIT}.service" 2>/dev/null || true
  systemd-run \
    --quiet \
    --unit="$SAFETY_UNIT" \
    --on-active="${ROLLBACK_SECONDS}s" \
    /usr/local/sbin/linux-clash-skill-rollback
  ROLLBACK_ARMED=1
  log "Armed automatic rollback for ${ROLLBACK_SECONDS} seconds."
}

cancel_safety_rollback() {
  systemctl stop "${SAFETY_UNIT}.timer" 2>/dev/null || true
  systemctl reset-failed "${SAFETY_UNIT}.timer" "${SAFETY_UNIT}.service" 2>/dev/null || true
  ROLLBACK_ARMED=0
}

extract_trace_ip() {
  sed -n 's/^ip=//p' | head -n 1
}

extract_first_ipv4() {
  python3 -c 'import ipaddress,re,sys
for candidate in re.findall(r"(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])", sys.stdin.read()):
    try:
        value = ipaddress.ip_address(candidate)
        if value.version == 4:
            print(value)
            break
    except ValueError:
        pass'
}

transparent_ip() {
  local url="$1"
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
    curl -4 -fsS --retry 1 --connect-timeout 15 --max-time 45 --noproxy '*' "$url"
}

transparent_china_ip() {
  local body ip
  body="$(transparent_ip https://2026.ip138.com/ 2>/dev/null || true)"
  ip="$(printf '%s' "$body" | extract_first_ipv4)"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
    return
  fi
  body="$(transparent_ip https://my.ip.cn/ 2>/dev/null || true)"
  ip="$(printf '%s' "$body" | extract_first_ipv4)"
  [[ -n "$ip" ]] || return 1
  printf '%s\n' "$ip"
}

verify_transparent_proxy() {
  systemctl is-active --quiet mihomo.service || die "mihomo.service is not active."
  ip link show Mihomo >/dev/null 2>&1 || die "Mihomo TUN interface is missing."

  local generic_ip china_ip cloudflare_ip claude_ip udp_cloudflare_ip udp_google_ip
  generic_ip="$(transparent_ip https://api64.ipify.org)"
  china_ip="$(transparent_china_ip || true)"
  cloudflare_ip="$(transparent_ip https://1.1.1.1/cdn-cgi/trace | extract_trace_ip)"
  claude_ip="$(transparent_ip https://claude.ai/cdn-cgi/trace | extract_trace_ip)"
  udp_cloudflare_ip="$(python3 "$CONFIG_TOOL" stun --target-host stun.cloudflare.com --target-port 3478)"
  udp_google_ip="$(python3 "$CONFIG_TOOL" stun --target-host stun.l.google.com --target-port 19302)"
  validate_ipv4 "$generic_ip" || die "Generic IP check returned an invalid address."
  if [[ -n "$china_ip" ]]; then
    validate_ipv4 "$china_ip" || die "China-site IP check returned an invalid address."
  else
    log "China-site IP checks were unavailable; retaining the five required generic/Cloudflare/Claude/STUN checks."
  fi
  validate_ipv4 "$cloudflare_ip" || die "Cloudflare trace returned an invalid address."
  validate_ipv4 "$claude_ip" || die "Claude trace returned an invalid address."
  validate_ipv4 "$udp_cloudflare_ip" || die "Cloudflare STUN returned an invalid address."
  validate_ipv4 "$udp_google_ip" || die "Google STUN returned an invalid address."
  [[ ( -z "$china_ip" || "$generic_ip" == "$china_ip" ) && "$generic_ip" == "$cloudflare_ip" && "$generic_ip" == "$claude_ip" && "$generic_ip" == "$udp_cloudflare_ip" && "$generic_ip" == "$udp_google_ip" ]] || {
    die "Transparent checks disagree: generic=${generic_ip}, china=${china_ip}, cloudflare=${cloudflare_ip}, claude=${claude_ip}, udp-cloudflare=${udp_cloudflare_ip}, udp-google=${udp_google_ip}"
  }
  if [[ -n "$EXPECTED_IP" ]]; then
    validate_ipv4 "$EXPECTED_IP" || die "Invalid --expected-ip: $EXPECTED_IP"
    [[ "$generic_ip" == "$EXPECTED_IP" ]] || die "Exit IP ${generic_ip} does not match expected IP ${EXPECTED_IP}."
  elif [[ -n "$PROBED_EXIT_IP" && "$generic_ip" != "$PROBED_EXIT_IP" ]]; then
    die "Transparent exit ${generic_ip} changed from preflight exit ${PROBED_EXIT_IP}."
  fi
  VERIFIED_EXIT_IP="$generic_ip"
  VERIFIED_UDP_EXIT_IP="$udp_cloudflare_ip"
  VERIFIED_GENERIC_IP="$generic_ip"
  VERIFIED_CHINA_IP="$china_ip"
  VERIFIED_CLOUDFLARE_IP="$cloudflare_ip"
  VERIFIED_CLAUDE_IP="$claude_ip"
  VERIFIED_UDP_CLOUDFLARE_IP="$udp_cloudflare_ip"
  VERIFIED_UDP_GOOGLE_IP="$udp_google_ip"
  log "Transparent TCP and UDP proxy verified: ${VERIFIED_EXIT_IP}"
}

align_exit_timezone() {
  [[ "$ALIGN_TIMEZONE" == "1" ]] || return 0
  command -v timedatectl >/dev/null 2>&1 || {
    log "Timezone alignment skipped: timedatectl is unavailable."
    return
  }
  local risk_payload timezone current_timezone
  risk_payload="$(transparent_ip "https://ip.net.coffee/api/iprisk/${VERIFIED_EXIT_IP}" 2>/dev/null || true)"
  if ! timezone="$(printf '%s' "$risk_payload" | python3 "$ENVIRONMENT_TOOL" exit-timezone 2>/dev/null)"; then
    log "Timezone alignment skipped: verified exit timezone is unavailable."
    return
  fi
  current_timezone="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  if [[ "$current_timezone" != "$timezone" ]]; then
    timedatectl set-timezone "$timezone"
    log "System timezone aligned to verified exit: ${timezone}."
  else
    log "System timezone already matches verified exit: ${timezone}."
  fi
  VERIFIED_TIMEZONE="$timezone"
}

write_result() {
  local output_dir result_path manifest_path
  output_dir="${SOP_OUTPUT_DIR:-${STATE_ROOT}}"
  install -d -o root -g root -m 0700 "$output_dir"
  result_path="${output_dir}/result.json"
  manifest_path="${output_dir}/manifest.json"
  python3 - "$result_path" "$VERIFIED_EXIT_IP" "$VERIFIED_UDP_EXIT_IP" "$SELECTED_PROXY_NAME" "$SELECTED_PROXY_SERVER" "$SELECTED_SERVER_IP" "$VERIFIED_GENERIC_IP" "$VERIFIED_CHINA_IP" "$VERIFIED_CLOUDFLARE_IP" "$VERIFIED_CLAUDE_IP" "$VERIFIED_UDP_CLOUDFLARE_IP" "$VERIFIED_UDP_GOOGLE_IP" "$VERIFIED_TIMEZONE" <<'PY'
import datetime, json, pathlib, sys
observed_paths = [sys.argv[7], sys.argv[9], sys.argv[10], sys.argv[11], sys.argv[12]]
if sys.argv[8]:
    observed_paths.append(sys.argv[8])
result = {
    "status": "ok",
    "transparent_proxy": True,
    "exit_ip": sys.argv[2],
    "udp_exit_ip": sys.argv[3],
    "tcp_udp_consistent": sys.argv[2] == sys.argv[3],
    "proxy_name": sys.argv[4],
    "proxy_hostname": sys.argv[5],
    "pinned_server_ip": sys.argv[6],
    "generic_exit_ip": sys.argv[7],
    "china_exit_ip": sys.argv[8],
    "cloudflare_exit_ip": sys.argv[9],
    "claude_exit_ip": sys.argv[10],
    "udp_cloudflare_exit_ip": sys.argv[11],
    "udp_google_exit_ip": sys.argv[12],
    "china_path_verified": bool(sys.argv[8]),
    "all_paths_consistent": len(set(observed_paths)) == 1,
    "exit_timezone": sys.argv[13],
    "timezone_aligned": bool(sys.argv[13]),
    "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  python3 - "$manifest_path" <<'PY'
import json, pathlib, sys
manifest = {"artifacts": [{"name": "result.json", "path": "result.json", "mime_type": "application/json"}]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
  chmod 0600 "$result_path" "$manifest_path"
  log "Result: $result_path"
}

run_plan() {
  [[ -n "$CONFIG_URL" ]] || die "plan requires --config-url."
  check_platform
  check_dependencies_without_writes
  make_workspace
  fetch_source_config
  resolve_proxy_endpoint
  show_plan
}

run_install() {
  [[ -n "$CONFIG_URL" ]] || die "install requires --config-url."
  require_root
  check_platform
  ensure_dependencies
  make_workspace
  fetch_source_config
  resolve_proxy_endpoint
  show_plan
  backup_current_state
  install -o root -g root -m 0700 "$ROLLBACK_SOURCE" /usr/local/sbin/linux-clash-skill-rollback
  arm_safety_rollback
  install_mihomo_binary
  install_runtime_files
  systemctl daemon-reload
  systemctl enable mihomo.service
  systemctl restart mihomo.service
  sleep 2
  verify_transparent_proxy
  align_exit_timezone
  cancel_safety_rollback
  write_result
  log "Installation complete. Public traffic is now transparently proxied."
}

run_verify() {
  require_root
  verify_transparent_proxy
  align_exit_timezone
  if [[ -f /etc/mihomo/config.yaml ]]; then
    SELECTED_PROXY_NAME="$(python3 "$CONFIG_TOOL" field --source /etc/mihomo/config.yaml --field name)"
    SELECTED_PROXY_SERVER="$(python3 "$CONFIG_TOOL" field --source /etc/mihomo/config.yaml --field server)"
    SELECTED_SERVER_IP="$(getent ahostsv4 "$SELECTED_PROXY_SERVER" 2>/dev/null | awk 'NR==1 {print $1}')"
  fi
  write_result
}

run_rollback() {
  require_root
  local rollback="/usr/local/sbin/linux-clash-skill-rollback"
  [[ -x "$rollback" ]] || rollback="$ROLLBACK_SOURCE"
  bash "$rollback"
}

run_disable() {
  require_root
  cancel_safety_rollback
  systemctl disable --now mihomo.service >/dev/null 2>&1 || true
  local attempt
  for attempt in {1..20}; do
    ip link show Mihomo >/dev/null 2>&1 || {
      log "Mihomo is disabled; existing files were retained for safe adoption."
      return
    }
    sleep 0.25
  done
  die "mihomo.service stopped but the Mihomo TUN interface is still present."
}

case "$COMMAND" in
  plan) run_plan ;;
  install) run_install ;;
  verify) run_verify ;;
  disable) run_disable ;;
  rollback) run_rollback ;;
  -h|--help|help|"") usage ;;
  *) usage; die "Unknown command: $COMMAND" ;;
esac
