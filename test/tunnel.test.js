'use strict';

// Pips Tunnel: the /tun/<name> reverse proxy, the client gateway API, the
// tunnel.tar.gz download, and the /tun landing page. Fast timers via env so
// the timeout paths run in milliseconds, plus direct unit tests of the
// Tunnels service with a stepped clock for TTL logic.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, TEST_ENV } = require('./helpers');
const { Tunnels } = require('../src/tunnel');

const FAST_ENV = {
  ...TEST_ENV,
  TUNNEL_WAIT_MS: '400',
  TUNNEL_POLL_WAIT_MS: '150',
  TUNNEL_TTL_MS: '900',
};

const TUN_JS = path.join(__dirname, '..', 'tunnel-client', 'tun.js');
const JSONH = { 'Content-Type': 'application/json' };
const runSh = promisify(execFile); // async: the in-process test server must serve curl during the installer run

async function register(base, name) {
  const res = await fetch(`${base}/api/tunnel/register`, { method: 'POST', headers: JSONH, body: JSON.stringify({ name }) });
  return { status: res.status, json: await res.json() };
}

// A tiny upstream app: echoes method, path and body back as JSON.
function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
        res.end(JSON.stringify({ url: req.url, method: req.method, body: body || null }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

// Poll until a forwarded request shows up (the visitor request races the poll).
async function pollUntil(base, name, clientId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/api/tunnel/poll?name=${encodeURIComponent(name)}&client=${encodeURIComponent(clientId)}`);
    const json = await res.json();
    if (res.status !== 200) return { status: res.status, json };
    if (json.data && json.data.request) return { status: res.status, json };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { status: 200, json: { data: { request: null } } };
}

describe('tunnel.tar.gz download', () => {
  test('serves a valid gzip tarball that untars into the client', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const res = await fetch(`${app.base}/api/tunnel/client.tar.gz`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/gzip');
      assert.match(res.headers.get('content-disposition') || '', /filename="tunnel\.tar\.gz"/);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf[0], 0x1f, 'gzip magic 1');
      assert.equal(buf[1], 0x8b, 'gzip magic 2');
      assert.ok(buf.length > 4000, `tarball looks too small: ${buf.length}`);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-pkg-'));
      const file = path.join(dir, 'tunnel.tar.gz');
      fs.writeFileSync(file, buf);
      execFileSync('tar', ['-xzf', file, '-C', dir]);
      const tunJs = fs.readFileSync(path.join(dir, 'tunnel', 'tun.js'), 'utf8');
      const readme = fs.readFileSync(path.join(dir, 'tunnel', 'README.md'), 'utf8');
      const tunSh = fs.readFileSync(path.join(dir, 'tunnel', 'tun'), 'utf8');
      assert.match(tunJs, /api\/tunnel\/register/);
      assert.match(tunJs, /precision-pledge-fled\.ngrok-free\.dev/, 'default server baked in');
      assert.match(readme, /tun start 5000 test/);
      assert.match(tunSh, /tun\.js/);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  });

  test('honors If-None-Match with 304', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const first = await fetch(`${app.base}/api/tunnel/client.tar.gz`);
      const etag = first.headers.get('etag');
      assert.ok(etag);
      const second = await fetch(`${app.base}/api/tunnel/client.tar.gz`, { headers: { 'If-None-Match': etag } });
      assert.equal(second.status, 304);
    } finally {
      await app.close();
    }
  });
});

describe('/tun landing page', () => {
  test('renders quickstart and live tunnels', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      await register(app.base, 'alpha');
      const res = await fetch(`${app.base}/tun`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /tunnel\.tar\.gz/);
      assert.match(html, /tun start 5000 test/);
      assert.match(html, /\/tun\/alpha/);
    } finally {
      await app.close();
    }
  });
});

describe('tunnel gateway API', () => {
  test('register returns a client id; invalid names are refused', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const good = await register(app.base, 'Test_App-1');
      assert.equal(good.status, 201);
      assert.equal(good.json.success, true);
      assert.equal(good.json.data.name, 'test_app-1', 'names are normalized to lowercase');
      assert.match(good.json.data.clientId, /^[0-9a-f]{24}$/);

      const bad = await register(app.base, 'Bad Name!');
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'INVALID_NAME');

      const missing = await register(app.base, '');
      assert.equal(missing.status, 400);
    } finally {
      await app.close();
    }
  });

  test('list shows connected tunnels with counters', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      await register(app.base, 'alpha');
      await register(app.base, 'beta');
      const res = await fetch(`${app.base}/api/tunnel/list`);
      const json = await res.json();
      assert.deepEqual(json.data.tunnels.map((t) => t.name), ['alpha', 'beta']);
      for (const t of json.data.tunnels) {
        assert.equal(t.pending, 0);
        assert.equal(t.served, 0);
        assert.equal(t.answered, 0);
        assert.ok(Number.isFinite(t.ageMs));
      }
    } finally {
      await app.close();
    }
  });

  test('poll blocks, then returns a null request', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const reg = await register(app.base, 'quiet');
      const clientId = reg.json.data.clientId;
      const t0 = Date.now();
      const res = await fetch(`${app.base}/api/tunnel/poll?name=quiet&client=${clientId}`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.data.request, null);
      assert.ok(Date.now() - t0 >= 100, 'poll waits for pollWaitMs instead of spinning');
    } finally {
      await app.close();
    }
  });

  test('close drops the tunnel', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const reg = await register(app.base, 'short');
      const clientId = reg.json.data.clientId;
      const close = await fetch(`${app.base}/api/tunnel/close`, { method: 'POST', headers: JSONH, body: JSON.stringify({ name: 'short', client: clientId }) });
      assert.deepEqual(await close.json(), { success: true, data: { closed: true } });
      const poll = await fetch(`${app.base}/api/tunnel/poll?name=short&client=${clientId}`);
      assert.equal(poll.status, 410);
      assert.equal((await poll.json()).error.code, 'TUNNEL_OFFLINE');
      const again = await fetch(`${app.base}/api/tunnel/close`, { method: 'POST', headers: JSONH, body: JSON.stringify({ name: 'short' }) });
      assert.deepEqual(await again.json(), { success: true, data: { closed: false } });
    } finally {
      await app.close();
    }
  });

  test('a second register takes the name over; the old client is told', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const first = await register(app.base, 'dup');
      const second = await register(app.base, 'dup');
      assert.notEqual(first.json.data.clientId, second.json.data.clientId);
      const poll = await fetch(`${app.base}/api/tunnel/poll?name=dup&client=${first.json.data.clientId}`);
      assert.equal(poll.status, 410);
      assert.equal((await poll.json()).error.code, 'TUNNEL_REPLACED');
      const poll2 = await fetch(`${app.base}/api/tunnel/poll?name=dup&client=${second.json.data.clientId}`);
      assert.equal(poll2.status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('/tun/<name> reverse proxy', () => {
  test('forwards method, stripped path, headers and body; the upstream answer comes back', async () => {
    const app = await startServer({ env: FAST_ENV });
    const up = await startUpstream();
    try {
      const reg = await register(app.base, 'test');
      const clientId = reg.json.data.clientId;

      const visitor = fetch(`${app.base}/tun/test/hello?x=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Custom': 'abc' },
        body: 'ping-body',
      });

      const picked = await pollUntil(app.base, 'test', clientId);
      assert.equal(picked.status, 200, JSON.stringify(picked.json));
      const req = picked.json.data.request;
      assert.equal(req.method, 'POST');
      assert.equal(req.path, '/hello?x=1', 'the /tun/<name> prefix is stripped');
      assert.equal(req.headers['x-custom'], 'abc');
      assert.ok(!req.headers.host, 'the Host header is not forwarded');
      assert.equal(Buffer.from(req.body, 'base64').toString(), 'ping-body');

      // The client's job: call the local app and post its answer back.
      const upstream = await fetch(`http://127.0.0.1:${up.port}${req.path}`, {
        method: req.method,
        headers: req.headers,
        body: Buffer.from(req.body, 'base64'),
      });
      const answer = await fetch(`${app.base}/api/tunnel/respond`, {
        method: 'POST',
        headers: JSONH,
        body: JSON.stringify({
          name: 'test',
          client: clientId,
          id: req.id,
          status: upstream.status,
          headers: Object.fromEntries(upstream.headers),
          body: Buffer.from(await upstream.arrayBuffer()).toString('base64'),
        }),
      });
      assert.deepEqual(await answer.json(), { success: true, data: { delivered: true } });

      const vis = await visitor;
      assert.equal(vis.status, 200);
      assert.equal(vis.headers.get('x-upstream'), 'yes');
      const echoed = await vis.json();
      assert.equal(echoed.url, '/hello?x=1', 'the local app saw the stripped path');
      assert.equal(echoed.method, 'POST');
      assert.equal(echoed.body, 'ping-body');
    } finally {
      await app.close();
      await up.close();
    }
  });

  test('an unknown app name answers 404', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const res = await fetch(`${app.base}/tun/ghost`);
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });

  test('a connected but silent client yields 504 TUNNEL_TIMEOUT', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      await register(app.base, 'slow');
      const t0 = Date.now();
      const res = await fetch(`${app.base}/tun/slow`);
      assert.equal(res.status, 504);
      assert.ok(Date.now() - t0 < 5000, 'the fast env keeps the wait short');
    } finally {
      await app.close();
    }
  });

  test('a queued request counts as pending/served in the list', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      await register(app.base, 'busy');
      const visitor = fetch(`${app.base}/tun/busy/one`);
      await new Promise((r) => setTimeout(r, 120));
      const list = await (await fetch(`${app.base}/api/tunnel/list`)).json();
      const busy = list.data.tunnels.find((t) => t.name === 'busy');
      assert.equal(busy.served, 1);
      assert.equal(busy.pending, 1);
      await visitor;
    } finally {
      await app.close();
    }
  });
});

describe('tunnel client CLI (tunnel-client/tun.js)', () => {
  test('--help exits 0 and documents start', () => {
    const out = execFileSync(process.execPath, [TUN_JS, '--help'], { encoding: 'utf8' });
    assert.match(out, /tun start <port> <app-name>/);
    assert.match(out, /tunnel\.tar\.gz/);
  });

  test('rejects a malformed app name', () => {
    try {
      execFileSync(process.execPath, [TUN_JS, 'start', '5000', 'BAD NAME!'], { encoding: 'utf8' });
      assert.fail('should have exited non-zero');
    } catch (err) {
      assert.match(String(err.stderr), /app name must be 1-32 chars/);
    }
  });

  test('rejects a missing port', () => {
    try {
      execFileSync(process.execPath, [TUN_JS, 'start', 'test'], { encoding: 'utf8' });
      assert.fail('should have exited non-zero');
    } catch (err) {
      assert.match(String(err.stderr), /start needs a port/);
    }
  });
});

describe('tunnel.sh installer', () => {
  test('serves a valid sh script pinned to the server it came from', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const res = await fetch(`${app.base}/tunnel.sh`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /shellscript/);
      const body = await res.text();
      assert.match(body, /client\.tar\.gz/);
      assert.match(body, /tar -xzf/);
      assert.ok(body.includes(app.base), 'the installer defaults to the server that served it');
      assert.ok(!body.includes('\r\n'), 'no CRLF: the script must stay sh-safe');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tun-sh-'));
      const f = path.join(dir, 'tunnel.sh');
      fs.writeFileSync(f, body);
      execFileSync('sh', ['-n', f]); // syntax check
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  });

  test('running the installer installs a working client', async () => {
    const app = await startServer({ env: FAST_ENV });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tun-home-'));
    try {
      const body = await (await fetch(`${app.base}/tunnel.sh`)).text();
      const inst = path.join(home, 'inst.sh');
      fs.writeFileSync(inst, body);
      await runSh('sh', [inst], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, TUNNEL_HOME: path.join(home, '.pips-tunnel'), TUN_SERVER: app.base },
      });
      const dest = path.join(home, '.pips-tunnel');
      const help = execFileSync(process.execPath, [path.join(dest, 'tun.js'), '--help'], { encoding: 'utf8' });
      assert.match(help, /tun start <port> <app-name>/);
      assert.ok(fs.statSync(path.join(dest, 'tun')).mode & 0o111, 'the tun wrapper is executable');
      assert.ok(fs.existsSync(path.join(home, 'README.md')) === false, 'nothing leaked outside TUNNEL_HOME');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      await app.close();
    }
  });
});

describe('Tunnels service (unit)', () => {
  test('sweep drops tunnels idle beyond ttl', () => {
    let now = 1000;
    const tunnels = new Tunnels({ now: () => now, waitMs: 50, pollWaitMs: 50, ttlMs: 1000 });
    tunnels.register('x');
    now += 1500;
    assert.equal(tunnels.get('x'), null);
    assert.deepEqual(tunnels.list(), []);
  });

  test('waiters time out and stale queue entries are swept', async () => {
    let now = 1000;
    const tunnels = new Tunnels({ now: () => now, waitMs: 50, pollWaitMs: 50, ttlMs: 60000 });
    const { clientId } = tunnels.register('y');
    const fwd = tunnels.forward({ name: 'y', method: 'GET', path: '/', headers: {}, body: '' });
    await assert.rejects(fwd, { status: 504, code: 'TUNNEL_TIMEOUT' });
    now += 3000; // past waitMs + grace: sweep drops the queued entry nobody picked up
    const t = tunnels.get('y');
    assert.ok(t, 'the tunnel itself is still fresh');
    assert.equal(t.queue.length, 0, 'stale queue entry swept');
    assert.equal(clientId, t.clientId);
  });

  test('forward wakes a waiting poll; respond resolves the proxy', async () => {
    const tunnels = new Tunnels({ waitMs: 2000, pollWaitMs: 2000 });
    const { clientId } = tunnels.register('w');
    const poll = tunnels.poll('w', clientId);
    const fwd = tunnels.forward({ name: 'w', method: 'GET', path: '/a', headers: { 'x-a': 'b' }, body: '' });
    const out = await poll;
    assert.equal(out.request.path, '/a');
    assert.equal(tunnels.respond('w', clientId, out.request.id, { status: 201, headers: { 'content-type': 'text/plain' }, body: 'hi' }).delivered, true);
    assert.deepEqual(await fwd, { status: 201, headers: { 'content-type': 'text/plain' }, body: 'hi' });
  });
});
