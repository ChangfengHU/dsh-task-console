#!/usr/bin/env python3
"""Resolve a Fleet SSH credential without putting secrets in argv/stdout.

This host-only helper is intentionally narrower than ``vault.sh``. It accepts
only one fixed operation plus a canonical public IPv4 over stdin. The server,
not this caller, derives every Vault key. Resolve/bootstrap material is written
to a 0600 host-owned file and stdout is metadata only; commit writes one fixed
full-IP claude record and verifies its readback server-side. curl receives its
Authorization header through an owner-only config file and its body through
``@file``.
"""

from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


MAX_BYTES = 1024 * 1024
DEFAULT_URL = "https://fleet.vyibc.com/mcp/fleet-onboard-vault"


class ProviderError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_request():
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ProviderError("request-too-large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ProviderError("request-invalid") from exc
    if not isinstance(value, dict) or set(value) != {"schema", "operation", "ip"}:
        raise ProviderError("request-shape-invalid")
    operation = value.get("operation")
    if value.get("schema") != 1 or operation not in {"resolve", "bootstrap", "commit"}:
        raise ProviderError("request-operation-invalid")
    try:
        ip = ipaddress.IPv4Address(value.get("ip"))
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ProviderError("ip-invalid") from exc
    if not ip.is_global:
        raise ProviderError("ip-must-be-public")
    return operation, str(ip)


def curl_path() -> str:
    for candidate in ("/usr/bin/curl", "/bin/curl"):
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise ProviderError("curl-unavailable")


def vault_url() -> str:
    value = os.environ.get("FLEET_ONBOARD_VAULT_RESOLVE_URL", DEFAULT_URL)
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        raise ProviderError("vault-url-unsafe")
    return value


def extract_credential(payload, ip: str):
    if not isinstance(payload, dict) or "error" in payload:
        raise ProviderError("managed-credential-missing")
    try:
        text = payload["result"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ProviderError("managed-credential-missing") from exc
    if not isinstance(text, str):
        raise ProviderError("managed-credential-missing")
    try:
        resolved = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProviderError("managed-credential-missing") from exc
    allowed = {"ok", "ip", "username", "source", "private_key", "password"}
    if not isinstance(resolved, dict) or set(resolved) - allowed or resolved.get("ok") is not True:
        raise ProviderError("managed-credential-missing")
    if resolved.get("ip") != ip or resolved.get("source") != "vault":
        raise ProviderError("managed-credential-missing")
    username = resolved.get("username")
    if username != "claude":
        raise ProviderError("managed-credential-missing")
    credential = {"schema": 1, "ip": ip, "username": username, "source": "vault"}
    private_key = resolved.get("private_key")
    password = resolved.get("password")
    if private_key is not None:
        if not isinstance(private_key, str) or "PRIVATE KEY-----" not in private_key:
            raise ProviderError("managed-credential-missing")
        credential["private_key"] = private_key
    if password is not None:
        if not isinstance(password, str) or not password:
            raise ProviderError("managed-credential-missing")
        credential["password"] = password
    if "private_key" not in credential and "password" not in credential:
        raise ProviderError("managed-credential-missing")
    return credential


def extract_bootstrap(payload, ip: str):
    resolved = extract_result(payload, "bootstrap-material-missing")
    allowed = {"ok", "ip", "username", "source", "public_key", "private_key"}
    if not isinstance(resolved, dict) or set(resolved) - allowed or resolved.get("ok") is not True:
        raise ProviderError("bootstrap-material-missing")
    if resolved.get("ip") != ip or resolved.get("username") != "claude" or resolved.get("source") != "vault":
        raise ProviderError("bootstrap-material-missing")
    public_key = resolved.get("public_key")
    private_key = resolved.get("private_key")
    if not isinstance(public_key, str) or not re.fullmatch(
        r"(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,200})?",
        public_key,
    ):
        raise ProviderError("bootstrap-material-missing")
    if not isinstance(private_key, str) or len(private_key) > 128 * 1024 or "PRIVATE KEY-----" not in private_key:
        raise ProviderError("bootstrap-material-missing")
    return {
        "schema": 1, "ip": ip, "username": "claude", "source": "vault",
        "public_key": public_key, "private_key": private_key,
    }


def extract_commit(payload, ip: str):
    resolved = extract_result(payload, "managed-login-commit-failed")
    allowed = {"ok", "ip", "username", "source", "committed", "readback", "changed"}
    if not isinstance(resolved, dict) or set(resolved) - allowed or resolved.get("ok") is not True:
        raise ProviderError("managed-login-commit-failed")
    if (resolved.get("ip") != ip or resolved.get("username") != "claude" or
            resolved.get("source") != "vault" or resolved.get("committed") is not True or
            resolved.get("readback") is not True or not isinstance(resolved.get("changed"), bool)):
        raise ProviderError("managed-login-commit-failed")
    return {"schema": 1, "committed": True, "readback": True, "changed": resolved["changed"]}


def extract_result(payload, error: str):
    if not isinstance(payload, dict) or "error" in payload:
        raise ProviderError(error)
    try:
        text = payload["result"]["content"][0]["text"]
        resolved = json.loads(text)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ProviderError(error) from exc
    if not isinstance(resolved, dict):
        raise ProviderError(error)
    return resolved


def vault_rpc(ip: str, root: Path, tool: str):
    token = os.environ.get("FLEET_ONBOARD_VAULT_RESOLVE_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{16,512}", token):
        raise ProviderError("onboard-vault-token-unavailable")
    request_path = root / "request.json"
    response_path = root / "response.json"
    config_path = root / "curl.conf"
    request = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {
            "name": "vyibc-fleet-onboard-vault_" + tool,
            "arguments": {"ip": ip},
        },
    }
    request_path.write_text(canonical(request), encoding="utf-8")
    config_path.write_text(
        'header = "content-type: application/json"\n'
        + 'header = "authorization: Bearer ' + token.replace("\\", "\\\\").replace('"', '\\"') + '"\n',
        encoding="utf-8",
    )
    os.chmod(request_path, 0o600)
    os.chmod(config_path, 0o600)
    try:
        try:
            result = subprocess.run(
                [curl_path(), "--silent", "--show-error", "--fail", "--max-time", "60",
                 "--request", "POST", "--config", str(config_path),
                 "--data-binary", "@" + str(request_path), "--output", str(response_path), vault_url()],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env={name: os.environ[name] for name in ("HOME", "LANG", "LC_ALL", "PATH", "TZ") if name in os.environ},
                timeout=65,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProviderError("vault-transport-failed") from exc
    finally:
        config_path.unlink(missing_ok=True)
        request_path.unlink(missing_ok=True)
    if result.returncode != 0:
        response_path.unlink(missing_ok=True)
        raise ProviderError("vault-transport-failed")
    try:
        if response_path.stat().st_size > MAX_BYTES:
            raise ProviderError("vault-response-too-large")
        payload = json.loads(response_path.read_text(encoding="utf-8"))
        return payload
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProviderError("vault-response-invalid") from exc
    finally:
        response_path.unlink(missing_ok=True)


def vault_resolve(ip: str, root: Path):
    return extract_credential(vault_rpc(ip, root, "resolve_ssh"), ip)


def vault_bootstrap(ip: str, root: Path):
    return extract_bootstrap(vault_rpc(ip, root, "resolve_bootstrap"), ip)


def vault_commit(ip: str, root: Path):
    return extract_commit(vault_rpc(ip, root, "commit_managed_ssh"), ip)


def output_path(environment_name: str) -> Path:
    value = os.environ.get(environment_name, "")
    path = Path(value)
    if not value or not path.is_absolute() or path.exists() or path.parent.is_symlink():
        raise ProviderError("credential-output-unsafe")
    parent = path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in {0, os.geteuid()} or parent.st_mode & 0o077:
        raise ProviderError("credential-output-unsafe")
    return path


def main() -> int:
    try:
        operation, ip = read_request()
        target = output_path(
            "FLEET_ONBOARD_CREDENTIAL_FILE" if operation == "resolve" else "FLEET_ONBOARD_BOOTSTRAP_FILE",
        ) if operation != "commit" else None
        with tempfile.TemporaryDirectory(
            prefix=".vault-" + operation + "-", dir=str(target.parent) if target else None,
        ) as name:
            root = Path(name)
            root.chmod(0o700)
            if operation == "commit":
                result = vault_commit(ip, root)
            else:
                result = vault_resolve(ip, root) if operation == "resolve" else vault_bootstrap(ip, root)
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    handle.write(canonical(result) + "\n")
        metadata = {"schema": 1, "available": True, "source": "vault"}
        if operation != "resolve":
            metadata["operation"] = operation
        if operation == "commit":
            metadata.update({"committed": True, "readback": True, "changed": result["changed"]})
        print(canonical(metadata))
        return 0
    except ProviderError as exc:
        print(canonical({"schema": 1, "available": False, "reason_code": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
