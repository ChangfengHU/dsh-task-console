"""Pinned preview adapter; package beside an unchanged, pinned studio_upload.py.

Upload receives only a host snapshot. Verify never invokes an S3 write and can
reconcile ambiguous uploads without changing their deterministic full-SHA key.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import sys
import time
import urllib.parse

MAX_BYTES = 500_000_000


def load_library(expected):
    path = pathlib.Path(__file__).resolve().with_name('studio_upload.py')
    if not re.fullmatch(r'[a-f0-9]{64}', expected or '') or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('Pinned upload library changed')
    spec = importlib.util.spec_from_file_location('studio_preview_upload_library', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def credentials(lib, token_file):
    token = pathlib.Path(token_file).read_text().strip()
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
        'name': 'vyibc-vault_get_config', 'arguments': {'key': 'service:youtube-mcp'}}}).encode()
    with lib.request('https://fleet.vyibc.com/mcp/vault', body, {
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'}) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError('Vault response too large')
    raw = raw.decode()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = json.loads(next(line[6:] for line in raw.splitlines() if line.startswith('data: ')))
    payload = json.loads(next(x['text'] for x in data['result']['content'] if x.get('type') == 'text'))
    cfg = payload['value']
    return json.loads(cfg) if isinstance(cfg, str) else cfg


def target(cfg, digest, origins):
    key = 'studio-dsh/' + digest + '/preview.mp4'
    cdn = cfg['cdn']
    url = cdn.replace('<r2_key>', key) if '<r2_key>' in cdn else cdn.rstrip('/') + '/' + key
    parsed = urllib.parse.urlsplit(url)
    origin = parsed.scheme + '://' + parsed.netloc
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment or origin not in origins or not parsed.path.endswith('/' + key):
        raise ValueError('Public preview origin not allowed')
    return key, url


def verify(lib, url, digest, size):
    deadline = time.monotonic() + 600
    actual, received = hashlib.sha256(), 0
    with lib.request(url) as response:
        if response.status != 200:
            raise ValueError('Public object unavailable')
        while chunk := response.read(1024 * 1024):
            received += len(chunk)
            if received > size or time.monotonic() > deadline:
                raise ValueError('Public object size or deadline exceeded')
            actual.update(chunk)
    if received != size or actual.hexdigest() != digest:
        raise ValueError('Public object hash mismatch')


def run(args, lib):
    if not re.fullmatch(r'[a-f0-9]{64}', args.expected_sha256 or '') or not 0 < args.expected_bytes <= MAX_BYTES:
        raise ValueError('Expected preview identity required')
    content = None
    if args.action == 'upload':
        root, path = pathlib.Path(args.project_root).resolve(), pathlib.Path(args.file).resolve()
        if not path.is_relative_to(root) or path.name != 'preview.mp4' or not path.is_file() or path.stat().st_size != args.expected_bytes:
            raise ValueError('Host snapshot required')
        content = path.read_bytes()
        if len(content) != args.expected_bytes or hashlib.sha256(content).hexdigest() != args.expected_sha256:
            raise ValueError('Host snapshot changed')
    elif args.file or args.project_root:
        raise ValueError('Verify accepts no upload source')
    cfg = credentials(lib, args.vault_token_file)
    key, url = target(cfg, args.expected_sha256, args.allowed_public_origin)
    mode = 'verified_existing'
    if args.action == 'upload':
        mode = lib.put_object(cfg, key, content, 'video/mp4')
    verify(lib, url, args.expected_sha256, args.expected_bytes)
    return {'url': url, 'sha256': args.expected_sha256, 'bytes': args.expected_bytes,
            'public_hash_verified': True, 'upload_mode': mode}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['upload', 'verify'])
    p.add_argument('--file')
    p.add_argument('--project-root')
    p.add_argument('--vault-token-file', required=True)
    p.add_argument('--library-sha256', required=True)
    p.add_argument('--expected-sha256', required=True)
    p.add_argument('--expected-bytes', type=int, required=True)
    p.add_argument('--allowed-public-origin', action='append', required=True)
    args = p.parse_args()
    try:
        result = run(args, load_library(args.library_sha256))
        print(json.dumps(result))
    except Exception:
        # Provider errors may include credentials or private URLs. Unknown means
        # preserve the original intent; never authorize another upload here.
        print(json.dumps({'ok': False, 'state': 'unknown', 'error_code': 'preview_not_verified'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
