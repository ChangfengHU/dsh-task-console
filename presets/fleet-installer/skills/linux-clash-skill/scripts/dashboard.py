#!/usr/bin/env python3
"""Local multi-node dashboard for linux-clash-skill controllers."""

from __future__ import annotations

import argparse
import base64
import copy
import concurrent.futures
import datetime as dt
import hashlib
import hmac
import http.cookies
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


VERSION = "1.6.0"
MAX_BODY = 16 * 1024
SESSION_SECONDS = 12 * 60 * 60
STATUS_CACHE_SECONDS = 8
FIRST_STATUS_WAIT_SECONDS = 2
NODE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
PUBLIC_DASHBOARD_RESULT_FIELDS = {
    "status",
    "transparent_proxy",
    "exit_ip",
    "udp_exit_ip",
    "tcp_udp_consistent",
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


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_secret(path: Path) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise ValueError(f"secret file is missing or too short: {path}")
    return value


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def issue_session(secret: str, now: int | None = None) -> str:
    issued_at = int(time.time() if now is None else now)
    nonce = secrets.token_hex(8)
    payload = f"{issued_at}.{nonce}"
    signature = hmac.new(
        secret.encode(), f"session:{payload}".encode(), hashlib.sha256
    ).digest()
    return f"{payload}.{b64url(signature)}"


def verify_session(secret: str, value: str, now: int | None = None) -> bool:
    try:
        issued, nonce, signature = value.split(".", 2)
        issued_at = int(issued)
    except (ValueError, AttributeError):
        return False
    current = int(time.time() if now is None else now)
    if issued_at > current + 60 or current - issued_at > SESSION_SECONDS:
        return False
    payload = f"{issued}.{nonce}"
    expected = b64url(
        hmac.new(secret.encode(), f"session:{payload}".encode(), hashlib.sha256).digest()
    )
    return hmac.compare_digest(signature, expected)


def csrf_token(secret: str, session: str) -> str:
    return b64url(
        hmac.new(secret.encode(), f"csrf:{session}".encode(), hashlib.sha256).digest()
    )


def validate_node_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("node URL must not contain credentials, query, or fragment")
    if parsed.path not in ("", "/"):
        raise ValueError("node URL must be an origin without a path")
    if parsed.scheme == "https" and parsed.hostname:
        return value.rstrip("/")
    if parsed.scheme == "http" and parsed.hostname:
        try:
            if ipaddress.ip_address(parsed.hostname).is_loopback:
                return value.rstrip("/")
        except ValueError:
            pass
    raise ValueError("node URL must use HTTPS, except loopback HTTP used for local testing")


class NodeRegistry:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> list[dict[str, Any]]:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        raw_nodes = data.get("nodes") if isinstance(data, dict) else None
        if not isinstance(raw_nodes, list):
            raise ValueError("nodes.json must contain a nodes array")
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        seen_hosts: set[str] = set()
        for raw in raw_nodes:
            if not isinstance(raw, dict):
                raise ValueError("every node entry must be an object")
            node_id = raw.get("id", "")
            if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
                raise ValueError("node id must use lowercase letters, digits, and hyphens")
            if node_id in seen:
                raise ValueError(f"duplicate node id: {node_id}")
            seen.add(node_id)
            token_file = Path(str(raw.get("token_file", "")))
            if not token_file.is_absolute():
                raise ValueError(f"token_file for {node_id} must be absolute")
            node_url = validate_node_url(str(raw.get("url", "")))
            hostname = (urllib.parse.urlsplit(node_url).hostname or "").lower()
            if hostname in seen_hosts:
                raise ValueError(f"duplicate node hostname: {hostname}")
            seen_hosts.add(hostname)
            node = {
                "id": node_id,
                "name": str(raw.get("name") or node_id)[:200],
                "url": node_url,
                "token_file": token_file,
            }
            result.append(node)
        return result

    def get(self, node_id: str) -> dict[str, Any]:
        for node in self.load():
            if node["id"] == node_id:
                return node
        raise KeyError(node_id)


class AuditLog:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    status TEXT NOT NULL,
                    operation_id TEXT NOT NULL DEFAULT '',
                    message TEXT NOT NULL DEFAULT ''
                )
                """
            )
        os.chmod(self.path, 0o600)

    def add(
        self,
        node_id: str,
        action: str,
        status: str,
        operation_id: str = "",
        message: str = "",
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO audit(created_at,node_id,action,status,operation_id,message) VALUES(?,?,?,?,?,?)",
                (utc_now(), node_id, action, status, operation_id[:100], message[:500]),
            )

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 200))
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT created_at,node_id,action,status,operation_id,message FROM audit ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]


class NodeClient:
    def _headers(self, node: dict[str, Any]) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {read_secret(node['token_file'])}",
            "Accept": "application/json",
        }
        return headers

    def request(
        self,
        node: dict[str, Any],
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 15,
    ) -> dict[str, Any]:
        headers = self._headers(node)
        data = None
        method = "GET"
        if payload is not None:
            method = "POST"
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{node['url']}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read(MAX_BODY + 1)
                if len(body) > MAX_BODY:
                    raise ValueError("node response is too large")
                parsed = json.loads(body)
                if not isinstance(parsed, dict):
                    raise ValueError("node returned an invalid JSON response")
                return parsed
        except urllib.error.HTTPError as exc:
            try:
                body = json.loads(exc.read(MAX_BODY))
                message = str(body.get("error", "node request failed"))
            except Exception:
                message = "node request failed"
            raise ValueError(f"node returned HTTP {exc.code}: {message}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ValueError("node is unreachable through its management tunnel") from exc

    def status(self, node: dict[str, Any]) -> dict[str, Any]:
        status = self.request(node, "/v1/status", timeout=12)
        allowed = {
            "version",
            "node_name",
            "configured",
            "proxy_enabled",
            "service_active",
            "tun_present",
            "config_source",
            "expected_ip",
            "server_ip",
            "align_timezone",
            "timezone",
            "resources",
            "desktop",
            "platform",
            "last_result",
            "operation",
            "checked_at",
        }
        public = {key: value for key, value in status.items() if key in allowed}
        return {**public, "id": node["id"], "name": node["name"], "reachable": True}

    def lines(self, node: dict[str, Any], force: bool = False) -> dict[str, Any]:
        # Read-only on the node: it dials each configured line without switching,
        # so it answers "could this box move there?" while everything keeps running.
        path = "/v1/lines?force=1" if force else "/v1/lines"
        return self.request(node, path, timeout=120)

    def action(
        self, node: dict[str, Any], payload: dict[str, Any]
    ) -> dict[str, Any]:
        result = self.request(node, "/v1/actions", payload=payload, timeout=20)
        return {
            key: result.get(key)
            for key in ("id", "action", "status", "created_at", "message")
            if result.get(key) is not None
        }


class DashboardApp:
    def __init__(
        self,
        registry: NodeRegistry,
        audit: AuditLog,
        admin_token_file: Path,
        static_root: Path,
        insecure_cookie: bool = False,
        client: NodeClient | None = None,
        sources_path: Path | None = None,
    ) -> None:
        self.registry = registry
        self.audit = audit
        self.admin_token_file = admin_token_file
        self.static_root = static_root
        self.sources_path = sources_path or Path("/etc/linux-clash-skill/sources.json")
        self.insecure_cookie = insecure_cookie
        self.client = client or NodeClient()
        self._status_lock = threading.Lock()
        self._status_ready = threading.Event()
        self._status_cache: list[dict[str, Any]] = []
        self._status_cached_at = 0.0
        self._status_refreshing = False

    def secret(self) -> str:
        return read_secret(self.admin_token_file)

    def _fetch_statuses(self) -> list[dict[str, Any]]:
        nodes = self.registry.load()

        def fetch(node: dict[str, Any]) -> dict[str, Any]:
            try:
                return self.client.status(node)
            except Exception as exc:
                return {
                    "id": node["id"],
                    "name": node["name"],
                    "reachable": False,
                    "proxy_enabled": False,
                    "error": str(exc)[:300],
                    "checked_at": utc_now(),
                }

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, max(1, len(nodes)))) as pool:
            return list(pool.map(fetch, nodes))

    def _refresh_statuses(self) -> None:
        statuses: list[dict[str, Any]] | None = None
        try:
            statuses = self._fetch_statuses()
        finally:
            with self._status_lock:
                if statuses is not None:
                    self._status_cache = statuses
                    self._status_cached_at = time.monotonic()
                self._status_refreshing = False
                self._status_ready.set()

    def _start_status_refresh(self) -> bool:
        with self._status_lock:
            stale = time.monotonic() - self._status_cached_at >= STATUS_CACHE_SECONDS
            if not stale or self._status_refreshing:
                return False
            self._status_refreshing = True
            self._status_ready.clear()
        threading.Thread(target=self._refresh_statuses, daemon=True).start()
        return True

    def _status_snapshot(self) -> list[dict[str, Any]]:
        with self._status_lock:
            return copy.deepcopy(self._status_cache)

    def list_statuses(self, include_admin: bool = False) -> list[dict[str, Any]]:
        self._start_status_refresh()
        statuses = self._status_snapshot()
        if not statuses:
            self._status_ready.wait(FIRST_STATUS_WAIT_SECONDS)
            statuses = self._status_snapshot()
        if not statuses:
            statuses = [
                {
                    "id": node["id"],
                    "name": node["name"],
                    "reachable": False,
                    "proxy_enabled": False,
                    "error": "node status refresh is still running",
                    "checked_at": utc_now(),
                }
                for node in self.registry.load()
            ]
        for status in statuses:
            if not include_admin:
                for key in ("config_source", "operation", "platform", "server_ip", "align_timezone"):
                    status.pop(key, None)
                result = status.get("last_result")
                if isinstance(result, dict):
                    status["last_result"] = {
                        key: value
                        for key, value in result.items()
                        if key in PUBLIC_DASHBOARD_RESULT_FIELDS
                    }
        return statuses

    # Named proxy sources, so switching lines is a click instead of pasting a URL.
    #
    # The URL is the credential: these YAMLs are publicly readable and contain the
    # username and password in clear, so whoever holds the link holds the line.
    # The list is therefore read server-side and the browser only ever sees an id
    # and a label — safer than the existing dialog, which requires pasting the
    # secret into an input box.
    def sources(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self.sources_path.read_text())
        except FileNotFoundError:
            # Genuinely not configured. An empty list is the honest answer.
            return []
        except PermissionError as exc:
            # A file that exists but cannot be read must NOT look the same as one
            # that was never configured. Swallowing this is how the switcher
            # rendered zero lines with no error anywhere: the dashboard runs as
            # linux-clash-dashboard and the file was root-only.
            raise RuntimeError(
                f"proxy sources unreadable ({self.sources_path}): {exc.strerror}. "
                "Expected mode 640 root:linux-clash-dashboard."
            ) from exc
        except ValueError as exc:
            raise RuntimeError(f"proxy sources file is not valid JSON: {exc}") from exc
        out = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            sid = str(item.get("id", ""))
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", sid):
                continue
            out.append({
                "id": sid,
                "label": str(item.get("label", sid))[:80],
                "expected_ip": str(item.get("expected_ip", ""))[:45],
                "note": str(item.get("note", ""))[:120],
            })
        return out

    def _source_payload(self, source_id: str) -> dict[str, Any]:
        try:
            raw = json.loads(self.sources_path.read_text())
        except FileNotFoundError:
            raise ValueError("no proxy sources configured")
        except PermissionError as exc:
            raise ValueError(f"proxy sources unreadable: {exc.strerror}")
        except ValueError as exc:
            raise ValueError(f"proxy sources file is not valid JSON: {exc}")
        for item in raw if isinstance(raw, list) else []:
            if isinstance(item, dict) and str(item.get("id", "")) == source_id:
                url = str(item.get("config_url", ""))
                if not url.startswith("https://"):
                    raise ValueError("source has no https config_url")
                return {
                    "config_url": url,
                    "expected_ip": str(item.get("expected_ip", "")),
                    "proxy_name": str(item.get("proxy_name", "")),
                    "server_ip": "",
                }
        raise ValueError("unknown source")

    def lines(self, force: bool = False) -> dict[str, Any]:
        out: list[dict[str, Any]] = []
        for node in self.registry.load():
            row: dict[str, Any] = {"node": node.get("id"), "name": node.get("name")}
            try:
                probed = self.client.lines(node, force=force)
                row["checked_at"] = probed.get("checked_at")
                row["lines"] = probed.get("lines") or []
            except Exception as exc:
                # An unreachable node must read as unknown, never as "no lines".
                row["error"] = str(exc)[:160]
                row["lines"] = []
            out.append(row)
        return {"nodes": out}

    def action(self, node_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        action = payload.get("action", "")
        if action not in {"enable", "disable", "verify", "replace"}:
            raise ValueError("unsupported action")
        # A replace may name a configured source instead of carrying the URL. The
        # substitution happens here so the secret never has to reach the browser.
        source_id = payload.get("source_id", "")
        if action == "replace" and source_id:
            payload = {"action": "replace", **self._source_payload(str(source_id))}
        node = self.registry.get(node_id)
        try:
            result = self.client.action(node, payload)
            self.audit.add(
                node_id,
                action,
                "accepted",
                str(result.get("id", "")),
                str(result.get("message", "")),
            )
            with self._status_lock:
                self._status_cached_at = 0.0
                self._status_cache = []
            return result
        except Exception as exc:
            self.audit.add(node_id, action, "failed", message=str(exc))
            raise


class DashboardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], app: DashboardApp):
        super().__init__(address, DashboardHandler)
        self.app = app


class DashboardHandler(BaseHTTPRequestHandler):
    server: DashboardHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _headers(self, content_type: str, length: int, cache: str = "no-store") -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self' https://ip.net.coffee stun:; img-src 'self' data:; "
            "style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
        )
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        if not self.server.app.insecure_cookie:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    def _bytes(
        self, status: int, body: bytes, content_type: str, cache: str = "no-store"
    ) -> None:
        self.send_response(status)
        self._headers(content_type, len(body), cache)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, body: dict[str, Any] | list[Any]) -> None:
        self._bytes(
            status,
            json.dumps(body, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _cookie(self) -> str:
        cookie = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("lcs_session")
        return morsel.value if morsel else ""

    def _session(self) -> str:
        value = self._cookie()
        try:
            secret = self.server.app.secret()
        except (OSError, ValueError):
            return ""
        return value if verify_session(secret, value) else ""

    def _require_session(self, api: bool = False) -> str:
        session = self._session()
        if session:
            return session
        if api:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        else:
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/login")
            self.send_header("Content-Length", "0")
            self.end_headers()
        return ""

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 2 or length > MAX_BODY:
            raise ValueError("invalid request size")
        body = json.loads(self.rfile.read(length))
        if not isinstance(body, dict):
            raise ValueError("JSON object required")
        return body

    def _csrf_valid(self, session: str) -> bool:
        supplied = self.headers.get("X-CSRF-Token", "")
        expected = csrf_token(self.server.app.secret(), session)
        return hmac.compare_digest(supplied, expected)

    def _static(self, filename: str, content_type: str, authenticated: bool = False) -> None:
        if authenticated and not self._require_session():
            return
        root = self.server.app.static_root
        try:
            body = (root / filename).read_bytes()
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "dashboard assets missing"})
            return
        is_html = content_type.startswith("text/html")
        if is_html:
            # Stamp the asset links with their own mtime. The HTML itself is
            # no-store, so a fresh page always names the current CSS and JS.
            #
            # Without this a deploy is invisible: the response header says
            # max-age=300, but the edge in front of this tunnel rewrites it to
            # 14400, so a browser keeps a four-hour-old app.js and the page looks
            # simply unchanged — no error, nothing to notice. Asking people to
            # hard-refresh is not a fix; the URL has to change when the file does.
            for asset in ("app.css", "app.js"):
                try:
                    stamp = int((root / asset).stat().st_mtime)
                except OSError:
                    continue
                body = body.replace(
                    f"/static/{asset}".encode(), f"/static/{asset}?v={stamp}".encode()
                )
        cache = "no-store" if is_html else "public, max-age=300"
        self._bytes(HTTPStatus.OK, body, content_type, cache)

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            self._json(HTTPStatus.OK, {"status": "ok", "version": VERSION})
            return
        if path == "/login":
            if self._session():
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._static("login.html", "text/html; charset=utf-8")
            return
        if path == "/static/app.css":
            self._static("app.css", "text/css; charset=utf-8")
            return
        if path == "/static/app.js":
            self._static("app.js", "text/javascript; charset=utf-8")
            return
        if path == "/":
            self._static("index.html", "text/html; charset=utf-8")
            return
        try:
            if path == "/api/session":
                session = self._session()
                body = {"authenticated": bool(session), "version": VERSION}
                if session:
                    body["csrf_token"] = csrf_token(self.server.app.secret(), session)
                self._json(HTTPStatus.OK, body)
            elif path == "/api/nodes":
                self._json(
                    HTTPStatus.OK,
                    {"nodes": self.server.app.list_statuses(include_admin=bool(self._session()))},
                )
            elif path == "/api/sources":
                # Authenticated: the list of lines is operational detail, and the
                # id is what a POST accepts, so it must not be public.
                if not self._require_session(api=True):
                    return
                self._json(HTTPStatus.OK, {"sources": self.server.app.sources()})
            elif path == "/api/lines":
                # Public on purpose: it answers "which lines could this box use",
                # carries no URL and no credential, and its whole value is being
                # visible at a glance next to the machine card.
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                force = query.get("force", ["0"])[0] in {"1", "true", "yes"}
                self._json(HTTPStatus.OK, self.server.app.lines(force=force))
            elif path == "/api/audit":
                if not self._require_session(api=True):
                    return
                self._json(HTTPStatus.OK, {"events": self.server.app.audit.recent()})
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        except Exception as exc:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)[:300]})

    def do_POST(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/login":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 4096:
                    raise ValueError("invalid request")
                values = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8"))
                supplied = values.get("token", [""])[0]
                secret = self.server.app.secret()
                if not hmac.compare_digest(supplied, secret):
                    raise ValueError("invalid token")
                session = issue_session(secret)
                secure = "" if self.server.app.insecure_cookie else "; Secure"
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", "/")
                self.send_header(
                    "Set-Cookie",
                    f"lcs_session={session}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Strict{secure}",
                )
                self.send_header("Content-Length", "0")
                self.end_headers()
            except Exception:
                self._bytes(
                    HTTPStatus.UNAUTHORIZED,
                    "登录失败，请检查管理令牌。".encode("utf-8"),
                    "text/plain; charset=utf-8",
                )
            return
        session = self._require_session(api=True)
        if not session:
            return
        if not self._csrf_valid(session):
            self._json(HTTPStatus.FORBIDDEN, {"error": "invalid CSRF token"})
            return
        if path == "/logout":
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/login")
            self.send_header("Set-Cookie", "lcs_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        match = re.fullmatch(r"/api/nodes/([a-z0-9][a-z0-9-]{0,62})/actions", path)
        if not match:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            payload = self._read_json()
            result = self.server.app.action(match.group(1), payload)
            self._json(HTTPStatus.ACCEPTED, result)
        except KeyError:
            self._json(HTTPStatus.NOT_FOUND, {"error": "unknown node"})
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)[:300]})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--nodes", type=Path, default=Path("/etc/linux-clash-skill/nodes.json"))
    parser.add_argument(
        "--admin-token-file",
        type=Path,
        default=Path("/etc/linux-clash-skill/dashboard.token"),
    )
    parser.add_argument(
        "--database", type=Path, default=Path("/var/lib/linux-clash-dashboard/audit.sqlite3")
    )
    parser.add_argument(
        "--static-root",
        type=Path,
        default=Path("/usr/local/share/linux-clash-dashboard"),
    )
    parser.add_argument(
        "--sources",
        type=Path,
        default=Path("/etc/linux-clash-skill/sources.json"),
        help="named proxy sources; the file holds the URLs, the browser never sees them",
    )
    parser.add_argument("--insecure-cookie", action="store_true")
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
    app = DashboardApp(
        NodeRegistry(args.nodes),
        AuditLog(args.database),
        args.admin_token_file,
        args.static_root,
        args.insecure_cookie,
        None,
        args.sources,
    )
    app.secret()
    app.registry.load()
    DashboardHTTPServer((args.bind, args.port), app).serve_forever()


if __name__ == "__main__":
    main()
