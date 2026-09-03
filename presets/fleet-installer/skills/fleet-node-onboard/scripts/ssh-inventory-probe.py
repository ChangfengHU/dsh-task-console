#!/usr/bin/env python3
"""Read-only production SSH probe for the Fleet onboarding host adapter.

Credentials arrive only through ``FLEET_ONBOARD_CREDENTIAL_FD``.  Passwords
are handed to sshpass through an inherited pipe descriptor and private keys
through an anonymous memfd, so neither secret appears in argv or on disk.
The remote program has a fixed body and returns booleans only; raw host keys
and machine-id are hashed locally and removed before output.

This probe intentionally leaves checks false when the current installation
does not expose authoritative evidence (notably the line-100 identity and
browser WebRTC exit).  It is safe to deploy but cannot by itself make all ten
stages pass; the capability matrix documents that boundary.
"""

from __future__ import annotations

import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.request


MAX_BYTES = 1024 * 1024
FLEET_URL = "https://fleet.vyibc.com/api/fleet"


class ProbeError(ValueError):
    pass


REMOTE_PROBE_TEMPLATE = r'''
import concurrent.futures, datetime, ipaddress, json, os, pathlib, pwd, re, subprocess, urllib.request

desired_browser_count = __FLEET_ONBOARD_BROWSER_COUNT__

def run(argv, timeout=8):
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, timeout=timeout)
        return p.returncode, p.stdout[:262144]
    except Exception:
        return 127, ""

def read_json(path):
    try:
        value = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def read_text(path, limit=4096):
    try:
        value = pathlib.Path(path).read_text(encoding="utf-8")
        return value.strip() if len(value.encode("utf-8")) <= limit else ""
    except Exception:
        return ""

def recent(stamp, seconds):
    try:
        observed = datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        age = (datetime.datetime.now(datetime.timezone.utc) - observed).total_seconds()
        return 0 <= age <= seconds
    except Exception:
        return False

def unit(name):
    code, out = run(["systemctl", "show", name, "--property=LoadState,ActiveState,UnitFileState", "--value"])
    values = out.splitlines()
    exists = code == 0 and bool(values) and values[0] != "not-found"
    return {"exists": exists, "active": "active" in values, "enabled": "enabled" in values}

def component(checks, units=None, present=None, facts=None):
    units = units or {}
    if present is None:
        present = bool(units) and any(row["exists"] for row in units.values())
    healthy = bool(present) and all(checks.values()) and all(
        row["exists"] and row["active"] and row["enabled"] for row in units.values())
    value = {"present": bool(present), "healthy": healthy, "units": units, "checks": checks}
    if facts is not None:
        value["facts"] = facts
    return value

def ipv4(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = ipaddress.IPv4Address(value)
        if str(parsed) != value:
            return None
        first, second, third, _fourth = (int(part) for part in value.split("."))
        special = (first in (0, 10, 127) or first >= 224
            or (first == 100 and 64 <= second <= 127)
            or (first == 169 and second == 254)
            or (first == 172 and 16 <= second <= 31)
            or (first == 192 and second == 168)
            or (first == 192 and second == 0 and third in (0, 2))
            or (first == 192 and second == 88 and third == 99)
            or (first == 198 and second in (18, 19))
            or (first == 198 and second == 51 and third == 100)
            or (first == 203 and second == 0 and third == 113))
        return None if special else str(parsed)
    except Exception:
        return None

def url_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return 200 <= response.status < 400
    except Exception:
        return False

def url_json(url):
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            value = json.loads(response.read(262145))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def public_latency(url):
    code, out = run(["curl", "--noproxy", "", "-sS", "-o", "/dev/null", "--max-time", "12", "-w", "%{http_code}", url], timeout=15)
    return code == 0 and len(out.strip()) == 3 and out.strip().isdigit() and out.strip() != "000"

def admin():
    return os.geteuid() == 0 or run(["sudo", "-n", "true"])[0] == 0

def claude_sudo():
    if run(["id", "claude"])[0] != 0:
        return False
    if os.geteuid() == 0:
        return run(["runuser", "-u", "claude", "--", "sudo", "-n", "true"])[0] == 0
    return run(["sudo", "-n", "-u", "claude", "sudo", "-n", "true"])[0] == 0

mem = 0
try:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemTotal:"):
            mem = int(line.split()[1])
except Exception:
    pass
try:
    disk = os.statvfs("/").f_bavail * os.statvfs("/").f_frsize
except Exception:
    disk = 0
resources = mem >= 3670016 and disk >= 10 * 1024 * 1024 * 1024

claude_exists = run(["id", "claude"])[0] == 0
sudo_ok = claude_sudo()
current_user = pwd.getpwuid(os.geteuid()).pw_name
managed_session = current_user == "claude"
managed_sudo = managed_session and run(["sudo", "-n", "true"])[0] == 0
ss_ok = run(["ss", "-lntp"])[0] == 0
systemd_ok = run(["systemctl", "is-system-running"])[0] in (0, 1)
components = {}
components["ssh-preflight"] = component({
    "reachable": True, "admin": admin(), "systemd": systemd_ok,
    "tun": pathlib.Path("/dev/net/tun").is_char_device(), "resources": resources,
}, present=True)
components["standard-account"] = component({
    "login": claude_exists, "passwordless_sudo": sudo_ok, "vault_writeback": False,
}, present=claude_exists)
components["vault-login"] = component({
    "login": managed_session, "passwordless_sudo": managed_sudo, "vault_readback": False,
}, present=managed_session)
machined = url_json("http://127.0.0.1:8792/health")
components["resource-snapshot"] = component({
    "captured": True, "ports_inspected": ss_ok, "services_inspected": systemd_ok,
    "machined_ready": machined.get("ok") is True and machined.get("version") == "0.15.1",
}, present=True)

mihomo_units = {"mihomo.service": unit("mihomo.service")}
result = read_json("/var/lib/linux-clash-skill/result.json")
line_declaration = read_json("/etc/vyibc-fleet-onboard/line-100.json")
tcp = ipv4(result.get("exit_ip"))
udp = ipv4(result.get("udp_exit_ip"))
line_value = line_declaration.get("line") or result.get("source_id") or result.get("line") or ""
line = line_value if isinstance(line_value, str) and line_value.startswith("line-") and line_value[5:].isdigit() and 1 <= len(line_value[5:]) <= 4 and line_value[5] != "0" else None
expected_ip = ipv4(line_declaration.get("expected_ip"))
components["mihomo"] = component({
    "tun": pathlib.Path("/sys/class/net/Mihomo").exists(),
    "tcp_exit": bool(tcp) and (not expected_ip or tcp == expected_ip),
    "udp_exit": bool(udp) and tcp == udp and (not expected_ip or udp == expected_ip),
    "line_100": line == "line-100" and bool(expected_ip),
}, mihomo_units, facts={
    "desiredLine": "line-100", "actualLine": line,
    "tcpExit": tcp, "udpExit": udp,
})

control_units = {name: unit(name) for name in (
    "linux-clash-node-controller.service", "linux-clash-dashboard.service")}
components["clash-control-plane"] = component({
    "controller_health": url_ok("http://127.0.0.1:8788/healthz"),
    "dashboard_health": url_ok("http://127.0.0.1:8787/healthz") or url_ok("http://127.0.0.1:8789/api/health"),
}, control_units)

browser_names = [
    "linux-browser-vnc-xvfb.service", "linux-browser-vnc-openbox.service",
    "linux-browser-vnc-x11vnc.service", "linux-browser-vnc-novnc.service",
    "linux-browser-vnc-health.service",
] + [f"linux-browser-vnc-browser@{index}.service" for index in range(1, desired_browser_count + 1)]
browser_units = {name: unit(name) for name in browser_names}
desktop = read_json("/var/lib/linux-browser-vnc/status.json")
configured = int(desktop.get("instances_configured") or 0)
up = int(desktop.get("instances_up") or 0)
browser_script = "/usr/local/lib/linux-browser-vnc/scripts/browser_probe.py"
desktop_env = read_text("/etc/linux-browser-vnc/desktop.env", 16384)
debug_match = re.search(r"^BROWSER_DEBUG_PORT_BASE=([0-9]+)$", desktop_env, re.MULTILINE)
debug_base = int(debug_match.group(1)) if debug_match else 0
browser_egress = bool(expected_ip and debug_base and pathlib.Path(browser_script).is_file())
if browser_egress:
    for index in range(desired_browser_count):
        code, _out = run(["sudo", "-n", "python3", browser_script, "--debug-port", str(debug_base + index), "--expected-ip", expected_ip], timeout=60)
        if code != 0:
            browser_egress = False
            break
components["browser-vnc"] = component({
    "browser_instances": configured >= desired_browser_count and up >= desired_browser_count,
    "loopback_only": bool(desktop.get("ok")),
    "https_exit": browser_egress, "webrtc_exit": browser_egress,
}, browser_units)

tunnel_units = {"linux-browser-vnc-tunnel.service": unit("linux-browser-vnc-tunnel.service")}
clash_url = read_text("/etc/linux-clash-skill/dashboard-public.url", 512).rstrip("/")
vnc_url = read_text("/var/lib/linux-browser-vnc/public.url", 512).rstrip("/")
clash_public = clash_url.startswith("https://clash-") and url_ok(clash_url + "/healthz")
vnc_public = vnc_url.startswith("https://vnc-") and url_ok(vnc_url + "/healthz")
vnc_websocket = False
if vnc_public and pathlib.Path(browser_script).is_file():
    vnc_websocket = run(["sudo", "-n", "python3", browser_script, "--websocket-check", vnc_url], timeout=45)[0] == 0
components["cloudflare-publication"] = component({
    "clash_http": clash_public, "vnc_http": vnc_public, "vnc_websocket": vnc_websocket,
}, tunnel_units)
latency_targets = ["https://gemini.google.com", "https://claude.ai", "https://chatgpt.com", "https://www.youtube.com", "https://github.com"]
latency_ok = False
if tcp and udp and expected_ip and tcp == udp == expected_ip and browser_egress and clash_public and vnc_websocket:
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        latency_ok = all(pool.map(public_latency, latency_targets))
acceptance_checks = {
    "ssh_survives_tun": True,
    "controller": components["clash-control-plane"]["checks"]["controller_health"],
    "dashboard": components["clash-control-plane"]["checks"]["dashboard_health"],
    "tcp_exit_line_100": components["mihomo"]["checks"]["tcp_exit"] and components["mihomo"]["checks"]["line_100"],
    "udp_exit_line_100": components["mihomo"]["checks"]["udp_exit"] and components["mihomo"]["checks"]["line_100"],
    "clash_public": clash_public,
    "vnc_websocket": vnc_websocket,
    "browser_egress": browser_egress,
    "timezone_aligned": result.get("timezone_aligned") is True,
    "telemetry_fresh": recent(result.get("verified_at"), 3600) and recent(desktop.get("checked_at"), 180),
    "disk": disk >= 10 * 1024 * 1024 * 1024,
    "proxy_latency": latency_ok,
}
components["acceptance"] = component(acceptance_checks, present=True)
components["fleet-registration"] = component({
    "registered": False, "readback": False, "reachable": False,
}, present=False)

machine_id = pathlib.Path("/etc/machine-id").read_text().strip()
print(json.dumps({
    "schema": 1,
    "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "components": components,
    "identity": {"machine_id": machine_id, "login_user": current_user},
}, separators=(",", ":")))
'''


def render_remote_probe(browser_count: int) -> str:
    if browser_count not in {1, 2}:
        raise ProbeError("browser-count-invalid")
    return REMOTE_PROBE_TEMPLATE.replace("__FLEET_ONBOARD_BROWSER_COUNT__", str(browser_count))


def read_request():
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ProbeError("request-too-large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ProbeError("request-invalid") from exc
    if not isinstance(value, dict) or set(value) != {"schema", "operation", "ip", "browser_count"}:
        raise ProbeError("request-shape-invalid")
    if value.get("schema") != 1 or value.get("operation") != "probe":
        raise ProbeError("request-operation-invalid")
    try:
        ip = ipaddress.IPv4Address(value.get("ip"))
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ProbeError("ip-invalid") from exc
    if not ip.is_global:
        raise ProbeError("ip-must-be-public")
    browser_count = value.get("browser_count")
    if browser_count not in {1, 2}:
        raise ProbeError("browser-count-invalid")
    return str(ip), browser_count


def credential():
    try:
        descriptor = int(os.environ["FLEET_ONBOARD_CREDENTIAL_FD"])
        os.lseek(descriptor, 0, os.SEEK_SET)
        raw = os.read(descriptor, 128 * 1024)
        value = json.loads(raw.decode("utf-8"))
    except (KeyError, ValueError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProbeError("credential-unavailable") from exc
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise ProbeError("credential-invalid")
    user = value.get("username")
    if not isinstance(user, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user):
        raise ProbeError("credential-user-invalid")
    return value


def ssh_binary():
    for candidate in ("/usr/bin/ssh", "/bin/ssh"):
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise ProbeError("ssh-unavailable")


def known_hosts_file():
    value = os.environ.get("FLEET_ONBOARD_KNOWN_HOSTS_FILE", "")
    path = Path(value)
    if not value or not path.is_absolute() or path.is_symlink():
        raise ProbeError("known-hosts-file-unsafe")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    if path.exists():
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()} or metadata.st_mode & 0o077:
            raise ProbeError("known-hosts-file-unsafe")
    else:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    return path


def negotiated_host_key(ip: str, known_hosts: Path) -> str:
    executable = next((item for item in ("/usr/bin/ssh-keygen", "/bin/ssh-keygen") if Path(item).is_file()), None)
    if not executable:
        raise ProbeError("ssh-keygen-unavailable")
    result = subprocess.run(
        [executable, "-F", ip, "-f", str(known_hosts)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, timeout=10, check=False,
    )
    if result.returncode != 0:
        raise ProbeError("negotiated-host-key-unavailable")
    keys = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if line.startswith("#") or len(fields) < 3 or not fields[-2].startswith("ssh-"):
            continue
        keys.append(fields[-2] + " " + fields[-1])
    if not keys:
        raise ProbeError("negotiated-host-key-unavailable")
    return "\n".join(sorted(set(keys)))


def run_ssh(ip: str, auth, browser_count: int):
    pass_fds = []
    temporary_fds = []
    argv = [ssh_binary(), "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
            "-o", "StrictHostKeyChecking=accept-new", "-o", "CheckHostIP=yes",
            "-o", "UserKnownHostsFile=" + str(known_hosts_file()), "-o", "LogLevel=ERROR"]
    if auth.get("private_key"):
        if not hasattr(os, "memfd_create"):
            raise ProbeError("private-key-memfd-unavailable")
        descriptor = os.memfd_create("fleet-onboard-key", getattr(os, "MFD_CLOEXEC", 0))
        os.fchmod(descriptor, 0o600)
        os.write(descriptor, str(auth["private_key"]).encode("utf-8"))
        os.lseek(descriptor, 0, os.SEEK_SET)
        argv.extend(["-i", f"/proc/self/fd/{descriptor}", "-o", "IdentitiesOnly=yes"])
        pass_fds.append(descriptor)
        temporary_fds.append(descriptor)
    elif auth.get("password"):
        sshpass = next((item for item in ("/usr/bin/sshpass", "/bin/sshpass") if Path(item).is_file()), None)
        if not sshpass:
            raise ProbeError("sshpass-unavailable")
        read_fd, write_fd = os.pipe()
        os.write(write_fd, str(auth["password"]).encode("utf-8") + b"\n")
        os.close(write_fd)
        argv = [sshpass, "-d", str(read_fd), *argv]
        argv[argv.index("BatchMode=yes")] = "BatchMode=no"
        pass_fds.append(read_fd)
        temporary_fds.append(read_fd)
    elif auth.get("ssh_agent_socket"):
        pass
    else:
        raise ProbeError("credential-auth-unavailable")
    argv.extend([f"{auth['username']}@{ip}", "python3", "-"])
    env = {name: os.environ[name] for name in ("HOME", "LANG", "LC_ALL", "PATH", "TZ") if name in os.environ}
    if auth.get("ssh_agent_socket"):
        env["SSH_AUTH_SOCK"] = str(auth["ssh_agent_socket"])
    try:
        result = subprocess.run(
            argv, input=render_remote_probe(browser_count), text=True, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=90, env=env,
            pass_fds=tuple(pass_fds), check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProbeError("ssh-probe-failed") from exc
    finally:
        for descriptor in temporary_fds:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if result.returncode != 0 or len(result.stdout.encode("utf-8")) > MAX_BYTES:
        raise ProbeError("ssh-probe-failed")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ProbeError("ssh-probe-output-invalid")
    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise ProbeError("ssh-probe-output-invalid") from exc
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise ProbeError("ssh-probe-output-invalid")
    identity = value.get("identity")
    if not isinstance(identity, dict) or identity.get("login_user") != auth["username"]:
        raise ProbeError("ssh-login-user-mismatch")
    return value


def fleet_state(ip: str):
    node_id = "host-" + ip.replace(".", "-")
    try:
        request = urllib.request.Request(FLEET_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read(MAX_BYTES + 1))
        nodes = payload.get("nodes", []) if isinstance(payload, dict) else []
        row = next((item for item in nodes if isinstance(item, dict) and item.get("id") == node_id), None)
        return {"registered": row is not None, "reachable": bool(row and row.get("reachable")),
                **({"node_id": node_id} if row is not None else {})}
    except Exception:
        return {"registered": False, "reachable": False}


def main():
    try:
        ip, browser_count = read_request()
        observed = run_ssh(ip, credential(), browser_count)
        identity = observed.pop("identity", {})
        host_key = negotiated_host_key(ip, known_hosts_file())
        machine_id = identity.get("machine_id") if isinstance(identity, dict) else ""
        if not host_key or not re.fullmatch(r"[0-9a-fA-F-]{16,128}", str(machine_id)):
            raise ProbeError("target-identity-unavailable")
        fingerprint = "sha256:" + hashlib.sha256((host_key + "\0" + machine_id).encode("utf-8")).hexdigest()
        fleet = fleet_state(ip)
        components = observed.get("components", {})
        registration = components.get("fleet-registration", {})
        registration.update({
            "present": fleet["registered"], "healthy": fleet["registered"] and fleet["reachable"],
            "checks": {"registered": fleet["registered"], "readback": fleet["registered"], "reachable": fleet["reachable"]},
        })
        print(json.dumps({
            "schema": 1, "ip": ip, "observed_at": observed.get("observed_at"),
            "target_fingerprint": fingerprint, "fleet": fleet, "components": components,
        }, ensure_ascii=False, separators=(",", ":")))
        return 0
    except ProbeError:
        # The host adapter discards stderr and reports a stable transport code.
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
