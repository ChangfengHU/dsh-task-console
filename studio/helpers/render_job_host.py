"""Durable bounded HyperFrames jobs; trusted host runtime, project-local inputs.

Not an OS sandbox: task HTML is trusted rendering code. No host credentials are
passed to the worker or browser. A lost process is never reported as complete.
"""
import argparse
import contextlib
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import uuid

JOBS = '.studio-render-jobs'
HEX = re.compile(r'[a-f0-9]{64}\Z')
MAX_FILES = 2000
MAX_BYTES = 250_000_000
REMOTE = re.compile(r'(?:https?:|file:|data:|//)', re.I)


class RenderError(ValueError):
    pass


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def plain(path, directory=False):
    path = Path(path).absolute()
    if path.resolve() != path or path.is_symlink() or not (path.is_dir() if directory else path.is_file()):
        raise RenderError('plain_directory_required' if directory else 'plain_file_required')
    return path


def local(root, value, must_exist=False):
    p = Path(value)
    if not value or p.is_absolute() or '\\' in value or '\x00' in value or any(x in ('.', '..') or re.search(r'credential|secret|token|password|private.?key', x, re.I) for x in p.parts):
        raise RenderError('project_relative_path_required')
    target = root / p
    if target.resolve() != target or not target.is_relative_to(root) or p.parts[0] == JOBS:
        raise RenderError('project_path_invalid')
    if must_exist:
        plain(target, directory=True)
    return target


def atomic(path, value):
    temp = path.with_name('.tmp-' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(encoded(value))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def job_dir(root):
    directory = root / JOBS
    directory.mkdir(mode=0o700, exist_ok=True)
    return plain(directory, directory=True)


@contextlib.contextmanager
def locked(root):
    directory = job_dir(root)
    fd = os.open(directory / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield directory
    finally:
        os.close(fd)


class Sources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.audio = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.audio += int(tag == 'audio')
        for name in ['src', 'href', 'poster', 'data-composition-src']:
            if attrs.get(name):
                self.urls.append(attrs[name])
        if attrs.get('srcset'):
            self.urls += [v.strip().split()[0] for v in attrs['srcset'].split(',')]


def snapshot(composition):
    plain(composition, directory=True)
    plain(composition / 'index.html')
    rows = []
    total = 0
    audio = 0
    for path in sorted(composition.rglob('*')):
        if path.is_symlink():
            raise RenderError('input_symlink_forbidden')
        if path.is_dir():
            continue
        plain(path)
        if re.search(r'credential|secret|password|private.?key|\.env(?:\.|$)', path.name, re.I):
            raise RenderError('sensitive_input_forbidden')
        size = path.stat().st_size
        total += size
        if len(rows) >= MAX_FILES or total > MAX_BYTES:
            raise RenderError('input_snapshot_too_large')
        data = path.read_bytes()
        if len(data) != size:
            raise RenderError('input_changed_during_snapshot')
        rows.append({'path': str(path.relative_to(composition)), 'bytes': size, 'sha256': sha(data)})
        if path.suffix.lower() not in ['.html', '.htm', '.css', '.js', '.mjs']:
            continue
        text = data.decode('utf-8')
        urls = []
        if path.suffix.lower() in ['.html', '.htm']:
            parser = Sources()
            parser.feed(text)
            urls += parser.urls
            audio += parser.audio
        urls += re.findall(r'url\(\s*[\"\']?([^\)\"\']+)', text)
        urls += re.findall(r'@import\s+[\"\']([^\"\']+)', text)
        # Dynamic network loaders cannot be frozen by static asset discovery.
        if re.search(r'\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(', text):
            raise RenderError('freeze_dynamic_dependencies_required')
        for url in urls:
            parsed = urllib.parse.urlsplit(url.strip())
            if parsed.scheme or parsed.netloc or parsed.query or url.startswith('/'):
                raise RenderError('freeze_remote_dependencies_required')
            if not parsed.path:
                continue
            dependency = (path.parent / urllib.parse.unquote(parsed.path)).resolve()
            if not dependency.is_relative_to(composition) or not dependency.is_file():
                raise RenderError('freeze_dependencies_inside_composition')
    if not audio:
        raise RenderError('composition_audio_required')
    return {'files': rows, 'sha256': sha(encoded(rows)), 'audioElements': audio}


def runtime_binding(value, executables=None):
    executables = executables or {}
    for value_path in executables.values():
        if not isinstance(value_path, str) or not Path(value_path).is_absolute() or '\0' in value_path:
            raise RenderError('render_executable_invalid')
    root = plain(value, directory=True)
    package = plain(root / 'node_modules/hyperframes/package.json')
    binary = plain(root / 'node_modules/hyperframes/bin/hyperframes.mjs')
    ffmpeg = plain(Path(executables.get('ffmpeg', root / 'node_modules/ffmpeg-static/ffmpeg')).resolve())
    node = plain(Path(executables.get('node', '/usr/bin/node')).resolve())
    node_version = subprocess.check_output([str(node), '--version'], timeout=10, text=True).strip()
    if not re.fullmatch(r'v\d+\.\d+\.\d+', node_version) or int(node_version[1:].split('.')[0]) < 22:
        raise RenderError('render_node_version_unsupported')
    probe = plain(Path(executables.get('ffprobe', shutil.which('ffprobe') or '/usr/bin/ffprobe')).resolve())
    chrome = plain(Path(executables.get('chrome', '/usr/bin/google-chrome')).resolve())
    python = plain(Path(executables.get('python', sys.executable)).resolve())
    if any(not os.access(path, os.X_OK) for path in [node, probe, ffmpeg, chrome, python]):
        raise RenderError('render_executable_unavailable')
    # Resolve trusted host executable symlinks; project input symlinks stay denied.
    version = json.loads(package.read_text())['version']
    files = [package, binary, ffmpeg, node, probe, chrome, python]
    return {'root': str(root), 'version': version, 'nodeVersion': node_version, 'cli': str(binary), 'ffmpeg': str(ffmpeg),
            'node': str(node), 'ffprobe': str(probe), 'chrome': str(chrome), 'python': str(python),
            'hashes': {str(p): sha(p.read_bytes()) for p in files}}


def process_identity(pid):
    if sys.platform == 'darwin':
        # macOS has no /proc. Do not treat two unavailable identities as proof
        # of a live worker. A PID alone is unsafe after process reuse.
        try:
            result = subprocess.run(['/bin/ps', '-p', str(int(pid)), '-o', 'lstart=', '-o', 'stat='],
                                    capture_output=True, text=True, timeout=5,
                                    env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
            match = re.fullmatch(r'([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([A-Za-z+<>-]+)', result.stdout.strip())
            if result.returncode or not match or match[2].startswith('Z'):
                return None
            return 'darwin:' + ' '.join(match[1].split())
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
    try:
        text = Path('/proc/' + str(pid) + '/stat').read_text()
        values = text[text.rfind(')') + 2:].split()
        if values[0] == 'Z':
            return None
        return values[19]  # starttime, field 22; comm may contain spaces.
    except (OSError, IndexError):
        return None


def read_job(root, job_id):
    if not HEX.fullmatch(job_id):
        raise RenderError('invalid_job_id')
    path = plain(job_dir(root) / (job_id + '.json'))
    record = json.loads(path.read_text())
    if record.get('jobId') != job_id:
        raise RenderError('job_identity_mismatch')
    return record


def public(record, reused=False):
    keys = ['jobId', 'intentId', 'state', 'composition', 'output', 'inputSha256', 'inputIndexSha256', 'outputSha256', 'bytes', 'width', 'height', 'fps', 'durationSeconds', 'errorCode', 'logs']
    return {'ok': True, **{k: record[k] for k in keys if k in record}, 'reused': reused, 'qualityApproved': False}


def status(root, job_id):
    with locked(root) as directory:
        record = read_job(root, job_id)
        if record['state'] in ['queued', 'running']:
            alive = record.get('pid') and record.get('processStart') is not None and process_identity(record['pid']) == record['processStart']
            if not alive and (record.get('pid') or time.time() - record['createdAt'] > 15):
                record.update(state='unknown', errorCode='worker_lost_reconcile_required')
                atomic(directory / (job_id + '.json'), record)
        if record['state'] == 'completed':
            output = local(root, record['output'])
            if not output.is_file() or output.stat().st_size != record['bytes'] or sha(output.read_bytes()) != record['outputSha256']:
                record.update(state='failed', errorCode='completed_output_changed')
                atomic(directory / (job_id + '.json'), record)
        return public(record)


def worker_env(runtime, home):
    # Do not inherit API keys, vault tokens, MCP credentials or logged-in profiles.
    return {'PATH': str(Path(runtime['ffmpeg']).parent) + ':/usr/bin:/bin', 'HOME': str(home),
            'LANG': 'C.UTF-8', 'HYPERFRAMES_SKIP_SKILLS': '1', 'FFMPEG_PATH': runtime['ffmpeg'],
            'PUPPETEER_EXECUTABLE_PATH': runtime['chrome'], 'HYPERFRAMES_BROWSER_PATH': runtime['chrome']}


def start(root, composition_value, output_value, runtime_value, fps=30, width=1080, height=1920, intent_id=None, executables=None):
    if intent_id is not None:
        if not HEX.fullmatch(intent_id):
            raise RenderError('invalid_intent_id')
        # Resolve a lost reply against the original durable request BEFORE
        # reading changed composition/runtime bytes. Never mint a new job.
        with locked(root) as directory:
            for prior in directory.glob('*.json'):
                saved = json.loads(plain(prior).read_text())
                if saved.get('intentId') == intent_id:
                    if saved.get('composition') != composition_value or saved.get('output') != output_value:
                        raise RenderError('intent_request_mismatch')
                    return public(read_job(root, saved['jobId']), reused=True)
    composition = local(root, composition_value, True)
    output = local(root, output_value)
    if output.suffix != '.mp4' or output.is_relative_to(composition) or not 1 <= fps <= 60 or not 1 <= width <= 4096 or not 1 <= height <= 4096:
        raise RenderError('invalid_render_request')
    inputs = snapshot(composition)
    runtime = runtime_binding(runtime_value, executables)
    spec = {'composition': composition_value, 'output': output_value, 'inputSha256': inputs['sha256'],
            'inputIndexSha256': next(row['sha256'] for row in inputs['files'] if row['path'] == 'index.html'),
            'runtime': runtime, 'fps': fps, 'width': width, 'height': height}
    if intent_id is not None:
        if not HEX.fullmatch(intent_id):
            raise RenderError('invalid_intent_id')
        spec['intentId'] = intent_id
    job_id = sha(encoded(spec))
    with locked(root) as directory:
        if intent_id is not None:
            for prior in directory.glob('*.json'):
                saved = json.loads(plain(prior).read_text())
                if saved.get('intentId') == intent_id:
                    if saved.get('composition') != composition_value or saved.get('output') != output_value:
                        raise RenderError('intent_request_mismatch')
                    return public(read_job(root, saved['jobId']), reused=True)
        path = directory / (job_id + '.json')
        if path.exists():
            return public(read_job(root, job_id), reused=True)
        for other in directory.glob('*.json'):
            if json.loads(plain(other).read_text()).get('output') == output_value:
                raise RenderError('output_reserved_by_other_job')
        if output.exists():
            raise RenderError('output_exists')
        logs = directory / job_id
        logs.mkdir(mode=0o700)
        record = {**spec, 'jobId': job_id, 'state': 'queued', 'createdAt': time.time(),
                  'logDirectory': str(logs.relative_to(root)), 'logs': [], 'inputs': inputs}
        atomic(path, record)  # durable intent before dispatch; never blind-retry.
        home = logs / 'home'
        home.mkdir(mode=0o700)
        try:
            with (logs / 'worker.log').open('wb') as stream:
                record['logs'] = [str((logs / 'worker.log').relative_to(root))]
                atomic(path, record)
                subprocess.Popen([runtime['python'], '-B', str(Path(__file__).resolve()), 'worker', '--project-root', str(root), '--job-id', job_id],
                                 cwd=root, env=worker_env(runtime, home), stdin=subprocess.DEVNULL,
                                 stdout=stream, stderr=stream, start_new_session=True, close_fds=True)
        except Exception:
            record.update(state='unknown', errorCode='worker_start_unknown_reconcile_required')
            atomic(path, record)
        return public(record)


def command(argv, cwd, env, log, timeout):
    stage = log.stem if log.stem in ['check', 'render', 'decode'] else 'render'
    with log.open('wb') as stream:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, start_new_session=True)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RenderError(stage + '_step_timeout') from None
    if process.returncode:
        raise RenderError(stage + '_step_failed')


def inspect_media(output, runtime, expected, env, logdir):
    result = subprocess.run([runtime['ffprobe'], '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)],
                            env=env, capture_output=True, timeout=60, check=True)
    probe = json.loads(result.stdout)
    streams = probe.get('streams', [])
    videos = [s for s in streams if s.get('codec_type') == 'video']
    if len(videos) != 1 or not any(s.get('codec_type') == 'audio' for s in streams):
        raise RenderError('render_video_audio_required')
    video = videos[0]
    numerator, denominator = map(int, video['avg_frame_rate'].split('/'))
    fps = numerator / denominator
    duration = float(probe['format']['duration'])
    if video['width'] != expected['width'] or video['height'] != expected['height'] or abs(fps - expected['fps']) > .001 or not 0 < duration <= 1800:
        raise RenderError('render_media_spec_mismatch')
    command([runtime['ffmpeg'], '-nostdin', '-v', 'error', '-xerror', '-i', str(output), '-f', 'null', '-'], output.parent, env, logdir / 'decode.log', 600)
    return {'bytes': output.stat().st_size, 'outputSha256': sha(output.read_bytes()), 'width': video['width'], 'height': video['height'], 'fps': fps, 'durationSeconds': duration}


def worker(root, job_id):
    with locked(root) as directory:
        record = read_job(root, job_id)
        if record['state'] != 'queued':
            raise RenderError('job_already_dispatched')
        record.update(state='running', pid=os.getpid(), processStart=process_identity(os.getpid()))
        atomic(directory / (job_id + '.json'), record)
    logdir = plain(root / record['logDirectory'], directory=True)
    composition, output = local(root, record['composition'], True), local(root, record['output'])
    runtime = record['runtime']
    env = worker_env(runtime, logdir / 'home')
    partial = output.with_name('.render-' + job_id + '.mp4')
    try:
        if snapshot(composition)['sha256'] != record['inputSha256']:
            raise RenderError('render_inputs_changed')
        for path, digest in runtime['hashes'].items():
            if sha(plain(path).read_bytes()) != digest:
                raise RenderError('render_runtime_changed')
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists() or partial.exists():
            raise RenderError('render_output_exists')
        command([runtime['node'], runtime['cli'], 'check', str(composition), '--json'], composition, env, logdir / 'check.log', 600)
        command([runtime['node'], runtime['cli'], 'render', str(composition), '--output', str(partial), '--fps', str(record['fps']), '--format', 'mp4', '--strict'],
                composition, env, logdir / 'render.log', 7200)
        details = inspect_media(plain(partial), runtime, record, env, logdir)
        if snapshot(composition)['sha256'] != record['inputSha256']:
            raise RenderError('render_inputs_changed')
        os.link(partial, output, follow_symlinks=False)  # no overwrite
        partial.unlink()
        record.update(state='completed', **details)
    except Exception as error:
        record.update(state='failed', errorCode=str(error) if isinstance(error, RenderError) else 'render_worker_failed')
    finally:
        record['finishedAt'] = time.time()
        record['logs'] = [str(p.relative_to(root)) for p in sorted(logdir.glob('*.log')) if p.is_file() and not p.is_symlink()]
        with locked(root) as directory:
            current = read_job(root, job_id)
            if current.get('pid') == record['pid'] and current.get('processStart') == record['processStart']:
                atomic(directory / (job_id + '.json'), record)
    return public(record)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    begin = sub.add_parser('start')
    begin.add_argument('--composition', required=True)
    begin.add_argument('--output', required=True)
    begin.add_argument('--runtime', required=True, help='Trusted deployment configuration, never model-supplied')
    for executable in ['python', 'node', 'chrome', 'ffmpeg', 'ffprobe']:
        begin.add_argument('--' + executable + '-executable', help='Absolute trusted host executable, never model-supplied')
    begin.add_argument('--intent-id', help='Trusted host scope, not model-supplied')
    begin.add_argument('--fps', type=int, default=30)
    begin.add_argument('--width', type=int, default=1080)
    begin.add_argument('--height', type=int, default=1920)
    check = sub.add_parser('status')
    background = sub.add_parser('worker')
    for item in [begin, check, background]:
        item.add_argument('--project-root', required=True)
    for item in [check, background]:
        item.add_argument('--job-id', required=True)
    args = parser.parse_args()
    try:
        root = plain(args.project_root, directory=True)
        if args.action == 'start':
            executables = {name: getattr(args, name + '_executable') for name in ['python', 'node', 'chrome', 'ffmpeg', 'ffprobe'] if getattr(args, name + '_executable') is not None}
            result = start(root, args.composition, args.output, args.runtime, args.fps, args.width, args.height, args.intent_id, executables)
        elif args.action == 'status':
            result = status(root, args.job_id)
        else:
            result = worker(root, args.job_id)
    except Exception as error:
        result = {'ok': False, 'errorCode': str(error) if isinstance(error, RenderError) else 'render_host_failed', 'qualityApproved': False}
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
