"""Fixed privileged adapter, supplied over SSH stdin by the MCP host. No shell input API."""
import datetime
import errno
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path('/etc/linux-clash-skill/controller.json')
TOKEN = Path('/etc/linux-clash-skill/controller.token')
STATE = Path('/var/lib/linux-clash-skill/proxy-mcp')
SCRIPT = Path('/usr/local/lib/linux-clash-skill/scripts/linux-clash-skill.sh')
UNIT = 'linux-clash-node-controller.service'
PATH_FIELDS = ['generic_exit_ip', 'cloudflare_exit_ip', 'claude_exit_ip', 'udp_cloudflare_exit_ip', 'udp_google_exit_ip']
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}


class Refused(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def emit(value):
    try:
        print(json.dumps(value, separators=(',', ':')), flush=True)
    except BrokenPipeError:
        pass  # Persist the outcome even if the caller disconnects.


def ip(value):
    try:
        return str(ipaddress.IPv4Address(value))
    except Exception:
        return None


def root_file(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
        raise Refused('managed-file-ownership-invalid')
    return path.read_text()


def read_json(path):
    return json.loads(root_file(path))


def save(path, value):
    fd, name = tempfile.mkstemp(prefix='.receipt-', dir=STATE)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file); file.flush(); os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def controller(path='/v1/status', payload=None):
    token = root_file(TOKEN).strip()
    if not token or '\n' in token:
        raise Refused('controller-credential-invalid')
    request = urllib.request.Request('http://127.0.0.1:8788' + path,
        data=json.dumps(payload).encode() if payload else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=15) as response:
            data = response.read(262145)
            if len(data) > 262144:
                raise Refused('controller-response-too-large')
            return json.loads(data)
    except urllib.error.HTTPError as exc:
        raise Refused('controller-busy' if exc.code == 409 else 'controller-request-denied')
    except urllib.error.URLError as exc:
        if getattr(exc.reason, 'errno', None) == errno.ECONNREFUSED:
            raise Refused('controller-not-listening')
        raise Refused('controller-connection-unknown')


def snapshot(raw, expected, source_matches):
    previous = raw.get('last_result') or {}
    paths = {k: ip(previous.get(k)) for k in PATH_FIELDS}
    checked = previous.get('verified_at')
    if not isinstance(checked, str) or not re.fullmatch(r'[0-9T:+.Z-]{10,40}', checked):
        checked = None
    op = raw.get('operation') or {}
    return {'controllerAvailable': True, 'serviceActive': raw.get('service_active') is True,
        'tunPresent': raw.get('tun_present') is True, 'configured': raw.get('configured') is True,
        'expectedIp': expected, 'configuredExpectedIp': ip(raw.get('expected_ip')),
        'sourceMatches': source_matches, 'observedAt': now(),
        'historicalEvidence': {'verifiedAt': checked, 'paths': paths, 'notCurrentAcceptance': True},
        'controllerOperation': {'id': op.get('id') if re.fullmatch(r'[a-f0-9]{24}', str(op.get('id', ''))) else None,
            'state': op.get('status') if op.get('status') in ['queued', 'running', 'failed', 'succeeded'] else None}}


def independent_verify(expected):
    root_file(SCRIPT)
    directory = tempfile.mkdtemp(prefix='proxy-verify-')
    started = now()
    try:
        result = subprocess.run(['/usr/bin/bash', str(SCRIPT), 'verify', '--expected-ip', expected],
            env={**ENV, 'SOP_OUTPUT_DIR': directory}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=200, text=True)
        if result.returncode:
            output = result.stdout
            reason = 'proxy-verification-failed'
            for fragment, code in [('not match expected IP', 'proxy-exit-mismatch'),
                    ('Transparent checks disagree', 'proxy-paths-disagree'),
                    ('mihomo.service is not active', 'mihomo-inactive'), ('TUN interface is missing', 'tun-missing')]:
                if fragment in output:
                    reason = code
            return {'ok': False, 'reason': reason, 'startedAt': started, 'checkedAt': now()}
        evidence = read_json(Path(directory) / 'result.json')
        paths = {k: ip(evidence.get(k)) for k in PATH_FIELDS}
        observed = evidence.get('verified_at', '')
        try:
            stamp = datetime.datetime.fromisoformat(observed.replace('Z', '+00:00'))
            fresh = datetime.datetime.fromisoformat(started) <= stamp <= datetime.datetime.now(datetime.timezone.utc)
        except Exception:
            fresh = False
        valid = fresh and all(value == expected for value in paths.values()) and evidence.get('tcp_udp_consistent') is True and (not evidence.get('china_exit_ip') or ip(evidence['china_exit_ip']) == expected)
        return {'ok': valid, 'reason': None if valid else 'proxy-evidence-invalid', 'expectedIp': expected,
            'startedAt': started, 'checkedAt': now(), 'verifiedAt': observed if fresh else None, 'paths': paths}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'reason': 'proxy-verification-timeout', 'startedAt': started, 'checkedAt': now()}
    finally:
        shutil.rmtree(directory)  # Only this invocation's fresh verifier output.


class Operation:
    def __init__(self, request):
        self.request = request
        self.id = request['operationId']
        self.path = STATE / (self.id + '.json')
        self.record = {'operationId': self.id, 'lineId': request['lineId'], 'expectedIp': request['expectedIp'],
            'action': request['action'], 'operatorMachineId': request['operatorMachineId'], 'startedAt': now(),
            'events': [], 'quiescent': False}
        self.uncertain = False

    def event(self, stage, **fields):
        event = {'stage': stage, 'at': now(), **fields}
        self.record['events'].append(event)
        save(self.path, self.record)
        emit({'event': event})

    def action(self, name, payload=None):
        self.event('controller-submit', action=name)
        self.uncertain = True  # Never repeat POST when its response is lost.
        try:
            reply = controller('/v1/actions', {'action': name, **(payload or {})})
        except Refused as exc:
            if str(exc) in ['controller-busy', 'controller-request-denied']:
                self.uncertain = False
            raise
        operation_id = reply.get('id')
        if not isinstance(operation_id, str) or not re.fullmatch(r'[a-f0-9]{24}', operation_id):
            raise Refused('controller-operation-id-invalid')
        self.event('controller-running', action=name, controllerOperationId=operation_id)
        until = time.monotonic() + 1100
        last_state = None
        while time.monotonic() < until:
            raw = controller()
            operation = raw.get('operation') or {}
            if operation.get('id') != operation_id:
                raise Refused('controller-operation-superseded')
            state = operation.get('status')
            if state != last_state:
                self.event('controller-progress', action=name, state=state if state in ['queued', 'running', 'failed', 'succeeded'] else 'unknown')
                last_state = state
            if state in ['failed', 'succeeded']:
                self.uncertain = False
                if state == 'failed':
                    raise Refused('controller-transaction-failed')
                return raw
            time.sleep(2)
        raise Refused('controller-operation-timeout')

    def recover_controller(self):
        # A live unfinished transaction forbids restart: don't interrupt its rollback.
        old = Path('/var/lib/linux-clash-skill/controller-operation.json')
        if old.exists() and read_json(old).get('status') in ['queued', 'running']:
            raise Refused('controller-has-unfinished-operation')
        unit = root_file(Path('/etc/systemd/system') / UNIT)
        if not re.search(r'(?m)^ExecStart=/usr/bin/python3 /usr/local/lib/linux-clash-skill/scripts/node_controller\.py(?: --port (?:\$\{CONTROLLER_PORT\}|8788))?$', unit) or re.search(r'(?m)^Exec(?:StartPre|StartPost|Stop|StopPost)=', unit):
            raise Refused('managed-controller-unit-missing')
        root_file(Path('/usr/local/lib/linux-clash-skill/scripts/node_controller.py'))
        self.event('controller-recovery')
        self.uncertain = True
        result = subprocess.run(['/usr/bin/systemctl', 'restart', UNIT], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
        if result.returncode:
            raise Refused('controller-restart-failed')
        for _ in range(15):
            try:
                raw = controller(); self.uncertain = False; return raw
            except Refused as exc:
                if str(exc) != 'controller-not-listening':
                    raise
                time.sleep(2)
        raise Refused('controller-not-recovered')

    def run(self):
        request = self.request
        if request['action'] == 'repair' and Path('/etc/machine-id').read_text().strip() == request['operatorMachineId']:
            raise Refused('self-proxy-repair-forbidden')
        settings = read_json(CONFIG)
        matches = settings.get('config_url') == request['configUrl'] and settings.get('expected_ip') == request['expectedIp']
        try:
            raw = controller()
        except Refused as exc:
            if request['action'] != 'repair' or str(exc) != 'controller-not-listening':
                raise
            raw = self.recover_controller()
        if (raw.get('operation') or {}).get('status') in ['queued', 'running']:
            raise Refused('controller-busy')
        self.event('inspect', sourceMatches=matches, serviceActive=raw.get('service_active') is True, tunPresent=raw.get('tun_present') is True)
        before_settings = hashlib.sha256(root_file(CONFIG).encode()).hexdigest()
        self.event('independent-verification')
        verified = independent_verify(request['expectedIp'])
        changed = any(e['stage'] == 'controller-recovery' for e in self.record['events'])
        if request['action'] == 'repair' and (not verified['ok'] or not matches):
            if verified.get('reason') == 'proxy-verification-timeout':
                raise Refused('proxy-verification-timeout')
            if matches and not verified['ok'] and verified.get('reason') not in ['proxy-exit-mismatch', 'proxy-paths-disagree', 'mihomo-inactive', 'tun-missing']:
                raise Refused('proxy-repair-evidence-inconclusive')
            # Controller's replace owns disable, direct preflight, install and rollback.
            raw = self.action('replace', {'config_url': request['configUrl'], 'expected_ip': request['expectedIp'], 'proxy_name': '', 'server_ip': ''})
            if raw.get('proxy_enabled') is not True:
                raw = self.action('enable')
            changed = True
            before_settings = hashlib.sha256(root_file(CONFIG).encode()).hexdigest()
            self.event('independent-reverification')
            verified = independent_verify(request['expectedIp'])
        latest = controller()
        current = read_json(CONFIG)
        matches = current.get('config_url') == request['configUrl'] and current.get('expected_ip') == request['expectedIp']
        if before_settings != hashlib.sha256(root_file(CONFIG).encode()).hexdigest() or (latest.get('operation') or {}).get('status') in ['queued', 'running']:
            raise Refused('proxy-changed-during-verification')
        accepted = verified['ok'] and matches and latest.get('service_active') is True and latest.get('tun_present') is True
        return {'ok': accepted, 'quiescent': True, 'changed': changed, 'reused': not changed and accepted,
            'reason': None if accepted else verified.get('reason') or 'proxy-source-or-runtime-mismatch',
            'evidence': verified, 'snapshot': snapshot(latest, request['expectedIp'], matches)}


def dispatch(request):
    action = request.get('action')
    if action not in ['inspect', 'verify', 'repair', 'receipt'] or not re.fullmatch(r'[a-f0-9-]{36}', request.get('operationId', '')):
        raise Refused('invalid-fixed-operation')
    if ip(request.get('expectedIp')) is None or not re.fullmatch(r'[a-f0-9]{32}', request.get('operatorMachineId', '')):
        raise Refused('invalid-fixed-target')
    if action == 'inspect':
        settings = read_json(CONFIG)
        return {'ok': True, 'snapshot': snapshot(controller(), request['expectedIp'],
            settings.get('config_url') == request['configUrl'] and settings.get('expected_ip') == request['expectedIp'])}
    if action == 'receipt':
        path = STATE / (request['operationId'] + '.json')
        if not path.exists():
            return {'ok': False, 'reason': 'remote-receipt-unavailable', 'quiescent': False}
        record = read_json(path)
        if record.get('operatorMachineId') != request['operatorMachineId'] or record.get('operationId') != request['operationId']:
            raise Refused('remote-receipt-owner-mismatch')
        if record.get('result'):
            return {**record['result'], 'receiptOperationId': request['operationId']}
        return {'ok': False, 'reason': 'remote-operation-incomplete', 'quiescent': False}
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = STATE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise Refused('private-remote-state-required')
    lock = os.open(STATE / 'node.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'ok': False, 'reason': 'proxy-node-busy', 'quiescent': True}
        operation = Operation(request)
        if operation.path.exists():
            previous = read_json(operation.path)
            if any(previous.get(k) != request[k] for k in ['action', 'operatorMachineId', 'lineId', 'expectedIp']):
                raise Refused('remote-operation-conflict')
            return previous.get('result') or {'ok': False, 'reason': 'remote-operation-incomplete', 'quiescent': False}
        inflight = STATE / 'inflight.json'
        if inflight.exists():
            return {'ok': False, 'reason': 'previous-proxy-operation-unresolved', 'quiescent': True}
        save(inflight, {'operationId': operation.id})
        operation.event('started')
        try:
            result = operation.run()
        except Exception as exc:
            reason = str(exc) if isinstance(exc, Refused) else 'fixed-proxy-operation-failed'
            result = {'ok': False, 'reason': reason, 'quiescent': not operation.uncertain}
        operation.record['result'] = result
        operation.record['quiescent'] = result['quiescent']
        save(operation.path, operation.record)
        if result['quiescent']:
            inflight.unlink()
        return result
    finally:
        os.close(lock)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        payload = sys.stdin.buffer.read(32769)
        if len(payload) > 32768:
            raise Refused('fixed-request-too-large')
        emit({'result': dispatch(json.loads(payload))})
    except Exception as exc:
        emit({'result': {'ok': False, 'reason': str(exc) if isinstance(exc, Refused) else 'fixed-proxy-request-failed', 'quiescent': False}})
