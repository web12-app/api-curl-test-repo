#!/usr/bin/env python3
"""Background URL upload for a workflow runner.

Downloads one https URL and sends it to File Vault in numbered pieces
(init -> chunks -> complete), authenticated with a Bearer API token (sat_...).

Quiet by design: nothing is printed. The exit code is the only result:
  0 uploaded, 1 failed, 2 bad input.

Environment:
  SOURCE_URL          required, https URL to download
  PIPS_UPLOAD_TOKEN   required, sat_ API token of the account that owns the file
  PIPS_BASE           optional https origin. Default: the `url` in live-url.json
  FILE_NAME           optional file name with an extension (default: from the URL)
  CHUNK_BYTES         optional piece size, 256 KiB to 8 MiB (default 8 MiB)
"""
import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

LIVE_SOURCE = (
    'https://api.github.com/repos/web12-app/api-curl-test-repo/contents/live-url.json?ref=live-url'
)
MIB = 1024 * 1024
MAX_BYTES = 2 * 1024 * MIB  # the server's per-file ceiling
MIN_CHUNK = 256 * 1024
MAX_CHUNK = 8 * MIB
TIMEOUT = 120
RETRIES = 3


class Fail(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def resolve_base():
    base = os.environ.get('PIPS_BASE', '').strip()
    if not base:
        req = urllib.request.Request(LIVE_SOURCE, headers={'Accept': 'application/vnd.github.raw+json'})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            base = str(json.loads(r.read()).get('url', ''))
    base = base.strip().rstrip('/')
    if not base.startswith('https://') or len(base) < len('https://a.bc'):
        raise Fail(2)
    return base


def file_name(url):
    given = os.environ.get('FILE_NAME', '').strip()
    if given:
        return given
    base = urllib.parse.unquote(os.path.basename(urllib.parse.urlsplit(url).path)) or 'download'
    return base if '.' in base else base + '.bin'


def download(url, dest):
    """Streams the URL into dest. Raises Fail(1) when empty or over the size limit."""
    req = urllib.request.Request(url, headers={'User-Agent': 'pips-background-upload'})
    total = 0
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r, open(dest, 'wb') as f:
        while True:
            block = r.read(MIB)
            if not block:
                break
            total += len(block)
            if total > MAX_BYTES:
                raise Fail(1)
            f.write(block)
    if total == 0:
        raise Fail(1)
    return total


def api(method, url, token, body=None, raw=None, headers=None):
    h = {'Authorization': 'Bearer ' + token, 'X-Requested-With': 'fetch', 'Accept': 'application/json'}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        out = r.read()
    env = json.loads(out) if out else {}
    if env.get('success') is False:
        raise Fail(1)
    return env.get('data', env)


def upload(base, token, path, name, chunk_bytes):
    size = os.path.getsize(path)
    count = -(-size // chunk_bytes)
    view = api('POST', f'{base}/api/uploads/init', token, body={
        'uploadId': str(uuid.uuid4()), 'name': name, 'size': size, 'chunkBytes': chunk_bytes,
    })
    sid = view['id']
    with open(path, 'rb') as f:
        for i in range(count):
            piece = f.read(chunk_bytes)
            sha = hashlib.sha256(piece).hexdigest()
            for attempt in range(RETRIES):
                try:
                    api('POST', f'{base}/api/uploads/{sid}/chunks/{i}', token, raw=piece, headers={
                        'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha,
                    })
                    break
                except (urllib.error.URLError, Fail):
                    if attempt == RETRIES - 1:
                        raise Fail(1)
                    time.sleep(2 ** attempt)
    done = api('POST', f'{base}/api/uploads/{sid}/complete', token, raw=b'')
    if not done.get('file'):
        raise Fail(1)
    return done['file']


def main():
    try:
        src = os.environ.get('SOURCE_URL', '').strip()
        token = os.environ.get('PIPS_UPLOAD_TOKEN', '').strip()
        if not src.startswith('https://') or not token:
            raise Fail(2)
        chunk = int(os.environ.get('CHUNK_BYTES') or MAX_CHUNK)
        if not MIN_CHUNK <= chunk <= MAX_CHUNK:
            raise Fail(2)
        base = resolve_base()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'payload')
            download(src, path)
            upload(base, token, path, file_name(src), chunk)
        return 0
    except Fail as e:
        return e.code
    except Exception:
        return 1


if __name__ == '__main__':
    sys.exit(main())
