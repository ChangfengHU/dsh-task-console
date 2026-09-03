#!/usr/bin/env python3
"""Measure what the visible desktop browser actually sees.

A node-side probe cannot answer the questions that matter for a remote desktop:
the browser has its own DNS, its own WebRTC stack, its own timezone and its own
language. This module drives the running browser through its loopback DevTools
endpoint and reports those values from inside the real session.

The DevTools endpoint is bound to 127.0.0.1 by the browser unit. Nothing here
opens a network listener, and no credential is ever sent to the page.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import sys
import urllib.error
import urllib.request
from typing import Any

TRACE_TARGETS = {
    "cloudflare_exit_ip": "https://www.cloudflare.com/cdn-cgi/trace",
    "claude_exit_ip": "https://claude.ai/cdn-cgi/trace",
}


class WebSocketError(RuntimeError):
    pass


class MinimalWebSocket:
    """A small RFC 6455 client, sufficient for a loopback DevTools session."""

    def __init__(self, url: str, timeout: float = 30.0) -> None:
        if not url.startswith("ws://"):
            raise WebSocketError("only loopback ws:// DevTools URLs are supported")
        remainder = url[len("ws://") :]
        netloc, _, path = remainder.partition("/")
        host, _, port_text = netloc.partition(":")
        if host not in ("127.0.0.1", "localhost"):
            raise WebSocketError("refusing a non-loopback DevTools host")
        self.socket = socket.create_connection((host, int(port_text or "80")), timeout=timeout)
        self.socket.settimeout(timeout)
        self.buffer = b""
        key = base64.b64encode(os.urandom(16)).decode()
        handshake = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {netloc}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.socket.sendall(handshake.encode())
        while b"\r\n\r\n" not in self.buffer:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise WebSocketError("the DevTools endpoint closed during the handshake")
            self.buffer += chunk
        header, _, rest = self.buffer.partition(b"\r\n\r\n")
        if b" 101 " not in header.split(b"\r\n", 1)[0]:
            raise WebSocketError("the DevTools endpoint refused the WebSocket upgrade")
        self.buffer = rest

    def _recv_exact(self, count: int) -> bytes:
        while len(self.buffer) < count:
            chunk = self.socket.recv(65536)
            if not chunk:
                raise WebSocketError("the DevTools connection closed unexpectedly")
            self.buffer += chunk
        value, self.buffer = self.buffer[:count], self.buffer[count:]
        return value

    def send_text(self, text: str) -> None:
        payload = text.encode()
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.socket.sendall(bytes(header) + masked)

    def receive_text(self) -> str:
        while True:
            first, second = self._recv_exact(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            payload = self._recv_exact(length) if length else b""
            if opcode == 0x9:  # ping
                self.socket.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x8:
                raise WebSocketError("the DevTools endpoint closed the connection")
            if opcode in (0x1, 0x0):
                return payload.decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self.socket.close()
        except OSError:
            pass


class DevToolsSession:
    def __init__(self, port: int, timeout: float = 30.0, scratch_tab: bool = False) -> None:
        self.port = port
        self.timeout = timeout
        self.next_id = 0
        self.scratch_id = ""
        # A scratch about:blank tab has no page CSP, so the exit-IP trace fetch
        # works regardless of what the foreground page is. The measured desktop
        # page (e.g. chatgpt.com) restricts cross-origin fetch, which would
        # otherwise make the probe report no HTTP exit even though the proxy is
        # working. It is closed in close().
        target = self._new_target() if scratch_tab else self._page_target()
        self.socket = MinimalWebSocket(target, timeout=timeout)

    def _page_target(self) -> str:
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            targets = json.loads(response.read().decode())
        for target in targets:
            if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                return str(target["webSocketDebuggerUrl"])
        raise WebSocketError("the browser has no open page target")

    def _new_target(self) -> str:
        # Chrome 111+ requires PUT for /json/new.
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/json/new?about:blank", method="PUT"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                target = json.loads(response.read().decode())
        except urllib.error.HTTPError:
            request = urllib.request.Request(f"http://127.0.0.1:{self.port}/json/new?about:blank")
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                target = json.loads(response.read().decode())
        self.scratch_id = str(target.get("id", ""))
        ws = target.get("webSocketDebuggerUrl")
        if not ws:
            raise WebSocketError("could not open a scratch DevTools tab")
        return str(ws)

    def evaluate(self, expression: str, await_promise: bool = True) -> Any:
        self.next_id += 1
        message_id = self.next_id
        self.socket.send_text(
            json.dumps(
                {
                    "id": message_id,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": expression,
                        "awaitPromise": await_promise,
                        "returnByValue": True,
                        "timeout": int(self.timeout * 1000),
                    },
                }
            )
        )
        while True:
            message = json.loads(self.socket.receive_text())
            if message.get("id") != message_id:
                continue
            if "error" in message:
                raise WebSocketError(str(message["error"].get("message", "evaluate failed")))
            result = message.get("result", {})
            if result.get("exceptionDetails"):
                text = result["exceptionDetails"].get("text", "evaluation raised")
                raise WebSocketError(text)
            return result.get("result", {}).get("value")

    def close(self) -> None:
        self.socket.close()
        if self.scratch_id:
            try:
                urllib.request.urlopen(
                    f"http://127.0.0.1:{self.port}/json/close/{self.scratch_id}",
                    timeout=self.timeout,
                ).close()
            except (urllib.error.URLError, OSError):
                pass


def parse_trace(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in str(text).splitlines():
        key, separator, value = line.partition("=")
        if separator:
            fields[key.strip()] = value.strip()
    return fields


def fetch_expression(url: str) -> str:
    # The page performs the request, so the measurement reflects the browser's
    # own network path rather than the node's.
    return (
        "(async () => {"
        f"  const response = await fetch({json.dumps(url)}, {{cache: 'no-store'}});"
        "  return await response.text();"
        "})()"
    )


WEBRTC_EXPRESSION = """
(async () => {
  const connection = new RTCPeerConnection({
    iceServers: [{urls: 'stun:stun.cloudflare.com:3478'}]
  });
  const found = new Set();
  connection.createDataChannel('probe');
  await connection.setLocalDescription(await connection.createOffer());
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    connection.onicecandidate = (event) => {
      if (!event.candidate) { clearTimeout(timer); resolve(); return; }
      const parts = event.candidate.candidate.split(' ');
      if (parts[7] === 'srflx' || parts[7] === 'prflx') { found.add(parts[4]); }
    };
  });
  connection.close();
  return Array.from(found);
})()
"""


def collect(session: DevToolsSession) -> dict[str, Any]:
    report: dict[str, Any] = {}
    for name, url in TRACE_TARGETS.items():
        try:
            fields = parse_trace(session.evaluate(fetch_expression(url)))
            report[name] = fields.get("ip", "")
            if name == "cloudflare_exit_ip":
                report["cloudflare_trace_location"] = fields.get("loc", "")
        except WebSocketError as error:
            report[name] = ""
            report[f"{name}_error"] = str(error)[:200]
    try:
        report["webrtc_udp_ips"] = session.evaluate(WEBRTC_EXPRESSION) or []
    except WebSocketError as error:
        report["webrtc_udp_ips"] = []
        report["webrtc_error"] = str(error)[:200]
    try:
        report["timezone"] = session.evaluate(
            "Intl.DateTimeFormat().resolvedOptions().timeZone", await_promise=False
        )
        report["language"] = session.evaluate("navigator.language", await_promise=False)
        report["languages"] = session.evaluate("navigator.languages", await_promise=False)
        report["user_agent"] = session.evaluate("navigator.userAgent", await_promise=False)
    except WebSocketError as error:
        report["environment_error"] = str(error)[:200]
    return report


def evaluate_report(report: dict[str, Any], expected_ip: str | None) -> tuple[bool, list[str]]:
    problems: list[str] = []
    observed = {
        report.get("cloudflare_exit_ip", ""),
        report.get("claude_exit_ip", ""),
    }
    observed.discard("")
    if not observed:
        problems.append("the browser reported no HTTP exit IP at all")
    elif len(observed) > 1:
        problems.append(f"the browser HTTP exits disagree: {sorted(observed)}")
    if expected_ip:
        for name in ("cloudflare_exit_ip", "claude_exit_ip"):
            value = report.get(name, "")
            if value and value != expected_ip:
                problems.append(f"{name} is {value}, expected {expected_ip}")
        for address in report.get("webrtc_udp_ips", []) or []:
            if address != expected_ip:
                problems.append(f"WebRTC reflexive address {address} differs from {expected_ip}")
    if not report.get("webrtc_udp_ips"):
        problems.append("no WebRTC reflexive candidate was gathered")
    return (not problems), problems


def websocket_check(url: str, timeout: float = 25.0) -> dict[str, Any]:
    """Prove that the public hostname really completes a noVNC upgrade.

    An HTTP 200 on `/healthz` says nothing about WebSockets: the auto-domain
    agent answered 200 there while dropping every upgrade. Only a `101` plus the
    RFB greeting proves a usable desktop. Once Cloudflare Access protects the
    hostname an unauthenticated probe is redirected instead, which is also a
    pass, because the edge is then enforcing rather than failing.
    """
    import ssl

    hostname = url.split("://", 1)[-1].strip("/")
    try:
        raw = socket.create_connection((hostname, 443), timeout=timeout)
        sock = ssl.create_default_context().wrap_socket(raw, server_hostname=hostname)
    except OSError as error:
        return {"ok": False, "state": "unreachable", "detail": str(error)[:200]}
    try:
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(
            (
                f"GET /websockify HTTP/1.1\r\nHost: {hostname}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                f"Sec-WebSocket-Protocol: binary\r\nOrigin: https://{hostname}\r\n\r\n"
            ).encode()
        )
        sock.settimeout(timeout)
        buffer = b""
        while b"\r\n\r\n" not in buffer and len(buffer) < 65536:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buffer += chunk
        header, _, rest = buffer.partition(b"\r\n\r\n")
        status_line = header.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        if b" 101 " in header.split(b"\r\n", 1)[0]:
            payload = rest
            while len(payload) < 6:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                payload += chunk
            body = payload[2 : 2 + (payload[1] & 0x7F)] if len(payload) > 2 else b""
            if body.startswith(b"RFB "):
                return {
                    "ok": True,
                    "state": "upgraded",
                    "status": status_line,
                    "rfb_greeting": body.decode("ascii", "replace").strip(),
                }
            return {"ok": False, "state": "upgraded_without_rfb", "status": status_line}
        lowered = header.lower()
        if b"cloudflareaccess.com" in lowered or b" 302 " in lowered or b" 403 " in lowered:
            return {"ok": True, "state": "blocked_by_access", "status": status_line}
        return {"ok": False, "state": "no_upgrade", "status": status_line}
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--debug-port", type=int, default=9222)
    parser.add_argument("--expected-ip", default="")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--websocket-check",
        metavar="HTTPS_URL",
        help="only test the public noVNC WebSocket upgrade and exit",
    )
    args = parser.parse_args()

    if args.websocket_check:
        result = websocket_check(args.websocket_check, timeout=args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1

    try:
        session = DevToolsSession(args.debug_port, timeout=args.timeout, scratch_tab=True)
    except (WebSocketError, urllib.error.URLError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)[:300]}, ensure_ascii=False))
        return 2
    try:
        report = collect(session)
    finally:
        session.close()

    ok, problems = evaluate_report(report, args.expected_ip or None)
    report["ok"] = ok
    report["problems"] = problems
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
