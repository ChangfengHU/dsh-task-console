#!/usr/bin/env python3
"""Loopback health service for one linux-browser-vnc desktop.

The service answers ``/healthz`` on loopback with live measurements and mirrors
the same document to two files:

* ``<state>/status.json`` so the Clash node Controller can publish a small,
  sanitized desktop summary without importing anything from this skill;
* ``<web>/healthz`` so the public noVNC route can be probed end to end without
  exposing a second hostname.

Only the standard library is used. Every check is a real measurement: a unit
that is ``active`` while its X display, RFB port, or noVNC bridge is dead must
report ``ok: false``.
"""

from __future__ import annotations

import argparse
import calendar
import http.server
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

VERSION = "1.0.0"
BROWSER_MATCH = ("chrome", "chromium")
STALE_AFTER_SECONDS = 90
SYSTEM_SLICE = Path("/sys/fs/cgroup/system.slice")
PIDS_V1_SLICE = Path("/sys/fs/cgroup/pids/system.slice")
MEMORY_V1_SLICE = Path("/sys/fs/cgroup/memory/system.slice")
# Kept for the single-instance fallback and existing tests.
BROWSER_CGROUP = SYSTEM_SLICE / "linux-browser-vnc-browser.service"
BROWSER_CGROUP_PROCS = BROWSER_CGROUP / "cgroup.procs"
BROWSER_CGROUP_MEMORY = BROWSER_CGROUP / "memory.current"


def instance_cgroup(instance: int, slice_dir: Path = SYSTEM_SLICE, legacy_slices=None) -> Path:
    """Locate the cgroup directory for one browser template instance.

    systemd places ``foo@N.service`` instances inside a per-template slice whose
    name escapes ``-`` as ``\\x2d``, e.g.
    ``system.slice/system-linux\\x2dbrowser\\x2dvnc\\x2dbrowser.slice/linux-browser-vnc-browser@N.service``.
    Rather than reimplement that escaping, find the directory by name; fall back
    to the naive path so a caller with ``scoped_only`` cleanly reports zero.
    """
    unit = f"linux-browser-vnc-browser@{instance}.service"
    direct = slice_dir / unit
    if direct.is_dir():
        return direct
    try:
        for candidate in slice_dir.glob(f"*/{unit}"):
            if candidate.is_dir():
                return candidate
    except OSError:
        pass
    # CentOS/RHEL 8 commonly uses cgroup v1, where each controller has its own
    # system.slice tree rather than the unified v2 path above.
    if legacy_slices is None and slice_dir == SYSTEM_SLICE:
        legacy_slices = (PIDS_V1_SLICE, Path("/sys/fs/cgroup/systemd/system.slice"))
    for legacy_slice in legacy_slices or ():
        direct = legacy_slice / unit
        if direct.is_dir():
            return direct
        try:
            for candidate in legacy_slice.glob(f"*/{unit}"):
                if candidate.is_dir():
                    return candidate
        except OSError:
            pass
    return direct


def instance_memory_file(
    instance: int,
    unified_slice: Path = SYSTEM_SLICE,
    legacy_slice: Path = MEMORY_V1_SLICE,
) -> Path:
    """Return the v2 or v1 charged-memory file for one browser instance."""
    cgroup = instance_cgroup(instance, unified_slice)
    current = cgroup / "memory.current"
    if current.is_file():
        return current
    unit = f"linux-browser-vnc-browser@{instance}.service"
    direct = legacy_slice / unit
    if (direct / "memory.usage_in_bytes").is_file():
        return direct / "memory.usage_in_bytes"
    try:
        for candidate in legacy_slice.glob(f"*/{unit}/memory.usage_in_bytes"):
            if candidate.is_file():
                return candidate
    except OSError:
        pass
    return current


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def display_socket_path(display: str) -> str:
    """Return the abstract-free unix socket path for ``:100`` style displays."""
    number = display.lstrip(":").split(".", 1)[0]
    if not number.isdigit():
        raise ValueError("display must look like :100")
    return f"/tmp/.X11-unix/X{number}"


def check_display(display: str, connect: Callable[[str], bool] | None = None) -> bool:
    """A live X server accepts a connection on its unix socket."""
    try:
        path = display_socket_path(display)
    except ValueError:
        return False
    if connect is not None:
        return connect(path)
    if not Path(path).exists():
        return False
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(3)
    try:
        client.connect(path)
        return True
    except OSError:
        return False
    finally:
        client.close()


def check_tcp(port: int, host: str = "127.0.0.1", timeout: float = 3.0) -> bool:
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        client.close()


def check_http(url: str, timeout: float = 5.0) -> bool:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 400
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _process_owner(status_text: str) -> int | None:
    for line in status_text.splitlines():
        if line.startswith("Uid:"):
            fields = line.split()
            if len(fields) >= 2 and fields[1].isdigit():
                return int(fields[1])
    return None


def _process_rss_bytes(status_text: str) -> int:
    for line in status_text.splitlines():
        if line.startswith("VmRSS:"):
            fields = line.split()
            if len(fields) >= 2 and fields[1].isdigit():
                return int(fields[1]) * 1024
    return 0


def read_cgroup_pids(cgroup_procs: Path) -> list[str] | None:
    """Return the PIDs systemd accounts to the browser unit, or None."""
    try:
        return [line.strip() for line in cgroup_procs.read_text().splitlines() if line.strip().isdigit()]
    except OSError:
        return None


def _looks_like_browser(entry: Path, cmdline: str) -> bool:
    """Identify a browser process without trusting argv[0].

    Chrome rewrites its own argv in place, so a renderer's first NUL-separated
    token is a fragment of the rewritten string rather than the executable path.
    Matching on basename(argv[0]) therefore counted 3 of 11 live processes and
    would have missed a leak entirely. `/proc/PID/exe` survives the rewrite.
    """
    try:
        executable = os.readlink(entry / "exe").rsplit("/", 1)[-1].lower()
        if any(token in executable for token in BROWSER_MATCH):
            return True
    except OSError:
        pass
    return any(token in cmdline.lower() for token in BROWSER_MATCH)


def browser_processes(
    uid: int,
    proc_root: Path = Path("/proc"),
    cgroup_procs: Path = BROWSER_CGROUP_PROCS,
    scoped_only: bool = False,
) -> dict[str, int]:
    """Count and size the desktop's browser processes.

    The unit's cgroup is authoritative when it is readable: it is exactly what
    systemd's TasksMax enforces, and it cannot be fooled by argv rewriting or by
    a process changing its name. The /proc scan is the fallback for a manually
    started single desktop. The 95 node once leaked 144 headless Chrome
    processes, so this count is a health signal, not a diagnostic afterthought.

    With ``scoped_only`` a missing cgroup returns zero rather than scanning all
    of /proc. A per-instance query must never fall back to a uid-wide scan: every
    instance shares the desktop uid, so that would attribute all browsers to each
    instance and multiply the count.
    """
    count = 0
    headless = 0
    rss_total = 0
    scoped = read_cgroup_pids(cgroup_procs)
    if scoped is not None:
        entries = [proc_root / pid for pid in scoped]
    elif scoped_only:
        return {"count": 0, "headless_count": 0, "rss_bytes": 0}
    else:
        try:
            entries = [entry for entry in proc_root.iterdir() if entry.name.isdigit()]
        except OSError:
            return {"count": 0, "headless_count": 0, "rss_bytes": 0}
    for entry in entries:
        try:
            cmdline = (entry / "cmdline").read_bytes().decode("utf-8", "replace")
        except OSError:
            continue
        if not cmdline:
            continue
        if scoped is None and not _looks_like_browser(entry, cmdline):
            continue
        try:
            status_text = (entry / "status").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if scoped is None and _process_owner(status_text) != uid:
            continue
        count += 1
        rss_total += _process_rss_bytes(status_text)
        if "--headless" in cmdline.replace("\x00", " "):
            headless += 1
    return {"count": count, "headless_count": headless, "rss_bytes": rss_total}


def cgroup_memory_bytes(path: Path = BROWSER_CGROUP_MEMORY) -> int | None:
    """Actual charged memory for the browser tree.

    Summing per-process RSS double-counts Chrome's shared pages heavily, so the
    cgroup figure is what the fleet should display and what MemoryMax enforces.
    """
    try:
        value = int(path.read_text().strip())
    except (OSError, ValueError):
        return None
    return value if value >= 0 else None


def read_first_line(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip().splitlines()[0].strip()
    except (OSError, IndexError):
        return ""


class HealthProbe:
    def __init__(
        self,
        display: str,
        rfb_port: int,
        novnc_port: int,
        debug_port: int,
        desktop_uid: int,
        public_url_file: Path,
        max_browser_processes: int,
        instances: int = 1,
    ) -> None:
        self.display = display
        self.rfb_port = rfb_port
        self.novnc_port = novnc_port
        # debug_port is the base; instance i listens on base + i - 1.
        self.debug_port = debug_port
        self.desktop_uid = desktop_uid
        self.public_url_file = public_url_file
        self.max_browser_processes = max_browser_processes
        self.instances = max(1, instances)

    def _instance_status(self, index: int) -> dict[str, Any]:
        port = self.debug_port + index - 1
        cgroup = instance_cgroup(index)
        procs = browser_processes(
            self.desktop_uid, cgroup_procs=cgroup / "cgroup.procs", scoped_only=True
        )
        # A process count alone is not liveness. A browser that fails to start
        # leaves its crash-looping wrapper in the cgroup, which counted as a
        # healthy browser and reported ok:true while nothing was running. The
        # DevTools endpoint only answers when the browser is genuinely up.
        up = procs["count"] > 0 and check_http(f"http://127.0.0.1:{port}/json/version")
        return {
            "instance": index,
            "debug_port": port,
            "up": up,
            "processes": procs["count"],
            "headless_processes": procs["headless_count"],
            "memory_bytes": cgroup_memory_bytes(instance_memory_file(index)),
            "rss_sum_bytes": procs["rss_bytes"],
        }

    def collect(self) -> dict[str, Any]:
        display_ok = check_display(self.display)
        rfb_ok = check_tcp(self.rfb_port)
        novnc_ok = check_http(f"http://127.0.0.1:{self.novnc_port}/vnc.html")
        instances = [self._instance_status(i) for i in range(1, self.instances + 1)]

        total_procs = sum(i["processes"] for i in instances)
        total_mem = sum(i["memory_bytes"] or 0 for i in instances)
        total_rss = sum(i["rss_sum_bytes"] for i in instances)
        instances_up = sum(1 for i in instances if i["up"])
        # Every configured instance must be genuinely up.
        browser_ok = instances_up == self.instances
        bounded = (
            self.max_browser_processes <= 0
            or total_procs <= self.max_browser_processes * self.instances
        )
        checks = {
            "display": display_ok,
            "browser": browser_ok,
            "rfb": rfb_ok,
            "novnc": novnc_ok,
            "process_budget": bounded,
        }
        return {
            "version": VERSION,
            "ok": all(checks.values()),
            "checks": checks,
            "display": self.display,
            "instances_configured": self.instances,
            "instances_up": instances_up,
            "instances": instances,
            "browser_processes": total_procs,
            "browser_memory_bytes": total_mem or None,
            "browser_rss_sum_bytes": total_rss,
            "max_browser_processes": self.max_browser_processes,
            "public_url": read_first_line(self.public_url_file),
            "checked_at": utc_now(),
        }


def write_atomic(path: Path, text: str, mode: int = 0o644) -> None:
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def publish(document: dict[str, Any], targets: list[Path]) -> None:
    text = json.dumps(document, ensure_ascii=False, sort_keys=True) + "\n"
    for target in targets:
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(target, text)
        except OSError:
            continue


def is_stale(document: dict[str, Any], now: float | None = None) -> bool:
    """A published document whose timestamp stopped moving is not evidence."""
    stamp = document.get("checked_at")
    if not isinstance(stamp, str):
        return True
    try:
        parsed = time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return True
    current = time.time() if now is None else now
    # The stamp is UTC, so it must be converted with timegm rather than mktime,
    # which would interpret it in the machine's local zone.
    return (current - calendar.timegm(parsed)) > STALE_AFTER_SECONDS


class HealthHandler(http.server.BaseHTTPRequestHandler):
    server_version = "linux-browser-vnc"
    sys_version = ""
    probe: HealthProbe
    targets: list[Path]

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path.split("?", 1)[0] not in ("/healthz", "/"):
            self.send_error(404, "not found")
            return
        document = self.probe.collect()
        publish(document, self.targets)
        body = (json.dumps(document, ensure_ascii=False, sort_keys=True) + "\n").encode()
        self.send_response(200 if document["ok"] else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        """Access logging is disabled by design, as in the Clash dashboard."""


def refresh_loop(probe: HealthProbe, targets: list[Path], interval: int) -> None:
    while True:
        publish(probe.collect(), targets)
        time.sleep(interval)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--display", default=os.environ.get("VNC_DISPLAY", ":100"))
    parser.add_argument("--rfb-port", type=int, default=int(os.environ.get("VNC_RFB_PORT", "5910")))
    parser.add_argument("--novnc-port", type=int, default=int(os.environ.get("VNC_NOVNC_PORT", "6080")))
    parser.add_argument("--debug-port", type=int, default=int(os.environ.get("BROWSER_DEBUG_PORT", "9222")))
    parser.add_argument("--health-port", type=int, default=int(os.environ.get("VNC_HEALTH_PORT", "6081")))
    parser.add_argument("--desktop-uid", type=int, default=os.getuid())
    parser.add_argument("--state-root", type=Path, default=Path("/var/lib/linux-browser-vnc"))
    parser.add_argument("--web-root", type=Path, default=Path("/var/lib/linux-browser-vnc/web"))
    parser.add_argument(
        "--max-browser-processes",
        type=int,
        default=int(os.environ.get("VNC_MAX_BROWSER_PROCESSES", "60")),
    )
    parser.add_argument("--instances", type=int, default=int(os.environ.get("VNC_INSTANCES", "1")))
    parser.add_argument("--refresh-seconds", type=int, default=20)
    parser.add_argument("--once", action="store_true", help="print one document and exit")
    args = parser.parse_args()

    probe = HealthProbe(
        display=args.display,
        rfb_port=args.rfb_port,
        novnc_port=args.novnc_port,
        debug_port=args.debug_port,
        desktop_uid=args.desktop_uid,
        public_url_file=args.state_root / "public.url",
        max_browser_processes=args.max_browser_processes,
        instances=args.instances,
    )
    targets = [args.state_root / "status.json", args.web_root / "healthz"]

    if args.once:
        document = probe.collect()
        publish(document, targets)
        print(json.dumps(document, ensure_ascii=False, sort_keys=True))
        return 0 if document["ok"] else 1

    HealthHandler.probe = probe
    HealthHandler.targets = targets
    threading.Thread(
        target=refresh_loop,
        args=(probe, targets, max(5, args.refresh_seconds)),
        daemon=True,
    ).start()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.health_port), HealthHandler)
    server.daemon_threads = True
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
