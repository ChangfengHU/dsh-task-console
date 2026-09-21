#!/usr/bin/env bash
set -euo pipefail

STATE_ROOT="/var/lib/linux-clash-skill"
CURRENT_FILE="${STATE_ROOT}/current-backup"

if [[ ! -f "$CURRENT_FILE" ]]; then
  echo "No linux-clash-skill backup is registered." >&2
  exit 1
fi

BACKUP_DIR="$(<"$CURRENT_FILE")"
case "$BACKUP_DIR" in
  "${STATE_ROOT}/backups/"*) ;;
  *) echo "Refusing unsafe backup path: $BACKUP_DIR" >&2; exit 1 ;;
esac
[[ -d "$BACKUP_DIR" && -f "$BACKUP_DIR/state.env" ]] || {
  echo "Backup is incomplete: $BACKUP_DIR" >&2
  exit 1
}

# shellcheck disable=SC1090
source "$BACKUP_DIR/state.env"

systemctl disable --now mihomo.service >/dev/null 2>&1 || true

if [[ "$hosts_existed" == "1" ]]; then
  install -o root -g root -m 0644 "$BACKUP_DIR/hosts" /etc/hosts
fi

if [[ "$config_existed" == "1" ]]; then
  install -d -o root -g mihomo -m 0750 /etc/mihomo
  install -o root -g mihomo -m 0640 "$BACKUP_DIR/config.yaml" /etc/mihomo/config.yaml
else
  rm -f /etc/mihomo/config.yaml
fi

if [[ "$service_existed" == "1" ]]; then
  install -o root -g root -m 0644 "$BACKUP_DIR/mihomo.service" /etc/systemd/system/mihomo.service
else
  rm -f /etc/systemd/system/mihomo.service
fi

if [[ "$binary_existed" == "1" ]]; then
  install -o root -g root -m 0755 "$BACKUP_DIR/mihomo" /usr/local/bin/mihomo
else
  rm -f /usr/local/bin/mihomo
fi

systemctl daemon-reload
if [[ "$service_enabled" == "enabled" ]]; then
  systemctl enable mihomo.service >/dev/null 2>&1 || true
else
  systemctl disable mihomo.service >/dev/null 2>&1 || true
fi
if [[ "$service_active" == "active" ]]; then
  systemctl start mihomo.service
fi

if [[ -n "${timezone_before:-}" && "$timezone_before" != /* && "$timezone_before" != *..* && -f "/usr/share/zoneinfo/${timezone_before}" ]]; then
  timedatectl set-timezone "$timezone_before"
fi

if [[ "$service_active" == "active" ]]; then
  systemctl is-active --quiet mihomo.service || {
    echo "Rollback restored files but the previous Mihomo service did not start." >&2
    exit 1
  }
else
  if systemctl is-active --quiet mihomo.service || [[ -e /sys/class/net/Mihomo ]]; then
    echo "Rollback did not remove the Mihomo transparent route." >&2
    exit 1
  fi
  direct_trace="$(curl --noproxy '*' -4fsS --connect-timeout 8 --max-time 20 https://1.1.1.1/cdn-cgi/trace)"
  [[ "$direct_trace" == *$'\nip='* ]] || {
    echo "Rollback restored direct routing but direct HTTPS verification failed." >&2
    exit 1
  }
fi

echo "Restored pre-install state from: $BACKUP_DIR"
