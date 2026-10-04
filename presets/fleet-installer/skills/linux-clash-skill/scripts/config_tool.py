#!/usr/bin/env python3
"""Safely inspect and render a Mihomo TUN config from a Clash YAML source."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import ssl
from pathlib import Path
from typing import Any

import yaml


MANAGED_HOSTS_BEGIN = "# BEGIN linux-clash-skill"
MANAGED_HOSTS_END = "# END linux-clash-skill"
HOSTNAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Clash YAML must contain a top-level mapping")
    return data


def select_proxy(data: dict[str, Any], requested_name: str | None) -> dict[str, Any]:
    proxies = data.get("proxies")
    if not isinstance(proxies, list) or not proxies:
        raise ValueError("Clash YAML does not contain any proxies")

    candidates = [item for item in proxies if isinstance(item, dict)]
    selected: dict[str, Any] | None = None

    if requested_name:
        selected = next((item for item in candidates if item.get("name") == requested_name), None)
        if selected is None:
            raise ValueError(f"proxy not found: {requested_name}")
    else:
        names = {str(item.get("name")): item for item in candidates if item.get("name")}
        for group in data.get("proxy-groups") or []:
            if not isinstance(group, dict):
                continue
            for name in group.get("proxies") or []:
                if name in names:
                    selected = names[name]
                    break
            if selected:
                break
        if selected is None:
            selected = next((item for item in candidates if item.get("type") == "socks5"), candidates[0])

    selected = dict(selected)
    if selected.get("type") != "socks5":
        raise ValueError(f"only socks5 proxies are supported; got: {selected.get('type')!r}")
    if not selected.get("name") or not selected.get("server"):
        raise ValueError("selected proxy must contain name and server")
    if not isinstance(selected["name"], str) or any(ord(char) < 32 for char in selected["name"]):
        raise ValueError("selected proxy has an invalid name")
    if not isinstance(selected["server"], str) or not HOSTNAME_RE.fullmatch(selected["server"]):
        raise ValueError("selected proxy has an invalid server hostname")
    try:
        port = int(selected.get("port"))
    except (TypeError, ValueError) as exc:
        raise ValueError("selected proxy has an invalid port") from exc
    if not 1 <= port <= 65535:
        raise ValueError("selected proxy port is outside 1..65535")
    selected["port"] = port
    return selected


def inspect_proxy(args: argparse.Namespace) -> None:
    selected = select_proxy(load_yaml(args.source), args.proxy_name)
    result = {
        "name": selected["name"],
        "type": selected["type"],
        "server": selected["server"],
        "port": selected["port"],
        "has_username": bool(selected.get("username")),
        "has_password": bool(selected.get("password")),
    }
    print(json.dumps(result, ensure_ascii=False))


def print_field(args: argparse.Namespace) -> None:
    selected = select_proxy(load_yaml(args.source), args.proxy_name)
    allowed = {"name", "type", "server", "port"}
    if args.field not in allowed:
        raise ValueError(f"unsupported field: {args.field}")
    print(selected[args.field])


def recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ValueError("SOCKS5 server closed the connection early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def authenticate_socks(sock: socket.socket, selected: dict[str, Any]) -> None:
    username = str(selected.get("username") or "").encode("utf-8")
    password = str(selected.get("password") or "").encode("utf-8")
    if len(username) > 255 or len(password) > 255:
        raise ValueError("SOCKS5 username or password is too long")
    methods = [0x00]
    if username or password:
        methods.insert(0, 0x02)
    sock.sendall(bytes([0x05, len(methods), *methods]))
    version, method = recv_exact(sock, 2)
    if version != 0x05 or method == 0xFF:
        raise ValueError("SOCKS5 method negotiation failed")
    if method == 0x02:
        sock.sendall(bytes([0x01, len(username)]) + username + bytes([len(password)]) + password)
        auth_version, auth_status = recv_exact(sock, 2)
        if auth_version != 0x01 or auth_status != 0x00:
            raise ValueError("SOCKS5 authentication failed")
    elif method != 0x00:
        raise ValueError(f"unsupported SOCKS5 authentication method: {method}")


def read_socks_reply(sock: socket.socket, action: str) -> tuple[str, int]:
    reply_version, reply_status, _, address_type = recv_exact(sock, 4)
    if reply_version != 0x05 or reply_status != 0x00:
        raise ValueError(f"SOCKS5 {action} failed with status {reply_status}")
    if address_type == 0x01:
        host = socket.inet_ntoa(recv_exact(sock, 4))
    elif address_type == 0x03:
        host = recv_exact(sock, recv_exact(sock, 1)[0]).decode("idna")
    elif address_type == 0x04:
        host = socket.inet_ntop(socket.AF_INET6, recv_exact(sock, 16))
    else:
        raise ValueError("SOCKS5 server returned an unknown address type")
    port = int.from_bytes(recv_exact(sock, 2), "big")
    return host, port


def validate_probe_options(args: argparse.Namespace) -> None:
    if not 1 <= args.target_port <= 65535:
        raise ValueError("probe target port is outside 1..65535")
    if not 1 <= args.timeout <= 60:
        raise ValueError("probe timeout is outside 1..60 seconds")


def make_stun_request() -> tuple[bytes, bytes]:
    transaction_id = os.urandom(12)
    return (
        b"\x00\x01\x00\x00\x21\x12\xa4\x42" + transaction_id,
        transaction_id,
    )


def parse_stun_response(data: bytes, transaction_id: bytes) -> ipaddress.IPv4Address:
    if len(data) < 20:
        raise ValueError("STUN response is too short")
    message_type, length, cookie = int.from_bytes(data[:2], "big"), int.from_bytes(data[2:4], "big"), data[4:8]
    if message_type != 0x0101 or cookie != b"\x21\x12\xa4\x42" or data[8:20] != transaction_id:
        raise ValueError("STUN response header is invalid")
    position = 20
    limit = min(len(data), 20 + length)
    while position + 4 <= limit:
        attribute_type = int.from_bytes(data[position : position + 2], "big")
        attribute_length = int.from_bytes(data[position + 2 : position + 4], "big")
        value = data[position + 4 : position + 4 + attribute_length]
        if attribute_type == 0x0020 and len(value) >= 8 and value[1] == 0x01:
            decoded = bytes(a ^ b for a, b in zip(value[4:8], b"\x21\x12\xa4\x42"))
            return ipaddress.IPv4Address(decoded)
        if attribute_type == 0x0001 and len(value) >= 8 and value[1] == 0x01:
            return ipaddress.IPv4Address(value[4:8])
        position += 4 + ((attribute_length + 3) // 4) * 4
    raise ValueError("STUN response did not contain an IPv4 mapped address")


def probe_socks(args: argparse.Namespace) -> None:
    selected = select_proxy(load_yaml(args.source), args.proxy_name)
    endpoint = str(ipaddress.ip_address(args.server_ip))
    validate_probe_options(args)
    with socket.create_connection((endpoint, int(selected["port"])), timeout=args.timeout) as raw:
        raw.settimeout(args.timeout)
        authenticate_socks(raw, selected)
        target = args.target_host.encode("idna")
        if len(target) > 255:
            raise ValueError("probe target hostname is too long")
        raw.sendall(
            b"\x05\x01\x00\x03"
            + bytes([len(target)])
            + target
            + int(args.target_port).to_bytes(2, "big")
        )
        read_socks_reply(raw, "CONNECT")

        context = ssl.create_default_context()
        with context.wrap_socket(raw, server_hostname=args.target_host) as tls:
            request = (
                f"GET /cdn-cgi/trace HTTP/1.1\r\n"
                f"Host: {args.target_host}\r\n"
                "User-Agent: linux-clash-skill/1\r\n"
                "Connection: close\r\n\r\n"
            ).encode("ascii")
            tls.sendall(request)
            response = bytearray()
            while len(response) < 131072:
                chunk = tls.recv(16384)
                if not chunk:
                    break
                response.extend(chunk)

    text = response.decode("utf-8", errors="replace")
    if not re.search(r"^HTTP/1\.[01] 200\b", text):
        raise ValueError("probe target did not return HTTP 200")
    match = re.search(r"(?m)^ip=([^\r\n]+)", text)
    if not match:
        raise ValueError("probe response did not contain an exit IP")
    exit_ip = ipaddress.ip_address(match.group(1).strip())
    print(exit_ip)


def skip_udp_address(data: bytes, position: int) -> int:
    if position >= len(data):
        raise ValueError("SOCKS5 UDP reply is truncated")
    address_type = data[position]
    position += 1
    if address_type == 0x01:
        position += 4
    elif address_type == 0x03:
        if position >= len(data):
            raise ValueError("SOCKS5 UDP domain is truncated")
        position += 1 + data[position]
    elif address_type == 0x04:
        position += 16
    else:
        raise ValueError("SOCKS5 UDP reply has an unknown address type")
    if position + 2 > len(data):
        raise ValueError("SOCKS5 UDP reply port is truncated")
    return position + 2


def probe_socks_udp(args: argparse.Namespace) -> None:
    selected = select_proxy(load_yaml(args.source), args.proxy_name)
    endpoint = str(ipaddress.ip_address(args.server_ip))
    validate_probe_options(args)
    target = args.target_host.encode("idna")
    if len(target) > 255:
        raise ValueError("probe target hostname is too long")

    with socket.create_connection((endpoint, int(selected["port"])), timeout=args.timeout) as control:
        control.settimeout(args.timeout)
        authenticate_socks(control, selected)
        control.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
        relay_host, relay_port = read_socks_reply(control, "UDP ASSOCIATE")
        if relay_host in {"0.0.0.0", "::"}:
            relay_host = endpoint
        relay_ip = socket.gethostbyname(relay_host)
        stun_request, transaction_id = make_stun_request()
        packet = (
            b"\x00\x00\x00\x03"
            + bytes([len(target)])
            + target
            + int(args.target_port).to_bytes(2, "big")
            + stun_request
        )
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.settimeout(args.timeout)
            udp.sendto(packet, (relay_ip, relay_port))
            response, _ = udp.recvfrom(65535)
        if len(response) < 4 or response[:2] != b"\x00\x00" or response[2] != 0:
            raise ValueError("SOCKS5 UDP reply header is invalid")
        payload_position = skip_udp_address(response, 3)
        print(parse_stun_response(response[payload_position:], transaction_id))


def probe_stun(args: argparse.Namespace) -> None:
    validate_probe_options(args)
    request, transaction_id = make_stun_request()
    address = socket.getaddrinfo(
        args.target_host,
        args.target_port,
        socket.AF_INET,
        socket.SOCK_DGRAM,
    )[0][4]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.settimeout(args.timeout)
        udp.sendto(request, address)
        response, _ = udp.recvfrom(65535)
    print(parse_stun_response(response, transaction_id))


def render(args: argparse.Namespace) -> None:
    source = load_yaml(args.source)
    selected = select_proxy(source, args.proxy_name)
    selected["udp"] = True
    server_ip = str(ipaddress.ip_address(args.server_ip))
    if ":" in server_ip:
        raise ValueError("the first release supports IPv4 proxy endpoints only")

    mixed_port = int(source.get("mixed-port", 7890))
    if not 1 <= mixed_port <= 65535:
        raise ValueError("mixed-port is outside 1..65535")
    controller = str(source.get("external-controller", "127.0.0.1:9090"))
    if not controller.startswith("127.0.0.1:"):
        controller = "127.0.0.1:9090"

    route_exclusions = [
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        f"{server_ip}/32",
    ]
    for value in args.exclude_address:
        network = ipaddress.ip_network(value, strict=False)
        if network.version != 4:
            raise ValueError("the first release supports IPv4 route exclusions only")
        rendered_network = str(network)
        if rendered_network not in route_exclusions:
            route_exclusions.append(rendered_network)

    excluded_uids = [args.mihomo_uid]
    for value in args.exclude_uid:
        if value < 0:
            raise ValueError("excluded UIDs must be non-negative")
        if value not in excluded_uids:
            excluded_uids.append(value)

    config: dict[str, Any] = {
        "mixed-port": mixed_port,
        "allow-lan": False,
        "mode": "rule",
        "log-level": "info",
        "external-controller": controller,
        "ipv6": False,
        "tun": {
            "enable": True,
            "stack": "mixed",
            "device": "Mihomo",
            "auto-route": True,
            "auto-redirect": True,
            "auto-detect-interface": True,
            "strict-route": False,
            "dns-hijack": ["any:53", "tcp://any:53"],
            "route-exclude-address": route_exclusions,
            "exclude-uid": excluded_uids,
        },
        "dns": {
            "enable": True,
            "listen": "127.0.0.1:1053",
            "ipv6": False,
            "enhanced-mode": "fake-ip",
            "fake-ip-range": "198.18.0.1/16",
            # The Dashboard connector UID is intentionally excluded from the
            # TUN.  It must therefore receive a real address for its control
            # server instead of a fake-IP that only Mihomo can route.
            "fake-ip-filter": ["tunnel-api.chxyka.ccwu.cc"],
            "use-hosts": True,
            "use-system-hosts": True,
            "respect-rules": True,
            "default-nameserver": ["1.1.1.1", "8.8.8.8"],
            "proxy-server-nameserver": ["223.5.5.5", "119.29.29.29"],
            "nameserver": [
                "https://1.1.1.1/dns-query",
                "https://8.8.8.8/dns-query",
            ],
        },
        "profile": {"store-selected": True},
        "proxies": [selected],
        "proxy-groups": [
            {
                "name": "PROXY",
                "type": "select",
                "proxies": [selected["name"]],
            }
        ],
        "rules": [
            "IP-CIDR,169.254.169.254/32,DIRECT,no-resolve",
            "MATCH,PROXY",
        ],
    }

    output = Path(args.output)
    output.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False, default_flow_style=False),
        encoding="utf-8",
    )


def set_host(args: argparse.Namespace) -> None:
    ip = ipaddress.ip_address(args.ip)
    if ip.version != 4:
        raise ValueError("the first release supports IPv4 proxy endpoints only")
    if not HOSTNAME_RE.fullmatch(args.hostname):
        raise ValueError("invalid proxy hostname")

    path = Path(args.path)
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    pattern = re.compile(
        rf"\n?{re.escape(MANAGED_HOSTS_BEGIN)}.*?{re.escape(MANAGED_HOSTS_END)}\n?",
        re.DOTALL,
    )
    clean = pattern.sub("\n", text).rstrip()
    managed = f"{MANAGED_HOSTS_BEGIN}\n{ip}\t{args.hostname}\n{MANAGED_HOSTS_END}\n"
    path.write_text(f"{clean}\n\n{managed}" if clean else managed, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--source", type=Path, required=True)
    inspect_parser.add_argument("--proxy-name")
    inspect_parser.set_defaults(func=inspect_proxy)

    field_parser = subparsers.add_parser("field")
    field_parser.add_argument("--source", type=Path, required=True)
    field_parser.add_argument("--proxy-name")
    field_parser.add_argument("--field", required=True)
    field_parser.set_defaults(func=print_field)

    probe_parser = subparsers.add_parser("probe")
    probe_parser.add_argument("--source", type=Path, required=True)
    probe_parser.add_argument("--proxy-name")
    probe_parser.add_argument("--server-ip", required=True)
    probe_parser.add_argument("--target-host", default="www.cloudflare.com")
    probe_parser.add_argument("--target-port", type=int, default=443)
    probe_parser.add_argument("--timeout", type=float, default=12.0)
    probe_parser.set_defaults(func=probe_socks)

    udp_probe_parser = subparsers.add_parser("probe-udp")
    udp_probe_parser.add_argument("--source", type=Path, required=True)
    udp_probe_parser.add_argument("--proxy-name")
    udp_probe_parser.add_argument("--server-ip", required=True)
    udp_probe_parser.add_argument("--target-host", default="stun.cloudflare.com")
    udp_probe_parser.add_argument("--target-port", type=int, default=3478)
    udp_probe_parser.add_argument("--timeout", type=float, default=12.0)
    udp_probe_parser.set_defaults(func=probe_socks_udp)

    stun_parser = subparsers.add_parser("stun")
    stun_parser.add_argument("--target-host", default="stun.cloudflare.com")
    stun_parser.add_argument("--target-port", type=int, default=3478)
    stun_parser.add_argument("--timeout", type=float, default=12.0)
    stun_parser.set_defaults(func=probe_stun)

    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--source", type=Path, required=True)
    render_parser.add_argument("--output", required=True)
    render_parser.add_argument("--proxy-name")
    render_parser.add_argument("--server-ip", required=True)
    render_parser.add_argument("--mihomo-uid", type=int, required=True)
    render_parser.add_argument("--exclude-uid", action="append", type=int, default=[])
    render_parser.add_argument("--exclude-address", action="append", default=[])
    render_parser.set_defaults(func=render)

    hosts_parser = subparsers.add_parser("set-host")
    hosts_parser.add_argument("--path", default="/etc/hosts")
    hosts_parser.add_argument("--hostname", required=True)
    hosts_parser.add_argument("--ip", required=True)
    hosts_parser.set_defaults(func=set_host)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
