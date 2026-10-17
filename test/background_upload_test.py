"""Tests for scripts/background_upload.py with a local mock File Vault server.

Run: python3 -m unittest test/background_upload_test.py
"""
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import background_upload as bu  # noqa: E402

TOKEN = 'sat_test_token'


def make_server(payload, state):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _auth_ok(self):
            return self.headers.get('Authorization') == 'Bearer ' + TOKEN and self.headers.get('X-Requested-With') == 'fetch'

        def do_GET(self):
            if self.path == '/source.bin':
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self._send(404, {'success': False})

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(n) if n else b''
            if not self._auth_ok():
                return self._send(401, {'success': False})
            if self.path == '/api/uploads/init':
                req = json.loads(body)
                state['init'] = req
                return self._send(201, {'success': True, 'data': {
                    'id': 'a' * 32, 'name': req['name'], 'size': req['size'],
                    'chunkBytes': req['chunkBytes'],
                    'chunkCount': -(-req['size'] // req['chunkBytes']), 'missing': [],
                }})
            if self.path.startswith('/api/uploads/' + 'a' * 32 + '/chunks/'):
                idx = int(self.path.rsplit('/', 1)[1])
                if hashlib.sha256(body).hexdigest() != self.headers.get('X-Chunk-Sha256'):
                    return self._send(400, {'success': False, 'error': {'code': 'CHUNK_CORRUPT'}})
                state.setdefault('chunks', {})[idx] = body
                return self._send(200, {'success': True, 'data': {'received': idx}})
            if self.path == '/api/uploads/' + 'a' * 32 + '/complete':
                chunks = state.get('chunks', {})
                joined = b''.join(chunks[i] for i in sorted(chunks))
                state['joined'] = joined
                return self._send(201, {'success': True, 'data': {'file': {'id': 'f' * 32, 'size': len(joined)}}})
            self._send(404, {'success': False})

    srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class BackgroundUploadTest(unittest.TestCase):
    def setUp(self):
        # 600 KiB with 256 KiB pieces -> 3 pieces (256 + 256 + 88)
        self.payload = os.urandom(600 * 1024)
        self.state = {}
        self.srv = make_server(self.payload, self.state)
        self.base = f'http://127.0.0.1:{self.srv.server_address[1]}'
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, 'payload')

    def tearDown(self):
        self.srv.shutdown()
        self.tmp.cleanup()

    def test_download_then_chunked_upload_round_trip(self):
        n = bu.download(f'{self.base}/source.bin', self.src)
        self.assertEqual(n, len(self.payload))
        bu.upload(self.base, TOKEN, self.src, 'clip.mp4', 256 * 1024)
        self.assertEqual(self.state['init']['size'], len(self.payload))
        self.assertEqual(self.state['init']['chunkBytes'], 256 * 1024)
        self.assertEqual(len(self.state['chunks']), 3)
        self.assertEqual(self.state['joined'], self.payload)

    def test_wrong_token_is_rejected_by_the_server(self):
        bu.download(f'{self.base}/source.bin', self.src)
        with self.assertRaises(urllib.error.HTTPError) as cm:
            bu.upload(self.base, 'sat_wrong', self.src, 'clip.mp4', 256 * 1024)
        self.assertEqual(cm.exception.code, 401)
        self.assertNotIn('chunks', self.state)

    def test_bad_input_exits_2(self):
        old = dict(os.environ)
        try:
            cases = [
                {'SOURCE_URL': 'http://insecure.example/a.mp4', 'PIPS_UPLOAD_TOKEN': TOKEN, 'PIPS_BASE': self.base},
                {'SOURCE_URL': 'https://example.com/a.mp4', 'PIPS_UPLOAD_TOKEN': '', 'PIPS_BASE': self.base},
                {'SOURCE_URL': 'https://example.com/a.mp4', 'PIPS_UPLOAD_TOKEN': TOKEN,
                 'PIPS_BASE': 'https://x.trycloudflare.com', 'CHUNK_BYTES': '1000'},
            ]
            for env in cases:
                os.environ.clear()
                os.environ.update(env)
                self.assertEqual(bu.main(), 2, env)
        finally:
            os.environ.clear()
            os.environ.update(old)

    def test_file_name_from_url_and_override(self):
        self.assertEqual(bu.file_name('https://x.example/media/Trip%20Video.mp4?sig=1'), 'Trip Video.mp4')
        self.assertEqual(bu.file_name('https://x.example/download'), 'download.bin')
        os.environ['FILE_NAME'] = 'given.mkv'
        try:
            self.assertEqual(bu.file_name('https://x.example/anything'), 'given.mkv')
        finally:
            del os.environ['FILE_NAME']


if __name__ == '__main__':
    unittest.main()
