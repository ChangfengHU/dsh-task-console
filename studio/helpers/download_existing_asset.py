"""Download an authorized archived asset through Fleet; no generation or secret output.

The installed MCP credential authorizes asset_get. A separate host-owned token
authorizes Fleet's fixed media proxy. Neither credential is substituted for the
other, and a denied proxy request never falls back to another secret.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import urllib.error
import urllib.request
import uuid

MAX_FILE = 20_000_000
ID = re.compile(r'(?:[a-f0-9]{64}|[a-f0-9]{32}-[a-f0-9]{64})\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')
MCP_URL = 'https://fleet.vyibc.com/api/hub/plugin-bootstrap/mcp/vyibc-cartoon-assets'
MEDIA_ORIGIN = 'https://fleet.vyibc.com'
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.m4a', '.ogg', '.mp4', '.webm', '.flac'}


class DownloadError(ValueError):
    def __init__(self, code, next_action=None, http_status=None):
        super().__init__(code)
        self.code = code
        self.next_action = next_action
        self.http_status = http_status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise DownloadError('redirect_denied')


OPENER = urllib.request.build_opener(NoRedirect())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def asset_auth(profile):
    # Same installed-stanza boundary as preflight_host.asset_auth; never export
    # the profile or try other credentials when this transport is unavailable.
    text = Path(profile).read_text()
    match = re.search(r'(?m)^    - id: mcp-vyibc-cartoon-assets\s*\n(.*?)(?=^    - id:|\Z)', text, re.S)
    block = match.group(1) if match else ''
    url = re.search(r'(?m)^\s+url:\s*(\S+)\s*$', block)
    auth = re.search(r'(?m)^\s+Authorization:\s*(.+)\s*$', block)
    if not url or not auth:
        raise DownloadError('installed_asset_transport_missing')
    url, auth = url.group(1).strip('"\''), auth.group(1).strip().strip('"\'')
    if url != MCP_URL or not auth.startswith('Bearer ') or '\n' in auth or '\r' in auth:
        raise DownloadError('installed_asset_transport_unsupported')
    return url, auth


def get_asset(asset_id, profile):
    if not ID.fullmatch(asset_id):
        raise DownloadError('invalid_asset_id')
    url, auth = asset_auth(profile)
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': 'asset_get', 'arguments': {'id': asset_id}}}).encode()
    request = urllib.request.Request(url, body, headers={
        'Authorization': auth, 'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream', 'User-Agent': 'studio-asset-download/1'})
    with OPENER.open(request, timeout=45) as response:
        raw = response.read(4_000_001)
    if len(raw) > 4_000_000:
        raise DownloadError('asset_metadata_response_too_large')
    text = raw.decode()
    if text.lstrip().startswith('{'):
        reply = json.loads(text)
    else:
        messages = []
        for block in text.replace('\r\n', '\n').split('\n\n'):
            data = '\n'.join(line[5:].lstrip() for line in block.splitlines() if line.startswith('data:'))
            if data:
                messages.append(json.loads(data))
        reply = next((v for v in messages if v.get('id') == 1), {})
    if reply.get('id') != 1 or reply.get('error') or reply.get('result', {}).get('isError'):
        raise DownloadError('asset_lookup_failed')
    result = reply.get('result', {})
    value = result.get('structuredContent')
    if value is None:
        value = json.loads(next(c['text'] for c in result.get('content', []) if c.get('type') == 'text'))
    return value


def validate_asset(info, asset_id, purpose):
    if not ID.fullmatch(asset_id) or not isinstance(info, dict):
        raise DownloadError('invalid_asset_metadata')
    asset = info.get('asset', {})
    if asset.get('id') != asset_id:
        raise DownloadError('asset_identity_mismatch')
    obj = asset.get('object')
    if obj is None:
        raise DownloadError('asset_metadata_only', 'Use the actual source and verify project rights, or select another archived asset. Do not invent a file URL.')
    if not isinstance(obj, dict) or not SHA.fullmatch(str(obj.get('sha256', ''))) or type(obj.get('size')) is not int or not 0 < obj['size'] <= MAX_FILE or obj.get('extension') not in EXTENSIONS:
        raise DownloadError('invalid_archived_asset')
    claimed = info.get('download')
    if not isinstance(claimed, dict) or claimed.get('sha256') != obj['sha256'] or claimed.get('size') != obj['size']:
        raise DownloadError('download_metadata_mismatch')
    license = asset.get('license') or {}
    private = license.get('status') == 'user_authorized_private_reference' or license.get('publication') == 'not_for_publication' or license.get('scope') == 'private_reference_only'
    if private and purpose != 'private-reference':
        raise DownloadError('private_reference_not_for_production', 'Use this asset only as an authorized private reference; choose publication assets separately.')
    return obj, private


def output_parts(root, output, extension):
    root = Path(root).absolute()
    if not root.is_dir() or root.resolve() != root:
        raise DownloadError('project_root_must_be_real_directory')
    value = Path(output)
    if value.is_absolute() or not value.parts or any(p in ('.', '..') for p in value.parts) or '\\' in output or '\x00' in output:
        raise DownloadError('output_must_be_project_relative')
    if value.suffix.lower() != extension:
        raise DownloadError('output_extension_mismatch')
    return root, value.parts


def open_parent(root, parts):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def existing_matches(fd, name, obj):
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return False
    with os.fdopen(source, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != obj['size'] or digest(file.read(MAX_FILE + 1)) != obj['sha256']:
            raise DownloadError('output_exists_with_other_bytes')
    return True


def proxy_token(path):
    if not path:
        raise DownloadError('host_token_file_missing', 'Configure STUDIO_VAULT_TOKEN_FILE in the host; never put a token in tool arguments.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'r') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 4096:
            raise DownloadError('host_token_file_not_private')
        token = file.read(4097).strip()
    if not token or '\n' in token or '\r' in token:
        raise DownloadError('invalid_host_token')
    return token


def download(info, asset_id, root, output, token_file, purpose='production'):
    obj, private = validate_asset(info, asset_id, purpose)
    root, parts = output_parts(root, output, obj['extension'])
    fd = open_parent(root, parts)
    receipt = {'ok': True, 'assetId': asset_id, 'kind': info['asset'].get('kind'), 'newGeneration': 0, 'path': str(root.joinpath(*parts)),
               'sha256': obj['sha256'], 'bytes': obj['size'], 'purpose': purpose,
               'private_reference_only': private, 'qualityApproved': False, 'projectRightsApproved': False}
    try:
        if existing_matches(fd, parts[-1], obj):
            return {**receipt, 'reused': True, 'proxyAuthorizationVerifiedThisCall': False}
        request = urllib.request.Request(MEDIA_ORIGIN + '/api/media/assets/' + asset_id + '/file', headers={
            'Authorization': 'Bearer ' + proxy_token(token_file), 'User-Agent': 'studio-asset-download/1'})
        try:
            with OPENER.open(request, timeout=45) as response:
                if response.status != 200:
                    raise DownloadError('unexpected_proxy_status')
                data = response.read(MAX_FILE + 1)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise DownloadError('proxy_authorization_denied', 'Verify the host token is authorized for Fleet Media. Do not substitute the plugin bootstrap token or try another secret.', error.code) from None
            raise
        if len(data) != obj['size'] or digest(data) != obj['sha256']:
            raise DownloadError('download_integrity_failed')
        temp = '.asset-download-' + uuid.uuid4().hex
        target_fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(target_fd, 'wb') as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            try:
                os.link(temp, parts[-1], src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            except FileExistsError:
                if not existing_matches(fd, parts[-1], obj):
                    raise DownloadError('output_concurrent_conflict')
        finally:
            os.unlink(temp, dir_fd=fd)
        return {**receipt, 'reused': False, 'proxyAuthorizationVerifiedThisCall': True}
    finally:
        os.close(fd)


def safe_error(error):
    result = {'ok': False, 'error_code': error.code if isinstance(error, DownloadError) else ('http_error' if isinstance(error, urllib.error.HTTPError) else 'asset_download_failed'), 'qualityApproved': False}
    result['nextAction'] = error.next_action if isinstance(error, DownloadError) and error.next_action else 'Check the recorded asset and host configuration; do not bypass integrity checks or fetch an invented URL.'
    if isinstance(error, urllib.error.HTTPError):
        result['httpStatus'] = error.code
    elif isinstance(error, DownloadError) and error.http_status is not None:
        result['httpStatus'] = error.http_status
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--id', '--asset-id', dest='asset_id', required=True)
    parser.add_argument('--project-root', required=True)
    parser.add_argument('--output', required=True, help='New project-relative file; existing matching bytes can be reused')
    parser.add_argument('--vault-token-file', default=os.environ.get('STUDIO_VAULT_TOKEN_FILE'), help='Host-owned private token file; never pass token values')
    parser.add_argument('--dsh-profile', default='/home/claude/.dsh/profiles/web/cordis.patch.yml')
    parser.add_argument('--purpose', choices=['production', 'private-reference'], default='production')
    args = parser.parse_args()
    try:
        info = get_asset(args.asset_id, args.dsh_profile)
        result = download(info, args.asset_id, args.project_root, args.output, args.vault_token_file, args.purpose)
    except Exception as error:
        print(json.dumps(safe_error(error), ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
