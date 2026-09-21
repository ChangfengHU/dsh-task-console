#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ASSET_DIR="${SKILL_DIR}/assets"
INSTALL_ROOT="/usr/local/lib/linux-clash-skill"
CONFIG_ROOT="/etc/linux-clash-skill"
STATE_ROOT="/var/lib/linux-clash-skill"
TUNNEL_USER="linux-clash-tunnel"
DASHBOARD_USER="linux-clash-dashboard"

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift || true
CONFIG_URL=""
CONFIG_URL_FILE=""
EXPECTED_IP=""
PROXY_NAME=""
SERVER_IP=""
NODE_NAME="$(hostname -s 2>/dev/null || hostname)"
NODE_ID=""
NODE_URL=""
CONTROLLER_PORT=8788
DASHBOARD_PORT=8787
CONTROLLER_TOKEN_FILE=""
TUNNEL_TOKEN_FILE=""
TUNNEL_INSTANCE=""
AUTO_DOMAIN_ROOT=""
PUBLIC_NAME=""
ALIGN_TIMEZONE=true
PUBLIC_PREVIEW=true

log() { printf '[linux-clash-control] %s\n' "$*"; }
die() { printf '[linux-clash-control] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/control_plane.sh install-machine (--config-url HTTPS_URL | --config-url-file FILE) [--expected-ip IP] [--proxy-name NAME] [--server-ip IP] [--node-name NAME] [--public-name NAME] [--auto-domain-root DIR] [--no-public-preview] [--preserve-timezone]
  sudo bash scripts/control_plane.sh install-node (--config-url HTTPS_URL | --config-url-file FILE) [--expected-ip IP] [--proxy-name NAME] [--server-ip IP] [--node-name NAME] [--controller-port PORT] [--tunnel-token-file FILE] [--preserve-timezone]
  sudo bash scripts/control_plane.sh install-dashboard [--dashboard-port PORT] [--tunnel-token-file FILE]
  sudo bash scripts/control_plane.sh add-node --node-id ID --node-name NAME --node-url HTTPS_URL --controller-token-file FILE
  sudo bash scripts/control_plane.sh install-tunnel --tunnel-instance NAME --tunnel-token-file FILE

Tunnel tokens and controller tokens must be supplied through files, never command-line values.
The named tunnel must already have a public hostname whose origin is the loopback service.
install-machine is the default isolated deployment: local Controller + Dashboard + unique auto-domain hostname.
Use --no-public-preview when a production named Cloudflare tunnel will publish the Dashboard.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-url) [[ $# -ge 2 ]] || die "Missing value for --config-url"; CONFIG_URL="$2"; shift 2 ;;
    --config-url-file) [[ $# -ge 2 ]] || die "Missing value for --config-url-file"; CONFIG_URL_FILE="$2"; shift 2 ;;
    --expected-ip) [[ $# -ge 2 ]] || die "Missing value for --expected-ip"; EXPECTED_IP="$2"; shift 2 ;;
    --proxy-name) [[ $# -ge 2 ]] || die "Missing value for --proxy-name"; PROXY_NAME="$2"; shift 2 ;;
    --server-ip) [[ $# -ge 2 ]] || die "Missing value for --server-ip"; SERVER_IP="$2"; shift 2 ;;
    --node-name) [[ $# -ge 2 ]] || die "Missing value for --node-name"; NODE_NAME="$2"; shift 2 ;;
    --node-id) [[ $# -ge 2 ]] || die "Missing value for --node-id"; NODE_ID="$2"; shift 2 ;;
    --node-url) [[ $# -ge 2 ]] || die "Missing value for --node-url"; NODE_URL="$2"; shift 2 ;;
    --controller-port) [[ $# -ge 2 ]] || die "Missing value for --controller-port"; CONTROLLER_PORT="$2"; shift 2 ;;
    --dashboard-port) [[ $# -ge 2 ]] || die "Missing value for --dashboard-port"; DASHBOARD_PORT="$2"; shift 2 ;;
    --controller-token-file) [[ $# -ge 2 ]] || die "Missing value for --controller-token-file"; CONTROLLER_TOKEN_FILE="$2"; shift 2 ;;
    --tunnel-token-file) [[ $# -ge 2 ]] || die "Missing value for --tunnel-token-file"; TUNNEL_TOKEN_FILE="$2"; shift 2 ;;
    --tunnel-instance) [[ $# -ge 2 ]] || die "Missing value for --tunnel-instance"; TUNNEL_INSTANCE="$2"; shift 2 ;;
    --auto-domain-root) [[ $# -ge 2 ]] || die "Missing value for --auto-domain-root"; AUTO_DOMAIN_ROOT="$2"; shift 2 ;;
    --public-name) [[ $# -ge 2 ]] || die "Missing value for --public-name"; PUBLIC_NAME="$2"; shift 2 ;;
    --preserve-timezone) ALIGN_TIMEZONE=false; shift ;;
    --no-public-preview) PUBLIC_PREVIEW=false; shift ;;
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

require_root() {
  [[ $EUID -eq 0 ]] || die "Run this command as root (sudo)."
}

validate_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )) || die "Invalid TCP port: $value"
}

validate_instance() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "Tunnel instance must use lowercase letters, digits, and hyphens."
}

validate_public_name() {
  validate_instance "$1"
  (( ${#1} <= 48 )) || die "Public preview name must be 48 characters or fewer."
}

wait_for_health() {
  local port="$1" service="$2" attempt
  for attempt in {1..40}; do
    if curl -fsS --noproxy '*' --connect-timeout 1 --max-time 2 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  systemctl status "$service" --no-pager -l >&2 || true
  die "Service did not become healthy: $service"
}

nologin_shell() {
  command -v nologin 2>/dev/null || printf '/sbin/nologin\n'
}

ensure_dependencies() {
  local need=0 tool
  for tool in curl gzip python3 systemctl sha256sum; do
    command -v "$tool" >/dev/null || need=1
  done
  python3 -c 'import yaml' >/dev/null 2>&1 || need=1
  if [[ "$need" == "1" ]]; then
    log "Installing control-plane dependencies."
    if command -v apt-get >/dev/null; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gzip python3 python3-yaml iproute2 util-linux passwd
    elif command -v dnf >/dev/null; then
      dnf install -y ca-certificates curl gzip python3 python3-pyyaml iproute util-linux shadow-utils
    else
      die "apt-get or dnf is required to install dependencies."
    fi
  fi
  python3 -c 'import yaml' >/dev/null 2>&1 || die "PyYAML is unavailable."
}

ensure_system_user() {
  local user="$1" state_dir="$2"
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --home-dir "$state_dir" --create-home --shell "$(nologin_shell)" "$user"
  fi
}

install_common_files() {
  install -d -o root -g root -m 0755 "$INSTALL_ROOT/scripts" "$INSTALL_ROOT/assets"
  install -o root -g root -m 0755 \
    "$SCRIPT_DIR/config_tool.py" \
    "$SCRIPT_DIR/node_controller.py" \
    "$SCRIPT_DIR/dashboard.py" \
    "$SCRIPT_DIR/machine_identity.py" \
    "$SCRIPT_DIR/environment_tool.py" \
    "$SCRIPT_DIR/dashboard_public_tunnel.sh" \
    "$SCRIPT_DIR/dashboard_public_watchdog.sh" \
    "$INSTALL_ROOT/scripts/"
  install -o root -g root -m 0700 \
    "$SCRIPT_DIR/linux-clash-skill.sh" \
    "$SCRIPT_DIR/rollback.sh" \
    "$SCRIPT_DIR/control_plane.sh" \
    "$INSTALL_ROOT/scripts/"
  install -o root -g root -m 0644 "$ASSET_DIR/mihomo.service" "$INSTALL_ROOT/assets/mihomo.service"
  install -d -o root -g root -m 0755 /usr/local/share/linux-clash-dashboard
  install -o root -g root -m 0644 "$ASSET_DIR/dashboard/"* /usr/local/share/linux-clash-dashboard/
  # Traverse-only for non-root service users; individual files/directories remain group-scoped.
  install -d -o root -g root -m 0751 "$CONFIG_ROOT"
}

generate_secret_file() {
  local path="$1" owner="$2" group="$3" mode="$4"
  if [[ ! -s "$path" ]]; then
    umask 077
    python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > "$path"
  fi
  chown "$owner:$group" "$path"
  chmod "$mode" "$path"
}

install_cloudflared_binary() {
  if [[ -x /usr/local/bin/cloudflared ]]; then
    return
  fi
  local existing
  existing="$(command -v cloudflared || true)"
  if [[ -n "$existing" ]]; then
    install -o root -g root -m 0755 "$existing" /usr/local/bin/cloudflared
    return
  fi

  local machine arch workspace metadata asset_data asset_url digest binary
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "Unsupported cloudflared architecture: $machine" ;;
  esac
  workspace="$(mktemp -d /var/tmp/linux-clash-cloudflared.XXXXXX)"
  trap 'rm -rf -- "${workspace:-}"' RETURN
  metadata="$workspace/release.json"
  curl -fsSL --connect-timeout 15 --max-time 60 -o "$metadata" https://api.github.com/repos/cloudflare/cloudflared/releases/latest
  asset_data="$(python3 - "$metadata" "cloudflared-linux-${arch}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
for asset in data.get("assets", []):
    if asset.get("name") == sys.argv[2]:
        print("\t".join([asset.get("browser_download_url", ""), asset.get("digest", "")]))
        break
PY
  )"
  [[ -n "$asset_data" ]] || die "Official cloudflared release is missing the expected Linux asset."
  IFS=$'\t' read -r asset_url digest <<< "$asset_data"
  [[ "$digest" == sha256:* ]] || die "Official cloudflared asset does not provide a SHA-256 digest."
  binary="$workspace/cloudflared"
  curl -fL --connect-timeout 15 --max-time 180 --retry 3 -o "$binary" "$asset_url"
  printf '%s  %s\n' "${digest#sha256:}" "$binary" | sha256sum -c - >/dev/null
  install -o root -g root -m 0755 "$binary" /usr/local/bin/cloudflared
  /usr/local/bin/cloudflared --version
  rm -rf -- "$workspace"
  trap - RETURN
}

install_tunnel_service() {
  local instance="$1" source_token="$2"
  validate_instance "$instance"
  [[ -f "$source_token" ]] || die "Tunnel token file does not exist: $source_token"
  ensure_system_user "$TUNNEL_USER" /var/lib/linux-clash-tunnel
  install_cloudflared_binary
  install -d -o root -g "$TUNNEL_USER" -m 0750 "$CONFIG_ROOT/tunnels"
  local destination_token="$CONFIG_ROOT/tunnels/${instance}.token"
  if [[ "$(readlink -f "$source_token")" != "$(readlink -m "$destination_token")" ]]; then
    install -o root -g "$TUNNEL_USER" -m 0640 "$source_token" "$destination_token"
  else
    chown root:"$TUNNEL_USER" "$destination_token"
    chmod 0640 "$destination_token"
  fi
  install -o root -g root -m 0644 "$ASSET_DIR/linux-clash-tunnel@.service" /etc/systemd/system/linux-clash-tunnel@.service
  systemctl daemon-reload
  systemctl enable "linux-clash-tunnel@${instance}.service"
  systemctl restart "linux-clash-tunnel@${instance}.service"
  log "Tunnel service started: linux-clash-tunnel@${instance}.service"
}

install_node() {
  validate_port "$CONTROLLER_PORT"
  ensure_system_user "$TUNNEL_USER" /var/lib/linux-clash-tunnel
  local tunnel_uid config_path
  tunnel_uid="$(id -u "$TUNNEL_USER")"
  config_path="$CONFIG_ROOT/controller.json"
  if [[ -f "$config_path" ]]; then
    log "Preserving existing controller settings; use the Dashboard replace action to change the proxy source."
    python3 - "$config_path" "$tunnel_uid" "$STATE_ROOT/result.json" "$ALIGN_TIMEZONE" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
uids = value.setdefault("exclude_uids", [])
uid = int(sys.argv[2])
if uid not in uids:
    uids.append(uid)
if "align_timezone" not in value or sys.argv[4] == "false":
    value["align_timezone"] = sys.argv[4] == "true"
result_path = pathlib.Path(sys.argv[3])
try:
    result = json.loads(result_path.read_text(encoding="utf-8"))
except (FileNotFoundError, json.JSONDecodeError, OSError):
    result = {}
if not value.get("server_ip") and result.get("pinned_server_ip"):
    value["server_ip"] = result["pinned_server_ip"]
if not value.get("expected_ip") and result.get("exit_ip"):
    value["expected_ip"] = result["exit_ip"]
temporary = path.with_suffix(".tmp")
temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
  else
    [[ -n "$CONFIG_URL" ]] || die "install-node requires --config-url on first installation."
    python3 - "$config_path" "$NODE_NAME" "$CONFIG_URL" "$EXPECTED_IP" "$PROXY_NAME" "$SERVER_IP" "$tunnel_uid" "$ALIGN_TIMEZONE" <<'PY'
import ipaddress, json, os, pathlib, sys, urllib.parse
path, name, url, expected, proxy_name, server_ip, tunnel_uid, align_timezone = sys.argv[1:]
parsed = urllib.parse.urlsplit(url)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
    raise SystemExit("config URL must be HTTPS without userinfo or fragment")
if expected and ipaddress.ip_address(expected).version != 4:
    raise SystemExit("expected IP must be IPv4")
if server_ip and ipaddress.ip_address(server_ip).version != 4:
    raise SystemExit("server IP must be IPv4")
value = {
    "node_name": name[:200],
    "config_url": url,
    "expected_ip": expected,
    "proxy_name": proxy_name[:200],
    "server_ip": server_ip,
    "rollback_seconds": 180,
    "exclude_uids": [int(tunnel_uid)],
    "align_timezone": align_timezone == "true",
}
temporary = pathlib.Path(path + ".tmp")
temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
  fi
  generate_secret_file "$CONFIG_ROOT/controller.token" root root 0600
  printf 'CONTROLLER_PORT=%s\n' "$CONTROLLER_PORT" > "$CONFIG_ROOT/node-controller.env"
  chmod 0644 "$CONFIG_ROOT/node-controller.env"
  install -o root -g root -m 0644 "$ASSET_DIR/linux-clash-node-controller.service" /etc/systemd/system/linux-clash-node-controller.service
  systemctl daemon-reload
  systemctl enable linux-clash-node-controller.service
  systemctl restart linux-clash-node-controller.service
  wait_for_health "$CONTROLLER_PORT" linux-clash-node-controller.service
  if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
    install_tunnel_service node "$TUNNEL_TOKEN_FILE"
  fi
  log "Node controller is listening on 127.0.0.1:${CONTROLLER_PORT}."
  log "Controller token remains root-only at ${CONFIG_ROOT}/controller.token; transfer it securely to the Dashboard host."
  log "First proxy enable will exclude cloudflared UID ${tunnel_uid} from TUN."
}

install_dashboard() {
  validate_port "$DASHBOARD_PORT"
  ensure_system_user "$DASHBOARD_USER" /var/lib/linux-clash-dashboard
  install -d -o root -g "$DASHBOARD_USER" -m 0750 "$CONFIG_ROOT/node-tokens"
  generate_secret_file "$CONFIG_ROOT/dashboard.token" root "$DASHBOARD_USER" 0640
  if [[ ! -f "$CONFIG_ROOT/nodes.json" ]]; then
    printf '{\n  "nodes": []\n}\n' > "$CONFIG_ROOT/nodes.json"
  fi
  chown root:"$DASHBOARD_USER" "$CONFIG_ROOT/nodes.json"
  chmod 0640 "$CONFIG_ROOT/nodes.json"
  printf 'DASHBOARD_PORT=%s\n' "$DASHBOARD_PORT" > "$CONFIG_ROOT/dashboard.env"
  chmod 0644 "$CONFIG_ROOT/dashboard.env"
  install -o root -g root -m 0644 "$ASSET_DIR/linux-clash-dashboard.service" /etc/systemd/system/linux-clash-dashboard.service
  systemctl daemon-reload
  systemctl enable linux-clash-dashboard.service
  systemctl restart linux-clash-dashboard.service
  wait_for_health "$DASHBOARD_PORT" linux-clash-dashboard.service
  if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
    install_tunnel_service dashboard "$TUNNEL_TOKEN_FILE"
  fi
  log "Dashboard is listening on 127.0.0.1:${DASHBOARD_PORT}."
  log "Dashboard is public read-only; management-mode token: ${CONFIG_ROOT}/dashboard.token."
}

machine_identity_value() {
  local field="$1"
  python3 "$INSTALL_ROOT/scripts/machine_identity.py" --format "$field"
}

configured_public_name() {
  local path="$CONFIG_ROOT/dashboard-public.env" value=""
  [[ -r "$path" ]] || return 1
  value="$(sed -n 's/^PUBLIC_NAME=//p' "$path" | tail -n 1)"
  [[ "$value" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || return 1
  printf '%s\n' "$value"
}

direct_public_ipv4() {
  local value=""
  # An active Mihomo TUN would report the proxy exit, not this machine's
  # direct address. Existing installs retain their recorded public name.
  if command -v ip >/dev/null 2>&1 && ip link show Mihomo >/dev/null 2>&1; then
    return 1
  fi
  value="$(
    env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy \
      -u HTTPS_PROXY -u https_proxy -u NO_PROXY -u no_proxy \
      curl -4 --noproxy '*' -fsS --connect-timeout 5 --max-time 10 \
      https://api64.ipify.org 2>/dev/null
  )" || return 1
  python3 - "$value" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1].strip())
except ValueError:
    raise SystemExit(1)
if address.version != 4:
    raise SystemExit(1)
print(address)
PY
}

default_public_name() {
  local existing="" public_ip=""
  existing="$(configured_public_name || true)"
  if [[ -n "$existing" ]]; then
    printf '%s\n' "$existing"
    return
  fi
  public_ip="$(direct_public_ipv4 || true)"
  if [[ -n "$public_ip" ]]; then
    python3 "$INSTALL_ROOT/scripts/machine_identity.py" \
      --public-ip "$public_ip" --format public-name
    return
  fi
  machine_identity_value public-name
}

reset_effective_public_name_if_requested_changed() {
  local previous_requested="$1" requested="$2" name_file="$3" \
    effective_name="" service_state=""
  effective_name="$(sed -n '1p' "$name_file" 2>/dev/null || true)"
  if [[ -n "$previous_requested" && "$previous_requested" == "$requested" ]] && \
    { [[ "$effective_name" == "$requested" ]] || \
      [[ "$effective_name" =~ ^${requested}-[0-9a-f]{4}$ ]]; }; then
    return
  fi
  # Stop the old writer before clearing its state. Otherwise it can race the
  # restart and restore the old effective name or URL after we truncate them.
  service_state="$(systemctl is-active linux-clash-dashboard-public.service 2>/dev/null || true)"
  case "$service_state" in
    active|activating|reloading|deactivating)
      systemctl stop linux-clash-dashboard-public.service >/dev/null 2>&1 || \
        die "Could not stop the previous public Dashboard tunnel for hostname migration."
      ;;
    inactive|failed|unknown) ;;
    *) die "Could not determine whether the previous public Dashboard tunnel has stopped." ;;
  esac
  service_state="$(systemctl is-active linux-clash-dashboard-public.service 2>/dev/null || true)"
  case "$service_state" in
    inactive|failed|unknown) ;;
    *) die "Previous public Dashboard tunnel is still ${service_state}; refusing to clear hostname state." ;;
  esac
  # dashboard_public_tunnel.sh normally reuses this effective name so a
  # collision suffix remains stable. Clear it only for a fresh request or an
  # explicit migration; otherwise it would silently override --public-name.
  install -o "$TUNNEL_USER" -g "$TUNNEL_USER" -m 0644 /dev/null "$name_file"
}

register_local_machine() {
  local node_id="$1" token_destination next_registry backup
  validate_instance "$node_id"
  token_destination="$CONFIG_ROOT/node-tokens/${node_id}.token"
  install -o root -g "$DASHBOARD_USER" -m 0640 "$CONFIG_ROOT/controller.token" "$token_destination"
  next_registry="${CONFIG_ROOT}/nodes.json.next"
  python3 - "$next_registry" "$node_id" "$NODE_NAME" "$CONTROLLER_PORT" "$token_destination" <<'PY'
import json, os, pathlib, sys
path, node_id, name, port, token_file = sys.argv[1:]
value = {
    "nodes": [{
        "id": node_id,
        "name": name[:200] or node_id,
        "url": f"http://127.0.0.1:{int(port)}",
        "token_file": token_file,
    }]
}
target = pathlib.Path(path)
target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(target, 0o640)
PY
  if [[ -f "$CONFIG_ROOT/nodes.json" ]] && ! cmp -s "$CONFIG_ROOT/nodes.json" "$next_registry"; then
    backup="${CONFIG_ROOT}/nodes.central-backup.$(date -u +%Y%m%dT%H%M%SZ).json"
    install -o root -g "$DASHBOARD_USER" -m 0640 "$CONFIG_ROOT/nodes.json" "$backup"
    log "Previous Dashboard registry preserved at ${backup}."
  fi
  mv -f "$next_registry" "$CONFIG_ROOT/nodes.json"
  chown root:"$DASHBOARD_USER" "$CONFIG_ROOT/nodes.json"
  chmod 0640 "$CONFIG_ROOT/nodes.json"
  systemctl restart linux-clash-dashboard.service
  wait_for_health "$DASHBOARD_PORT" linux-clash-dashboard.service
  log "Dashboard registry is isolated to this machine (${node_id})."
}

find_auto_domain_root() {
  local candidate sudo_home=""
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | awk -F: '{print $6}' || true)"
  fi
  for candidate in \
    "$AUTO_DOMAIN_ROOT" \
    "$SKILL_DIR/../auto-domain" \
    "/root/.codex/skills/auto-domain" \
    "/root/.claude/skills/auto-domain" \
    "${sudo_home:+${sudo_home}/.codex/skills/auto-domain}" \
    "${sudo_home:+${sudo_home}/.claude/skills/auto-domain}" \
    "/usr/local/lib/linux-clash-auto-domain"; do
    [[ -n "$candidate" ]] || continue
    if [[ -x "$candidate/scripts/run.sh" && -f "$candidate/agent/agent.js" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

install_auto_domain_runtime() {
  local source_root node_major
  source_root="$(find_auto_domain_root || true)"
  if [[ -z "$source_root" ]]; then
    die "auto-domain Skill is required. Install it first with: bash <(curl -fsSL https://skill.vyibc.com/install-auto-domain.sh) codex"
  fi
  command -v node >/dev/null 2>&1 || die "auto-domain requires Node.js 18 or newer."
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 18 )) || die "auto-domain requires Node.js 18 or newer."

  if [[ "$(readlink -f "$source_root")" != "/usr/local/lib/linux-clash-auto-domain" ]]; then
    install -d -o root -g root -m 0755 \
      /usr/local/lib/linux-clash-auto-domain/scripts \
      /usr/local/lib/linux-clash-auto-domain/agent
    cp -a "$source_root/scripts/." /usr/local/lib/linux-clash-auto-domain/scripts/
    cp -a "$source_root/agent/." /usr/local/lib/linux-clash-auto-domain/agent/
  fi
  chown -R root:root /usr/local/lib/linux-clash-auto-domain
  chmod 0755 /usr/local/lib/linux-clash-auto-domain/scripts/run.sh
  command -v npm >/dev/null 2>&1 || die "npm is required to install the auto-domain runtime."
  if [[ -f /usr/local/lib/linux-clash-auto-domain/agent/package-lock.json ]]; then
    npm --prefix /usr/local/lib/linux-clash-auto-domain/agent ci --omit=dev --ignore-scripts
  else
    npm --prefix /usr/local/lib/linux-clash-auto-domain/agent install --omit=dev --ignore-scripts
  fi
  # control_plane.sh runs with umask 077. npm therefore creates node_modules as
  # root-only on a fresh RHEL/CentOS install unless we explicitly make the
  # copied runtime readable by the dedicated, unprivileged tunnel user.
  chown -R root:root /usr/local/lib/linux-clash-auto-domain
  chmod -R a+rX,go-w /usr/local/lib/linux-clash-auto-domain
}

wait_for_public_url() {
  local attempt url="" state_url="/var/lib/linux-clash-tunnel/dashboard-public.url"
  for attempt in {1..60}; do
    url="$(sed -n '1p' "$state_url" 2>/dev/null || true)"
    if [[ "$url" =~ ^https://[a-z0-9-]+\.[a-z0-9.-]+/?$ ]]; then
      log "Machine Dashboard public URL: ${url}"
      return
    fi
    sleep 0.5
  done
  systemctl status linux-clash-dashboard-public.service --no-pager -l >&2 || true
  die "Public Dashboard tunnel did not receive a hostname."
}

install_public_preview() {
  local public_name="$1" previous_public_name="" \
    state_url="/var/lib/linux-clash-tunnel/dashboard-public.url" \
    state_name="/var/lib/linux-clash-tunnel/dashboard-public.name"
  validate_public_name "$public_name"
  validate_port "$DASHBOARD_PORT"
  previous_public_name="$(configured_public_name || true)"
  ensure_system_user "$TUNNEL_USER" /var/lib/linux-clash-tunnel
  install_auto_domain_runtime
  install -d -o "$TUNNEL_USER" -g "$TUNNEL_USER" -m 0700 /var/lib/linux-clash-tunnel
  reset_effective_public_name_if_requested_changed \
    "$previous_public_name" "$public_name" "$state_name"
  install -o "$TUNNEL_USER" -g "$TUNNEL_USER" -m 0644 /dev/null "$state_url"
  ln -sfn "$state_url" "$CONFIG_ROOT/dashboard-public.url"
  printf 'DASHBOARD_PORT=%s\nPUBLIC_NAME=%s\n' "$DASHBOARD_PORT" "$public_name" > "$CONFIG_ROOT/dashboard-public.env"
  chown root:root "$CONFIG_ROOT/dashboard-public.env"
  chmod 0644 "$CONFIG_ROOT/dashboard-public.env"
  install -o root -g root -m 0644 "$ASSET_DIR/linux-clash-dashboard-public.service" /etc/systemd/system/linux-clash-dashboard-public.service
  systemctl daemon-reload
  systemctl enable linux-clash-dashboard-public.service
  systemctl restart linux-clash-dashboard-public.service
  wait_for_public_url
}

install_machine() {
  local node_id public_name
  [[ -z "$TUNNEL_TOKEN_FILE" ]] || die "install-machine does not consume a named-tunnel token; install that connector separately."
  install_node
  install_dashboard
  node_id="${NODE_ID:-$(machine_identity_value node-id)}"
  register_local_machine "$node_id"
  if [[ "$PUBLIC_PREVIEW" == "true" ]]; then
    public_name="${PUBLIC_NAME:-$(default_public_name)}"
    install_public_preview "$public_name"
    log "Dashboard requested public name: ${public_name}."
  else
    log "Skipped anonymous public preview; publish 127.0.0.1:${DASHBOARD_PORT} with the production named tunnel."
  fi
  log "Isolated machine deployment is ready."
}

add_node() {
  [[ -n "$NODE_ID" && -n "$NODE_URL" && -n "$CONTROLLER_TOKEN_FILE" ]] || die "add-node requires --node-id, --node-url, and --controller-token-file."
  validate_instance "$NODE_ID"
  [[ -f "$CONTROLLER_TOKEN_FILE" ]] || die "Controller token file does not exist: $CONTROLLER_TOKEN_FILE"
  id "$DASHBOARD_USER" >/dev/null 2>&1 || die "Install the Dashboard first."
  local destination="$CONFIG_ROOT/node-tokens/${NODE_ID}.token"
  if [[ "$(readlink -f "$CONTROLLER_TOKEN_FILE")" != "$(readlink -m "$destination")" ]]; then
    install -o root -g "$DASHBOARD_USER" -m 0640 "$CONTROLLER_TOKEN_FILE" "$destination"
  else
    chown root:"$DASHBOARD_USER" "$destination"
    chmod 0640 "$destination"
  fi
  python3 - "$CONFIG_ROOT/nodes.json" "$NODE_ID" "$NODE_NAME" "$NODE_URL" "$destination" <<'PY'
import ipaddress, json, os, pathlib, re, sys, urllib.parse
path, node_id, name, url, token_file = sys.argv[1:]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", node_id):
    raise SystemExit("invalid node id")
parsed = urllib.parse.urlsplit(url)
valid = parsed.scheme == "https" and parsed.hostname and parsed.path in ("", "/") and not any((parsed.username, parsed.password, parsed.query, parsed.fragment))
if not valid:
    try:
        valid = (
            parsed.scheme == "http"
            and ipaddress.ip_address(parsed.hostname).is_loopback
            and parsed.path in ("", "/")
            and not any((parsed.username, parsed.password, parsed.query, parsed.fragment))
        )
    except (ValueError, TypeError):
        valid = False
if not valid:
    raise SystemExit("node URL must use HTTPS")
target = pathlib.Path(path)
data = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {"nodes": []}
nodes = data.setdefault("nodes", [])
entry = {"id": node_id, "name": name[:200] or node_id, "url": url.rstrip("/"), "token_file": token_file}
hostname = (parsed.hostname or "").lower()
for node in nodes:
    other = urllib.parse.urlsplit(str(node.get("url", "")))
    if node.get("id") != node_id and (other.hostname or "").lower() == hostname:
        raise SystemExit(f"node hostname already registered: {hostname}")
for index, node in enumerate(nodes):
    if node.get("id") == node_id:
        nodes[index] = entry
        break
else:
    nodes.append(entry)
temporary = target.with_suffix(".tmp")
temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(temporary, 0o640)
os.replace(temporary, target)
PY
  chown root:"$DASHBOARD_USER" "$CONFIG_ROOT/nodes.json"
  systemctl try-restart linux-clash-dashboard.service
  log "Registered node ${NODE_ID}; the Dashboard never returns its URL or token path to browsers."
}

if [[ "${LINUX_CLASH_CONTROL_SOURCE_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

case "$COMMAND" in
  -h|--help|help|"") usage; exit 0 ;;
  install-machine|install-node|install-dashboard|add-node|install-tunnel) ;;
  *) usage; die "Unknown command: $COMMAND" ;;
esac

require_root
ensure_dependencies
install_common_files

case "$COMMAND" in
  install-machine) install_machine ;;
  install-node) install_node ;;
  install-dashboard) install_dashboard ;;
  add-node) add_node ;;
  install-tunnel)
    [[ -n "$TUNNEL_INSTANCE" && -n "$TUNNEL_TOKEN_FILE" ]] || die "install-tunnel requires --tunnel-instance and --tunnel-token-file."
    install_tunnel_service "$TUNNEL_INSTANCE" "$TUNNEL_TOKEN_FILE"
    ;;
esac
