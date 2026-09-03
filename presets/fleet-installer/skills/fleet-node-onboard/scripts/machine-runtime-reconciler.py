#!/usr/bin/env python3
"""Fixed Stage 4 worker: install/upgrade machined and seed the line-100 declaration.

The model cannot select URLs, commands, paths, users, line material, or tokens.
All three public artifacts are content-addressed below; SSH credentials arrive
through the host adapter's inherited descriptor and deployment secrets through
root-owned fixed files.
"""

from __future__ import annotations

import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


HERE = Path(__file__).resolve().parent
CONTRACT = HERE.parent / "component-contract.json"
LINE_FILE = Path("/etc/dsh-fleet-onboard/line-100.json")
ENROLL_FILE = Path("/etc/dsh-fleet-onboard/machined-enroll.token")
MAX_BYTES = 1024 * 1024
ARTIFACTS = {
    "machined.py": (
        "https://resource.vyibc.com/fleet-onboard_machined-0.15.1.py",
        "04859113aab507b77d0dc92c0c4fa4ae9c754e85e8fd8b43c2e1147b8e11cbd1",
    ),
    "install-machined.sh": (
        "https://resource.vyibc.com/fleet-onboard-install-machined-0.15.1.sh",
        "19e164826021d9d250c6b6ae080afbc1336c9d8a9a2939d7ab24d9d4e81e5f52",
    ),
    "agent.js": (
        "https://resource.vyibc.com/fleet-onboard-auto-domain-agent-2834c76.js",
        "cea38508e0bb4aad4209606be08281eab5d8e0016f6ebd4085ce332f975d7d95",
    ),
}


class ReconcilerError(ValueError):
    pass


class ReconcilerBlocked(ReconcilerError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def safe_file(path: Path, label: str, limit: int = MAX_BYTES, *, public: bool = False) -> Path:
    if not path.is_absolute() or path.is_symlink():
        raise ReconcilerError(label + "-unsafe")
    try:
        metadata = path.stat()
    except OSError as exc:
        raise ReconcilerBlocked(label + "-unavailable") from exc
    groups = set(os.getgroups()) | {os.getegid()}
    readable = (
        metadata.st_uid == os.geteuid()
        or (metadata.st_gid in groups and metadata.st_mode & 0o040)
        or bool(metadata.st_mode & 0o004)
    )
    forbidden_mode = 0o022 if public else 0o027
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()}
            or metadata.st_mode & forbidden_mode or not readable or not 0 < metadata.st_size <= limit):
        raise ReconcilerError(label + "-unsafe")
    return path.resolve()


def load_json(path: Path, label: str, *, public: bool = False):
    try:
        value = json.loads(safe_file(path, label, public=public).read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ReconcilerError(label + "-invalid") from exc
    if not isinstance(value, dict):
        raise ReconcilerError(label + "-invalid")
    return value


def contract_digest():
    return hashlib.sha256(canonical(load_json(CONTRACT, "component-contract", public=True)).encode()).hexdigest()


def load_request():
    request_path = safe_file(Path(os.environ.get("FLEET_ONBOARD_JOB_REQUEST_FILE", "")), "job-request")
    result_path = Path(os.environ.get("FLEET_ONBOARD_JOB_RESULT_FILE", ""))
    if not result_path.is_absolute() or result_path.is_symlink() or result_path.parent.resolve() != request_path.parent.resolve():
        raise ReconcilerError("job-result-unsafe")
    request = load_json(request_path, "job-request")
    if set(request) != {"schema", "ip", "contract_sha256", "action"} or request.get("schema") != 1:
        raise ReconcilerError("request-shape-invalid")
    try:
        ip = str(ipaddress.IPv4Address(request.get("ip")))
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ReconcilerError("request-ip-invalid") from exc
    if not ipaddress.IPv4Address(ip).is_global or ip != request.get("ip") or request.get("contract_sha256") != contract_digest():
        raise ReconcilerError("request-contract-invalid")
    action = request.get("action")
    if (not isinstance(action, dict)
            or set(action) != {"stage", "component", "executor_id", "operation_id", "reason"}
            or action.get("stage") != 4 or action.get("component") != "resource-snapshot"
            or action.get("executor_id") != "fleet.machine-runtime-reconcile.v1"
            or not re.fullmatch(r"onboard-[0-9a-f]{32}", str(action.get("operation_id") or ""))
            or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,95}", str(action.get("reason") or ""))):
        raise ReconcilerError("request-action-invalid")
    return request_path, result_path, request


def credential():
    try:
        descriptor = int(os.environ["FLEET_ONBOARD_CREDENTIAL_FD"])
        os.lseek(descriptor, 0, os.SEEK_SET)
        value = json.loads(os.read(descriptor, 128 * 1024).decode("utf-8"))
    except (KeyError, ValueError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReconcilerBlocked("dependency-unavailable") from exc
    if (not isinstance(value, dict) or value.get("schema") != 1 or value.get("username") != "claude"
            or not isinstance(value.get("private_key"), str) or "PRIVATE KEY-----" not in value["private_key"]):
        raise ReconcilerBlocked("dependency-unavailable")
    return value


def deployment_material(contract_sha: str):
    line = load_json(LINE_FILE, "line-100")
    if set(line) != {"schema", "line", "config_url", "expected_ip"} or line.get("schema") != 1 or line.get("line") != "line-100":
        raise ReconcilerError("line-100-invalid")
    try:
        expected = str(ipaddress.IPv4Address(line.get("expected_ip")))
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ReconcilerError("line-100-invalid") from exc
    if not ipaddress.IPv4Address(expected).is_global or expected != line.get("expected_ip"):
        raise ReconcilerError("line-100-invalid")
    url = str(line.get("config_url") or "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ReconcilerError("line-100-invalid")
    token = safe_file(ENROLL_FILE, "machined-enroll", 4096).read_text(encoding="utf-8").strip()
    if len(token) < 32 or any(character in token for character in "\0\r\n"):
        raise ReconcilerError("machined-enroll-invalid")
    return {
        "schema": 1, "contract_sha256": contract_sha, "line": "line-100",
        "config_url": url, "expected_ip": expected, "machined_enroll_token": token,
    }


def download_artifacts(root: Path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for name, (url, digest) in ARTIFACTS.items():
        try:
            with opener.open(urllib.request.Request(url, headers={"User-Agent": "dsh-fleet-onboard/1"}), timeout=60) as response:
                if response.status != 200 or response.geturl() != url:
                    raise ReconcilerBlocked("dependency-unavailable")
                raw = response.read(MAX_BYTES + 1)
        except ReconcilerBlocked:
            raise
        except Exception as exc:
            raise ReconcilerBlocked("dependency-unavailable") from exc
        if len(raw) > MAX_BYTES or hashlib.sha256(raw).hexdigest() != digest:
            raise ReconcilerBlocked("policy-conflict")
        path = root / name
        path.write_bytes(raw)
        path.chmod(0o700 if name.endswith((".py", ".sh")) else 0o600)


REMOTE = r'''set -euo pipefail
root="$1"; ip="$2"
trap 'rm -rf -- "$root"' EXIT
command -v node >/dev/null 2>&1 || exit 41
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || exit 41
owner="$(ps -eo user=,args= | awk '/[s]ervices\/machined\/machined.py/{print $1; exit}')"
owner="${owner:-claude}"
id "$owner" >/dev/null 2>&1 || exit 42
home_dir="$(getent passwd "$owner" | cut -d: -f6)"
[ -n "$home_dir" ] || exit 42
uid="$(id -u "$owner")"
sudo -n install -d -o "$owner" -g "$owner" -m 0755 "$home_dir/.local/lib/dsh-fleet-machined"
sudo -n install -o "$owner" -g "$owner" -m 0644 "$root/agent.js" "$home_dir/.local/lib/dsh-fleet-machined/agent.js"
sudo -n python3 - "$root/material.json" "$ip" <<'PY'
import hashlib,json,os,pathlib,sys,tempfile
material=json.load(open(sys.argv[1])); ip=sys.argv[2]
url=material['config_url']; expected=material['expected_ip']; contract=material['contract_sha256']
config_root=pathlib.Path('/etc/linux-clash-skill'); declaration_root=pathlib.Path('/etc/vyibc-fleet-onboard')
config_root.mkdir(parents=True,exist_ok=True); declaration_root.mkdir(parents=True,exist_ok=True)
controller=config_root/'controller.json'
try: value=json.load(open(controller))
except Exception: value={}
value.update({'node_name':'host-'+ip.replace('.','-'),'config_url':url,'expected_ip':expected})
value.setdefault('proxy_name',''); value.setdefault('server_ip',''); value.setdefault('rollback_seconds',180)
value.setdefault('exclude_uids',[]); value.setdefault('align_timezone',True)
declaration={'schema':1,'line':'line-100','contract_sha256':contract,'config_url_sha256':hashlib.sha256(url.encode()).hexdigest(),'expected_ip':expected}
for path,data in ((controller,value),(declaration_root/'line-100.json',declaration)):
    fd,tmp=tempfile.mkstemp(prefix='.write-',dir=str(path.parent),text=True)
    with os.fdopen(fd,'w') as handle: json.dump(data,handle,separators=(',',':')); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
    os.chmod(tmp,0o600); os.replace(tmp,path)
PY
sudo -n loginctl enable-linger "$owner" >/dev/null 2>&1 || true
enroll="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["machined_enroll_token"],end="")' "$root/material.json")"
existing=0
[ -f "$home_dir/.machined.env" ] && existing=1
args=(--machine-id="machine-$ip" --primary-runtime-id="runtime-${ip//./-}" --control-plane=https://control.vyibc.com --agent-js="$home_dir/.local/lib/dsh-fleet-machined/agent.js")
[ "$existing" = 1 ] && args+=(--no-enroll)
sudo -n -u "$owner" env HOME="$home_dir" XDG_RUNTIME_DIR="/run/user/$uid" MACHINED_ENROLL_TOKEN="$enroll" bash "$root/install-machined.sh" "${args[@]}" >/dev/null 2>&1
unset enroll
curl -fsS --max-time 15 http://127.0.0.1:8792/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("version")=="0.15.1"'
'''


def ssh_base(auth, known_hosts: Path):
    descriptor = os.memfd_create("fleet-onboard-key", getattr(os, "MFD_CLOEXEC", 0))
    os.fchmod(descriptor, 0o600)
    os.write(descriptor, auth["private_key"].encode())
    os.lseek(descriptor, 0, os.SEEK_SET)
    options = ["-F", "/dev/null", "-i", f"/proc/self/fd/{descriptor}", "-o", "IdentitiesOnly=yes",
               "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=yes",
               "-o", "CheckHostIP=yes", "-o", "UserKnownHostsFile=" + str(known_hosts), "-o", "LogLevel=ERROR"]
    return descriptor, options


def run_transport(argv, descriptor, *, data=None, timeout=1200):
    os.lseek(descriptor, 0, os.SEEK_SET)
    try:
        result = subprocess.run(argv, input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=timeout, pass_fds=(descriptor,), check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReconcilerBlocked("dependency-unavailable") from exc
    if result.returncode != 0:
        raise ReconcilerBlocked("dependency-unavailable")


def reconcile(ip: str, operation_id: str, material, work: Path):
    auth = credential()
    known_hosts = safe_file(Path(os.environ.get("FLEET_ONBOARD_KNOWN_HOSTS_FILE", "")), "known-hosts")
    descriptor, options = ssh_base(auth, known_hosts)
    remote = f"/tmp/{operation_id}"
    try:
        run_transport(["/usr/bin/ssh", *options, f"claude@{ip}", f"install -d -m 0700 -- {remote}"], descriptor, timeout=60)
        material_path = work / "material.json"
        material_path.write_text(canonical(material) + "\n", encoding="utf-8")
        material_path.chmod(0o600)
        for local in [work / "machined.py", work / "install-machined.sh", work / "agent.js", material_path]:
            run_transport(["/usr/bin/scp", *options, str(local), f"claude@{ip}:{remote}/{local.name}"], descriptor, timeout=120)
        run_transport(["/usr/bin/ssh", *options, f"claude@{ip}", "bash", "-s", "--", remote, ip], descriptor,
                      data=REMOTE.encode(), timeout=1200)
    finally:
        try:
            run_transport(["/usr/bin/ssh", *options, f"claude@{ip}", "rm", "-rf", "--", remote], descriptor, timeout=30)
        except ReconcilerBlocked:
            pass
        os.close(descriptor)


def atomic_json(path: Path, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".stage4-result-", dir=str(path.parent), text=True)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(canonical(value) + "\n"); handle.flush(); os.fsync(handle.fileno())
    os.chmod(temporary, 0o600); os.replace(temporary, path)


def run_worker():
    request_path, result_path, request = load_request()
    lock_path = request_path.parent / "machine-runtime.lock"
    with lock_path.open("a+") as lock:
        os.chmod(lock_path, 0o600); fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if result_path.exists():
            return 0
        try:
            with tempfile.TemporaryDirectory(prefix="stage4-", dir=str(request_path.parent)) as name:
                work = Path(name); work.chmod(0o700)
                download_artifacts(work)
                reconcile(request["ip"], request["action"]["operation_id"], deployment_material(request["contract_sha256"]), work)
            result = {"schema": 1, "outcome": "succeeded", "reason_code": "repaired-and-verified"}
        except ReconcilerBlocked as exc:
            reason = str(exc) if str(exc) in {"dependency-unavailable", "policy-conflict"} else "dependency-unavailable"
            result = {"schema": 1, "outcome": "blocked", "reason_code": reason}
        atomic_json(result_path, result)
    return 0


def main():
    try:
        return run_worker()
    except ReconcilerError as exc:
        sys.stderr.write(canonical({"schema": 1, "ok": False, "error": str(exc)}) + "\n")
        return 2
    except Exception:
        sys.stderr.write(canonical({"schema": 1, "ok": False, "error": "stage4-executor-failed"}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
