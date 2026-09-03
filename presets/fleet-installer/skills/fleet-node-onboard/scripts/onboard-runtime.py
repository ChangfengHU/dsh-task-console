#!/usr/bin/env python3
"""Deterministic Fleet onboarding assessor and executor-adapter driver.

This runtime never opens SSH or calls Fleet/Vault by itself.  It consumes a
strictly redacted inventory and emits fixed executor IDs.  ``apply`` may invoke
one operator-supplied executable (without a shell); that adapter is responsible
for the production transport and must return a newly observed redacted
inventory over JSON stdin/stdout.
"""

import argparse
import datetime
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any, Dict, Iterable, List, Optional


HERE = Path(__file__).resolve().parent
SKILL_ROOT = HERE.parent
CONTRACT_PATH = SKILL_ROOT / "component-contract.json"
STAGE_GATE = HERE / "stage-gate.sh"
MAX_JSON_BYTES = 1024 * 1024
SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
SAFE_UNIT = re.compile(r"^[A-Za-z0-9_.@:-]+\.service$")
SAFE_NODE_ID = re.compile(r"^host-[0-9]+(?:-[0-9]+){3}$")
SAFE_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
SAFE_LINE_ID = re.compile(r"^line-[1-9][0-9]{0,3}$")
SENSITIVE_TEXT = (
    re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----", re.I),
    re.compile(r"\bauthorization\s*[:=]\s*bearer\s+\S+", re.I),
    re.compile(r"https?://[^\s/:]+:[^@\s]+@", re.I),
    re.compile(r"[?&](?:token|key|secret|password|signature)=", re.I),
    re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b"),
)
FORBIDDEN_KEYS = {
    "authorization",
    "bootstrap_key",
    "config_url",
    "cookie",
    "password",
    "passwd",
    "private_key",
    "proxy_url",
    "secret",
    "source_url",
    "token",
}


class RuntimeContractError(ValueError):
    """A stable, non-secret validation or state error."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_contract() -> Dict[str, Any]:
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if contract.get("schema") != 1 or len(contract.get("stages", [])) != 10:
        raise RuntimeContractError("invalid-component-contract")
    numbers = [item.get("stage") for item in contract["stages"]]
    if numbers != list(range(1, 11)):
        raise RuntimeContractError("component-contract-stage-order-invalid")
    modes = [item.get("execution_mode") for item in contract["stages"]]
    if any(mode not in {"probe-gate", "reconcile"} for mode in modes):
        raise RuntimeContractError("component-contract-execution-mode-invalid")
    return contract


def contract_digest(contract: Dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(contract).encode("utf-8")).hexdigest()


def load_json_source(path: Path) -> Dict[str, Any]:
    try:
        if str(path) == "-":
            raw = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
            if len(raw) > MAX_JSON_BYTES:
                raise RuntimeContractError("inventory-too-large")
            text = raw.decode("utf-8")
        else:
            size = path.stat().st_size
            if size > MAX_JSON_BYTES:
                raise RuntimeContractError("inventory-too-large")
            text = path.read_text(encoding="utf-8")
        value = json.loads(text)
    except RuntimeContractError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeContractError("inventory-invalid-json") from exc
    if not isinstance(value, dict):
        raise RuntimeContractError("inventory-must-be-object")
    return value


def reject_sensitive(value: Any, path: str = "inventory") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in FORBIDDEN_KEYS:
                raise RuntimeContractError(f"secret-field-forbidden:{path}.{key}")
            reject_sensitive(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_sensitive(child, f"{path}[{index}]")
    elif isinstance(value, str):
        if any(pattern.search(value) for pattern in SENSITIVE_TEXT):
            raise RuntimeContractError(f"secret-value-forbidden:{path}")


def require_exact_keys(value: Dict[str, Any], allowed: Iterable[str], path: str) -> None:
    unknown = set(value) - set(allowed)
    if unknown:
        raise RuntimeContractError(f"unknown-field:{path}.{sorted(unknown)[0]}")


def require_bool(value: Dict[str, Any], key: str, path: str) -> None:
    if key in value and not isinstance(value[key], bool):
        raise RuntimeContractError(f"field-must-be-boolean:{path}.{key}")


def public_ipv4(value: str) -> bool:
    try:
        parsed = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        return False
    if str(parsed) != value:
        return False
    first, second, third, _fourth = (int(part) for part in value.split("."))
    return not (
        first in {0, 10, 127}
        or first >= 224
        or (first == 100 and 64 <= second <= 127)
        or (first == 169 and second == 254)
        or (first == 172 and 16 <= second <= 31)
        or (first == 192 and second == 168)
        or (first == 192 and second == 0 and third in {0, 2})
        or (first == 192 and second == 88 and third == 99)
        or (first == 198 and second in {18, 19})
        or (first == 198 and second == 51 and third == 100)
        or (first == 203 and second == 0 and third == 113)
    )


def validate_fact(value: Any, specification: Dict[str, Any], path: str) -> None:
    if not isinstance(specification, dict):
        raise RuntimeContractError(f"component-contract-fact-invalid:{path}")
    require_exact_keys(specification, {"type", "nullable"}, f"component-contract.{path}")
    if not isinstance(specification.get("nullable"), bool):
        raise RuntimeContractError(f"component-contract-fact-nullable-invalid:{path}")
    if value is None and specification["nullable"] is True:
        return
    if not isinstance(value, str):
        raise RuntimeContractError(f"component-fact-must-be-string:{path}")
    kind = specification.get("type")
    if kind == "line-id":
        if not SAFE_LINE_ID.fullmatch(value):
            raise RuntimeContractError(f"component-fact-line-id-invalid:{path}")
        return
    if kind == "public-ipv4":
        try:
            parsed = ipaddress.IPv4Address(value)
        except ipaddress.AddressValueError as exc:
            raise RuntimeContractError(f"component-fact-ipv4-invalid:{path}") from exc
        if str(parsed) != value:
            raise RuntimeContractError(f"component-fact-ipv4-noncanonical:{path}")
        if not public_ipv4(value):
            raise RuntimeContractError(f"component-fact-ipv4-not-public:{path}")
        return
    raise RuntimeContractError(f"component-contract-fact-type-invalid:{path}")


def inventory_hmac_key() -> bytes:
    key_file = os.environ.get("FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE")
    if key_file:
        path = Path(key_file)
        if not path.is_absolute():
            raise RuntimeContractError("inventory-attestation-key-file-unsafe")
        try:
            descriptor = os.open(
                path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
            )
            metadata = os.fstat(descriptor)
        except OSError as exc:
            raise RuntimeContractError("inventory-attestation-key-file-unreadable") from exc
        try:
            groups = set(os.getgroups()) | {os.getegid()}
            owner_private = metadata.st_uid == os.geteuid() and metadata.st_mode & 0o077 == 0
            root_group_readonly = (metadata.st_uid == 0 and metadata.st_gid in groups
                                   and metadata.st_mode & 0o040 and metadata.st_mode & 0o027 == 0)
            if not stat.S_ISREG(metadata.st_mode) or not (owner_private or root_group_readonly):
                raise RuntimeContractError("inventory-attestation-key-file-unsafe")
            if not 32 <= metadata.st_size <= 4096:
                raise RuntimeContractError("inventory-attestation-key-file-size-invalid")
            key = os.read(descriptor, 4097).rstrip(b"\r\n")
        finally:
            os.close(descriptor)
    elif os.environ.get("FLEET_ONBOARD_ALLOW_ENV_HMAC_KEY") == "1":
        key = os.environ.get("FLEET_ONBOARD_INVENTORY_HMAC_KEY", "").encode("utf-8")
    else:
        raise RuntimeContractError("inventory-attestation-key-file-required")
    if not re.fullmatch(rb"[0-9a-f]{64}", key):
        raise RuntimeContractError("inventory-attestation-key-format-invalid")
    return key


def validate_inventory(raw: Dict[str, Any], contract: Dict[str, Any]) -> Dict[str, Any]:
    reject_sensitive(raw)
    require_exact_keys(raw, {"schema", "ip", "provenance", "desired", "fleet", "credentials", "components"}, "inventory")
    if raw.get("schema") != 1:
        raise RuntimeContractError("inventory-schema-must-be-1")
    try:
        ipaddress.IPv4Address(raw.get("ip", ""))
    except ipaddress.AddressValueError as exc:
        raise RuntimeContractError("inventory-ip-invalid") from exc
    provenance = raw.get("provenance")
    if not isinstance(provenance, dict):
        raise RuntimeContractError("inventory-provenance-required")
    require_exact_keys(
        provenance,
        {"origin", "executor_id", "observed_at", "target_fingerprint", "contract_sha256", "attestation"},
        "inventory.provenance",
    )
    protocol = contract["inventory_protocol"]
    test_fixture = (provenance.get("origin") == "test-fixture-v1"
                    and os.environ.get("FLEET_ONBOARD_ALLOW_TEST_FIXTURES") == "1")
    if provenance.get("origin") != protocol["origin"] and not test_fixture:
        raise RuntimeContractError("inventory-origin-untrusted")
    if provenance.get("executor_id") != protocol["executor_id"]:
        raise RuntimeContractError("inventory-probe-executor-invalid")
    if not isinstance(provenance.get("target_fingerprint"), str) or not SAFE_FINGERPRINT.fullmatch(provenance["target_fingerprint"]):
        raise RuntimeContractError("inventory-target-fingerprint-invalid")
    expected_digest = contract_digest(contract)
    if provenance.get("contract_sha256") != expected_digest:
        raise RuntimeContractError("inventory-contract-digest-mismatch")
    attestation = provenance.get("attestation")
    if test_fixture:
        if attestation != "test-only":
            raise RuntimeContractError("test-inventory-attestation-invalid")
    else:
        if not isinstance(attestation, str) or not re.fullmatch(r"hmac-sha256:[0-9a-f]{64}", attestation):
            raise RuntimeContractError("inventory-attestation-invalid")
        key = inventory_hmac_key()
        unsigned = json.loads(canonical_json(raw))
        unsigned["provenance"].pop("attestation", None)
        expected = hmac.new(key, canonical_json(unsigned).encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(attestation, "hmac-sha256:" + expected):
            raise RuntimeContractError("inventory-attestation-mismatch")
    observed_at = provenance.get("observed_at")
    if not isinstance(observed_at, str) or len(observed_at) > 64:
        raise RuntimeContractError("inventory-observed-at-invalid")
    try:
        observed = datetime.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeContractError("inventory-observed-at-invalid") from exc
    if observed.tzinfo is None:
        raise RuntimeContractError("inventory-observed-at-requires-timezone")
    age = (datetime.datetime.now(datetime.timezone.utc) - observed.astimezone(datetime.timezone.utc)).total_seconds()
    if age < -60 or age > int(protocol["max_age_seconds"]):
        raise RuntimeContractError("inventory-observation-stale")

    desired = raw.get("desired")
    if not isinstance(desired, dict):
        raise RuntimeContractError("inventory-desired-required")
    require_exact_keys(desired, {"line", "browser_count", "profile"}, "inventory.desired")
    if desired.get("line") != contract["default_line"]:
        raise RuntimeContractError("inventory-desired-line-must-be-line-100")
    if desired.get("browser_count") not in {1, 2}:
        raise RuntimeContractError("inventory-browser-count-must-be-1-or-2")
    if desired.get("profile") not in {"base", "image-worker"}:
        raise RuntimeContractError("inventory-profile-invalid")

    fleet = raw.get("fleet", {})
    if not isinstance(fleet, dict):
        raise RuntimeContractError("inventory-fleet-must-be-object")
    require_exact_keys(fleet, {"registered", "reachable", "node_id"}, "inventory.fleet")
    require_bool(fleet, "registered", "inventory.fleet")
    require_bool(fleet, "reachable", "inventory.fleet")
    expected_node_id = f"host-{raw['ip'].replace('.', '-')}"
    if "node_id" in fleet and (not isinstance(fleet["node_id"], str) or not SAFE_NODE_ID.fullmatch(fleet["node_id"])):
        raise RuntimeContractError("inventory-fleet-node-id-invalid")
    if "node_id" in fleet and fleet["node_id"] != expected_node_id:
        raise RuntimeContractError("inventory-fleet-node-id-mismatch")
    if fleet.get("registered") is True and fleet.get("node_id") != expected_node_id:
        raise RuntimeContractError("inventory-registered-node-id-required")

    credentials = raw.get("credentials", {})
    if not isinstance(credentials, dict):
        raise RuntimeContractError("inventory-credentials-must-be-object")
    require_exact_keys(credentials, {"available", "source"}, "inventory.credentials")
    require_bool(credentials, "available", "inventory.credentials")
    if credentials.get("source", "none") not in {"none", "intake", "vault", "managed-account"}:
        raise RuntimeContractError("inventory-credentials-source-invalid")
    if credentials.get("available") is True and credentials.get("source") == "none":
        raise RuntimeContractError("inventory-credential-source-required")
    if credentials.get("available") is False and credentials.get("source", "none") != "none":
        raise RuntimeContractError("inventory-unavailable-credential-source-must-be-none")

    components = raw.get("components", {})
    if not isinstance(components, dict):
        raise RuntimeContractError("inventory-components-must-be-object")
    known = {item["id"]: item for item in contract["stages"]}
    unknown_components = set(components) - set(known)
    if unknown_components:
        raise RuntimeContractError(f"inventory-component-unknown:{sorted(unknown_components)[0]}")
    for component_id, value in components.items():
        path = f"inventory.components.{component_id}"
        if not isinstance(value, dict):
            raise RuntimeContractError(f"component-must-be-object:{component_id}")
        require_exact_keys(value, {"present", "healthy", "conflict", "fatal", "reason_code", "units", "checks", "facts"}, path)
        for key in ("present", "healthy", "conflict", "fatal"):
            require_bool(value, key, path)
        if "reason_code" in value and (not isinstance(value["reason_code"], str) or not SAFE_CODE.fullmatch(value["reason_code"])):
            raise RuntimeContractError(f"component-reason-code-invalid:{component_id}")
        units = value.get("units", {})
        if not isinstance(units, dict):
            raise RuntimeContractError(f"component-units-must-be-object:{component_id}")
        for unit, unit_state in units.items():
            if not isinstance(unit, str) or not SAFE_UNIT.fullmatch(unit):
                raise RuntimeContractError(f"component-unit-name-invalid:{component_id}")
            if not isinstance(unit_state, dict):
                raise RuntimeContractError(f"component-unit-state-must-be-object:{component_id}")
            require_exact_keys(unit_state, {"exists", "active", "enabled"}, f"{path}.units.{unit}")
            for key in ("exists", "active", "enabled"):
                require_bool(unit_state, key, f"{path}.units.{unit}")
        checks = value.get("checks", {})
        if not isinstance(checks, dict):
            raise RuntimeContractError(f"component-checks-must-be-object:{component_id}")
        expected_checks = set(known[component_id].get("required_checks", []))
        for check, result in checks.items():
            if check not in expected_checks:
                raise RuntimeContractError(f"component-check-unknown:{component_id}.{check}")
            if not isinstance(result, bool):
                raise RuntimeContractError(f"component-check-must-be-boolean:{component_id}.{check}")
        facts = value.get("facts", {})
        if not isinstance(facts, dict):
            raise RuntimeContractError(f"component-facts-must-be-object:{component_id}")
        allowed_facts = known[component_id].get("allowed_facts", {})
        if not isinstance(allowed_facts, dict):
            raise RuntimeContractError(f"component-contract-facts-invalid:{component_id}")
        unknown_facts = set(facts) - set(allowed_facts)
        if unknown_facts:
            raise RuntimeContractError(f"component-fact-unknown:{component_id}.{sorted(unknown_facts)[0]}")
        missing_facts = set(allowed_facts) - set(facts)
        if value and missing_facts:
            raise RuntimeContractError(f"component-fact-missing:{component_id}.{sorted(missing_facts)[0]}")
        for fact, result in facts.items():
            validate_fact(result, allowed_facts[fact], f"{component_id}.{fact}")
    return raw


def component_present(value: Dict[str, Any]) -> bool:
    if value.get("present") is True:
        return True
    return any(unit.get("exists") is True for unit in value.get("units", {}).values())


def classify_component(stage: Dict[str, Any], inventory: Dict[str, Any]) -> Dict[str, Any]:
    component_id = stage["id"]
    supplied = component_id in inventory.get("components", {})
    value = dict(inventory.get("components", {}).get(component_id, {}))
    fleet = inventory.get("fleet", {})
    credentials_available = inventory.get("credentials", {}).get("available") is True

    # Fleet read-back is already a typed control-plane observation, so stage 10
    # can use it directly when the component entry is omitted.
    if not supplied and component_id == "fleet-registration" and fleet.get("registered") is True:
        value = {
            "present": True,
            "healthy": fleet.get("reachable") is True,
            "checks": {
                "registered": True,
                "readback": True,
                "reachable": fleet.get("reachable") is True,
            },
        }

    units = value.get("units", {})
    missing_units: List[str] = []
    unhealthy_units: List[str] = []
    required_units = list(stage.get("required_units", []))
    template = stage.get("required_unit_template")
    if template:
        count = inventory["desired"]["browser_count"]
        required_units.extend(template["format"].format(index=index) for index in range(1, count + 1))
    for unit in required_units:
        observed = units.get(unit, {})
        if observed.get("exists") is not True:
            missing_units.append(unit)
        elif observed.get("active") is not True or observed.get("enabled") is not True:
            unhealthy_units.append(unit)

    checks = value.get("checks", {})
    failed_checks = [name for name in stage.get("required_checks", []) if checks.get(name) is not True]
    facts = value.get("facts", {})
    failed_facts: List[str] = []
    if stage.get("allowed_facts"):
        desired_line = facts.get("desiredLine")
        actual_line = facts.get("actualLine")
        tcp_exit = facts.get("tcpExit")
        udp_exit = facts.get("udpExit")
        if desired_line != inventory["desired"]["line"]:
            failed_facts.append("desiredLine")
        if not actual_line or actual_line != desired_line:
            failed_facts.append("actualLine")
        if not tcp_exit:
            failed_facts.append("tcpExit")
        if not udp_exit or udp_exit != tcp_exit:
            failed_facts.append("udpExit")
    present = component_present(value)
    if component_id == "fleet-registration" and fleet.get("registered") is True:
        present = True

    if value.get("fatal") is True:
        health, disposition = "blocked", "fatal"
        reason = value.get("reason_code", "fatal-policy-boundary")
    elif value.get("conflict") is True:
        health, disposition = "blocked", "needs-user"
        reason = value.get("reason_code", "target-policy-conflict")
    elif missing_units or not present:
        health = "missing"
        if stage.get("execution_mode") == "probe-gate":
            disposition, reason = "needs-user", "probe-gate-not-satisfied"
        else:
            disposition, reason = "repairable", "component-missing"
    elif unhealthy_units or failed_checks or failed_facts or value.get("healthy") is not True:
        health = "drifted"
        if stage.get("execution_mode") == "probe-gate":
            disposition = "needs-user"
            reason = value.get("reason_code", "probe-gate-not-satisfied")
        else:
            disposition = "repairable"
            reason = value.get("reason_code", "component-drifted")
    else:
        health, disposition = "healthy", "reusable"
        reason = "verified-healthy"

    if health != "healthy" and stage.get("credential_gate") is True and not credentials_available:
        health, disposition, reason = "blocked", "needs-user", "first-login-credential-required"

    result: Dict[str, Any] = {
        "stage": stage["stage"],
        "component": component_id,
        "health": health,
        "disposition": disposition,
        "reason": reason,
    }
    if missing_units:
        result["missing_units"] = missing_units
    if unhealthy_units:
        result["unhealthy_units"] = unhealthy_units
    if failed_checks:
        result["failed_checks"] = failed_checks
    if failed_facts:
        result["failed_facts"] = failed_facts
    return result


def state_path(state_dir: Path, ip: str) -> Path:
    return state_dir / f"{ip.replace('.', '-')}.json"


def read_state(state_dir: Path, ip: str) -> Optional[Dict[str, Any]]:
    path = state_path(state_dir, ip)
    if not path.is_file():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeContractError("transaction-state-invalid") from exc
    if state.get("ip") != ip:
        raise RuntimeContractError("transaction-state-ip-mismatch")
    return state


def ensure_target_binding(state: Optional[Dict[str, Any]], inventory: Dict[str, Any], contract: Dict[str, Any]) -> None:
    if state is None:
        return
    expected = (state.get("facts") or {}).get("target_fingerprint")
    actual = inventory["provenance"]["target_fingerprint"]
    if not expected:
        raise RuntimeContractError("transaction-target-fingerprint-missing:explicit-re-adopt-required")
    if expected != actual:
        raise RuntimeContractError("transaction-target-fingerprint-mismatch:possible-ip-reuse")
    expected_contract = (state.get("facts") or {}).get("contract_sha256")
    if not expected_contract:
        raise RuntimeContractError("transaction-contract-binding-missing:explicit-re-adopt-required")
    if expected_contract != contract_digest(contract):
        raise RuntimeContractError("transaction-contract-changed:explicit-reassessment-required")


def is_existing_node(inventory: Dict[str, Any]) -> bool:
    if inventory.get("fleet", {}).get("registered") is True:
        return True
    # Reachability, resource inspection and acceptance probes exist even on a
    # completely bare host. Only durable managed components prove adoption.
    durable = {
        "standard-account", "vault-login", "mihomo", "clash-control-plane",
        "browser-vnc", "cloudflare-publication", "fleet-registration",
    }
    components = inventory.get("components", {})
    return any(component_present(components.get(name, {})) for name in durable)


def operation_id(
    inventory: Dict[str, Any],
    stage: Dict[str, Any],
    contract: Dict[str, Any],
    state: Optional[Dict[str, Any]],
) -> str:
    material = ":".join((
        inventory["ip"],
        inventory["provenance"]["target_fingerprint"],
        str(stage["stage"]),
        stage["executor_id"],
        contract_digest(contract),
        str((state or {}).get("transaction_id", "unstarted")),
        str((state or {}).get("operation_generation", 0)),
    ))
    return "onboard-" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


def assess(inventory: Dict[str, Any], contract: Dict[str, Any], state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ensure_target_binding(state, inventory, contract)
    components = [classify_component(stage, inventory) for stage in contract["stages"]]
    first_issue = next((item for item in components if item["health"] != "healthy"), None)
    if state is None:
        mode = "adopt" if is_existing_node(inventory) else "new"
    elif state.get("phase") == "complete":
        mode = "verify-only" if first_issue is None else "repair"
    else:
        mode = "resume"

    if first_issue is None:
        phase = "complete"
    elif first_issue["disposition"] in {"needs-user", "fatal"}:
        if state is None and first_issue["reason"] == "first-login-credential-required":
            phase = "intake"
        else:
            phase = "blocked"
    else:
        phase = "planned"

    actions: List[Dict[str, Any]] = []
    blocker: Optional[Dict[str, Any]] = None
    if first_issue is not None and first_issue["disposition"] == "repairable":
        stage = contract["stages"][first_issue["stage"] - 1]
        actions.append({
            "stage": first_issue["stage"],
            "component": first_issue["component"],
            "executor_id": stage["executor_id"],
            "operation_id": operation_id(inventory, stage, contract, state),
            "reason": first_issue["reason"],
        })
    elif first_issue is not None:
        blocker = {
            "stage": first_issue["stage"],
            "component": first_issue["component"],
            "disposition": first_issue["disposition"],
            "reason": first_issue["reason"],
        }

    counts = {name: sum(item["health"] == name for item in components)
              for name in contract["health_states"]}
    return {
        "schema": 1,
        "ok": True,
        "ip": inventory["ip"],
        "mode": mode,
        "run_kind": state.get("run_kind") if state else mode,
        "phase": phase,
        "next_stage": first_issue["stage"] if first_issue else None,
        "changed": False,
        "state_changed": False,
        "execution_available": False,
        "adapter_required": bool(actions),
        "contract_sha256": contract_digest(contract),
        "summary": counts,
        "components": components,
        "actions": actions,
        "blocker": blocker,
    }


def gate_call(state_dir: Path, ip: str, *arguments: str) -> Dict[str, Any]:
    env = dict(os.environ)
    env["FLEET_ONBOARD_STATE_DIR"] = str(state_dir)
    result = subprocess.run(
        [str(STAGE_GATE), arguments[0], ip, *arguments[1:]],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        # stage-gate diagnostics are fixed identifiers.  Never surface command
        # output from an executor here.
        detail = result.stderr.strip().splitlines()[0][:160] if result.stderr.strip() else "no-detail"
        raise RuntimeContractError(f"stage-gate-failed:{result.returncode}:{detail}")
    if not result.stdout.strip():
        return {}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeContractError("stage-gate-returned-invalid-json") from exc


def contiguous_healthy(assessment: Dict[str, Any]) -> int:
    through = 0
    for item in assessment["components"]:
        if item["health"] != "healthy":
            break
        through = item["stage"]
    return through


def sync_observed_state(state_dir: Path, inventory: Dict[str, Any], assessment: Dict[str, Any]) -> bool:
    ip = inventory["ip"]
    state = read_state(state_dir, ip)
    if state is None:
        return False
    changed = False
    current = int(state.get("current", 0))
    by_stage = {item["stage"]: item for item in assessment["components"]}
    while current < 10 and by_stage[current + 1]["health"] == "healthy":
        item = by_stage[current + 1]
        gate_call(state_dir, ip, "observed", str(current + 1),
                  inventory["provenance"]["observed_at"], item["component"])
        current += 1
        changed = True
    if current == 10:
        latest = read_state(state_dir, ip)
        if latest and latest.get("phase") != "complete":
            gate_call(state_dir, ip, "complete")
            changed = True
        return changed

    issue = by_stage[current + 1]
    if issue["disposition"] in {"needs-user", "fatal"}:
        latest = read_state(state_dir, ip) or {}
        prior = (latest.get("stages") or {}).get(str(current + 1), {})
        if prior.get("status") != "block" or prior.get("note") != issue["reason"]:
            gate_call(state_dir, ip, "block", str(current + 1), issue["reason"])
            changed = True
    return changed


def start_transaction(state_dir: Path, inventory: Dict[str, Any], contract: Dict[str, Any]) -> Dict[str, Any]:
    ip = inventory["ip"]
    existing = read_state(state_dir, ip)
    initial = assess(inventory, contract, existing)
    if existing is not None:
        if existing.get("phase") != "complete":
            raise RuntimeContractError("transaction-incomplete:use-resume")
        if initial["phase"] == "complete":
            initial["mode"] = "verify-only"
            initial["run_kind"] = "verify-only"
            return initial
        gate_call(state_dir, ip, "observe", "fail", "structured-inventory-drift")
        gate_call(state_dir, ip, "reconcile", str(initial["next_stage"]), "structured-inventory-drift")
        result = assess(inventory, contract, read_state(state_dir, ip))
        sync_observed_state(state_dir, inventory, result)
        result = assess(inventory, contract, read_state(state_dir, ip))
        result["mode"] = "repair"
        result["run_kind"] = "repair"
        result["state_changed"] = True
        return result

    # Missing first-login data is conversational intake, not a transaction.
    if initial["phase"] == "intake":
        return initial
    if initial["mode"] == "adopt":
        through = contiguous_healthy(initial)
        gate_call(state_dir, ip, "adopt", str(through), "structured-inventory-adoption",
                  inventory["provenance"]["observed_at"],
                  inventory["provenance"]["target_fingerprint"], contract_digest(contract))
    else:
        gate_call(state_dir, ip, "begin", inventory["provenance"]["target_fingerprint"],
                  contract_digest(contract))
    state_changed = True
    state_changed = sync_observed_state(state_dir, inventory, initial) or state_changed
    result = assess(inventory, contract, read_state(state_dir, ip))
    result["mode"] = initial["mode"]
    result["run_kind"] = (read_state(state_dir, ip) or {}).get("run_kind", initial["mode"])
    result["state_changed"] = state_changed
    return result


def resume_transaction(state_dir: Path, inventory: Dict[str, Any], contract: Dict[str, Any]) -> Dict[str, Any]:
    ip = inventory["ip"]
    state = read_state(state_dir, ip)
    if state is None:
        raise RuntimeContractError("transaction-not-started:use-start")
    ensure_target_binding(state, inventory, contract)
    if state.get("phase") == "complete":
        return start_transaction(state_dir, inventory, contract)
    gate_call(state_dir, ip, "resume", "structured-inventory-resume")
    current = assess(inventory, contract, read_state(state_dir, ip))
    sync_observed_state(state_dir, inventory, current)
    result = assess(inventory, contract, read_state(state_dir, ip))
    result["mode"] = "resume"
    result["state_changed"] = True
    return result


def validate_executor(path_text: str) -> Path:
    path = Path(path_text)
    if not path.is_absolute():
        raise RuntimeContractError("executor-path-must-be-absolute")
    resolved = path.resolve()
    if not resolved.is_file() or not os.access(str(resolved), os.X_OK):
        raise RuntimeContractError("executor-not-executable")
    return resolved


def call_executor(executor: Path, request: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    try:
        result = subprocess.run(
            [str(executor)],
            input=canonical_json(request) + "\n",
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeContractError("executor-timeout") from exc
    if result.returncode != 0:
        # stderr is deliberately discarded because a production transport may
        # accidentally emit credentials there.
        raise RuntimeContractError(f"executor-exit-nonzero:{result.returncode}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1 or len(lines[0].encode("utf-8")) > MAX_JSON_BYTES:
        raise RuntimeContractError("executor-response-must-be-one-json-line")
    try:
        response = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise RuntimeContractError("executor-response-invalid-json") from exc
    if not isinstance(response, dict):
        raise RuntimeContractError("executor-response-must-be-object")
    reject_sensitive(response, "executor-response")
    require_exact_keys(
        response,
        {"schema", "executor_id", "operation_id", "outcome", "classification", "disposition", "reason_code", "inventory"},
        "executor-response",
    )
    if response.get("schema") != 1:
        raise RuntimeContractError("executor-response-schema-invalid")
    if response.get("executor_id") != request["action"]["executor_id"]:
        raise RuntimeContractError("executor-response-id-mismatch")
    if response.get("operation_id") != request["action"]["operation_id"]:
        raise RuntimeContractError("executor-response-operation-id-mismatch")
    if response.get("outcome") not in {"succeeded", "noop", "blocked", "failed"}:
        raise RuntimeContractError("executor-response-outcome-invalid")
    if response.get("classification") not in {"healthy", "drifted", "missing", "blocked"}:
        raise RuntimeContractError("executor-response-classification-invalid")
    if response.get("disposition") not in {"reusable", "repairable", "needs-user", "fatal"}:
        raise RuntimeContractError("executor-response-disposition-invalid")
    required_terminal = {
        "succeeded": ("healthy", "reusable"),
        "noop": ("healthy", "reusable"),
        "blocked": ("blocked", "needs-user"),
        "failed": ("blocked", "fatal"),
    }[response["outcome"]]
    if (response["classification"], response["disposition"]) != required_terminal:
        raise RuntimeContractError("executor-response-outcome-inconsistent")
    reason = response.get("reason_code", "")
    if not isinstance(reason, str) or not SAFE_CODE.fullmatch(reason):
        raise RuntimeContractError("executor-response-reason-code-invalid")
    return response


def attest_executor_request(request: Dict[str, Any]) -> Dict[str, Any]:
    signed = json.loads(canonical_json(request))
    if os.environ.get("FLEET_ONBOARD_ALLOW_TEST_FIXTURES") == "1":
        signed["action_attestation"] = "test-only"
        return signed
    digest = hmac.new(
        inventory_hmac_key(), canonical_json(signed).encode("utf-8"), hashlib.sha256,
    ).hexdigest()
    signed["action_attestation"] = "hmac-sha256:" + digest
    return signed


def atomic_write_inventory(path: Path, inventory: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".inventory-", dir=str(path.parent), text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(inventory, ensure_ascii=False, indent=2, sort_keys=True))
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_actions(
    state_dir: Path,
    inventory: Dict[str, Any],
    contract: Dict[str, Any],
    executor: Path,
    inventory_out: Optional[Path],
    timeout: int,
    max_actions: int,
) -> Dict[str, Any]:
    ip = inventory["ip"]
    if read_state(state_dir, ip) is None:
        current = start_transaction(state_dir, inventory, contract)
    else:
        current = resume_transaction(state_dir, inventory, contract)
    executions: List[Dict[str, Any]] = []
    target_changed = False
    terminal_blocker: Optional[Dict[str, Any]] = None

    for _ in range(max_actions):
        sync_observed_state(state_dir, inventory, current)
        current = assess(inventory, contract, read_state(state_dir, ip))
        if current["phase"] in {"complete", "intake", "blocked"} or not current["actions"]:
            break
        action = current["actions"][0]
        request = attest_executor_request({
            "schema": 1,
            "ip": ip,
            "contract_sha256": contract_digest(contract),
            "action": action,
            "inventory": inventory,
        })
        gate_call(state_dir, ip, "running", str(action["stage"]), action["executor_id"])
        try:
            response = call_executor(executor, request, timeout)
        except RuntimeContractError:
            gate_call(state_dir, ip, "block", str(action["stage"]), "executor-transport-failed")
            raise
        execution = {
            "stage": action["stage"],
            "component": action["component"],
            "executor_id": action["executor_id"],
            "operation_id": action["operation_id"],
            "outcome": response["outcome"],
            "classification": response["classification"],
            "disposition": response["disposition"],
            "reason": response["reason_code"],
        }
        executions.append(execution)
        if response["outcome"] in {"blocked", "failed"}:
            state = read_state(state_dir, ip) or {}
            next_stage = int(state.get("current", 0)) + 1
            if next_stage == action["stage"]:
                gate_call(state_dir, ip, "block", str(action["stage"]), response["reason_code"])
            terminal_blocker = {
                "stage": action["stage"],
                "component": action["component"],
                "disposition": response["disposition"],
                "reason": response["reason_code"],
            }
            break
        candidate = response.get("inventory")
        if not isinstance(candidate, dict):
            gate_call(state_dir, ip, "block", str(action["stage"]), "executor-success-missing-inventory")
            raise RuntimeContractError("executor-success-requires-inventory")
        try:
            inventory = validate_inventory(candidate, contract)
        except RuntimeContractError:
            gate_call(state_dir, ip, "block", str(action["stage"]), "executor-inventory-invalid")
            raise
        if inventory["ip"] != ip:
            raise RuntimeContractError("executor-inventory-ip-mismatch")
        verified = assess(inventory, contract, read_state(state_dir, ip))
        component = verified["components"][action["stage"] - 1]
        if component["health"] != "healthy":
            gate_call(state_dir, ip, "block", str(action["stage"]), "executor-result-not-healthy")
            raise RuntimeContractError("executor-result-not-healthy")
        if response["outcome"] == "succeeded":
            target_changed = True
        if inventory_out is not None:
            atomic_write_inventory(inventory_out, inventory)
        current = verified

    result = assess(inventory, contract, read_state(state_dir, ip))
    result["changed"] = target_changed
    result["state_changed"] = True
    result["execution_available"] = True
    result["adapter_required"] = bool(result["actions"])
    result["executions"] = executions
    if terminal_blocker is not None:
        result["phase"] = "blocked"
        result["blocker"] = terminal_blocker
        result["actions"] = []
        result["adapter_required"] = False
    if len(executions) >= max_actions and result["actions"]:
        result["phase"] = "planned"
        result["limit_reached"] = True
    return result


def default_state_dir() -> Path:
    base = os.environ.get("FLEET_ONBOARD_STATE_DIR")
    if base:
        return Path(base)
    xdg = os.environ.get("XDG_STATE_HOME")
    return Path(xdg) / "dsh-fleet-onboard" if xdg else Path.home() / ".local/state/dsh-fleet-onboard"


def add_inventory_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--state-dir", type=Path, default=default_state_dir())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic Fleet onboarding runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract")
    assess_parser = subparsers.add_parser("assess")
    add_inventory_arguments(assess_parser)
    start_parser = subparsers.add_parser("start")
    add_inventory_arguments(start_parser)
    resume_parser = subparsers.add_parser("resume")
    add_inventory_arguments(resume_parser)
    apply_parser = subparsers.add_parser("apply")
    add_inventory_arguments(apply_parser)
    apply_parser.add_argument("--executor", required=True)
    apply_parser.add_argument("--inventory-out", type=Path)
    apply_parser.add_argument("--executor-timeout", type=int, default=300)
    apply_parser.add_argument("--max-actions", type=int, default=10)
    for name in ("status", "report"):
        child = subparsers.add_parser(name)
        child.add_argument("--ip", required=True)
        child.add_argument("--state-dir", type=Path, default=default_state_dir())
    return parser


def emit(value: Dict[str, Any], stream: Any = sys.stdout) -> None:
    stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        contract = load_contract()
        if args.command == "contract":
            emit({"schema": 1, "ok": True, "contract_sha256": contract_digest(contract), "contract": contract})
            return 0
        if args.command in {"status", "report"}:
            try:
                ipaddress.IPv4Address(args.ip)
            except ipaddress.AddressValueError as exc:
                raise RuntimeContractError("ip-invalid") from exc
            state = read_state(args.state_dir, args.ip)
            if state is None:
                raise RuntimeContractError("transaction-not-started")
            if args.command == "status":
                emit({
                    "schema": 1,
                    "ok": True,
                    "ip": args.ip,
                    "phase": state.get("phase"),
                    "run_kind": state.get("run_kind"),
                    "current": state.get("current"),
                    "resume_count": state.get("resume_count", 0),
                    "changed": False,
                    "state": state,
                })
            else:
                env = dict(os.environ)
                env["FLEET_ONBOARD_STATE_DIR"] = str(args.state_dir)
                result = subprocess.run([str(STAGE_GATE), "report", args.ip], capture_output=True, text=True, env=env)
                if result.returncode != 0:
                    raise RuntimeContractError("report-unavailable")
                emit({"schema": 1, "ok": True, "ip": args.ip, "phase": state.get("phase"),
                      "run_kind": state.get("run_kind"), "changed": False, "markdown": result.stdout})
            return 0

        inventory = validate_inventory(load_json_source(args.inventory), contract)
        if args.command == "assess":
            emit(assess(inventory, contract, read_state(args.state_dir, inventory["ip"])))
        elif args.command == "start":
            emit(start_transaction(args.state_dir, inventory, contract))
        elif args.command == "resume":
            emit(resume_transaction(args.state_dir, inventory, contract))
        elif args.command == "apply":
            if not 1 <= args.max_actions <= 50:
                raise RuntimeContractError("max-actions-must-be-1..50")
            if not 1 <= args.executor_timeout <= 3600:
                raise RuntimeContractError("executor-timeout-must-be-1..3600")
            emit(apply_actions(args.state_dir, inventory, contract, validate_executor(args.executor),
                               args.inventory_out, args.executor_timeout, args.max_actions))
        return 0
    except RuntimeContractError as exc:
        emit({"schema": 1, "ok": False, "error": str(exc)}, sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
