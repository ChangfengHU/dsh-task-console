"""Upload studio artifacts; never expose Vault credentials or signed requests."""
import argparse, contextlib, datetime, hashlib, hmac, json, math, mimetypes
import pathlib, sys, time, urllib.error, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

MULTIPART_THRESHOLD = 32 * 1024 * 1024
PART_BYTES = 16 * 1024 * 1024


def request(url, body=None, headers=None, method=None):
    req = urllib.request.Request(url, data=body, headers={
        'User-Agent': 'studio-delivery/2', **(headers or {})}, method=method)
    return urllib.request.urlopen(req, timeout=180)


def progress(stage, **fields):
    print(json.dumps({'stage': stage, **fields}), file=sys.stderr, flush=True)


@contextlib.contextmanager
def stage(name):
    try:
        yield
    except Exception as error:
        if not hasattr(error, 'studio_stage'):
            error.studio_stage = name
        raise


def safe_error(error):
    result = {'ok': False, 'error_type': type(error).__name__}
    if hasattr(error, 'studio_stage'):
        result['stage'] = error.studio_stage
    if isinstance(error, urllib.error.HTTPError):
        result['http_status'] = error.code
    reason = getattr(error, 'reason', None)
    if reason is not None:
        result['reason_type'] = type(reason).__name__
        errno = getattr(reason, 'errno', None)
        if isinstance(errno, int):
            result['errno'] = errno
    # Do not stringify provider exceptions: reasons can contain URLs or headers.
    return result


def signed_s3_request(cfg, key, method, content=b'', query=(), content_type=None):
    host = cfg['account_id'] + '.r2.cloudflarestorage.com'
    uri = '/' + urllib.parse.quote(cfg['R2_BUCKET'] + '/' + key, safe='/')
    encoded = sorted((urllib.parse.quote(str(k), safe='-_.~'),
                      urllib.parse.quote(str(v), safe='-_.~')) for k, v in query)
    canonical_query = '&'.join(k + '=' + v for k, v in encoded)
    now = datetime.datetime.now(datetime.timezone.utc)
    date, amz = now.strftime('%Y%m%d'), now.strftime('%Y%m%dT%H%M%SZ')
    digest = hashlib.sha256(content).hexdigest()
    headers = {'host': host, 'x-amz-date': amz, 'x-amz-content-sha256': digest}
    signed = ';'.join(sorted(headers))
    canonical_headers = ''.join(k + ':' + headers[k] + '\n' for k in sorted(headers))
    canonical = '\n'.join([method, uri, canonical_query, canonical_headers, signed, digest])
    scope = date + '/auto/s3/aws4_request'
    to_sign = 'AWS4-HMAC-SHA256\n' + amz + '\n' + scope + '\n' + hashlib.sha256(canonical.encode()).hexdigest()
    def sign(k, s):
        return hmac.new(k, s.encode(), hashlib.sha256).digest()
    signing = sign(sign(sign(sign(('AWS4' + cfg['R2_SECRET_ACCESS_KEY']).encode(), date), 'auto'), 's3'), 'aws4_request')
    signature = hmac.new(signing, to_sign.encode(), hashlib.sha256).hexdigest()
    headers['Authorization'] = ('AWS4-HMAC-SHA256 Credential=' + cfg['R2_ACCESS_KEY_ID'] + '/' + scope
                                + ', SignedHeaders=' + signed + ', Signature=' + signature)
    if content_type:
        headers['Content-Type'] = content_type
    url = 'https://' + host + uri + ('?' + canonical_query if canonical_query else '')
    return request(url, content, headers, method)


def put_object(cfg, key, content, content_type):
    if len(content) <= MULTIPART_THRESHOLD:
        with stage('single_put'):
            progress('uploading', bytes=len(content))
            with signed_s3_request(cfg, key, 'PUT', content, content_type=content_type) as response:
                if response.status not in (200, 201):
                    raise RuntimeError('Unexpected object upload status')
        return 'single_put'

    upload_id = None
    try:
        with stage('multipart_create'):
            progress('multipart_create', bytes=len(content))
            with signed_s3_request(cfg, key, 'POST', query=[('uploads', '')], content_type=content_type) as response:
                if response.status != 200:
                    raise RuntimeError('Unexpected multipart create status')
                root = ET.fromstring(response.read(1024 * 1024))
            upload_id = root.findtext('.//{*}UploadId')
            if not upload_id:
                raise RuntimeError('Multipart create omitted upload ID')
        parts = []
        total = math.ceil(len(content) / PART_BYTES)
        for offset in range(0, len(content), PART_BYTES):
            number = len(parts) + 1
            body = content[offset:offset + PART_BYTES]
            with stage('multipart_part'):
                progress('multipart_part', part=number, parts=total, bytes=len(body))
                with signed_s3_request(cfg, key, 'PUT', body,
                        [('partNumber', number), ('uploadId', upload_id)]) as response:
                    if response.status != 200:
                        raise RuntimeError('Unexpected multipart part status')
                    etag = response.headers.get('ETag')
                    if not etag:
                        raise RuntimeError('Multipart part omitted ETag')
                parts.append((number, etag))
        with stage('multipart_complete'):
            progress('multipart_complete', parts=len(parts), bytes=len(content))
            root = ET.Element('CompleteMultipartUpload')
            for number, etag in parts:
                part = ET.SubElement(root, 'Part')
                ET.SubElement(part, 'PartNumber').text = str(number)
                ET.SubElement(part, 'ETag').text = etag
            body = ET.tostring(root, encoding='utf-8')
            with signed_s3_request(cfg, key, 'POST', body,
                    [('uploadId', upload_id)], content_type='application/xml') as response:
                if response.status != 200:
                    raise RuntimeError('Unexpected multipart complete status')
                result = ET.fromstring(response.read(1024 * 1024))
            if result.tag.rsplit('}', 1)[-1] != 'CompleteMultipartUploadResult':
                raise RuntimeError('Multipart completion did not confirm object')
        return 'multipart'
    except Exception:
        if upload_id:
            try:
                with signed_s3_request(cfg, key, 'DELETE', query=[('uploadId', upload_id)]) as response:
                    if response.status not in (200, 204, 404):
                        raise RuntimeError('Unexpected multipart abort status')
                progress('multipart_aborted')
            except Exception as abort_error:
                progress('multipart_abort_failed', error=safe_error(abort_error))
        raise


def upload(file, root, token_file):
    path, root = pathlib.Path(file).resolve(), pathlib.Path(root).resolve()
    with stage('artifact_preflight'):
        if not path.is_relative_to(root) or path.suffix.lower() not in {'.mp4', '.png', '.jpg', '.html', '.json', '.md', '.zip', '.gz'}:
            raise ValueError('File outside project or unsupported artifact')
        before = path.stat()
        if not path.is_file() or before.st_size > 500_000_000:
            raise ValueError('Artifact missing or too large')
        content = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(content) != before.st_size:
            raise ValueError('Artifact changed while reading')
    with stage('resolve_delivery_credentials'):
        progress('resolve_delivery_credentials')
        token = pathlib.Path(token_file).read_text().strip()
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
            'name': 'vyibc-vault_get_config', 'arguments': {'key': 'service:youtube-mcp'}}}).encode()
        with request('https://fleet.vyibc.com/mcp/vault', body, {
                'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'}) as response:
            raw = response.read().decode()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = json.loads(next(line[6:] for line in raw.splitlines() if line.startswith('data: ')))
        payload = json.loads(next(x['text'] for x in data['result']['content'] if x.get('type') == 'text'))
        cfg = payload['value']
        cfg = json.loads(cfg) if isinstance(cfg, str) else cfg
    digest = hashlib.sha256(content).hexdigest()
    key = 'studio-dsh/' + digest[:12] + '/' + path.name
    mode = put_object(cfg, key, content, mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
    encoded_key = urllib.parse.quote(key, safe='/')
    cdn = cfg['cdn']
    url = cdn.replace('<r2_key>', encoded_key) if '<r2_key>' in cdn else cdn.rstrip('/') + '/' + encoded_key
    with stage('public_verify'):
        progress('verifying_public', bytes=len(content))
        deadline = time.monotonic() + 600
        with request(url) as response:
            check, received = hashlib.sha256(), 0
            while chunk := response.read(1024 * 1024):
                check.update(chunk)
                received += len(chunk)
                if received % (4 * 1024 * 1024) == 0:
                    progress('verifying_public', received=received, bytes=len(content))
                if time.monotonic() > deadline:
                    raise TimeoutError('Public verification exceeded deadline')
        if received != len(content) or check.hexdigest() != digest:
            raise RuntimeError('Public artifact hash mismatch')
    return {'url': url, 'sha256': digest, 'bytes': len(content), 'public_hash_verified': True, 'upload_mode': mode}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('--project-root', required=True)
    parser.add_argument('--vault-token-file', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(upload(args.file, args.project_root, args.vault_token_file)))
    except Exception as error:
        print(json.dumps(safe_error(error)))
        raise SystemExit(1)
