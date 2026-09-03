#!/usr/bin/env bash
set -euo pipefail

single_browser=false
if [[ "${1:-}" == "--single-browser" ]]; then
  single_browser=true
  shift
fi
target="${1:?usage: preflight.sh [--single-browser] USER@IP}"
ssh_command=(ssh)
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
if [[ -n "${SSH_BOOTSTRAP_KEY:-}" ]]; then
  ssh_opts+=(-i "$SSH_BOOTSTRAP_KEY" -o IdentitiesOnly=yes)
fi
if [[ -n "${SSHPASS:-}" ]]; then
  command -v sshpass >/dev/null 2>&1 || {
    echo "sshpass-required: install sshpass or use an SSH key" >&2
    exit 5
  }
  ssh_command=(sshpass -e ssh)
  ssh_opts=(-o BatchMode=no -o PreferredAuthentications=password,keyboard-interactive -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
fi

"${ssh_command[@]}" "${ssh_opts[@]}" "$target" "SINGLE_BROWSER=$single_browser bash -s" <<'REMOTE'
set -euo pipefail
. /etc/os-release
case "${ID:-}" in ubuntu|debian|rhel|centos|rocky|almalinux|fedora) ;; *) echo "unsupported-os:${ID:-unknown}"; exit 2;; esac
case "$(uname -m)" in x86_64|aarch64) ;; *) echo "unsupported-arch:$(uname -m)"; exit 2;; esac
command -v systemctl >/dev/null
test -c /dev/net/tun
if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
  echo "admin-access-required: use root or passwordless sudo"
  exit 3
fi
mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
disk_kb=$(df -Pk / | awk 'NR==2{print $4}')
if [ "$SINGLE_BROWSER" = true ]; then
  [ "${mem_kb:-0}" -ge 3670016 ] && [ "${swap_kb:-0}" -ge 2097152 ] \
    || { echo "insufficient-memory-for-single-browser"; exit 4; }
else
  [ "${mem_kb:-0}" -ge 4194304 ] || { echo "insufficient-memory"; exit 4; }
fi
[ "${disk_kb:-0}" -ge 10485760 ] || { echo "insufficient-disk"; exit 4; }
echo "preflight-ok os=$ID arch=$(uname -m) memory_kb=$mem_kb swap_kb=$swap_kb disk_available_kb=$disk_kb single_browser=$SINGLE_BROWSER"
ss -lntp 2>/dev/null | awk 'NR==1 || /:(6080|8787|8788|8799|9090|9222|9223) /'
REMOTE
