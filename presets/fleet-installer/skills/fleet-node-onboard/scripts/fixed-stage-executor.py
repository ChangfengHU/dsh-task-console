#!/usr/bin/env python3
"""Fail-closed worker for the Fleet onboarding stage protocol.

This executable is intentionally safe to install before any mutating stage
driver exists.  It accepts only the job files and credential descriptor that
``host-adapter.py`` supplies, validates the action against the checked-in
component contract, and writes one durable terminal receipt.  No command,
path, hostname, credential, or inventory can be supplied by the model.

All ten stages currently remain disabled here.  That is deliberate: the
existing onboarding shell scripts cross stage boundaries or lack a durable
component-scoped receipt.  A disabled stage returns ``dependency-unavailable``
instead of pretending a partial mutation succeeded.  The host adapter must
continue to omit this worker from ``stage_executors`` until a stage is backed
by a reviewed, fixed implementation and the capability table below changes.
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
import sys
import tempfile
from typing import Any, Dict, Iterable


HERE = Path(__file__).resolve().parent
CONTRACT_PATH = HERE.parent / "component-contract.json"
MAX_BYTES = 1024 * 1024
MAX_CREDENTIAL_BYTES = 128 * 1024
SAFE_OPERATION_ID = re.compile(r"^onboard-[0-9a-f]{32}$")
SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")


# This table is code, not configuration.  Changing a stage from disabled to
# enabled therefore requires a reviewed source change and tests; an owner-only
# config file cannot silently turn an arbitrary executable into a Fleet writer.
STAGE_CAPABILITIES = {
    "fleet.ssh-preflight.v1": (
        1, "ssh-preflight", False, "read-only-probe-cannot-repair-unreachable-target"
    ),
    "fleet.standard-account.v1": (
        2, "standard-account", False, "vault-writeback-driver-not-shipped"
    ),
    "fleet.vault-login.v1": (
        3, "vault-login", False, "read-only-gate-has-no-mutation"
    ),
    "fleet.machine-runtime-reconcile.v1": (
        4, "resource-snapshot", False, "dedicated-machine-runtime-reconciler-required"
    ),
    "fleet.mihomo-reconcile.v1": (
        5, "mihomo", False, "component-scoped-rollback-driver-not-shipped"
    ),
    "fleet.clash-control-plane-reconcile.v1": (
        6, "clash-control-plane", False, "versioned-control-plane-driver-not-shipped"
    ),
    "fleet.browser-vnc-reconcile.v1": (
        7, "browser-vnc", False, "resumable-browser-driver-not-shipped"
    ),
    "fleet.cloudflare-publication-reconcile.v1": (
        8, "cloudflare-publication", False, "tunnel-ingress-cas-driver-not-shipped"
    ),
    "fleet.acceptance-reconcile.v1": (
        9, "acceptance", False, "fresh-acceptance-probe-not-shipped"
    ),
    "fleet.registration-reconcile.v1": (
        10, "fleet-registration", False, "audited-fleet-cas-driver-not-shipped"
    ),
}


class ExecutorError(ValueError):
    """Stable diagnostic that never embeds file contents or credentials."""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def exact_keys(value: Dict[str, Any], allowed: Iterable[str], label: str) -> None:
    extra = set(value) - set(allowed)
    if extra:
        raise ExecutorError(f"unknown-field:{label}.{sorted(extra)[0]}")


def safe_regular_file(
    path_text: str, label: str, *, max_bytes: int, owner_only: bool = True
) -> Path:
    path = Path(path_text)
    if not path_text or not path.is_absolute() or path.is_symlink():
        raise ExecutorError(f"{label}-unsafe")
    try:
        metadata = path.stat()
    except OSError as exc:
        raise ExecutorError(f"{label}-unavailable") from exc
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid not in {0, os.geteuid()}
        or metadata.st_mode & (0o077 if owner_only else 0o022)
        or metadata.st_size > max_bytes
    ):
        raise ExecutorError(f"{label}-unsafe")
    return path.resolve()


def safe_result_path(path_text: str, request_path: Path) -> Path:
    path = Path(path_text)
    if not path_text or not path.is_absolute() or path.is_symlink():
        raise ExecutorError("job-result-file-unsafe")
    parent = path.parent
    try:
        metadata = parent.stat()
    except OSError as exc:
        raise ExecutorError("job-result-directory-unavailable") from exc
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid not in {0, os.geteuid()}
        or metadata.st_mode & 0o077
        or parent.resolve() != request_path.parent.resolve()
    ):
        raise ExecutorError("job-result-directory-unsafe")
    if path.exists():
        safe_regular_file(str(path), "job-result-file", max_bytes=MAX_BYTES)
    return path


def load_json(path: Path, label: str) -> Dict[str, Any]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ExecutorError(f"{label}-invalid") from exc
    if not isinstance(value, dict):
        raise ExecutorError(f"{label}-must-be-object")
    return value


def load_contract() -> Dict[str, Any]:
    path = safe_regular_file(
        str(CONTRACT_PATH), "component-contract", max_bytes=MAX_BYTES, owner_only=False
    )
    contract = load_json(path, "component-contract")
    if contract.get("schema") != 1 or not isinstance(contract.get("stages"), list):
        raise ExecutorError("component-contract-invalid")
    rows = {
        stage.get("executor_id"): (stage.get("stage"), stage.get("id"))
        for stage in contract["stages"]
        if isinstance(stage, dict)
    }
    expected = {key: value[:2] for key, value in STAGE_CAPABILITIES.items()}
    if rows != expected:
        raise ExecutorError("component-contract-stage-drift")
    return contract


def contract_digest(contract: Dict[str, Any]) -> str:
    return hashlib.sha256(canonical(contract).encode("utf-8")).hexdigest()


def validate_credential_descriptor() -> None:
    value = os.environ.get("FLEET_ONBOARD_CREDENTIAL_FD", "")
    try:
        descriptor = int(value)
        metadata = os.fstat(descriptor)
    except (ValueError, OSError) as exc:
        raise ExecutorError("credential-descriptor-unavailable") from exc
    if (
        descriptor < 3
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_size <= 0
        or metadata.st_size > MAX_CREDENTIAL_BYTES
    ):
        raise ExecutorError("credential-descriptor-unsafe")
    # Do not read the descriptor until a reviewed stage implementation needs
    # it.  Merely proving that the host adapter supplied a bounded regular file
    # avoids copying secret material into this process' heap or job state.


def validate_request(request: Dict[str, Any], contract: Dict[str, Any]) -> Dict[str, Any]:
    exact_keys(request, {"schema", "ip", "contract_sha256", "action"}, "request")
    if request.get("schema") != 1:
        raise ExecutorError("request-schema-invalid")
    try:
        ip = ipaddress.IPv4Address(request.get("ip"))
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ExecutorError("request-ip-invalid") from exc
    if not ip.is_global:
        raise ExecutorError("request-ip-must-be-public")
    if request.get("contract_sha256") != contract_digest(contract):
        raise ExecutorError("request-contract-mismatch")
    action = request.get("action")
    if not isinstance(action, dict):
        raise ExecutorError("request-action-required")
    exact_keys(action, {"stage", "component", "executor_id", "operation_id", "reason"}, "action")
    executor_id = action.get("executor_id")
    capability = STAGE_CAPABILITIES.get(executor_id)
    if capability is None:
        raise ExecutorError("action-executor-not-allowed")
    stage, component, _enabled, _reason = capability
    if action.get("stage") != stage or action.get("component") != component:
        raise ExecutorError("action-contract-mismatch")
    if not isinstance(action.get("operation_id"), str) or not SAFE_OPERATION_ID.fullmatch(action["operation_id"]):
        raise ExecutorError("action-operation-id-invalid")
    if not isinstance(action.get("reason"), str) or not SAFE_CODE.fullmatch(action["reason"]):
        raise ExecutorError("action-reason-invalid")
    return action


def atomic_json(path: Path, value: Dict[str, Any]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".executor-result-", dir=str(path.parent))
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(canonical(value) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def terminal_result(action: Dict[str, Any]) -> Dict[str, Any]:
    _stage, _component, enabled, _capability_reason = STAGE_CAPABILITIES[action["executor_id"]]
    if enabled:
        # An enabled capability must have an explicit implementation branch.
        # This invariant prevents a metadata-only edit from claiming success.
        raise ExecutorError("enabled-stage-handler-missing")
    return {"schema": 1, "outcome": "blocked", "reason_code": "dependency-unavailable"}


def validate_existing_result(value: Dict[str, Any]) -> Dict[str, Any]:
    exact_keys(value, {"schema", "outcome", "reason_code"}, "job-result")
    if value != {"schema": 1, "outcome": "blocked", "reason_code": "dependency-unavailable"}:
        raise ExecutorError("job-result-conflict")
    return value


def run_worker() -> int:
    if len(sys.argv) != 1:
        raise ExecutorError("arguments-forbidden")
    contract = load_contract()
    request_path = safe_regular_file(
        os.environ.get("FLEET_ONBOARD_JOB_REQUEST_FILE", ""),
        "job-request-file",
        max_bytes=MAX_BYTES,
    )
    result_path = safe_result_path(
        os.environ.get("FLEET_ONBOARD_JOB_RESULT_FILE", ""), request_path
    )
    validate_credential_descriptor()
    request = load_json(request_path, "job-request")
    action = validate_request(request, contract)
    request_sha256 = hashlib.sha256(canonical(request).encode("utf-8")).hexdigest()

    lock_path = request_path.parent / "executor.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        receipt_path = request_path.parent / "executor-receipt.json"
        if result_path.exists():
            validate_existing_result(load_json(result_path, "job-result"))
            receipt = load_json(
                safe_regular_file(str(receipt_path), "executor-receipt", max_bytes=MAX_BYTES),
                "executor-receipt",
            )
            if receipt.get("request_sha256") != request_sha256:
                raise ExecutorError("operation-id-collision")
            return 0

        result = terminal_result(action)
        capability_reason = STAGE_CAPABILITIES[action["executor_id"]][3]
        receipt = {
            "schema": 1,
            "operation_id": action["operation_id"],
            "executor_id": action["executor_id"],
            "request_sha256": request_sha256,
            "outcome": result["outcome"],
            "reason_code": result["reason_code"],
            "capability_reason": capability_reason,
        }
        atomic_json(receipt_path, receipt)
        atomic_json(result_path, result)
    return 0


def main() -> int:
    try:
        return run_worker()
    except ExecutorError as exc:
        # Stable identifiers only.  Never echo request data, paths or child
        # output because any of those may accidentally contain credentials.
        sys.stderr.write(canonical({"schema": 1, "ok": False, "error": str(exc)}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
