#!/usr/bin/env python3
"""Generate stable, non-secret identifiers for one-machine Dashboard installs."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import socket
from pathlib import Path


LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MACHINE_ID_RE = re.compile(r"^[0-9a-fA-F]{16,128}$")
PUBLIC_NAME_MAX = 48


def slugify(value: str, fallback: str = "linux") -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or fallback


def read_machine_id(path: Path) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if not MACHINE_ID_RE.fullmatch(value):
        raise ValueError(f"invalid machine ID in {path}")
    return value.lower()


def public_name_from_ipv4(value: str) -> str:
    address = ipaddress.ip_address(value.strip())
    if address.version != 4:
        raise ValueError("public name requires an IPv4 address")
    public_name = f"clash-{str(address).replace('.', '-')}"
    if len(public_name) > PUBLIC_NAME_MAX or not LABEL_RE.fullmatch(public_name):
        raise ValueError("generated public name is not a valid DNS label")
    return public_name


def build_identity(
    hostname: str, machine_id: str, public_ip: str | None = None
) -> dict[str, str]:
    host_slug = slugify(hostname)
    short_id = machine_id[:8].lower()
    suffix = f"-{short_id}"
    public_prefix = "clash-"
    host_limit = PUBLIC_NAME_MAX - len(public_prefix) - len(suffix)
    short_host = host_slug[:host_limit].rstrip("-") or "linux"
    public_name = (
        public_name_from_ipv4(public_ip)
        if public_ip is not None
        else f"{public_prefix}{short_host}{suffix}"
    )
    node_limit = 63 - len(suffix)
    node_id = f"{host_slug[:node_limit].rstrip('-') or 'linux'}{suffix}"
    if not LABEL_RE.fullmatch(public_name) or not LABEL_RE.fullmatch(node_id):
        raise ValueError("generated machine identity is not a valid DNS label")
    return {
        "hostname": hostname,
        "machine_id_short": short_id,
        "node_id": node_id,
        "public_name": public_name,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hostname", default=socket.gethostname().split(".", 1)[0])
    parser.add_argument("--machine-id-file", type=Path, default=Path("/etc/machine-id"))
    parser.add_argument(
        "--public-ip",
        help="use clash-A-B-C-D as the requested public name",
    )
    parser.add_argument(
        "--format",
        choices=("json", "node-id", "public-name"),
        default="json",
    )
    args = parser.parse_args()
    identity = build_identity(
        args.hostname,
        read_machine_id(args.machine_id_file),
        public_ip=args.public_ip,
    )
    if args.format == "json":
        print(json.dumps(identity, ensure_ascii=False, sort_keys=True))
    else:
        print(identity[args.format.replace("-", "_")])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
