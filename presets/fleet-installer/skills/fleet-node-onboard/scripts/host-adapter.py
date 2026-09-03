#!/usr/bin/env python3
"""Host-owned transport boundary for deterministic Fleet onboarding.

The model-facing tool calls this executable with JSON on stdin.  The adapter
never accepts a command, executable path, credential, or inventory from the
model.  It resolves credentials through a host-owned file/provider, runs one
fixed probe, signs the redacted observation, and dispatches only executor IDs
declared by ``component-contract.json``.

No production SSH implementation is embedded here.  A deployment must supply
reviewed probe/stage executables in an owner-only config file.  Missing pieces
fail closed and are visible through the capability matrix.
"""

from __future__ import annotations

import datetime
import fcntl
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, Iterable, Optional, Tuple


HERE = Path(__file__).resolve().parent
CONTRACT_PATH = HERE.parent / "component-contract.json"
RUNTIME_PATH = HERE / "onboard-runtime.py"
MAX_JSON_BYTES = 1024 * 1024
MAX_CREDENTIAL_BYTES = 128 * 1024
SAFE_OPERATION_ID = re.compile(r"^onboard-[0-9a-f]{32}$")
SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
SAFE_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")


class AdapterError(ValueError):
    """A stable diagnostic that never contains transport output or secrets."""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_runtime():
    spec = importlib.util.spec_from_file_location("fleet_onboard_runtime", RUNTIME_PATH)
    if spec is None or spec.loader is None:
        raise AdapterError("runtime-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUNTIME = load_runtime()


def exact_keys(value: Dict[str, Any], allowed: Iterable[str], path: str) -> None:
    unknown = set(value) - set(allowed)
    if unknown:
        raise AdapterError(f"unknown-field:{path}.{sorted(unknown)[0]}")


def read_stdin() -> Dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise AdapterError("request-too-large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError("request-invalid-json") from exc
    if not isinstance(value, dict):
        raise AdapterError("request-must-be-object")
    # Runtime inventory is allowed, but credential-shaped data never is.
    RUNTIME.reject_sensitive(value, "request")
    return value


def require_ip(value: Any) -> str:
    try:
        address = ipaddress.IPv4Address(value)
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise AdapterError("ip-invalid") from exc
    if not address.is_global:
        raise AdapterError("ip-must-be-public")
    return str(address)


def safe_file(path_text: str, label: str, *, executable: bool = False) -> Path:
    path = Path(path_text)
    if not path.is_absolute() or path.is_symlink():
        raise AdapterError(f"{label}-unsafe")
    try:
        metadata = path.stat()
    except OSError as exc:
        raise AdapterError(f"{label}-unavailable") from exc
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()}:
        raise AdapterError(f"{label}-unsafe")
    if metadata.st_mode & 0o022:
        raise AdapterError(f"{label}-unsafe")
    if executable and (not metadata.st_mode & stat.S_IXUSR or not os.access(path, os.X_OK)):
        raise AdapterError(f"{label}-not-executable")
    return path.resolve()


def load_config() -> Dict[str, Any]:
    path_text = os.environ.get("FLEET_ONBOARD_HOST_CONFIG_FILE", "")
    if not path_text:
        raise AdapterError("host-adapter-config-required")
    path = safe_file(path_text, "host-adapter-config")
    metadata = path.stat()
    owner_private = metadata.st_uid == os.geteuid() and metadata.st_mode & 0o077 == 0
    groups = set(os.getgroups()) | {os.getegid()}
    root_group_readonly = (metadata.st_uid == 0 and metadata.st_gid in groups
                           and metadata.st_mode & 0o040 and metadata.st_mode & 0o027 == 0)
    if not (owner_private or root_group_readonly):
        raise AdapterError("host-adapter-config-not-private-to-service")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError("host-adapter-config-invalid") from exc
    if not isinstance(config, dict):
        raise AdapterError("host-adapter-config-must-be-object")
    exact_keys(
        config,
        {
            "schema", "state_dir", "credential_provider", "probe_executor",
            "stage_executors", "wait_timeout_seconds", "poll_interval_ms",
            "desired",
        },
        "config",
    )
    if config.get("schema") != 1:
        raise AdapterError("host-adapter-config-schema-invalid")
    state_dir = Path(str(config.get("state_dir", "")))
    if not state_dir.is_absolute() or state_dir.is_symlink():
        raise AdapterError("host-adapter-state-dir-unsafe")
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = state_dir.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()}:
        raise AdapterError("host-adapter-state-dir-unsafe")
    if metadata.st_mode & 0o077:
        raise AdapterError("host-adapter-state-dir-must-be-owner-only")
    config["state_dir"] = str(state_dir.resolve())

    for field in ("credential_provider", "probe_executor"):
        if config.get(field):
            config[field] = str(safe_file(str(config[field]), field.replace("_", "-"), executable=True))
    executors = config.get("stage_executors", {})
    if not isinstance(executors, dict):
        raise AdapterError("stage-executors-must-be-object")
    allowed = {stage["executor_id"] for stage in load_contract()["stages"]}
    if set(executors) - allowed:
        raise AdapterError("stage-executor-id-not-in-contract")
    config["stage_executors"] = {
        executor_id: str(safe_file(str(path), "stage-executor", executable=True))
        for executor_id, path in executors.items()
    }
    timeout = config.get("wait_timeout_seconds", 300)
    poll_ms = config.get("poll_interval_ms", 250)
    # Keep a safety margin inside the central ledger's 15-minute lease. Long
    # target jobs remain durable and are resumed by operation_id on the next turn.
    if not isinstance(timeout, int) or not 1 <= timeout <= 600:
        raise AdapterError("wait-timeout-must-be-1..600")
    if not isinstance(poll_ms, int) or not 25 <= poll_ms <= 5000:
        raise AdapterError("poll-interval-must-be-25..5000")
    config["wait_timeout_seconds"] = timeout
    config["poll_interval_ms"] = poll_ms
    desired = config.get("desired", {"line": "line-100", "browser_count": 2, "profile": "base"})
    if not isinstance(desired, dict):
        raise AdapterError("desired-must-be-object")
    exact_keys(desired, {"line", "browser_count", "profile"}, "config.desired")
    if desired.get("line") != "line-100" or desired.get("browser_count") not in {1, 2}:
        raise AdapterError("desired-policy-invalid")
    if desired.get("profile") not in {"base", "image-worker"}:
        raise AdapterError("desired-profile-invalid")
    config["desired"] = desired
    return config


def load_contract() -> Dict[str, Any]:
    return RUNTIME.load_contract()


def contract_digest(contract: Dict[str, Any]) -> str:
    return RUNTIME.contract_digest(contract)


def safe_environment(extra: Optional[Dict[str, str]] = None, *, vault: bool = False) -> Dict[str, str]:
    result: Dict[str, str] = {}
    inherited = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]
    if vault:
        inherited.extend([
            "FLEET_ONBOARD_VAULT_RESOLVE_TOKEN",
            "FLEET_ONBOARD_VAULT_RESOLVE_URL",
        ])
    for name in inherited:
        if name in os.environ:
            result[name] = os.environ[name]
    if extra:
        result.update(extra)
    return result


def one_json_line(stdout: bytes, label: str, allowed: Iterable[str]) -> Dict[str, Any]:
    if len(stdout) > MAX_JSON_BYTES:
        raise AdapterError(f"{label}-output-too-large")
    try:
        text = stdout.decode("utf-8")
    except UnicodeError as exc:
        raise AdapterError(f"{label}-output-invalid") from exc
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise AdapterError(f"{label}-must-return-one-json-line")
    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise AdapterError(f"{label}-invalid-json") from exc
    if not isinstance(value, dict):
        raise AdapterError(f"{label}-must-return-object")
    RUNTIME.reject_sensitive(value, label)
    exact_keys(value, allowed, label)
    return value


def validate_credential_file(path: Path, ip: str) -> Tuple[int, str]:
    if not path.is_absolute():
        raise AdapterError("credential-file-unsafe")
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
        )
        metadata = os.fstat(descriptor)
    except OSError as exc:
        raise AdapterError("managed-credential-missing") from exc
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()}
            or metadata.st_mode & 0o077 or metadata.st_size > MAX_CREDENTIAL_BYTES):
        os.close(descriptor)
        raise AdapterError("credential-file-unsafe")
    try:
        raw = os.read(descriptor, MAX_CREDENTIAL_BYTES + 1)
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        os.close(descriptor)
        raise AdapterError("credential-file-invalid") from exc
    finally:
        if "raw" in locals():
            mutable = bytearray(raw)
            mutable[:] = b"\x00" * len(mutable)
    if not isinstance(value, dict) or value.get("schema") != 1 or value.get("ip") != ip:
        os.close(descriptor)
        raise AdapterError("credential-file-target-mismatch")
    if not isinstance(value.get("username"), str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", value["username"]):
        os.close(descriptor)
        raise AdapterError("credential-file-user-invalid")
    if not any(value.get(name) for name in ("password", "private_key", "ssh_agent_socket")):
        os.close(descriptor)
        raise AdapterError("managed-credential-missing")
    source = value.get("source", "intake")
    if source not in {"intake", "vault", "managed-account"}:
        os.close(descriptor)
        raise AdapterError("credential-source-invalid")
    if source in {"vault", "managed-account"} and value["username"] != "claude":
        os.close(descriptor)
        raise AdapterError("managed-credential-user-invalid")
    os.lseek(descriptor, 0, os.SEEK_SET)
    return descriptor, source


def resolve_credential(
    config: Dict[str, Any], ip: str, *, allow_supplied: bool = True,
) -> Tuple[int, str, Optional[Path]]:
    supplied = os.environ.get("FLEET_ONBOARD_CREDENTIAL_FILE") if allow_supplied else None
    if supplied:
        descriptor, source = validate_credential_file(Path(supplied), ip)
        return descriptor, source, None
    provider = config.get("credential_provider")
    if not provider:
        raise AdapterError("managed-credential-missing")
    parent = Path(config["state_dir"]).parent
    temporary_dir = Path(tempfile.mkdtemp(prefix=".fleet-credential-", dir=str(parent)))
    temporary_dir.chmod(0o700)
    credential_path = temporary_dir / "credential.json"
    env = safe_environment({"FLEET_ONBOARD_CREDENTIAL_FILE": str(credential_path)}, vault=True)
    try:
        result = subprocess.run(
            [provider],
            input=canonical({"schema": 1, "operation": "resolve", "ip": ip}) + "\n",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=60,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AdapterError("credential-provider-unavailable") from exc
    if result.returncode != 0:
        raise AdapterError("managed-credential-missing")
    response = one_json_line(
        result.stdout.encode("utf-8"), "credential-provider-result",
        {"schema", "available", "source", "reason_code"},
    )
    if response.get("schema") != 1 or response.get("available") is not True:
        raise AdapterError(str(response.get("reason_code", "managed-credential-missing")))
    descriptor, source = validate_credential_file(credential_path, ip)
    # The open descriptor survives unlink and can be inherited by the trusted
    # probe/worker.  No secret remains in transaction or job state.
    credential_path.unlink()
    return descriptor, source, temporary_dir


def close_credential(descriptor: Optional[int], temporary_dir: Optional[Path]) -> None:
    if descriptor is not None:
        try:
            os.close(descriptor)
        except OSError:
            pass
    if temporary_dir is not None:
        try:
            temporary_dir.rmdir()
        except OSError:
            pass


def run_probe(config: Dict[str, Any], ip: str, credential_fd: int, source: str) -> Dict[str, Any]:
    executable = config.get("probe_executor")
    if not executable:
        raise AdapterError("probe-executor-unavailable")
    os.lseek(credential_fd, 0, os.SEEK_SET)
    known_hosts = Path(config["state_dir"]) / "known_hosts"
    env = safe_environment({
        "FLEET_ONBOARD_CREDENTIAL_FD": str(credential_fd),
        "FLEET_ONBOARD_KNOWN_HOSTS_FILE": str(known_hosts),
    })
    try:
        result = subprocess.run(
            [executable],
            input=canonical({
                "schema": 1, "operation": "probe", "ip": ip,
                "browser_count": config["desired"]["browser_count"],
            }) + "\n",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=120,
            env=env,
            pass_fds=(credential_fd,),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AdapterError("probe-transport-failed") from exc
    if result.returncode != 0:
        raise AdapterError("probe-transport-failed")
    raw = one_json_line(
        result.stdout.encode("utf-8"), "probe-result",
        {"schema", "ip", "observed_at", "target_fingerprint", "fleet", "components"},
    )
    if raw.get("schema") != 1 or raw.get("ip") != ip:
        raise AdapterError("probe-result-identity-mismatch")
    if not isinstance(raw.get("target_fingerprint"), str) or not SAFE_FINGERPRINT.fullmatch(raw["target_fingerprint"]):
        raise AdapterError("probe-target-fingerprint-required")
    if not isinstance(raw.get("fleet"), dict) or not isinstance(raw.get("components"), dict):
        raise AdapterError("probe-result-shape-invalid")
    observed_at = raw.get("observed_at")
    if not isinstance(observed_at, str):
        raise AdapterError("probe-observed-at-required")
    contract = load_contract()
    inventory = {
        "schema": 1,
        "ip": ip,
        "provenance": {
            "origin": contract["inventory_protocol"]["origin"],
            "executor_id": contract["inventory_protocol"]["executor_id"],
            "observed_at": observed_at,
            "target_fingerprint": raw["target_fingerprint"],
            "contract_sha256": contract_digest(contract),
        },
        "desired": config["desired"],
        "fleet": raw["fleet"],
        "credentials": {"available": True, "source": source},
        "components": raw["components"],
    }
    # A successful Vault provider resolution is direct host-side proof that the
    # managed login record exists and was read back.  Target login/sudo remain
    # probe facts and are never inferred from Vault metadata.
    if source in {"vault", "managed-account"}:
        standard = inventory["components"].get("standard-account", {})
        if isinstance(standard.get("checks"), dict):
            standard["checks"]["vault_writeback"] = True
            standard["healthy"] = bool(standard.get("present")) and all(standard["checks"].values())
        login = inventory["components"].get("vault-login", {})
        if isinstance(login.get("checks"), dict):
            login["checks"]["vault_readback"] = (
                login["checks"].get("login") is True
                and login["checks"].get("passwordless_sudo") is True
            )
            login["healthy"] = bool(login.get("present")) and all(login["checks"].values())
    key = RUNTIME.inventory_hmac_key()
    digest = hmac.new(key, canonical(inventory).encode("utf-8"), hashlib.sha256).hexdigest()
    inventory["provenance"]["attestation"] = "hmac-sha256:" + digest
    try:
        return RUNTIME.validate_inventory(inventory, contract)
    except RUNTIME.RuntimeContractError as exc:
        raise AdapterError(f"probe-inventory-invalid:{exc}") from exc


def response_for(action: Dict[str, Any], outcome: str, reason: str, inventory: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    classification, disposition = {
        "succeeded": ("healthy", "reusable"),
        "noop": ("healthy", "reusable"),
        "blocked": ("blocked", "needs-user"),
        "failed": ("blocked", "fatal"),
    }[outcome]
    response: Dict[str, Any] = {
        "schema": 1,
        "executor_id": action["executor_id"],
        "operation_id": action["operation_id"],
        "outcome": outcome,
        "classification": classification,
        "disposition": disposition,
        "reason_code": reason,
    }
    if inventory is not None:
        response["inventory"] = inventory
    return response


def validate_action_request(request: Dict[str, Any], contract: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    exact_keys(request, {"schema", "ip", "contract_sha256", "action", "inventory", "action_attestation"}, "request")
    if request.get("schema") != 1:
        raise AdapterError("request-schema-invalid")
    ip = require_ip(request.get("ip"))
    if request.get("contract_sha256") != contract_digest(contract):
        raise AdapterError("request-contract-mismatch")
    supplied_attestation = request.get("action_attestation")
    if not isinstance(supplied_attestation, str) or not re.fullmatch(r"hmac-sha256:[0-9a-f]{64}", supplied_attestation):
        raise AdapterError("action-attestation-required")
    unsigned = json.loads(canonical(request))
    unsigned.pop("action_attestation", None)
    expected_attestation = "hmac-sha256:" + hmac.new(
        RUNTIME.inventory_hmac_key(), canonical(unsigned).encode("utf-8"), hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(supplied_attestation, expected_attestation):
        raise AdapterError("action-attestation-mismatch")
    action = request.get("action")
    if not isinstance(action, dict):
        raise AdapterError("action-required")
    exact_keys(action, {"stage", "component", "executor_id", "operation_id", "reason"}, "request.action")
    stage_number = action.get("stage")
    if not isinstance(stage_number, int) or not 1 <= stage_number <= 10:
        raise AdapterError("action-stage-invalid")
    stage = contract["stages"][stage_number - 1]
    if action.get("component") != stage["id"] or action.get("executor_id") != stage["executor_id"]:
        raise AdapterError("action-not-in-component-contract")
    if not isinstance(action.get("operation_id"), str) or not SAFE_OPERATION_ID.fullmatch(action["operation_id"]):
        raise AdapterError("action-operation-id-invalid")
    if not isinstance(action.get("reason"), str) or not SAFE_CODE.fullmatch(action["reason"]):
        raise AdapterError("action-reason-invalid")
    inventory = request.get("inventory")
    if not isinstance(inventory, dict):
        raise AdapterError("signed-inventory-required")
    try:
        verified = RUNTIME.validate_inventory(inventory, contract)
    except RUNTIME.RuntimeContractError as exc:
        raise AdapterError(f"signed-inventory-invalid:{exc}") from exc
    if verified["ip"] != ip:
        raise AdapterError("inventory-ip-mismatch")
    return ip, action


def process_start_ticks(pid: int) -> Optional[str]:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()
        return fields[21]
    except (OSError, IndexError):
        return None


def process_alive(metadata: Dict[str, Any]) -> bool:
    pid = metadata.get("pid")
    start_ticks = metadata.get("process_start_ticks")
    if not isinstance(pid, int) or pid <= 1 or not isinstance(start_ticks, str):
        return False
    return process_start_ticks(pid) == start_ticks


def atomic_json(path: Path, value: Dict[str, Any]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".write-", dir=str(path.parent), text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(canonical(value) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_job_json(path: Path, label: str) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            raise AdapterError(f"{label}-too-large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError(f"{label}-invalid") from exc
    if not isinstance(value, dict):
        raise AdapterError(f"{label}-invalid")
    RUNTIME.reject_sensitive(value, label)
    return value


def validate_worker_result(value: Dict[str, Any]) -> Tuple[str, str]:
    exact_keys(value, {"schema", "outcome", "reason_code"}, "worker-result")
    if value.get("schema") != 1 or value.get("outcome") not in {"succeeded", "noop", "blocked", "failed"}:
        raise AdapterError("worker-result-invalid")
    reason = value.get("reason_code")
    if not isinstance(reason, str) or not SAFE_CODE.fullmatch(reason):
        raise AdapterError("worker-reason-code-invalid")
    allowed_reasons = {
        "succeeded": {"repaired-and-verified", "installed-and-verified"},
        "noop": {"already-healthy"},
        "blocked": {"credential-rejected", "dependency-unavailable", "policy-conflict"},
        "failed": {"executor-failed", "rollback-failed"},
    }
    if reason not in allowed_reasons[value["outcome"]]:
        raise AdapterError("worker-reason-code-not-allowed")
    return value["outcome"], reason


def job_paths(config: Dict[str, Any], operation_id: str, *, create: bool = True) -> Dict[str, Path]:
    root = Path(config["state_dir"]) / "jobs" / operation_id
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
    return {
        "root": root,
        "lock": root / "lock",
        "request": root / "request.json",
        "metadata": root / "metadata.json",
        "result": root / "result.json",
    }


def wait_for_job(paths: Dict[str, Path], metadata: Dict[str, Any], config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    deadline = time.monotonic() + config["wait_timeout_seconds"]
    while time.monotonic() < deadline:
        result = read_job_json(paths["result"], "worker-result")
        if result is not None:
            return result
        if not process_alive(metadata):
            return None
        time.sleep(config["poll_interval_ms"] / 1000)
    return None


def stage_is_healthy(inventory: Dict[str, Any], action: Dict[str, Any], contract: Dict[str, Any]) -> bool:
    classified = RUNTIME.classify_component(contract["stages"][action["stage"] - 1], inventory)
    return classified["health"] == "healthy"


def execute(config: Dict[str, Any], request: Dict[str, Any]) -> Dict[str, Any]:
    contract = load_contract()
    ip, action = validate_action_request(request, contract)
    node_dir = Path(config["state_dir"]) / "nodes"
    node_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    node_dir.chmod(0o700)
    node_lock = (node_dir / f"{ip.replace('.', '-')}.lock").open("a+", encoding="utf-8")
    os.chmod(node_lock.name, 0o600)
    try:
        try:
            fcntl.flock(node_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return response_for(action, "blocked", "node-operation-busy")
        credential_fd: Optional[int]
        credential_fd, source, temporary_dir = resolve_credential(config, ip)
        try:
            # Re-probe on every invocation, including recovery after an interrupted
            # adapter.  This prevents blind replay of a write whose result was lost.
            before = run_probe(config, ip, credential_fd, source)
            if stage_is_healthy(before, action, contract):
                return response_for(action, "noop", "already-healthy", before)
            executable = config["stage_executors"].get(action["executor_id"])
            if not executable:
                return response_for(action, "blocked", "executor-not-configured")
            paths = job_paths(config, action["operation_id"])
            safe_request = {
                "schema": 1,
                "ip": ip,
                "contract_sha256": contract_digest(contract),
                "action": action,
            }
            request_digest = hashlib.sha256(canonical(safe_request).encode("utf-8")).hexdigest()
            with paths["lock"].open("a+", encoding="utf-8") as lock:
                os.chmod(paths["lock"], 0o600)
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                metadata = read_job_json(paths["metadata"], "job-metadata")
                if metadata and metadata.get("request_sha256") != request_digest:
                    return response_for(action, "failed", "operation-id-collision")
                result = read_job_json(paths["result"], "worker-result")
                if result is None and metadata is None:
                    atomic_json(paths["request"], safe_request)
                    os.lseek(credential_fd, 0, os.SEEK_SET)
                    try:
                        child = subprocess.Popen(
                            [executable],
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            env=safe_environment({
                                "FLEET_ONBOARD_JOB_REQUEST_FILE": str(paths["request"]),
                                "FLEET_ONBOARD_JOB_RESULT_FILE": str(paths["result"]),
                                "FLEET_ONBOARD_CREDENTIAL_FD": str(credential_fd),
                            }, vault=action["stage"] == 2),
                            pass_fds=(credential_fd,),
                            close_fds=True,
                            start_new_session=True,
                        )
                    except OSError:
                        return response_for(action, "failed", "executor-launch-failed")
                    # /proc is populated immediately on supported Linux hosts.
                    start_ticks = process_start_ticks(child.pid)
                    if start_ticks is None and not paths["result"].exists():
                        try:
                            os.kill(child.pid, signal.SIGTERM)
                        except OSError:
                            pass
                        return response_for(action, "failed", "executor-process-unobservable")
                    metadata = {
                        "schema": 1,
                        "operation_id": action["operation_id"],
                        "executor_id": action["executor_id"],
                        "request_sha256": request_digest,
                        "pid": child.pid,
                        "process_start_ticks": start_ticks or "completed",
                        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                    }
                    atomic_json(paths["metadata"], metadata)
                elif result is None and metadata is not None and not process_alive(metadata):
                    # The fresh probe above proved the stage is still unhealthy.
                    # Do not replay a possibly-partial mutation under the same ID.
                    return response_for(action, "blocked", "orphaned-operation-requires-review")

            if result is None:
                result = wait_for_job(paths, metadata or {}, config)
            if result is None:
                if process_alive(metadata or {}):
                    return response_for(action, "blocked", "operation-still-running")
                # Give an atomic worker receipt a final scheduling opportunity.
                time.sleep(config["poll_interval_ms"] / 1000)
                result = read_job_json(paths["result"], "worker-result")
                if result is None:
                    return response_for(action, "blocked", "orphaned-operation-requires-review")
            outcome, reason = validate_worker_result(result)
            if outcome not in {"succeeded", "noop"}:
                return response_for(action, outcome, reason)
            if action["stage"] == 2 and outcome in {"succeeded", "noop"}:
                # Stage 2 changes the trust boundary: the bootstrap credential
                # must never be used to attest the managed account or Vault
                # readback. Destroy it, resolve the just-written managed login
                # through the scoped provider, and only then run the post-probe.
                close_credential(credential_fd, temporary_dir)
                credential_fd, temporary_dir = None, None
                try:
                    credential_fd, source, temporary_dir = resolve_credential(
                        config, ip, allow_supplied=False,
                    )
                except AdapterError:
                    return response_for(action, "blocked", "managed-credential-handoff-required")
                if source not in {"vault", "managed-account"}:
                    return response_for(action, "blocked", "managed-credential-handoff-required")
            if credential_fd is None:
                return response_for(action, "failed", "credential-descriptor-lost")
            after = run_probe(config, ip, credential_fd, source)
            if after["provenance"]["target_fingerprint"] != before["provenance"]["target_fingerprint"]:
                return response_for(action, "failed", "target-identity-changed")
            try:
                before_at = datetime.datetime.fromisoformat(
                    before["provenance"]["observed_at"].replace("Z", "+00:00"),
                )
                after_at = datetime.datetime.fromisoformat(
                    after["provenance"]["observed_at"].replace("Z", "+00:00"),
                )
            except (AttributeError, ValueError):
                return response_for(action, "failed", "post-probe-time-invalid")
            if after_at <= before_at:
                return response_for(action, "failed", "post-probe-not-fresh")
            if not stage_is_healthy(after, action, contract):
                return response_for(action, "failed", "postcondition-not-healthy")
            return response_for(action, outcome, reason, after)
        finally:
            close_credential(credential_fd, temporary_dir)
    finally:
        node_lock.close()


def probe(config: Dict[str, Any], request: Dict[str, Any]) -> Dict[str, Any]:
    exact_keys(request, {"schema", "operation", "ip"}, "request")
    if request.get("schema") != 1 or request.get("operation") not in {"probe", "inventory"}:
        raise AdapterError("probe-request-invalid")
    ip = require_ip(request.get("ip"))
    descriptor, source, temporary_dir = resolve_credential(config, ip)
    try:
        inventory = run_probe(config, ip, descriptor, source)
        # Keep the signed inventory authoritative while also projecting the
        # legacy raw-probe fields consumed by dsh-task-console 0.20.x.  That
        # host module may re-sign the same fields; models cannot supply either
        # representation.
        return {
            "schema": 1, "ok": True, "operation": "probe", "ip": ip,
            "observed_at": inventory["provenance"]["observed_at"],
            "target_fingerprint": inventory["provenance"]["target_fingerprint"],
            "fleet": inventory["fleet"], "components": inventory["components"],
            "inventory": inventory,
        }
    finally:
        close_credential(descriptor, temporary_dir)


def poll(config: Dict[str, Any], request: Dict[str, Any]) -> Dict[str, Any]:
    exact_keys(request, {"schema", "operation", "ip", "operation_id"}, "request")
    if request.get("schema") != 1 or request.get("operation") != "poll":
        raise AdapterError("poll-request-invalid")
    ip = require_ip(request.get("ip"))
    operation_id = request.get("operation_id")
    if not isinstance(operation_id, str) or not SAFE_OPERATION_ID.fullmatch(operation_id):
        raise AdapterError("operation-id-invalid")
    paths = job_paths(config, operation_id, create=False)
    if not paths["root"].is_dir():
        raise AdapterError("operation-not-found")
    metadata = read_job_json(paths["metadata"], "job-metadata")
    if metadata is None:
        raise AdapterError("operation-not-found")
    result = read_job_json(paths["result"], "worker-result")
    if result is not None:
        outcome, reason = validate_worker_result(result)
        status = outcome
    elif process_alive(metadata):
        status, reason = "running", "operation-still-running"
    else:
        status, reason = "blocked", "orphaned-operation-requires-review"
    return {
        "schema": 1, "ok": True, "operation": "poll", "ip": ip,
        "operation_id": operation_id, "executor_id": metadata.get("executor_id"),
        "status": status, "reason_code": reason,
    }


def capabilities(config: Dict[str, Any]) -> Dict[str, Any]:
    contract = load_contract()
    configured = config.get("stage_executors", {})
    rows = []
    for stage in contract["stages"]:
        mode = stage.get("execution_mode", "reconcile")
        available = stage["executor_id"] in configured
        if mode == "probe-gate":
            execution = "probe-gated"
            reason_code = "fresh-probe-required"
        else:
            execution = "configured" if available else "fail-closed"
            reason_code = "executor-configured" if available else "executor-not-configured"
        rows.append({
            "stage": stage["stage"], "component": stage["id"],
            "executor_id": stage["executor_id"], "execution_mode": mode,
            "execution": execution, "reason_code": reason_code,
        })
    return {
        "schema": 1, "ok": True, "operation": "capabilities",
        "probe": "configured" if config.get("probe_executor") else "fail-closed",
        "credential_provider": "configured" if config.get("credential_provider") else "host-intake-only",
        "stages": rows,
        "production_ssh_embedded": False,
    }


def emit(value: Dict[str, Any], stream=sys.stdout) -> None:
    stream.write(canonical(value) + "\n")


def main() -> int:
    try:
        config = load_config()
        if len(sys.argv) == 2 and sys.argv[1] == "capabilities":
            emit(capabilities(config))
            return 0
        if len(sys.argv) != 1:
            raise AdapterError("arguments-forbidden")
        request = read_stdin()
        if "action" in request:
            emit(execute(config, request))
        elif request.get("operation") in {"probe", "inventory"}:
            emit(probe(config, request))
        elif request.get("operation") == "poll":
            emit(poll(config, request))
        else:
            raise AdapterError("operation-invalid")
        return 0
    except (AdapterError, RUNTIME.RuntimeContractError) as exc:
        emit({"schema": 1, "ok": False, "error": str(exc)}, sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
