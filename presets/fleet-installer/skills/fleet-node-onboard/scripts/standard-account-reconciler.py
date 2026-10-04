#!/usr/bin/env python3
"""Fixed Stage 2 worker: bootstrap and attest the managed ``claude`` login.

The host adapter supplies one exact stage request plus the first-login
credential descriptor. This worker obtains the fixed Fleet operator keypair
from the scoped onboarding Vault provider, converges only the ``claude``
account, validates sudoers before installation, proves a new external key
login, and only then asks Vault to commit/read back the full-IP login record.

No command, path, account name, Vault key, token or credential is accepted in
the request. Secrets are carried by inherited descriptors or 0600 temporary
files and never appear in argv, stdout, receipts or diagnostics.
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
from typing import Any, Dict, Iterable, Optional, Tuple


HERE = Path(__file__).resolve().parent
CONTRACT_PATH = HERE.parent / "component-contract.json"
PROVIDER_PATH = HERE / "vault-credential-provider.py"
MAX_BYTES = 1024 * 1024
MAX_CREDENTIAL_BYTES = 128 * 1024
SAFE_OPERATION_ID = re.compile(r"^onboard-[0-9a-f]{32}$")
SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
PUBLIC_KEY = re.compile(
    r"(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) "
    r"[A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,200})?"
)


class ReconcilerError(ValueError):
    """Stable secret-free local failure."""


class ReconcilerBlocked(ReconcilerError):
    """A bounded condition that must not be reported as successful mutation."""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def exact_keys(value: Dict[str, Any], allowed: Iterable[str], label: str) -> None:
    extra = set(value) - set(allowed)
    if extra:
        raise ReconcilerError(f"unknown-field:{label}.{sorted(extra)[0]}")


def safe_regular_file(path_text: str, label: str, max_bytes: int, *, owner_only: bool = True) -> Path:
    path = Path(path_text)
    if not path_text or not path.is_absolute() or path.is_symlink():
        raise ReconcilerError(f"{label}-unsafe")
    try:
        metadata = path.stat()
    except OSError as exc:
        raise ReconcilerError(f"{label}-unavailable") from exc
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()}
            or metadata.st_mode & (0o077 if owner_only else 0o022) or metadata.st_size > max_bytes):
        raise ReconcilerError(f"{label}-unsafe")
    return path.resolve()


def safe_executable(path: Path, label: str) -> Path:
    resolved = safe_regular_file(str(path), label, MAX_BYTES, owner_only=False)
    if not resolved.stat().st_mode & stat.S_IXUSR or not os.access(resolved, os.X_OK):
        raise ReconcilerError(f"{label}-not-executable")
    return resolved


def load_json(path: Path, label: str) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReconcilerError(f"{label}-invalid") from exc
    if not isinstance(value, dict):
        raise ReconcilerError(f"{label}-must-be-object")
    return value


def contract_digest(contract: Dict[str, Any]) -> str:
    return hashlib.sha256(canonical(contract).encode("utf-8")).hexdigest()


def load_request() -> Tuple[Path, Path, Dict[str, Any]]:
    request_path = safe_regular_file(
        os.environ.get("FLEET_ONBOARD_JOB_REQUEST_FILE", ""), "job-request-file", MAX_BYTES,
    )
    result_text = os.environ.get("FLEET_ONBOARD_JOB_RESULT_FILE", "")
    result_path = Path(result_text)
    if (not result_text or not result_path.is_absolute() or result_path.is_symlink()
            or result_path.parent.resolve() != request_path.parent.resolve()):
        raise ReconcilerError("job-result-file-unsafe")
    parent = result_path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in {0, os.geteuid()} or parent.st_mode & 0o077:
        raise ReconcilerError("job-result-directory-unsafe")
    if result_path.exists():
        safe_regular_file(str(result_path), "job-result-file", MAX_BYTES)

    contract = load_json(
        safe_regular_file(str(CONTRACT_PATH), "component-contract", MAX_BYTES, owner_only=False),
        "component-contract",
    )
    request = load_json(request_path, "job-request")
    exact_keys(request, {"schema", "ip", "contract_sha256", "action"}, "request")
    if request.get("schema") != 1 or request.get("contract_sha256") != contract_digest(contract):
        raise ReconcilerError("request-contract-invalid")
    try:
        ip = ipaddress.IPv4Address(request.get("ip"))
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ReconcilerError("request-ip-invalid") from exc
    if not ip.is_global:
        raise ReconcilerError("request-ip-must-be-public")
    action = request.get("action")
    if not isinstance(action, dict):
        raise ReconcilerError("request-action-required")
    exact_keys(action, {"stage", "component", "executor_id", "operation_id", "reason"}, "action")
    expected = next((row for row in contract.get("stages", []) if row.get("stage") == 2), None)
    if (not expected or action.get("stage") != 2 or action.get("component") != "standard-account"
            or action.get("executor_id") != "fleet.standard-account.v1"
            or expected.get("id") != action.get("component")
            or expected.get("executor_id") != action.get("executor_id")):
        raise ReconcilerError("action-not-standard-account")
    if not isinstance(action.get("operation_id"), str) or not SAFE_OPERATION_ID.fullmatch(action["operation_id"]):
        raise ReconcilerError("action-operation-id-invalid")
    if not isinstance(action.get("reason"), str) or not SAFE_CODE.fullmatch(action["reason"]):
        raise ReconcilerError("action-reason-invalid")
    request["ip"] = str(ip)
    return request_path, result_path, request


def read_first_login(ip: str) -> Dict[str, Any]:
    descriptor: Optional[int] = None
    try:
        descriptor = int(os.environ["FLEET_ONBOARD_CREDENTIAL_FD"])
        if descriptor < 3:
            raise ReconcilerBlocked("credential-rejected")
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0
                or metadata.st_size > MAX_CREDENTIAL_BYTES):
            raise ReconcilerBlocked("credential-rejected")
        os.lseek(descriptor, 0, os.SEEK_SET)
        raw = os.read(descriptor, MAX_CREDENTIAL_BYTES + 1)
        value = json.loads(raw.decode("utf-8"))
    except (KeyError, ValueError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReconcilerBlocked("credential-rejected") from exc
    finally:
        if "raw" in locals():
            wiped = bytearray(raw)
            wiped[:] = b"\0" * len(wiped)
        # This is the worker's inherited copy. It is needed only for intake;
        # close it before any target mutation or Vault round-trip so a detached
        # Stage 2 process cannot retain the bootstrap credential.
        if descriptor is not None and descriptor >= 3:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if not isinstance(value, dict):
        raise ReconcilerBlocked("credential-rejected")
    exact_keys(value, {"schema", "ip", "username", "source", "password", "private_key"}, "credential")
    if value.get("schema") != 1 or value.get("ip") != ip:
        raise ReconcilerBlocked("credential-rejected")
    username = value.get("username")
    if not isinstance(username, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", username):
        raise ReconcilerBlocked("credential-rejected")
    if bool(value.get("password")) == bool(value.get("private_key")):
        raise ReconcilerBlocked("credential-rejected")
    if value.get("password") is not None and (not isinstance(value["password"], str) or not value["password"]):
        raise ReconcilerBlocked("credential-rejected")
    if value.get("private_key") is not None and (not isinstance(value["private_key"], str)
            or len(value["private_key"]) > MAX_CREDENTIAL_BYTES or "PRIVATE KEY-----" not in value["private_key"]):
        raise ReconcilerBlocked("credential-rejected")
    return value


def forget_credential(value: Dict[str, Any]) -> None:
    """Drop all live references held by this worker as soon as a phase ends."""
    for name in ("password", "private_key"):
        if name in value:
            value[name] = None
    value.clear()


def safe_child_environment(extra: Optional[Dict[str, str]] = None, *, vault: bool = False) -> Dict[str, str]:
    names = ["HOME", "LANG", "LC_ALL", "PATH", "TZ"]
    if vault:
        names.extend(["FLEET_ONBOARD_VAULT_RESOLVE_TOKEN", "FLEET_ONBOARD_VAULT_RESOLVE_URL"])
    result = {name: os.environ[name] for name in names if name in os.environ}
    if extra:
        result.update(extra)
    return result


def parse_metadata(stdout: str, operation: str) -> Dict[str, Any]:
    lines = [line for line in stdout.splitlines() if line.strip()]
    if len(lines) != 1 or len(lines[0].encode("utf-8")) > 4096:
        raise ReconcilerBlocked("dependency-unavailable")
    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise ReconcilerBlocked("dependency-unavailable") from exc
    allowed = {"schema", "available", "source", "operation", "committed", "readback", "changed"}
    if not isinstance(value, dict) or set(value) - allowed or value.get("schema") != 1:
        raise ReconcilerBlocked("dependency-unavailable")
    if value.get("available") is not True or value.get("source") != "vault" or value.get("operation") != operation:
        raise ReconcilerBlocked("dependency-unavailable")
    return value


def provider_call(operation: str, ip: str, work: Path) -> Dict[str, Any]:
    if operation not in {"bootstrap", "commit"}:
        raise ReconcilerError("provider-operation-invalid")
    provider = safe_executable(PROVIDER_PATH, "vault-provider")
    with tempfile.TemporaryDirectory(prefix=".stage2-vault-", dir=str(work)) as name:
        root = Path(name)
        root.chmod(0o700)
        material_path = root / "bootstrap.json"
        extra = {"FLEET_ONBOARD_BOOTSTRAP_FILE": str(material_path)} if operation == "bootstrap" else {}
        try:
            completed = subprocess.run(
                [provider], input=canonical({"schema": 1, "operation": operation, "ip": ip}) + "\n",
                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=75,
                env=safe_child_environment(extra, vault=True), check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ReconcilerBlocked("dependency-unavailable") from exc
        if completed.returncode != 0:
            raise ReconcilerBlocked("dependency-unavailable")
        metadata = parse_metadata(completed.stdout, operation)
        if operation == "commit":
            if (metadata.get("committed") is not True or metadata.get("readback") is not True
                    or not isinstance(metadata.get("changed"), bool)):
                raise ReconcilerBlocked("dependency-unavailable")
            return metadata
        material_file = safe_regular_file(str(material_path), "bootstrap-material", MAX_CREDENTIAL_BYTES)
        material = load_json(material_file, "bootstrap-material")
        material_path.unlink()
        exact_keys(material, {"schema", "ip", "username", "source", "public_key", "private_key"}, "bootstrap")
        if (material.get("schema") != 1 or material.get("ip") != ip or material.get("username") != "claude"
                or material.get("source") != "vault" or not isinstance(material.get("public_key"), str)
                or not PUBLIC_KEY.fullmatch(material["public_key"]) or not isinstance(material.get("private_key"), str)
                or len(material["private_key"]) > MAX_CREDENTIAL_BYTES
                or "PRIVATE KEY-----" not in material["private_key"]):
            raise ReconcilerBlocked("dependency-unavailable")
        return material


REMOTE_RECONCILE_TEMPLATE = r'''
import json, os, pathlib, pwd, stat, subprocess, tempfile

PUBLIC_KEY = __FLEET_OPERATOR_PUBLIC_KEY__
ACCOUNT = "claude"
HOME = pathlib.Path("/home/claude")
SUDOERS = pathlib.Path("/etc/sudoers.d/90-claude")

def emit(ok, reason, changed=None):
    print(json.dumps({"schema":1,"ok":ok,"reason_code":reason,"changed":changed or []}, separators=(",",":")))

def stop(reason):
    emit(False, reason)
    raise SystemExit(20)

if os.geteuid() != 0:
    stop("admin-required")
if "\n" in PUBLIC_KEY or "\r" in PUBLIC_KEY or not PUBLIC_KEY.startswith(("ssh-", "ecdsa-", "sk-ssh-")):
    stop("operator-key-invalid")

changed = []
try:
    account = pwd.getpwnam(ACCOUNT)
except KeyError:
    useradd = next((path for path in ("/usr/sbin/useradd", "/sbin/useradd") if pathlib.Path(path).is_file()), None)
    if not useradd or subprocess.run([useradd, "--create-home", "--home-dir", str(HOME), "--shell", "/bin/bash", ACCOUNT],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL).returncode != 0:
        stop("account-create-failed")
    changed.append("account-created")
    account = pwd.getpwnam(ACCOUNT)

if (account.pw_name != ACCOUNT or account.pw_uid == 0 or account.pw_dir != str(HOME)
        or account.pw_shell not in {"/bin/bash", "/usr/bin/bash"}):
    stop("target-policy-conflict")

if HOME.is_symlink():
    stop("target-policy-conflict")
if HOME.exists():
    home_metadata = HOME.stat()
    if not stat.S_ISDIR(home_metadata.st_mode) or home_metadata.st_uid != account.pw_uid:
        stop("target-policy-conflict")
else:
    HOME.mkdir(mode=0o755)
    os.chown(HOME, account.pw_uid, account.pw_gid)
    changed.append("home-created")

ssh_dir = HOME / ".ssh"
if ssh_dir.is_symlink():
    stop("target-policy-conflict")
if ssh_dir.exists() and not ssh_dir.is_dir():
    stop("target-policy-conflict")
ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
ssh_metadata = ssh_dir.stat()
if not stat.S_ISDIR(ssh_metadata.st_mode):
    stop("target-policy-conflict")
os.chown(ssh_dir, account.pw_uid, account.pw_gid)
os.chmod(ssh_dir, 0o700)
authorized = ssh_dir / "authorized_keys"
if authorized.is_symlink():
    stop("target-policy-conflict")
existing = []
if authorized.exists():
    metadata = authorized.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > 1024 * 1024:
        stop("target-policy-conflict")
    existing = authorized.read_text(encoding="utf-8").splitlines()
if PUBLIC_KEY not in existing:
    descriptor, temporary = tempfile.mkstemp(prefix=".authorized_keys-", dir=str(ssh_dir), text=True)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, account.pw_uid, account.pw_gid)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            for line in existing:
                handle.write(line + "\n")
            handle.write(PUBLIC_KEY + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, authorized)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    changed.append("operator-key-installed")
os.chown(authorized, account.pw_uid, account.pw_gid)
os.chmod(authorized, 0o600)

desired = "claude ALL=(ALL) NOPASSWD:ALL\n"
if SUDOERS.is_symlink():
    stop("target-policy-conflict")
if SUDOERS.exists():
    sudoers_metadata = SUDOERS.stat()
    if (not stat.S_ISREG(sudoers_metadata.st_mode) or sudoers_metadata.st_nlink != 1
            or sudoers_metadata.st_uid != 0 or sudoers_metadata.st_size > 4096
            or SUDOERS.read_text(encoding="utf-8") != desired):
        stop("target-policy-conflict")
visudo = next((path for path in ("/usr/sbin/visudo", "/sbin/visudo", "/usr/bin/visudo") if pathlib.Path(path).is_file()), None)
if not visudo:
    stop("visudo-unavailable")
if not SUDOERS.exists():
    descriptor, temporary = tempfile.mkstemp(prefix=".90-claude-", dir=str(SUDOERS.parent), text=True)
    try:
        os.fchmod(descriptor, 0o440)
        os.fchown(descriptor, 0, 0)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(desired)
            handle.flush()
            os.fsync(handle.fileno())
        if subprocess.run([visudo, "-cf", temporary], stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            stop("sudoers-validation-failed")
        os.replace(temporary, SUDOERS)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    changed.append("sudoers-installed")
os.chown(SUDOERS, 0, 0)
os.chmod(SUDOERS, 0o440)
if subprocess.run([visudo, "-cf", str(SUDOERS)], stdin=subprocess.DEVNULL,
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
    stop("sudoers-validation-failed")
emit(True, "target-account-converged", changed)
'''


REMOTE_VERIFY = r'''
import json, os, pwd, subprocess
login = pwd.getpwuid(os.geteuid()).pw_name == "claude"
sudo = subprocess.run(["sudo", "-n", "true"], stdin=subprocess.DEVNULL,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
print(json.dumps({"schema":1,"ok":login and sudo,"login":login,"passwordless_sudo":sudo}, separators=(",",":")))
'''


def binary(candidates: Iterable[str], label: str) -> str:
    for candidate in candidates:
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise ReconcilerBlocked(f"{label}-unavailable")


def known_hosts_for(request_path: Path) -> Path:
    try:
        state_root = request_path.parents[2]
    except IndexError as exc:
        raise ReconcilerError("job-layout-invalid") from exc
    if request_path.parent.parent.name != "jobs":
        raise ReconcilerError("job-layout-invalid")
    return safe_regular_file(str(state_root / "known_hosts"), "known-hosts-file", MAX_BYTES)


def ssh_run(
    ip: str, username: str, auth: Dict[str, Any], known_hosts: Path, program: str, *, as_admin: bool,
) -> Dict[str, Any]:
    pass_fds = []
    temporary_fds = []
    argv = [
        binary(("/usr/bin/ssh", "/bin/ssh"), "ssh"), "-F", "/dev/null",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=yes",
        "-o", "CheckHostIP=yes", "-o", "UserKnownHostsFile=" + str(known_hosts), "-o", "LogLevel=ERROR",
    ]
    if auth.get("private_key"):
        if not hasattr(os, "memfd_create"):
            raise ReconcilerBlocked("private-key-memfd-unavailable")
        descriptor = os.memfd_create("fleet-stage2-key", getattr(os, "MFD_CLOEXEC", 0))
        os.fchmod(descriptor, 0o600)
        os.write(descriptor, auth["private_key"].encode("utf-8"))
        os.lseek(descriptor, 0, os.SEEK_SET)
        argv.extend(["-i", f"/proc/self/fd/{descriptor}", "-o", "IdentitiesOnly=yes"])
        pass_fds.append(descriptor)
        temporary_fds.append(descriptor)
    elif auth.get("password"):
        sshpass = binary(("/usr/bin/sshpass", "/bin/sshpass"), "sshpass")
        read_fd, write_fd = os.pipe()
        os.write(write_fd, auth["password"].encode("utf-8") + b"\n")
        os.close(write_fd)
        argv = [sshpass, "-d", str(read_fd), *argv]
        argv[argv.index("BatchMode=yes")] = "BatchMode=no"
        pass_fds.append(read_fd)
        temporary_fds.append(read_fd)
    else:
        raise ReconcilerBlocked("credential-rejected")
    remote = ["python3", "-"] if not as_admin or username == "root" else ["sudo", "-n", "python3", "-"]
    argv.extend([f"{username}@{ip}", *remote])
    try:
        completed = subprocess.run(
            argv, input=program, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=120, env=safe_child_environment(), pass_fds=tuple(pass_fds), check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReconcilerBlocked("credential-rejected") from exc
    finally:
        for descriptor in temporary_fds:
            try: os.close(descriptor)
            except OSError: pass
    if len(completed.stdout.encode("utf-8")) > 64 * 1024:
        raise ReconcilerBlocked("credential-rejected" if username != "claude" else "dependency-unavailable")
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ReconcilerBlocked("credential-rejected" if as_admin else "dependency-unavailable")
    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise ReconcilerBlocked("dependency-unavailable") from exc
    if not isinstance(value, dict):
        raise ReconcilerBlocked("dependency-unavailable")
    if completed.returncode != 0 and value.get("ok") is not False:
        raise ReconcilerBlocked("credential-rejected" if as_admin else "dependency-unavailable")
    return value


def converge_target(ip: str, first_login: Dict[str, Any], public_key: str, known_hosts: Path) -> list:
    program = REMOTE_RECONCILE_TEMPLATE.replace("__FLEET_OPERATOR_PUBLIC_KEY__", json.dumps(public_key))
    result = ssh_run(ip, first_login["username"], first_login, known_hosts, program, as_admin=True)
    exact_keys(result, {"schema", "ok", "reason_code", "changed"}, "target-result")
    if (result.get("schema") != 1 or result.get("ok") is not True or result.get("reason_code") != "target-account-converged"
            or not isinstance(result.get("changed"), list)
            or any(item not in {"account-created", "home-created", "operator-key-installed", "sudoers-installed"} for item in result["changed"])):
        reason = result.get("reason_code")
        if reason == "target-policy-conflict":
            raise ReconcilerBlocked("policy-conflict")
        raise ReconcilerBlocked("dependency-unavailable")
    return result["changed"]


def verify_managed_login(ip: str, private_key: str, known_hosts: Path) -> None:
    result = ssh_run(ip, "claude", {"private_key": private_key}, known_hosts, REMOTE_VERIFY, as_admin=False)
    exact_keys(result, {"schema", "ok", "login", "passwordless_sudo"}, "managed-login-result")
    if (result.get("schema") != 1 or result.get("ok") is not True or result.get("login") is not True
            or result.get("passwordless_sudo") is not True):
        raise ReconcilerBlocked("dependency-unavailable")


def atomic_json(path: Path, value: Dict[str, Any]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".stage2-result-", dir=str(path.parent), text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(canonical(value) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def run_worker() -> int:
    if len(sys.argv) != 1:
        raise ReconcilerError("arguments-forbidden")
    request_path, result_path, request = load_request()
    action = request["action"]
    request_sha = hashlib.sha256(canonical(request).encode("utf-8")).hexdigest()
    lock_path = request_path.parent / "standard-account.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        receipt_path = request_path.parent / "standard-account-receipt.json"
        if result_path.exists():
            result = load_json(result_path, "job-result")
            receipt = load_json(safe_regular_file(str(receipt_path), "stage2-receipt", MAX_BYTES), "stage2-receipt")
            if receipt.get("request_sha256") != request_sha:
                raise ReconcilerError("operation-id-collision")
            if result.get("schema") != 1 or result.get("outcome") not in {"succeeded", "noop", "blocked", "failed"}:
                raise ReconcilerError("job-result-conflict")
            return 0
        try:
            first_login = read_first_login(request["ip"])
            material: Dict[str, Any] = {}
            try:
                material = provider_call("bootstrap", request["ip"], request_path.parent)
                changed = converge_target(
                    request["ip"], first_login, material["public_key"], known_hosts_for(request_path),
                )
                # The bootstrap login has served its only purpose. Do not retain
                # its parsed password/key while proving the independent managed
                # claude identity.
                forget_credential(first_login)
                verify_managed_login(request["ip"], material["private_key"], known_hosts_for(request_path))
            finally:
                forget_credential(first_login)
                forget_credential(material)
            receipt = {
                "schema": 1, "operation_id": action["operation_id"], "executor_id": action["executor_id"],
                "request_sha256": request_sha, "phase": "target-verified", "target": "claude",
                "checks": {"operator_key_login": True, "passwordless_sudo": True},
            }
            atomic_json(receipt_path, receipt)
            committed = provider_call("commit", request["ip"], request_path.parent)
            receipt.update({
                "phase": "managed-login-readback",
                "checks": {**receipt["checks"], "vault_commit": True, "vault_readback": True},
            })
            atomic_json(receipt_path, receipt)
            result = {
                "schema": 1, "outcome": "succeeded",
                "reason_code": "installed-and-verified" if "account-created" in changed else "repaired-and-verified",
            }
            if not changed and committed["changed"] is False:
                result = {"schema": 1, "outcome": "noop", "reason_code": "already-healthy"}
        except ReconcilerBlocked as exc:
            reason = str(exc)
            if reason not in {"credential-rejected", "dependency-unavailable", "policy-conflict"}:
                reason = "dependency-unavailable"
            result = {"schema": 1, "outcome": "blocked", "reason_code": reason}
            atomic_json(receipt_path, {
                "schema": 1, "operation_id": action["operation_id"], "executor_id": action["executor_id"],
                "request_sha256": request_sha, "phase": "blocked", "reason_code": reason,
            })
        atomic_json(result_path, result)
    return 0


def main() -> int:
    try:
        return run_worker()
    except ReconcilerError as exc:
        sys.stderr.write(canonical({"schema": 1, "ok": False, "error": str(exc)}) + "\n")
        return 2
    except Exception:
        # Never risk including an exception value originating in credentials or
        # a child process. Unexpected faults remain a stable fail-closed code.
        sys.stderr.write(canonical({"schema": 1, "ok": False, "error": "stage2-executor-failed"}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
