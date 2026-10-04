#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: stage-gate.sh begin IP [TARGET_FINGERPRINT CONTRACT_SHA256]" >&2
  echo "       stage-gate.sh status|complete|reset|report IP" >&2
  echo "       stage-gate.sh adopt IP THROUGH_STAGE NOTE OBSERVED_AT TARGET_FINGERPRINT CONTRACT_SHA256" >&2
  echo "       stage-gate.sh resume IP NOTE" >&2
  echo "       stage-gate.sh observed IP STAGE OBSERVED_AT COMPONENT" >&2
  echo "       stage-gate.sh running|pass|block|reopen|reconcile IP STAGE NOTE" >&2
  echo "       stage-gate.sh fact IP KEY VALUE" >&2
  echo "       stage-gate.sh observe IP pass|fail NOTE" >&2
  echo "       stage-gate.sh run IP STAGE NOTE -- COMMAND [ARG...]" >&2
  echo "       stage-gate.sh verify IP NOTE -- COMMAND [ARG...]" >&2
  exit 64
}

action="${1:-}"; ip="${2:-}"
[[ -n "$action" && "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
python3 - "$ip" <<'PY' >/dev/null || { echo "invalid-ipv4: $ip" >&2; exit 64; }
import ipaddress, sys
ipaddress.IPv4Address(sys.argv[1])
PY

# State must survive logout, reboot and a different operator.
root="${FLEET_ONBOARD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dsh-fleet-onboard}"
mkdir -p "$root"; chmod 700 "$root"
state="$root/${ip//./-}.json"
report="$root/${ip//./-}.report.md"
lock="$state.lock"

# Preserve transactions made by older releases that stored state under /tmp.
legacy="${XDG_RUNTIME_DIR:-/tmp}/dsh-fleet-onboard-${UID}/${ip//./-}.json"
if [[ ! -e "$state" && -r "$legacy" ]]; then
  cp "$legacy" "$state"
  chmod 600 "$state"
fi

mutate() {
  local operation="$1" arg1="${2:-}" arg2="${3:-}" arg3="${4:-}" arg4="${5:-}" arg5="${6:-}"
  python3 - "$state" "$ip" "$operation" "$arg1" "$arg2" "$arg3" "$arg4" "$arg5" <<'PY'
import datetime, json, os, re, sys, tempfile, uuid
path, ip, op, arg1, arg2, arg3, arg4, arg5 = sys.argv[1:]

def now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def redact(value):
    text = str(value or "")[:500]
    text = re.sub(r"-----BEGIN [^-]+PRIVATE KEY-----.*", "[REDACTED]", text, flags=re.I | re.S)
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(password|passwd|token|secret|cookie|private[_-]?key)\b(\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)", r"\1\2[REDACTED]", text)
    text = re.sub(r"(?i)([?&](?:token|key|secret|password|signature)=)[^&#\s]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)(https?://[^\s:/]+:)[^@\s]+@", r"\1[REDACTED]@", text)
    return text[:240]

existed = os.path.exists(path)
if existed:
    with open(path, encoding="utf-8") as handle:
        state = json.load(handle)
else:
    created = now()
    state = {"schema": 3, "ip": ip, "current": 0, "phase": "new", "run_kind": "new",
             "created_at": created, "updated_at": created, "stages": {}, "facts": {},
             "verifications": [], "events": [], "resume_count": 0,
             "transaction_id": "run-" + uuid.uuid4().hex, "operation_generation": 0,
             "revision": 0}

# Upgrade old state in place.
state["schema"] = 3
state.setdefault("run_kind", "new")
state.setdefault("created_at", now())
state.setdefault("facts", {})
state.setdefault("verifications", [])
state.setdefault("events", [])
state.setdefault("resume_count", 0)
state.setdefault("transaction_id", "run-" + uuid.uuid4().hex)
state.setdefault("operation_generation", 0)
state.setdefault("revision", 0)
stamp = now()

def satisfied(stage):
    return state["stages"].get(str(stage), {}).get("status") in {"pass", "adopted"}

def validate_observed_at(value):
    try:
        observed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        raise SystemExit("observed-at-invalid")
    if observed.tzinfo is None:
        raise SystemExit("observed-at-requires-timezone")
    age = (datetime.datetime.now(datetime.timezone.utc) - observed.astimezone(datetime.timezone.utc)).total_seconds()
    if age < -60 or age > 600:
        raise SystemExit("observation-stale")

def validate_binding(fingerprint, digest):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", fingerprint):
        raise SystemExit("invalid-target-fingerprint")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise SystemExit("invalid-contract-digest")

def event(kind, note="", stage=None):
    item = {"at": stamp, "kind": kind}
    if stage is not None: item["stage"] = stage
    if note: item["note"] = redact(note)
    state["events"].append(item)
    state["events"] = state["events"][-100:]

if op == "begin":
    if state["phase"] == "complete":
        raise SystemExit("transaction-already-complete: use verify before reconcile")
    if state["phase"] == "blocked":
        raise SystemExit("transaction-blocked: use resume")
    state["phase"] = "running"
    state["last_operation"] = "start"
    if arg1 or arg2:
        validate_binding(arg1, arg2)
        state["facts"]["target_fingerprint"] = arg1
        state["facts"]["contract_sha256"] = arg2
    event("begin")
elif op == "adopt":
    through = int(arg1)
    if not 0 <= through <= 10:
        raise SystemExit("adopt-through-stage-must-be-0..10")
    if existed and (int(state.get("current", 0)) != 0 or state.get("phase") not in {"new"}):
        raise SystemExit("transaction-already-started: use resume")
    if through:
        validate_observed_at(arg3)
    validate_binding(arg4, arg5)
    state = {"schema": 3, "ip": ip, "current": through, "phase": "running", "run_kind": "adopt",
             "created_at": stamp, "updated_at": stamp, "stages": {},
             "facts": {"target_fingerprint": arg4, "contract_sha256": arg5},
             "verifications": [], "events": [], "resume_count": 0, "last_operation": "adopt",
             "transaction_id": "run-" + uuid.uuid4().hex, "operation_generation": 0,
             "revision": 0}
    note = redact(arg2)
    for stage in range(1, through + 1):
        state["stages"][str(stage)] = {"status": "adopted", "note": note,
                                         "started_at": stamp, "updated_at": stamp,
                                         "finished_at": stamp,
                                         "evidence": {"kind": "structured-inventory",
                                                      "observed_at": redact(arg3)}}
    event("adopt", note, through)
elif op == "resume":
    if not existed or state.get("phase") not in {"running", "blocked"} or int(state.get("current", 0)) >= 10:
        raise SystemExit("resume-requires-incomplete-transaction")
    state["resume_count"] = int(state.get("resume_count", 0)) + 1
    state["last_operation"] = "resume"
    event("resume", arg1, int(state.get("current", 0)) + 1)
elif op == "reset":
    state = {"schema": 3, "ip": ip, "current": 0, "phase": "running", "run_kind": "new",
             "created_at": stamp, "updated_at": stamp, "stages": {}, "facts": {},
             "verifications": [], "events": [{"at": stamp, "kind": "reset"}],
             "resume_count": 0, "last_operation": "reset",
             "transaction_id": "run-" + uuid.uuid4().hex, "operation_generation": 0,
             "revision": 0}
elif op in {"reopen", "reconcile"}:
    stage = int(arg1)
    if not 1 <= stage <= 10:
        raise SystemExit("stage-must-be-1..10")
    if op == "reopen":
        if state.get("phase") != "blocked" or stage != int(state.get("current", 0)):
            raise SystemExit("reopen-requires-current-passed-stage-after-block")
        if state["stages"].get(str(stage), {}).get("status") not in {"pass", "adopted"}:
            raise SystemExit(f"reopen-requires-satisfied-stage: stage={stage}")
    else:
        checks = state.get("verifications") or []
        if state.get("phase") != "complete" or not checks or checks[-1].get("status") != "fail":
            raise SystemExit("reconcile-requires-failed-verification-of-complete-transaction")
        state["run_kind"] = "repair"
    state["operation_generation"] = int(state.get("operation_generation", 0)) + 1
    if not all(satisfied(n) for n in range(1, stage)):
        raise SystemExit("reopen-requires-earlier-passed-stages")
    for n in range(stage, 11):
        state["stages"].pop(str(n), None)
    state["current"] = stage - 1
    state["phase"] = "running"
    event(op, arg2, stage)
elif op in {"running", "pass", "block"}:
    stage = int(arg1)
    if not 1 <= stage <= 10:
        raise SystemExit("stage-must-be-1..10")
    expected = int(state["current"]) + 1
    if stage != expected:
        raise SystemExit(f"stage-order-violation: expected={expected} got={stage}")
    previous = state["stages"].get(str(stage), {}).get("status")
    if op == "pass" and previous != "running":
        raise SystemExit(f"stage-not-running: stage={stage}")
    item = state["stages"].get(str(stage), {})
    item.update({"status": op, "note": redact(arg2), "updated_at": stamp})
    item.setdefault("started_at", stamp)
    if op in {"pass", "block"}: item["finished_at"] = stamp
    if op == "pass": item["evidence"] = {"kind": "command-exit", "exit_code": 0}
    state["stages"][str(stage)] = item
    state["phase"] = "blocked" if op == "block" else "running"
    if op == "pass": state["current"] = stage
    event(op, arg2, stage)
elif op == "observed":
    stage = int(arg1)
    if not 1 <= stage <= 10:
        raise SystemExit("stage-must-be-1..10")
    expected = int(state["current"]) + 1
    if stage != expected:
        raise SystemExit(f"stage-order-violation: expected={expected} got={stage}")
    validate_observed_at(arg2)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", arg3):
        raise SystemExit("component-id-invalid")
    if not state.get("facts", {}).get("target_fingerprint") or not state.get("facts", {}).get("contract_sha256"):
        raise SystemExit("observed-stage-requires-bound-target-and-contract")
    state["stages"][str(stage)] = {
        "status": "pass", "note": f"{arg3}:verified-healthy",
        "started_at": stamp, "updated_at": stamp, "finished_at": stamp,
        "evidence": {"kind": "structured-inventory", "observed_at": arg2,
                     "component": arg3,
                     "contract_sha256": state["facts"]["contract_sha256"],
                     "target_fingerprint": state["facts"]["target_fingerprint"]},
    }
    state["phase"] = "running"
    state["current"] = stage
    event("observed-pass", arg3, stage)
elif op == "complete":
    if state["current"] != 10 or any(not satisfied(n) for n in range(1, 11)):
        raise SystemExit(f"transaction-incomplete: passed={state['current']}/10")
    if state.get("run_kind") == "adopt":
        if not state.get("facts", {}).get("target_fingerprint") or not state.get("facts", {}).get("contract_sha256"):
            raise SystemExit("adopted-transaction-missing-target-or-contract-binding")
        if any(not state["stages"][str(n)].get("evidence", {}).get("observed_at") for n in range(1, 11)):
            raise SystemExit("adopted-transaction-missing-observation-evidence")
    state["phase"] = "complete"
    state["completed_at"] = stamp
    event("complete")
elif op == "fact":
    key, value = arg1, redact(arg2)
    allowed = {"run_kind", "node_id", "desired_line", "actual_line", "browser_count",
               "clash_url", "vnc_url", "fleet_reachable", "profile",
               "target_fingerprint", "contract_sha256"}
    if key not in allowed: raise SystemExit(f"fact-key-not-allowed: {key}")
    if key == "run_kind" and value not in {"new", "adopt", "verify-only", "repair"}: raise SystemExit("invalid-run-kind")
    if key in {"desired_line", "actual_line"} and not re.fullmatch(r"line-[0-9]+", value): raise SystemExit("invalid-line-id")
    if key == "browser_count" and not re.fullmatch(r"[0-9]+", value): raise SystemExit("invalid-browser-count")
    if key == "fleet_reachable" and value not in {"true", "false"}: raise SystemExit("invalid-boolean")
    if key in {"clash_url", "vnc_url"} and not re.fullmatch(r"https://[A-Za-z0-9.-]+\.vyibc\.com/?", value): raise SystemExit("invalid-public-url")
    if key == "target_fingerprint" and not re.fullmatch(r"sha256:[0-9a-f]{64}", value): raise SystemExit("invalid-target-fingerprint")
    if key == "contract_sha256" and not re.fullmatch(r"[0-9a-f]{64}", value): raise SystemExit("invalid-contract-digest")
    state["facts"][key] = value
    if key == "run_kind": state["run_kind"] = value
    event("fact", f"{key}={value}")
elif op == "verification":
    status = "pass" if arg2 == "0" else "fail"
    item = {"at": stamp, "status": status, "note": redact(arg1), "exit_code": int(arg2)}
    state["verifications"].append(item)
    state["verifications"] = state["verifications"][-20:]
    if status == "pass": state["run_kind"] = "verify-only"
    event("verification-" + status, arg1)
elif op == "observation":
    if state.get("phase") != "complete":
        raise SystemExit("observe-requires-complete-transaction")
    if arg1 not in {"pass", "fail"}:
        raise SystemExit("observe-result-must-be-pass-or-fail")
    item = {"at": stamp, "status": arg1, "note": redact(arg2),
            "evidence": "structured-inventory"}
    state["verifications"].append(item)
    state["verifications"] = state["verifications"][-20:]
    if arg1 == "pass": state["run_kind"] = "verify-only"
    event("verification-" + arg1, arg2)
else:
    raise SystemExit("unknown-operation")

state["updated_at"] = stamp
state["revision"] = int(state.get("revision", 0)) + 1
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".stage-", dir=directory, text=True)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
print(json.dumps(state, ensure_ascii=False, sort_keys=True))
PY
}

render_report() {
  [[ -r "$state" ]] || { echo "transaction-not-started" >&2; exit 2; }
  python3 - "$state" "$report" <<'PY'
import json, os, tempfile, sys
state_path, report_path = sys.argv[1:]
with open(state_path, encoding="utf-8") as handle: s = json.load(handle)
facts = s.get("facts") or {}
labels = {"new":"全新安装", "adopt":"既有节点接管", "verify-only":"健康复核", "repair":"修复执行"}
lines = ["# Fleet 节点装机报告", "", f"- 目标：`{s['ip']}`",
         f"- 执行类型：{labels.get(s.get('run_kind'), s.get('run_kind', '未知'))}",
         f"- 最终状态：`{s.get('phase', 'unknown')}`", f"- 生成时间：`{s.get('updated_at', '')}`", ""]
if facts:
    lines += ["## 验收事实", "", "| 项目 | 结果 |", "| --- | --- |"]
    for key in ("node_id","desired_line","actual_line","browser_count","clash_url","vnc_url","fleet_reachable","profile"):
        if key in facts: lines.append(f"| {key} | `{facts[key]}` |")
    lines.append("")
lines += ["## 十阶段结果", "", "| 阶段 | 状态 | 动作 / 结果 | 完成时间 |", "| --- | --- | --- | --- |"]
for stage in range(1, 11):
    item = (s.get("stages") or {}).get(str(stage), {})
    lines.append(f"| {stage} | {item.get('status', 'pending')} | {item.get('note', '')} | {item.get('finished_at', '')} |")
checks = s.get("verifications") or []
if checks:
    lines += ["", "## 重跑复核", "", "| 时间 | 结果 | 说明 |", "| --- | --- | --- |"]
    for item in checks:
        lines.append(f"| {item.get('at','')} | {item.get('status','')} | {item.get('note','')} |")
lines += ["", "## 结论", ""]
if s.get("phase") == "complete":
    lines.append("装机事务已完成；上表是本次实际复用、变更与验收结果。")
elif s.get("phase") == "blocked":
    lines.append("装机事务尚未完成，请从阻塞阶段继续；不得将本报告作为上线验收。")
else:
    lines.append("装机事务仍在执行中；不得将本报告作为上线验收。")
lines += ["", "> 安全说明：报告只记录脱敏后的阶段事实，不保存密码、Token、代理订阅、Cookie 或私钥。", ""]
text = "\n".join(lines)
fd, temporary = tempfile.mkstemp(prefix=".report-", dir=os.path.dirname(report_path), text=True)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle: handle.write(text)
    os.replace(temporary, report_path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
print(text, end="")
PY
}

case "$action" in
  status)
    [[ -r "$state" ]] || { echo "transaction-not-started" >&2; exit 2; }
    cat "$state"
    ;;
  begin)
    if [[ $# -eq 2 ]]; then
      ( flock -x 9; mutate begin ) 9>"$lock"
    elif [[ $# -eq 4 ]]; then
      ( flock -x 9; mutate begin "$3" "$4" ) 9>"$lock"
    else
      usage
    fi
    ;;
  reset)
    ( flock -x 9; mutate reset ) 9>"$lock"
    ;;
  adopt)
    [[ $# -eq 7 ]] || usage
    ( flock -x 9; mutate adopt "$3" "$4" "$5" "$6" "$7" ) 9>"$lock"
    ;;
  resume)
    [[ $# -ge 3 ]] || usage
    ( flock -x 9; mutate resume "${3:-operator-resume}" ) 9>"$lock"
    ;;
  observed)
    [[ $# -ge 5 ]] || usage
    ( flock -x 9; mutate observed "$3" "$4" "$5" ) 9>"$lock"
    ;;
  complete)
    ( flock -x 9; result="$(mutate complete)"; render_report >/dev/null; printf '%s\n' "$result" ) 9>"$lock"
    ;;
  report)
    ( flock -x 9; render_report ) 9>"$lock"
    ;;
  fact)
    [[ $# -ge 4 ]] || usage
    ( flock -x 9; mutate fact "$3" "$4" ) 9>"$lock"
    ;;
  observe)
    [[ $# -ge 4 ]] || usage
    ( flock -x 9; mutate observation "$3" "$4" ) 9>"$lock"
    ;;
  running|pass|block|reopen|reconcile)
    [[ $# -ge 4 ]] || usage
    ( flock -x 9; mutate "$action" "$3" "$4" ) 9>"$lock"
    ;;
  run)
    [[ $# -ge 6 && "$5" == "--" ]] || usage
    stage="$3"; note="$4"; shift 5
    (
      flock -n 9 || { echo "transaction-busy: another stage command owns $ip" >&2; exit 75; }
      mutate running "$stage" "$note" >/dev/null
      if "$@"; then
        mutate pass "$stage" "$note:exit=0"
      else
        code=$?
        mutate block "$stage" "$note:exit=$code"
        exit "$code"
      fi
    ) 9>"$lock"
    ;;
  verify)
    [[ $# -ge 5 && "$4" == "--" ]] || usage
    note="$3"; shift 4
    (
      flock -n 9 || { echo "transaction-busy: another stage command owns $ip" >&2; exit 75; }
      [[ -r "$state" ]] || { echo "transaction-not-started" >&2; exit 2; }
      phase="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["phase"])' "$state")"
      [[ "$phase" == "complete" ]] || { echo "verify-requires-complete-transaction" >&2; exit 65; }
      if "$@"; then code=0; else code=$?; fi
      mutate verification "$note" "$code" >/dev/null
      render_report >/dev/null
      exit "$code"
    ) 9>"$lock"
    ;;
  *) usage ;;
esac
