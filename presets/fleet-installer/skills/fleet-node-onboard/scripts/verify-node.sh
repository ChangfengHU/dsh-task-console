#!/usr/bin/env bash
set -euo pipefail

profile="base"
if [[ "${1:-}" == "--profile" ]]; then
  profile="${2:-}"; shift 2
fi
[[ "$profile" == "base" || "$profile" == "image-worker" ]] || {
  echo "profile must be base or image-worker" >&2; exit 64;
}
ip="${1:?usage: verify-node.sh [--profile base|image-worker] DIRECT_IPV4}"
dashed="${ip//./-}"

clash="$(curl -fsS --max-time 15 "https://clash-${dashed}.vyibc.com/api/nodes")"
CLASH="$clash" python3 - <<'PY'
import json, os
d=json.loads(os.environ["CLASH"])
nodes=d.get("nodes") or []
assert nodes, "dashboard returned no node"
n=nodes[0]
assert n.get("reachable") is not False, "node unreachable"
assert n.get("proxy_enabled") is True, "transparent proxy disabled"
last=n.get("last_result") or {}
if "tcp_udp_consistent" in last:
    assert last.get("tcp_udp_consistent") is True, "TCP/UDP exit mismatch"
desktop=n.get("desktop") or {}
configured=int(desktop.get("instances_configured") or 0)
up=int(desktop.get("instances_up") or 0)
assert configured >= 1, "no browser instances configured"
assert up == configured, f"browser instances unhealthy: {up}/{configured}"
print(json.dumps({"proxy":True,"browsers":configured,"desktop":desktop.get("online") is not False},ensure_ascii=False))
PY

curl -fsS --max-time 15 "https://vnc-${dashed}.vyibc.com/healthz" >/dev/null

if [[ "$profile" == "image-worker" ]]; then
  caps="$(curl -fsS --max-time 15 "https://imggen-${dashed}.vyibc.com/capabilities")"
  CAPS="$caps" python3 - <<'PY'
import json, os
d=json.loads(os.environ["CAPS"])
assert d.get("ok") is True
assert (d.get("host") or {}).get("disk")
targets=(d.get("network") or {}).get("targets") or {}
required={"gemini","claude","chatgpt","youtube","github"}
assert required <= targets.keys(), sorted(required-targets.keys())
assert all("ok" in targets[x] and "latencyMs" in targets[x] for x in required)
assert d.get("browsers"), "no image-worker browser instances"
print(json.dumps({"imageWorker":True,"disk":d["host"]["disk"],"latency":{x:targets[x]["latencyMs"] for x in sorted(required)}},ensure_ascii=False))
PY
fi

echo "public-endpoints-ok profile=$profile"
