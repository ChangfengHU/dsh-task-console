#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: verify-golden-node.sh USER@DIRECT_IPV4 [EXPECTED_BROWSERS]}"
expected="${2:-2}"
ip="${target##*@}"
ssh_cmd=(ssh)
if [[ -n "${SSHPASS:-}" ]]; then
  command -v sshpass >/dev/null || {
    echo "SSHPASS is set but sshpass is unavailable" >&2
    exit 2
  }
  ssh_cmd=(sshpass -e ssh)
fi

if ! [[ "$expected" =~ ^[1-9][0-9]*$ ]]; then
  echo "EXPECTED_BROWSERS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "target must end in a direct IPv4 address" >&2
  exit 2
fi

"${ssh_cmd[@]}" -o BatchMode="$( [[ -n "${SSHPASS:-}" ]] && echo no || echo yes )" \
  -o ConnectTimeout=10 "$target" bash -s -- "$expected" <<'REMOTE'
set -euo pipefail
expected="$1"
fail() { echo "FAIL: $*" >&2; exit 1; }

required_units=(
  mihomo.service
  linux-clash-node-controller.service
  linux-clash-dashboard.service
  linux-browser-vnc-xvfb.service
  linux-browser-vnc-openbox.service
  linux-browser-vnc-x11vnc.service
  linux-browser-vnc-novnc.service
  linux-browser-vnc-health.service
  linux-browser-vnc-tunnel.service
  chatgpt-image-service.service
)
for unit in "${required_units[@]}"; do
  systemctl is-active --quiet "$unit" || fail "$unit is not active"
  systemctl is-enabled --quiet "$unit" || fail "$unit is not enabled"
done

for ((i=1; i<=expected; i++)); do
  unit="linux-browser-vnc-browser@${i}.service"
  systemctl is-active --quiet "$unit" || fail "$unit is not active"
  systemctl is-enabled --quiet "$unit" || fail "$unit is not enabled"
  [[ "$(systemctl show "$unit" -p Restart --value)" == always ]] || fail "$unit Restart is not always"
  [[ "$(systemctl show "$unit" -p KillMode --value)" == control-group ]] || fail "$unit KillMode is not control-group"
  for property in MemoryHigh MemoryMax TasksMax; do
    value="$(systemctl show "$unit" -p "$property" --value)"
    [[ -n "$value" && "$value" != infinity && "$value" != 0 ]] || fail "$unit has unbounded $property"
  done
done

pid="$(systemctl show chatgpt-image-service.service -p MainPID --value)"
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "image service has no MainPID"
env_file="$(systemctl show chatgpt-image-service.service -p EnvironmentFiles --value | awk '{print $1}')"
[[ -r "$env_file" ]] || fail "image service EnvironmentFile is not readable"
if grep -Eq '^CHATGPT_IMAGE_RECYCLE_ENABLED=(false|0|no)$' "$env_file"; then
  fail "active browser recycle is explicitly disabled"
fi

http_port="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^CHATGPT_IMAGE_HTTP_PORT=//p' | head -1)"
http_port="${http_port:-8787}"
health="$(curl --noproxy '*' -fsS --max-time 10 "http://127.0.0.1:${http_port}/health")"
caps="$(curl --noproxy '*' -fsS --max-time 10 "http://127.0.0.1:${http_port}/capabilities")"

HEALTH="$health" CAPS="$caps" EXPECTED="$expected" python3 - <<'PY'
import json, os
h=json.loads(os.environ["HEALTH"])
c=json.loads(os.environ["CAPS"])
n=int(os.environ["EXPECTED"])
assert h.get("ok") is True
assert h.get("identityContract")=="gemini-page-authoritative-v1"
assert (h.get("recyclePolicy") or {}).get("enabled") is True, "recycle policy disabled"
ports=h.get("cdpPorts") or []
assert len(ports)==n, (ports,n)
workers=h.get("workers") or []
expected={(str(p),e) for p in ports for e in ("chatgpt","gemini")}
actual={(str(w.get("cdpPort")),w.get("engine")) for w in workers}
assert expected <= actual, sorted(expected-actual)
assert len(c.get("browsers") or [])==n
assert c.get("identityContract")=="gemini-page-authoritative-v1"
assert (c.get("recyclePolicy") or {}).get("enabled") is True
host=c.get("host") or {}
assert host.get("disk") and host.get("totalMb") and host.get("cores")
targets=((c.get("network") or {}).get("targets") or {})
required={"gemini","claude","chatgpt","youtube","github"}
assert required <= targets.keys(), sorted(required-targets.keys())
assert all("ok" in targets[x] and "latencyMs" in targets[x] for x in required)
for browser in c["browsers"]:
    assert browser.get("ok") is True
    assert browser.get("memory",{}).get("highMb")
    identities=browser.get("identities") or {}
    assert {"chatgpt","gemini","douyin","xhs","weixin"} <= identities.keys()
print(json.dumps({"local":True,"browsers":n,"recycle":True},ensure_ascii=False))
PY

for port in "$http_port" 6080 5910; do
  ss -lntH "sport = :$port" | grep -q . || fail "required port $port is not listening"
  ss -lntH "sport = :$port" | awk '{print $4}' | grep -Evq '^(127\.0\.0\.1|\[::1\]):' \
    || true
  if ss -lntH "sport = :$port" | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):' | grep -q .; then
    fail "port $port has a non-loopback listener"
  fi
done
for ((i=0; i<expected; i++)); do
  port=$((9222+i))
  ss -lntH "sport = :$port" | grep -q . || fail "CDP port $port is not listening"
  if ss -lntH "sport = :$port" | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):' | grep -q .; then
    fail "CDP port $port has a non-loopback listener"
  fi
done
REMOTE

dashed="${ip//./-}"
for kind in clash vnc imggen; do
  url="https://${kind}-${dashed}.vyibc.com"
  path=/healthz
  [[ "$kind" == imggen ]] && path=/capabilities
  curl -fsS --max-time 15 "${url}${path}" >/dev/null || {
    echo "FAIL: public $kind endpoint is unhealthy: $url" >&2
    exit 1
  }
done

echo "golden-node-ok target=$target browsers=$expected canonical_domain=vyibc.com"
