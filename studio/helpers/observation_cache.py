"""Project-scoped replay of completed observations, never review verdicts.

Opt-in through host environment. Content hashes detect corruption, not malicious
same-UID tampering. The caller validates input before lookup and result on hits.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import uuid

SCHEMA = 'studio-observation-cache-v1'
TTL_SECONDS = 6 * 60 * 60
MAX_BYTES = 1024 * 1024


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_fingerprint(paths):
    result = {}
    for path in map(Path, paths):
        if path.name in result:
            raise ValueError('observation_cache_duplicate_source_name')
        result[path.name] = digest(path.read_bytes())
    return result


def _plain_directory(path):
    path = Path(path).absolute()
    if path.resolve() != path or not path.is_dir() or path.is_symlink():
        raise ValueError('observation_cache_directory_invalid')
    if path.stat().st_mode & 0o077 or path.stat().st_uid != os.getuid():
        raise PermissionError('observation_cache_directory_not_private')
    return path


@contextlib.contextmanager
def _lock(path, timeout=5):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('observation_cache_lock_invalid')
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('observation_cache_in_progress') from None
                time.sleep(min(.05, max(0, deadline - time.monotonic())))
        yield
    finally:
        os.close(fd)


def _read(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError('observation_cache_file_invalid')
        data = file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('observation_cache_file_invalid')
    try:
        return json.loads(data)
    except (ValueError, UnicodeError):
        return None


def _write(path, value):
    data = encoded(value)
    if len(data) > MAX_BYTES:
        raise ValueError('observation_cache_result_too_large')
    tmp = path.with_name('.tmp-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        tmp.unlink(missing_ok=True)


def _validate(result, validate):
    if not isinstance(result, dict) or result.get('ok') is not True or result.get('finish_reason') != 'stop':
        raise ValueError('observation_cache_incomplete_result')
    if any(result.get(key) is True for key in ('qualityApproved', 'quality_pass', 'quality_approved', 'calibrated')):
        raise ValueError('observation_cache_not_for_verdicts')
    if 'observation_cache' in result:
        raise ValueError('observation_cache_nested_replay')
    validate(result)


def observe_cached(signature, run, validate, *, clock=time.time):
    """Always validate fresh and cached results; never cache failures or approval."""
    cache_dir = os.environ.get('STUDIO_OBSERVATION_CACHE_ROOT')
    if not cache_dir:
        result = run()
        _validate(result, validate)
        return {**result, 'observation_cache': {'enabled': False, 'hit': False,
                'quality_approved': False}}
    root = Path(os.environ['STUDIO_PROJECT_ROOT']).resolve(strict=True)
    task = os.environ.get('STUDIO_TASK_ID', '')
    if not task:
        raise ValueError('observation_cache_task_scope_required')
    # Cache location comes only from deployment configuration, never tool args.
    base = _plain_directory(cache_dir)
    scope = digest(encoded({'project': str(root), 'task': task}))
    directory = base / scope
    directory.mkdir(mode=0o700, exist_ok=True)
    _plain_directory(directory)
    key = digest(encoded({'schema': SCHEMA, 'scope': scope, 'signature': signature,
                          'epoch': os.environ.get('STUDIO_OBSERVATION_CACHE_EPOCH', '')}))
    path = directory / (key + '.json')
    with _lock(directory / (key + '.lock')):
        now = clock()
        saved = _read(path)
        valid = isinstance(saved, dict) and saved.get('schema') == SCHEMA and saved.get('key') == key
        if valid:
            created = saved.get('created_at')
            valid = isinstance(created, (int, float)) and not isinstance(created, bool) and 0 <= now - created < TTL_SECONDS
        if valid:
            valid = isinstance(saved.get('result'), dict) and saved.get('result_sha256') == digest(encoded(saved['result']))
        if valid:
            try:
                _validate(saved['result'], validate)
            except (ValueError, TypeError, KeyError):
                valid = False
        if valid:
            result, created = saved['result'], saved['created_at']
        else:
            # Exceptions and incomplete/invalid responses leave no successful row.
            result = run()
            _validate(result, validate)
            created = clock()
            _write(path, {'schema': SCHEMA, 'key': key, 'created_at': created,
                         'result_sha256': digest(encoded(result)), 'result': result})
    return {**result, 'observation_cache': {'enabled': True, 'hit': bool(valid),
            'key': key, 'observed_at_epoch': created, 'age_seconds': max(0, clock() - created),
            'scope': 'same-task-input-and-observer-version; observation only, not a QA report',
            'usage_scope': 'original-provider-call; no new provider call on hit',
            'quality_approved': False}}
