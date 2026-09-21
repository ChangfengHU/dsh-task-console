#!/usr/bin/env python3
"""Loopback-only control API for transactional Mihomo proxy operations."""

from __future__ import annotations

import argparse
import datetime as dt
import hmac
import ipaddress
import json
import os
import platform
import re
import secrets
import signal
import subprocess
import tempfile
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable


VERSION = "1.6.0"
MAX_BODY = 16 * 1024
PUBLIC_RESULT_FIELDS = {
    "status",
    "transparent_proxy",
    "exit_ip",
    "udp_exit_ip",
    "tcp_udp_consistent",
    "proxy_name",
    "proxy_hostname",
    "pinned_server_ip",
    "generic_exit_ip",
    "china_exit_ip",
    "cloudflare_exit_ip",
    "claude_exit_ip",
    "udp_cloudflare_exit_ip",
    "udp_google_exit_ip",
    "china_path_verified",
    "all_paths_consistent",
    "exit_timezone",
    "timezone_aligned",
    "verified_at",
}


def system_timezone() -> str:
    """Return an IANA zone when Linux exposes one, with an abbreviation fallback."""
    try:
        target = Path("/etc/localtime").resolve()
        marker = "/zoneinfo/"
        if marker in str(target):
            return str(target).split(marker, 1)[1]
    except OSError:
        pass
    timezone_file = Path("/etc/timezone")
    try:
        value = timezone_file.read_text(encoding="utf-8").strip()
        if value and "\n" not in value:
            return value
    except OSError:
        pass
    return dt.datetime.now().astimezone().tzname() or "unknown"


# --- Line reachability probe -------------------------------------------------
# Answers "could this machine switch to that line?" WITHOUT switching. Every dial
# runs as linux-clash-tunnel with --noproxy so it leaves the box directly instead
# of being swallowed by our own TUN, which would otherwise make every line look
# alive as long as the current one works. Read-only: it never takes the operation
# lock, so it still answers while a replace is in flight.
LINE_PROBE_TTL = 120.0
LINE_PROBE_TARGET = "https://api.ipify.org"
_line_cache: dict[str, Any] = {"at": 0.0, "lines": []}


def _direct_run(args: list[str], timeout: int, no_proxy: bool = True) -> subprocess.CompletedProcess:
    # Escaping TUN comes from running as linux-clash-tunnel (uid-based routing),
    # NOT from --noproxy. And --noproxy '*' cancels --socks5-hostname outright, so
    # a dial must never carry it — otherwise every line reports the machine's own
    # IP and all four look identically "alive".
    proxy_flags = ["--noproxy", "*"] if no_proxy else []
    return subprocess.run(
        ["runuser", "--user", "linux-clash-tunnel", "--", "curl", *proxy_flags,
         "--silent", "--show-error", "--max-time", str(timeout), *args],
        check=False, capture_output=True, text=True,
    )


_direct_ip_cache: dict[str, Any] = {"at": 0.0, "ip": None}


def _direct_exit_ip() -> str | None:
    now = time.monotonic()
    if _direct_ip_cache["ip"] and now - _direct_ip_cache["at"] < 600:
        return _direct_ip_cache["ip"]
    got = _direct_run([LINE_PROBE_TARGET], 10)
    ip = got.stdout.strip() if got.returncode == 0 else None
    _direct_ip_cache["at"] = now
    _direct_ip_cache["ip"] = ip
    return ip


def probe_lines(sources_path: Path, force: bool = False) -> list[dict[str, Any]]:
    now = time.monotonic()
    if not force and _line_cache["lines"] and now - _line_cache["at"] < LINE_PROBE_TTL:
        return _line_cache["lines"]
    try:
        raw = json.loads(sources_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        # Surfaced, never swallowed: an unreadable list must not look like an
        # empty one. That exact confusion cost a day once already.
        return [{"id": None, "error": f"sources unreadable: {exc}"}]
    items = raw if isinstance(raw, list) else (raw.get("sources") or raw.get("items") or [])
    lines: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        row: dict[str, Any] = {
            "id": item.get("id"),
            "label": item.get("label"),
            "expected_ip": item.get("expected_ip"),
            "ok": False,
            "exit_ip": None,
            "matches_expected": None,
            "ms": None,
            "error": None,
        }
        url = str(item.get("config_url") or "")
        if not url:
            row["error"] = "该线路没有登记 config_url"
            lines.append(row)
            continue
        # Fetching the line list uses the machine's NORMAL route on purpose. Only
        # the dial has to escape TUN; forcing the fetch direct broke on a box whose
        # own IP cannot reach the resource host at all, making every line read as
        # "配置拉不到" when the lines themselves were fine.
        fetched = subprocess.run(
            ["curl", "--silent", "--show-error", "--max-time", "20", url],
            check=False, capture_output=True, text=True,
        )
        if fetched.returncode != 0 or not fetched.stdout.strip():
            row["error"] = "配置拉不到"
            lines.append(row)
            continue
        try:
            import yaml  # lazy: a missing pyyaml must degrade this probe, not the controller
            proxy = (yaml.safe_load(fetched.stdout).get("proxies") or [{}])[0]
        except ImportError:
            row["error"] = "本机缺少 pyyaml,无法解析线路配置"
            lines.append(row)
            continue
        except Exception:
            row["error"] = "配置解析失败"
            lines.append(row)
            continue
        server, port = proxy.get("server"), proxy.get("port")
        user, password = proxy.get("username"), proxy.get("password")
        kind = str(proxy.get("type") or "socks5")
        row["entry"] = f"{server}:{port}"
        if not (server and port):
            row["error"] = "配置里没有 server/port"
            lines.append(row)
            continue
        auth = f"{user}:{password}@" if user else ""
        flag = "--socks5-hostname" if kind == "socks5" else "--proxy"
        target = f"{auth}{server}:{port}" if kind == "socks5" else f"http://{auth}{server}:{port}"
        started = time.monotonic()
        dialed = _direct_run([flag, target, LINE_PROBE_TARGET], 15, no_proxy=False)
        row["ms"] = int((time.monotonic() - started) * 1000)
        exit_ip = dialed.stdout.strip()
        if exit_ip and exit_ip == _direct_exit_ip():
            # The dial leaked past the proxy. Reporting that as success is exactly
            # the "green light that measures nothing" trap; call it out instead.
            row["error"] = "拨号未经代理(出口等于本机直连 IP),结果不可信"
            lines.append(row)
            continue
        if dialed.returncode == 0 and exit_ip:
            row["ok"] = True
            row["exit_ip"] = exit_ip
            row["matches_expected"] = (not row["expected_ip"]) or exit_ip == row["expected_ip"]
        else:
            # curl's own message can quote the credential; keep only its shape.
            stderr = (dialed.stderr or "").lower()
            if "rejected" in stderr or "user was rejected" in stderr:
                row["error"] = "上游拒绝该账号(口令错/入口不匹配/本机未授权,三者不可区分)"
            elif "could not resolve" in stderr:
                row["error"] = "入口域名解析失败"
            elif "timed out" in stderr or "timeout" in stderr:
                row["error"] = "连接超时"
            else:
                row["error"] = "拨号失败"
        lines.append(row)
    _line_cache["at"] = now
    _line_cache["lines"] = lines
    return lines


def system_resources() -> dict[str, int]:
    """Return current memory and root-filesystem usage without subprocesses."""
    resources: dict[str, int] = {}
    try:
        values: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, separator, remainder = line.partition(":")
            if not separator:
                continue
            fields = remainder.strip().split()
            if fields and fields[0].isdigit():
                values[key] = int(fields[0]) * 1024
        total = values.get("MemTotal", 0)
        available = values.get("MemAvailable")
        if available is None:
            available = sum(values.get(key, 0) for key in ("MemFree", "Buffers", "Cached"))
        if total > 0:
            resources["memory_total_bytes"] = total
            resources["memory_used_bytes"] = max(0, min(total, total - available))
    except (OSError, ValueError):
        pass

    try:
        disk = os.statvfs("/")
        total = disk.f_blocks * disk.f_frsize
        free = disk.f_bfree * disk.f_frsize
        if total > 0:
            resources["root_disk_total_bytes"] = total
            resources["root_disk_used_bytes"] = max(0, min(total, total - free))
    except OSError:
        pass
    return resources


DESKTOP_STATUS_PATH = Path("/var/lib/linux-browser-vnc/status.json")
DESKTOP_STALE_SECONDS = 120


def desktop_status(
    path: Path = DESKTOP_STATUS_PATH, now: float | None = None
) -> dict[str, Any] | None:
    """Summarize the optional linux-browser-vnc desktop for the fleet view.

    The browser desktop is a separate skill. This reads only the small status
    file it publishes, so a machine without a desktop simply reports nothing and
    a broken desktop can never affect Clash's own status.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(document, dict):
        return None

    stamp = str(document.get("checked_at") or "")
    fresh = False
    if stamp:
        try:
            observed = dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=dt.timezone.utc
            )
            current = (
                dt.datetime.now(dt.timezone.utc)
                if now is None
                else dt.datetime.fromtimestamp(now, dt.timezone.utc)
            )
            fresh = 0 <= (current - observed).total_seconds() <= DESKTOP_STALE_SECONDS
        except ValueError:
            fresh = False

    url = str(document.get("public_url") or "")
    if not re.fullmatch(r"https://[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,4}/?", url):
        url = ""

    processes = document.get("browser_processes")
    memory = document.get("browser_memory_bytes")
    configured = document.get("instances_configured")
    up = document.get("instances_up")

    def _count(value: Any) -> int | None:
        return value if isinstance(value, int) and value >= 0 else None

    return {
        # A stale document is not evidence: the health loop may have died while
        # the file still says ok.
        "online": bool(document.get("ok")) and fresh,
        "fresh": fresh,
        "url": url,
        "browser_processes": _count(processes),
        "browser_memory_bytes": _count(memory),
        # Present only for multi-instance desktops; older single-instance
        # documents omit them and the fleet treats that as one instance.
        "instances_configured": _count(configured),
        "instances_up": _count(up),
        "checked_at": stamp[:80],
    }


class ActionError(RuntimeError):
    """An expected control operation failure."""


class BusyError(ActionError):
    """Another operation is already running."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, json.JSONDecodeError):
        return default


def atomic_write_json(path: Path, value: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def validate_config_url(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 2048:
        raise ActionError("config_url must be a non-empty HTTPS URL")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ActionError("config_url must be an HTTPS URL without URL userinfo")
    if parsed.fragment:
        raise ActionError("config_url must not contain a fragment")
    return value


def validate_ipv4(value: str, field: str = "expected_ip") -> str:
    if not isinstance(value, str):
        raise ActionError(f"{field} must be an IPv4 address")
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise ActionError(f"{field} must be an IPv4 address") from exc
    if address.version != 4:
        raise ActionError(f"{field} must be an IPv4 address")
    return str(address)


def parse_plan_selection(output: str) -> dict[str, str]:
    values: dict[str, str] = {}
    fields = {
        "server_ip": r"^Pinned server IP:\s*(\S+)\s*$",
        "tcp_exit_ip": r"^Observed TCP exit:\s*(\S+)\s*$",
        "udp_exit_ip": r"^Observed UDP exit:\s*(\S+)\s*$",
    }
    for field, pattern in fields.items():
        match = re.search(pattern, output, re.MULTILINE)
        if not match:
            raise ActionError("proxy plan did not return a reusable endpoint selection")
        values[field] = validate_ipv4(match.group(1), field)
    if values["tcp_exit_ip"] != values["udp_exit_ip"]:
        raise ActionError("proxy plan returned different TCP and UDP exits")
    return values


def redact_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname or "unknown"
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{hostname}{port}/…"
    except (ValueError, TypeError):
        return "configured"


def sanitize_message(value: str, secrets_to_remove: list[str]) -> str:
    cleaned = value
    for secret in secrets_to_remove:
        if secret:
            cleaned = cleaned.replace(secret, "[redacted]")
    cleaned = re.sub(r"https://\S+", "[redacted-url]", cleaned)
    return cleaned.strip()[-4000:]


def default_execute(argv: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        environment.pop(key, None)
    environment["LC_ALL"] = "C"
    process = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        raise ActionError(f"operation timed out after {timeout} seconds")
    result = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, argv, output=stdout, stderr=stderr
        )
    return result


def default_system_probe() -> dict[str, Any]:
    active = subprocess.run(
        ["systemctl", "is-active", "--quiet", "mihomo.service"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0
    return {
        "service_active": active,
        "tun_present": Path("/sys/class/net/Mihomo").exists(),
    }


def public_tunnel_is_healthy(url_path: Path) -> bool:
    try:
        url = url_path.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not re.fullmatch(r"https://[a-z0-9-]+\.[a-z0-9.-]+/?", url):
        return False
    health_url = f"{url.rstrip('/')}/healthz"
    return subprocess.run(
        [
            "runuser",
            "--user",
            "linux-clash-tunnel",
            "--",
            "curl",
            "--noproxy",
            "*",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "8",
            health_url,
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def default_refresh_management_tunnel() -> None:
    unit_path = Path("/etc/systemd/system/linux-clash-dashboard-public.service")
    if not unit_path.is_file():
        return
    url_path = Path("/var/lib/linux-clash-tunnel/dashboard-public.url")
    if public_tunnel_is_healthy(url_path):
        return
    restarted = subprocess.run(
        ["systemctl", "restart", "linux-clash-dashboard-public.service"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if restarted.returncode != 0:
        raise ActionError("public Dashboard tunnel restart failed")
    for _attempt in range(30):
        if public_tunnel_is_healthy(url_path):
            return
        time.sleep(1)
    raise ActionError("public Dashboard tunnel did not recover after route change")


class NodeControl:
    def __init__(
        self,
        config_path: Path,
        state_root: Path,
        skill_script: Path,
        execute: Callable[[list[str], int], subprocess.CompletedProcess[str]] = default_execute,
        system_probe: Callable[[], dict[str, Any]] = default_system_probe,
        resource_probe: Callable[[], dict[str, int]] = system_resources,
        desktop_probe: Callable[[], dict[str, Any] | None] = desktop_status,
        refresh_management_tunnel: Callable[[], None] = default_refresh_management_tunnel,
        sources_path: Path = Path("/etc/linux-clash-skill/sources.json"),
    ) -> None:
        self.sources_path = sources_path
        self.config_path = config_path
        self.state_root = state_root
        self.skill_script = skill_script
        self.execute = execute
        self.system_probe = system_probe
        self.resource_probe = resource_probe
        self.desktop_probe = desktop_probe
        self.refresh_management_tunnel = refresh_management_tunnel
        self.operation_path = state_root / "controller-operation.json"
        self.result_path = state_root / "result.json"
        self._operation_lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def load_settings(self) -> dict[str, Any]:
        settings = read_json(self.config_path, None)
        if not isinstance(settings, dict):
            raise ActionError("controller configuration is missing or invalid")
        settings["config_url"] = validate_config_url(settings.get("config_url", ""))
        expected_ip = settings.get("expected_ip", "")
        settings["expected_ip"] = validate_ipv4(expected_ip) if expected_ip else ""
        server_ip = settings.get("server_ip", "")
        settings["server_ip"] = validate_ipv4(server_ip, "server_ip") if server_ip else ""
        proxy_name = settings.get("proxy_name", "")
        if not isinstance(proxy_name, str) or len(proxy_name) > 200:
            raise ActionError("proxy_name is invalid")
        settings["proxy_name"] = proxy_name
        rollback = settings.get("rollback_seconds", 180)
        if not isinstance(rollback, int) or not 60 <= rollback <= 900:
            raise ActionError("rollback_seconds must be between 60 and 900")
        settings["rollback_seconds"] = rollback
        exclude_uids = settings.get("exclude_uids", [])
        if not isinstance(exclude_uids, list) or any(
            not isinstance(value, int) or value < 0 for value in exclude_uids
        ):
            raise ActionError("exclude_uids must contain non-negative integers")
        settings["exclude_uids"] = list(dict.fromkeys(exclude_uids))
        align_timezone = settings.get("align_timezone", True)
        if not isinstance(align_timezone, bool):
            raise ActionError("align_timezone must be a boolean")
        settings["align_timezone"] = align_timezone
        return settings

    def save_settings(self, settings: dict[str, Any]) -> None:
        normalized = {
            "node_name": str(settings.get("node_name", platform.node()))[:200],
            "config_url": validate_config_url(settings["config_url"]),
            "expected_ip": validate_ipv4(settings["expected_ip"])
            if settings.get("expected_ip")
            else "",
            "proxy_name": str(settings.get("proxy_name", ""))[:200],
            "server_ip": validate_ipv4(settings["server_ip"], "server_ip")
            if settings.get("server_ip")
            else "",
            "rollback_seconds": int(settings.get("rollback_seconds", 180)),
            "exclude_uids": list(dict.fromkeys(settings.get("exclude_uids", []))),
            "align_timezone": bool(settings.get("align_timezone", True)),
        }
        atomic_write_json(self.config_path, normalized)

    def _public_operation(self) -> dict[str, Any] | None:
        operation = read_json(self.operation_path, None)
        if not isinstance(operation, dict):
            return None
        return {
            key: operation.get(key)
            for key in (
                "id",
                "action",
                "status",
                "created_at",
                "started_at",
                "finished_at",
                "message",
            )
            if operation.get(key) is not None
        }

    def status(self) -> dict[str, Any]:
        try:
            settings = self.load_settings()
            configured = True
            config_url = redact_url(settings["config_url"])
            node_name = str(settings.get("node_name") or platform.node())
            expected_ip = settings.get("expected_ip", "")
            server_ip = settings.get("server_ip", "")
            align_timezone = settings.get("align_timezone", True)
        except ActionError:
            configured = False
            config_url = ""
            node_name = platform.node()
            expected_ip = ""
            server_ip = ""
            align_timezone = True
        probe = self.system_probe()
        try:
            resources = self.resource_probe()
        except (OSError, ValueError):
            resources = {}
        if not isinstance(resources, dict):
            resources = {}
        try:
            desktop = self.desktop_probe()
        except (OSError, ValueError):
            desktop = None
        if not isinstance(desktop, dict):
            desktop = None
        active = bool(probe.get("service_active") and probe.get("tun_present"))
        result = read_json(self.result_path, {})
        public_result = {
            key: value
            for key, value in result.items()
            if key in PUBLIC_RESULT_FIELDS
        } if isinstance(result, dict) else {}
        if not active:
            # A successful result from an earlier enabled state is historical, not the current direct exit.
            public_result = {}
        return {
            "version": VERSION,
            "node_name": node_name,
            "configured": configured,
            "proxy_enabled": active,
            "service_active": bool(probe.get("service_active")),
            "tun_present": bool(probe.get("tun_present")),
            "config_source": config_url,
            "expected_ip": expected_ip,
            "server_ip": server_ip,
            "align_timezone": align_timezone,
            "timezone": system_timezone(),
            "resources": resources,
            "desktop": desktop,
            "platform": platform.platform(),
            "last_result": public_result,
            "operation": self._public_operation(),
            "checked_at": utc_now(),
        }

    def _command(
        self, command: str, settings: dict[str, Any], config_url_file: Path | None = None
    ) -> list[str]:
        argv = ["bash", str(self.skill_script), command]
        if command in {"plan", "install"}:
            if config_url_file is None:
                raise ActionError("protected config URL file is required")
            argv.extend(["--config-url-file", str(config_url_file)])
            if settings.get("proxy_name"):
                argv.extend(["--proxy-name", settings["proxy_name"]])
            if settings.get("server_ip"):
                argv.extend(["--server-ip", settings["server_ip"]])
            argv.extend(["--rollback-seconds", str(settings["rollback_seconds"])])
            for uid in settings.get("exclude_uids", []):
                argv.extend(["--exclude-uid", str(uid)])
        if command in {"plan", "install", "verify"} and settings.get("expected_ip"):
            argv.extend(["--expected-ip", settings["expected_ip"]])
        if command in {"install", "verify"} and settings.get("align_timezone", True):
            argv.append("--align-timezone")
        return argv

    def _run(self, command: str, settings: dict[str, Any], timeout: int = 900) -> str:
        url_path: Path | None = None
        try:
            if command in {"plan", "install"}:
                self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                descriptor, temporary = tempfile.mkstemp(
                    prefix=".controller-source.", dir=self.state_root
                )
                url_path = Path(temporary)
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    handle.write(settings["config_url"] + "\n")
                os.chmod(url_path, 0o600)
            result = self.execute(self._command(command, settings, url_path), timeout)
        except subprocess.CalledProcessError as exc:
            output = f"{exc.output or ''}\n{exc.stderr or ''}"
            raise ActionError(
                sanitize_message(output, [settings.get("config_url", "")])
                or f"{command} failed"
            ) from exc
        finally:
            if url_path is not None:
                try:
                    url_path.unlink()
                except FileNotFoundError:
                    pass
        return sanitize_message(
            f"{result.stdout or ''}\n{result.stderr or ''}",
            [settings.get("config_url", "")],
        )

    def _is_enabled(self) -> bool:
        probe = self.system_probe()
        return bool(probe.get("service_active") and probe.get("tun_present"))

    def _apply_plan_selection(
        self, settings: dict[str, Any], output: str
    ) -> dict[str, Any]:
        selection = parse_plan_selection(output)
        selected = dict(settings)
        selected["server_ip"] = selection["server_ip"]
        if not selected.get("expected_ip"):
            selected["expected_ip"] = selection["tcp_exit_ip"]
        return selected

    def _with_runtime_selection(self, settings: dict[str, Any]) -> dict[str, Any]:
        selected = dict(settings)
        result = read_json(self.result_path, {})
        if not isinstance(result, dict):
            return selected
        if not selected.get("server_ip") and result.get("pinned_server_ip"):
            try:
                selected["server_ip"] = validate_ipv4(
                    result["pinned_server_ip"], "server_ip"
                )
            except ActionError:
                pass
        if not selected.get("expected_ip") and result.get("exit_ip"):
            try:
                selected["expected_ip"] = validate_ipv4(
                    result["exit_ip"], "expected_ip"
                )
            except ActionError:
                pass
        return selected

    def _enable(self, settings: dict[str, Any]) -> str:
        if self._is_enabled():
            self._run("verify", settings, timeout=180)
            return "Proxy was already enabled and passed verification."
        if not settings.get("server_ip"):
            settings = self._apply_plan_selection(
                settings, self._run("plan", settings, timeout=240)
            )
            self.save_settings(settings)
        self._run("install", settings)
        return "Proxy enabled and TCP/UDP verification passed."

    def _disable(self, settings: dict[str, Any]) -> str:
        if not self._is_enabled():
            return "Proxy was already disabled."
        if (self.state_root / "current-backup").is_file():
            self._run("rollback", settings, timeout=180)
            message = "Proxy disabled and the pre-install network state was restored."
        else:
            self._run("disable", settings, timeout=180)
            message = "Proxy disabled to direct mode; unmanaged legacy files were retained for safe adoption."
        if self._is_enabled():
            raise ActionError("disable completed but Mihomo TUN is still active")
        return message

    def _replacement_settings(
        self, old: dict[str, Any], payload: dict[str, Any]
    ) -> dict[str, Any]:
        new = dict(old)
        new["config_url"] = validate_config_url(payload.get("config_url", ""))
        expected = payload.get("expected_ip", "")
        new["expected_ip"] = validate_ipv4(expected) if expected else ""
        proxy_name = payload.get("proxy_name", "")
        if not isinstance(proxy_name, str) or len(proxy_name) > 200:
            raise ActionError("proxy_name is invalid")
        new["proxy_name"] = proxy_name
        server_ip = payload.get("server_ip", "")
        new["server_ip"] = (
            validate_ipv4(server_ip, "server_ip") if server_ip else ""
        )
        return new

    def _replace(self, payload: dict[str, Any]) -> str:
        old = self._with_runtime_selection(self.load_settings())
        new = self._replacement_settings(old, payload)
        was_enabled = self._is_enabled()
        if was_enabled:
            self._disable(old)
        try:
            new = self._apply_plan_selection(
                new, self._run("plan", new, timeout=240)
            )
            if was_enabled:
                self._run("install", new)
            self.save_settings(new)
        except Exception as exc:
            recovery_error = ""
            if was_enabled:
                try:
                    if self._is_enabled():
                        self._run("rollback", new, timeout=180)
                    self._run("install", old)
                except Exception as recovery_exc:
                    recovery_error = f"; previous proxy recovery also failed: {recovery_exc}"
            raise ActionError(f"replacement failed; previous settings retained: {exc}{recovery_error}") from exc
        if was_enabled:
            return "Proxy source replaced; new TCP/UDP exit passed verification."
        return "Proxy source preflight passed and was saved; proxy remains disabled."

    def execute_action(self, action: str, payload: dict[str, Any]) -> str:
        settings = self.load_settings()
        try:
            if action == "enable":
                return self._enable(settings)
            if action == "disable":
                return self._disable(settings)
            if action == "verify":
                self._run("verify", settings, timeout=180)
                return "TCP and UDP exits passed verification."
            if action == "replace":
                return self._replace(payload)
            raise ActionError("unsupported action")
        finally:
            if action in {"enable", "disable", "replace"}:
                self.refresh_management_tunnel()

    def submit(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action not in {"enable", "disable", "verify", "replace"}:
            raise ActionError("unsupported action")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("another proxy operation is already running")
        operation = {
            "id": secrets.token_hex(12),
            "action": action,
            "status": "queued",
            "created_at": utc_now(),
            "message": "Operation accepted.",
        }
        atomic_write_json(self.operation_path, operation)
        self._thread = threading.Thread(
            target=self._run_operation,
            args=(operation, dict(payload)),
            daemon=True,
        )
        self._thread.start()
        return self._public_operation() or operation

    def _run_operation(self, operation: dict[str, Any], payload: dict[str, Any]) -> None:
        try:
            operation.update(status="running", started_at=utc_now())
            atomic_write_json(self.operation_path, operation)
            operation["message"] = self.execute_action(operation["action"], payload)
            operation["status"] = "succeeded"
        except Exception as exc:
            try:
                settings = self.load_settings()
                secrets_to_remove = [settings.get("config_url", ""), payload.get("config_url", "")]
            except Exception:
                secrets_to_remove = [payload.get("config_url", "")]
            operation["status"] = "failed"
            operation["message"] = sanitize_message(str(exc), secrets_to_remove) or "operation failed"
        finally:
            operation["finished_at"] = utc_now()
            atomic_write_json(self.operation_path, operation)
            self._operation_lock.release()


class ControllerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], control: NodeControl, token_file: Path):
        super().__init__(address, ControllerHandler)
        self.control = control
        self.token_file = token_file


class ControllerHandler(BaseHTTPRequestHandler):
    server: ControllerHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _security_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")

    def _json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        try:
            expected = self.server.token_file.read_text(encoding="utf-8").strip()
        except OSError:
            return False
        supplied = self.headers.get("Authorization", "")
        if not supplied.startswith("Bearer "):
            return False
        return bool(expected) and hmac.compare_digest(supplied[7:], expected)

    def _require_auth(self) -> bool:
        if self._authorized():
            return True
        self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        return False

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        if not self._require_auth():
            return
        if path == "/v1/status":
            self._json(HTTPStatus.OK, self.server.control.status())
            return
        if path == "/v1/lines":
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            force = query.get("force", ["0"])[0] in {"1", "true", "yes"}
            self._json(HTTPStatus.OK, {
                "checked_at": utc_now(),
                "lines": probe_lines(self.server.control.sources_path, force=force),
            })
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if not self._require_auth():
            return
        if path != "/v1/actions":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > MAX_BODY:
                raise ActionError("invalid request size")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ActionError("JSON object required")
            action = body.get("action", "")
            operation = self.server.control.submit(action, body)
            self._json(HTTPStatus.ACCEPTED, operation)
        except BusyError as exc:
            self._json(HTTPStatus.CONFLICT, {"error": str(exc)})
        except (ActionError, json.JSONDecodeError, ValueError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument(
        "--config", type=Path, default=Path("/etc/linux-clash-skill/controller.json")
    )
    parser.add_argument(
        "--sources", type=Path, default=Path("/etc/linux-clash-skill/sources.json")
    )
    parser.add_argument(
        "--token-file", type=Path, default=Path("/etc/linux-clash-skill/controller.token")
    )
    parser.add_argument(
        "--state-root", type=Path, default=Path("/var/lib/linux-clash-skill")
    )
    parser.add_argument(
        "--skill-script",
        type=Path,
        default=Path("/usr/local/lib/linux-clash-skill/scripts/linux-clash-skill.sh"),
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        bind_address = ipaddress.ip_address(args.bind)
    except ValueError as exc:
        raise SystemExit("--bind must be a loopback IP address") from exc
    if not bind_address.is_loopback:
        raise SystemExit("refusing non-loopback bind; expose this service only through a tunnel")
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    control = NodeControl(args.config, args.state_root, args.skill_script, sources_path=args.sources)
    control.load_settings()
    if not args.token_file.is_file():
        raise SystemExit(f"token file does not exist: {args.token_file}")
    server = ControllerHTTPServer((args.bind, args.port), control, args.token_file)
    server.serve_forever()


if __name__ == "__main__":
    main()
