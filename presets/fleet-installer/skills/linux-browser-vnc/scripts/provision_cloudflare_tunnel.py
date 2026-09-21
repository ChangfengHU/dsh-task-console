#!/usr/bin/env python3
"""Provision the Cloudflare side of one desktop hostname.

This runs on the operator's machine, never on the fleet node. The node only ever
receives a connector token, so Cloudflare account credentials stay off the
machines entirely.

Three objects are created per machine:

1. a named tunnel with remotely managed ingress pointing at the loopback noVNC
   bridge;
2. a proxied CNAME `vnc-<ip>.<zone>` to `<tunnel-id>.cfargotunnel.com`;
3. a Worker route for that exact hostname bound to **no** script, so the zone's
   `*.<zone>` auto-domain Worker stops intercepting it.

Step 3 is required. Without it the wildcard Worker answers first and the
WebSocket upgrade that noVNC needs never reaches the tunnel.

Credentials come from the environment only:

    CLOUDFLARE_EMAIL, CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from typing import Any

API = "https://api.cloudflare.com/client/v4"
HOSTNAME_RE = re.compile(r"^vnc-[a-z0-9-]{1,48}$")


class CloudflareError(RuntimeError):
    pass


class Cloudflare:
    def __init__(self, email: str, api_key: str, account_id: str) -> None:
        if not (email and api_key and account_id):
            raise CloudflareError(
                "set CLOUDFLARE_EMAIL, CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID"
            )
        self.headers = {
            "X-Auth-Email": email,
            "X-Auth-Key": api_key,
            "Content-Type": "application/json",
        }
        self.account_id = account_id

    def call(self, method: str, path: str, payload: Any = None) -> Any:
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{API}{path}", data=data, method=method, headers=self.headers
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read().decode())
            except Exception:
                raise CloudflareError(f"{method} {path} failed with HTTP {error.code}") from error
        if not body.get("success"):
            raise CloudflareError(f"{method} {path} failed: {body.get('errors')}")
        return body.get("result")

    # -- zone ---------------------------------------------------------------

    def zone_id(self, zone_name: str) -> str:
        result = self.call("GET", f"/zones?name={zone_name}")
        if not result:
            raise CloudflareError(f"zone {zone_name} is not in this account")
        return str(result[0]["id"])

    # -- tunnel -------------------------------------------------------------

    def find_tunnel(self, name: str) -> dict[str, Any] | None:
        result = self.call("GET", f"/accounts/{self.account_id}/cfd_tunnel?name={name}&is_deleted=false")
        return result[0] if result else None

    def create_tunnel(self, name: str) -> dict[str, Any]:
        secret = base64.b64encode(secrets.token_bytes(32)).decode()
        return self.call(
            "POST",
            f"/accounts/{self.account_id}/cfd_tunnel",
            {"name": name, "tunnel_secret": secret, "config_src": "cloudflare"},
        )

    def tunnel_token(self, tunnel_id: str) -> str:
        return str(self.call("GET", f"/accounts/{self.account_id}/cfd_tunnel/{tunnel_id}/token"))

    def get_ingress(self, tunnel_id: str) -> list[dict[str, Any]]:
        result = self.call(
            "GET", f"/accounts/{self.account_id}/cfd_tunnel/{tunnel_id}/configurations"
        )
        config = (result or {}).get("config") or {}
        rules = config.get("ingress")
        return rules if isinstance(rules, list) else []

    def _rule(self, hostname: str, service: str) -> dict[str, Any]:
        return {
            "hostname": hostname,
            "service": service,
            # noVNC needs a long-lived upgraded connection.
            "originRequest": {"noTLSVerify": False, "connectTimeout": 30},
        }

    def set_ingress(self, tunnel_id: str, hostname: str, service: str) -> None:
        self.call(
            "PUT",
            f"/accounts/{self.account_id}/cfd_tunnel/{tunnel_id}/configurations",
            {"config": {"ingress": [self._rule(hostname, service), {"service": "http_status:404"}]}},
        )

    def add_ingress_hostname(self, tunnel_id: str, hostname: str, service: str) -> bool:
        """Add one hostname to the tunnel's ingress without dropping the others."""
        rules = self.get_ingress(tunnel_id)
        matched = [r for r in rules if r.get("hostname")]
        if any(r.get("hostname") == hostname for r in matched):
            return False
        catch_all = [r for r in rules if not r.get("hostname")] or [{"service": "http_status:404"}]
        new_rules = matched + [self._rule(hostname, service)] + catch_all
        self.call(
            "PUT",
            f"/accounts/{self.account_id}/cfd_tunnel/{tunnel_id}/configurations",
            {"config": {"ingress": new_rules}},
        )
        return True

    # -- dns ----------------------------------------------------------------

    def upsert_cname(self, zone: str, hostname: str, target: str) -> str:
        existing = self.call("GET", f"/zones/{zone}/dns_records?name={hostname}")
        record = {"type": "CNAME", "name": hostname, "content": target, "proxied": True}
        if existing:
            return str(self.call("PUT", f"/zones/{zone}/dns_records/{existing[0]['id']}", record)["id"])
        return str(self.call("POST", f"/zones/{zone}/dns_records", record)["id"])

    # -- worker route -------------------------------------------------------

    def ensure_bypass_route(self, zone: str, hostname: str) -> str:
        """Bind this hostname to no Worker so the wildcard route stops winning."""
        pattern = f"{hostname}/*"
        for route in self.call("GET", f"/zones/{zone}/workers/routes") or []:
            if route.get("pattern") == pattern:
                if route.get("script"):
                    self.call(
                        "PUT",
                        f"/zones/{zone}/workers/routes/{route['id']}",
                        {"pattern": pattern, "script": None},
                    )
                return str(route["id"])
        return str(self.call("POST", f"/zones/{zone}/workers/routes", {"pattern": pattern, "script": None})["id"])

    # -- access -------------------------------------------------------------

    def find_access_app(self, domain: str) -> dict[str, Any] | None:
        for app in self.call("GET", f"/accounts/{self.account_id}/access/apps") or []:
            if app.get("domain") == domain:
                return app
        return None

    def ensure_access_app(self, hostname: str, emails: list[str], session: str) -> dict[str, Any]:
        existing = self.find_access_app(hostname)
        payload = {
            "name": f"Remote browser {hostname}",
            "domain": hostname,
            "type": "self_hosted",
            "session_duration": session,
            "app_launcher_visible": True,
            # WebSocket upgrades carry the CF_Authorization cookie, so noVNC keeps
            # working once the browser has completed the Access login.
            "allowed_idps": [],
            "auto_redirect_to_identity": False,
        }
        if existing:
            app = self.call(
                "PUT", f"/accounts/{self.account_id}/access/apps/{existing['id']}", payload
            )
        else:
            app = self.call("POST", f"/accounts/{self.account_id}/access/apps", payload)
        self.call(
            "POST",
            f"/accounts/{self.account_id}/access/apps/{app['id']}/policies",
            {
                "name": "Allow the fleet owner",
                "decision": "allow",
                "precedence": 1,
                "include": [{"email": {"email": address}} for address in emails],
            },
        )
        return app


def provision(client: Cloudflare, args: argparse.Namespace) -> dict[str, Any]:
    hostname_label = args.name
    if not HOSTNAME_RE.fullmatch(hostname_label):
        raise CloudflareError("the desktop label must look like vnc-161-35-60-232")
    hostname = f"{hostname_label}.{args.zone}"
    zone = client.zone_id(args.zone)

    tunnel = client.find_tunnel(hostname_label) or client.create_tunnel(hostname_label)
    tunnel_id = str(tunnel["id"])
    client.set_ingress(tunnel_id, hostname, f"http://127.0.0.1:{args.novnc_port}")
    client.upsert_cname(zone, hostname, f"{tunnel_id}.cfargotunnel.com")
    # Only the chxyka zone carries the auto-domain wildcard Worker that must be
    # bypassed. Other zones (e.g. vyibc.com) have no such route.
    bypassed = args.zone == "chxyka.ccwu.cc"
    if bypassed:
        client.ensure_bypass_route(zone, hostname)
    token = client.tunnel_token(tunnel_id)

    if args.token_file:
        path = args.token_file
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(token + "\n")

    return {
        "hostname": hostname,
        "url": f"https://{hostname}",
        "tunnel_id": tunnel_id,
        "tunnel_name": hostname_label,
        "token_written_to": args.token_file or "",
        "wildcard_worker_bypassed": bypassed,
    }


def check_account(client: Cloudflare, args: argparse.Namespace) -> dict[str, Any]:
    """Read-only proof that one credential set owns both required scopes."""
    zone = client.zone_id(args.zone)
    tunnel = client.find_tunnel(args.name) if args.name else None
    return {
        "zone": args.zone,
        "zone_id": zone,
        "zone_owned": True,
        "tunnel_name": args.name or "",
        "tunnel_exists": bool(tunnel),
        "tunnel_id": str(tunnel.get("id", "")) if tunnel else "",
    }


HOST_ANY_RE = re.compile(r"^[a-z0-9-]{1,63}$")


def check_conflict(client: "Cloudflare", zone: str, host: str, target: str) -> str:
    """Return the existing content if `host` already points somewhere else."""
    for record in client.call("GET", f"/zones/{zone}/dns_records?name={host}") or []:
        if record.get("content") != target:
            return str(record.get("content"))
    return ""


def rename(client: "Cloudflare", args: argparse.Namespace) -> dict[str, Any]:
    """Change a desktop's subdomain within one account, refusing a name clash.

    This is the flexible relabel the owner asked for: the only guard is that the
    new hostname must not already resolve to something else. Same account, so no
    cross-account tunnel routing is involved.
    """
    new_label = args.new_name
    if not HOSTNAME_RE.fullmatch(new_label):
        raise CloudflareError("the new label must look like vnc-152-32-214-95")
    tunnel = client.find_tunnel(args.name)
    if not tunnel:
        raise CloudflareError(f"no tunnel named {args.name}")
    tunnel_id = str(tunnel["id"])
    zone = client.zone_id(args.zone)
    new_host = f"{new_label}.{args.zone}"
    target = f"{tunnel_id}.cfargotunnel.com"

    conflict = check_conflict(client, zone, new_host, target)
    if conflict and not args.force:
        raise CloudflareError(
            f"{new_host} already points to {conflict}; choose another name or pass --force"
        )

    client.set_ingress(tunnel_id, new_host, f"http://127.0.0.1:{args.novnc_port}")
    client.upsert_cname(zone, new_host, target)
    removed_old = ""
    if args.old_name and args.old_name != new_label:
        old_host = f"{args.old_name}.{args.zone}"
        for record in client.call("GET", f"/zones/{zone}/dns_records?name={old_host}") or []:
            if record.get("content") == target:
                client.call("DELETE", f"/zones/{zone}/dns_records/{record['id']}")
                removed_old = old_host
    return {
        "hostname": new_host,
        "url": f"https://{new_host}",
        "tunnel_id": tunnel_id,
        "removed_old_record": removed_old,
        "repointed_from": conflict,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="create tunnel, DNS and route bypass")
    create.add_argument("--name", required=True, help="label such as vnc-161-35-60-232")
    create.add_argument("--zone", default="chxyka.ccwu.cc")
    create.add_argument("--novnc-port", type=int, default=6080)
    create.add_argument("--token-file", help="write the connector token here with mode 0600")

    check = subparsers.add_parser("check", help="read-only account, zone and tunnel preflight")
    check.add_argument("--zone", required=True)
    check.add_argument("--name", default="", help="optional tunnel label to look up")

    ren = subparsers.add_parser("rename", help="change a desktop subdomain (conflict-checked)")
    ren.add_argument("--name", required=True, help="existing tunnel label")
    ren.add_argument("--new-name", required=True, help="new label, e.g. vnc-my-worker")
    ren.add_argument("--old-name", default="", help="previous label whose DNS record to remove")
    ren.add_argument("--zone", default="vyibc.com")
    ren.add_argument("--novnc-port", type=int, default=6080)
    ren.add_argument("--force", action="store_true", help="repoint an existing conflicting record")

    protect = subparsers.add_parser("protect", help="put Cloudflare Access in front")
    protect.add_argument("--name", required=True)
    protect.add_argument("--zone", default="chxyka.ccwu.cc")
    protect.add_argument("--email", action="append", required=True, help="allowed identity")
    protect.add_argument("--session-duration", default="24h")

    show = subparsers.add_parser("show", help="report the current state of a hostname")
    show.add_argument("--name", required=True)
    show.add_argument("--zone", default="chxyka.ccwu.cc")

    args = parser.parse_args()
    try:
        client = Cloudflare(
            os.environ.get("CLOUDFLARE_EMAIL", ""),
            os.environ.get("CLOUDFLARE_API_KEY", ""),
            os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
        )
        if args.command == "create":
            result = provision(client, args)
        elif args.command == "check":
            result = check_account(client, args)
        elif args.command == "rename":
            result = rename(client, args)
        elif args.command == "protect":
            hostname = f"{args.name}.{args.zone}"
            app = client.ensure_access_app(hostname, args.email, args.session_duration)
            result = {
                "hostname": hostname,
                "access_app_id": app.get("id"),
                "session_duration": app.get("session_duration"),
                "allowed_identities": len(args.email),
            }
        else:
            hostname = f"{args.name}.{args.zone}"
            tunnel = client.find_tunnel(args.name)
            app = client.find_access_app(hostname)
            result = {
                "hostname": hostname,
                "tunnel_id": tunnel.get("id") if tunnel else "",
                "tunnel_connections": len(tunnel.get("connections") or []) if tunnel else 0,
                "access_protected": bool(app),
            }
    except CloudflareError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
