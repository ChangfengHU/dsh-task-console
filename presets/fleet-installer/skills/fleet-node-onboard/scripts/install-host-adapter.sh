#!/usr/bin/env bash
# Install the host-owned, read-only production probe.  Stage mutations remain
# fail-closed until reviewed fixed executors are added to the owner-only config.
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "install-host-adapter requires root" >&2; exit 77; }
service_user=root
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-user) service_user="${2:?--service-user requires a local account}"; shift 2 ;;
    *) echo "usage: install-host-adapter.sh [--service-user USER]" >&2; exit 64 ;;
  esac
done
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "invalid service user" >&2; exit 64; }
getent passwd "$service_user" >/dev/null || { echo "service user does not exist" >&2; exit 67; }
adapter_group=dsh-onboard
getent group "$adapter_group" >/dev/null || groupadd --system "$adapter_group"
if [[ "$service_user" != root ]] && ! id -nG "$service_user" | tr ' ' '\n' | grep -qx "$adapter_group"; then
  usermod -a -G "$adapter_group" "$service_user"
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill="$(cd "$here/.." && pwd)"
install_root=/usr/local/lib/dsh-fleet-onboard
scripts_root="$install_root/scripts"
config_root=/etc/dsh-fleet-onboard
state_root=/var/lib/dsh-fleet-onboard-host

install -d -o root -g root -m 0755 "$install_root" "$scripts_root"
install -d -o root -g "$adapter_group" -m 0750 "$config_root"
install -d -o "$service_user" -g "$adapter_group" -m 0700 "$state_root"
for name in onboard-runtime.py host-adapter.py vault-credential-provider.py ssh-inventory-probe.py standard-account-reconciler.py machine-runtime-reconciler.py stage-gate.sh; do
  install -o root -g root -m 0755 "$here/$name" "$scripts_root/$name"
done
install -o root -g root -m 0644 "$skill/component-contract.json" "$install_root/component-contract.json"
install -o root -g root -m 0644 "$skill/host-adapter-capabilities.json" "$install_root/host-adapter-capabilities.json"

key="$config_root/inventory-hmac.key"
if [[ ! -e "$key" ]]; then
  umask 077
  /usr/bin/openssl rand -hex 32 | tr -d '\r\n' > "$key"
fi
[[ ! -L "$key" && -f "$key" ]] || { echo "unsafe HMAC key file" >&2; exit 78; }
[[ "$(wc -c < "$key")" -eq 64 ]] && LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$key" || {
  echo "existing HMAC key has an unsupported format; refusing to replace a possibly deployed key" >&2
  exit 78
}
chown "root:$adapter_group" "$key"; chmod 0640 "$key"

config="$config_root/host-adapter.json"
if [[ ! -e "$config" ]]; then
  install -o root -g root -m 0600 "$skill/host-adapter.example.json" "$config"
fi
chown "root:$adapter_group" "$config"; chmod 0640 "$config"

echo "host adapter installed; fixed stage 2 and stage 4 executors are enabled in newly generated configs"
echo "service user: $service_user"
echo "config: $config"
echo "hmac key file: $key (value is never printed; provision the same value as the fleet-console Worker secret)"
echo "DSH: use host-adapter.py as probe/runtime executor; its capability matrix remains authoritative"
echo "capability matrix (current config):"
runuser -u "$service_user" -- env \
  FLEET_ONBOARD_HOST_CONFIG_FILE="$config" \
  FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE="$key" \
  "$scripts_root/host-adapter.py" capabilities
