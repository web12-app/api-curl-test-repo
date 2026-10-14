'use strict';

// CLI window (G11-G17): --name flag, honest startup banner, local probe,
// register body with port/proto, status/logs/doctor/close commands and the
// cloudflared Quick Tunnel wrapper. Pattern: in-process test server +
// spawned `node tun.js ...` processes (same CLI as tunnel.test.js uses).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, TEST_ENV } = require('./helpers');

const FAST_ENV = {
  ...TEST_ENV,
  TUNNEL_WAIT_MS: '800',
  TUNNEL_POLL_WAIT_MS: '120',
  TUNNEL_TTL_MS: '20000',
  TUNNEL_SAVE_MS: '20',
};

const TUN_JS = path.join(__dirname, '..', 'tunnel-client', 'tun.js');
const JSONH = { 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny upstream app: echoes method, path and body back as JSON.
function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: req.url, method: req.method, body: body || null }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

async function register(base, body, token) {
  const headers = token ? { ...JSONH, Authorization: `Bearer ${token}` } : JSONH;
  const res = await fetch(`${base}/api/tunnel/register`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function createAccount(base) {
  const res = await fetch(`${base}/api/tunnel/account`, { method: 'POST', headers: JSONH, body: JSON.stringify({}) });
  const json = await res.json();
  return { status: res.status, json, token: json.data && json.data.token };
}

async function pollUntil(base, name, clientId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/api/tunnel/poll?name=${encodeURIComponent(name)}&client=${encodeURIComponent(clientId)}`);
    const json = await res.json();
    if (res.status !== 200) return { status: res.status, json };
    if (json.data && json.data.request) return { status: res.status, json };
    await sleep(50);
  }
  return { status: 200, json: { data: { request: null } } };
}

function spawnCli(args, env = {}) {
  const child = spawn(process.execPath, [TUN_JS, ...args], {
    env: { ...process.env, TUN_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { state.stdout += c; });
  child.stderr.on('data', (c) => { state.stderr += c; });
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => resolve({ code: -1, error: err }));
  });
  return { child, state, exited };
}

async function waitFor(fn, ms = 12000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}

async function runCli(args, env = {}, timeoutMs = 20000) {
  const cli = spawnCli(args, env);
  const killer = setTimeout(() => { try { cli.child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
  const r = await cli.exited;
  clearTimeout(killer);
  return { ...r, stdout: cli.state.stdout, stderr: cli.state.stderr };
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tun-cli-home-'));

// A port that is (almost certainly) closed: bind, read, release.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('tun CLI v4', () => {
  test('G11/G12/G14: --name start honors the name, sends port+proto 2, prints the honest banner', async () => {
    const app = await startServer({ env: FAST_ENV });
    const up = await startUpstream();
    const home = tmpHome();
    try {
      const acc = await createAccount(app.base);
      const cli = spawnCli(['start', '--name', 'cliX', String(up.port), '--server', app.base], { TUNNEL_HOME: home, TUN_TOKEN: acc.token });
      assert.ok(
        await waitFor(() => cli.state.stdout.includes('Status: Connected')),
        `the CLI never connected:\n${cli.state.stdout}\n${cli.state.stderr}`,
      );
      assert.match(cli.state.stdout, /Pips Tunnel/);
      assert.match(cli.state.stdout, /Application registered\./);
      assert.match(cli.state.stdout, /Public URL:\n\s*\S+\/tun\/clix/);
      assert.match(cli.state.stdout, /Status: Connected$/m);
      const list = await (await fetch(`${app.base}/api/tunnel/list`)).json();
      const row = (list.data.tunnels || []).find((t) => t.name === 'clix');
      assert.ok(row, 'clix is connected');
      assert.equal(row.port, up.port, 'the local port travels with the register');
      assert.equal(row.proto, 2);
      cli.child.kill('SIGTERM');
      assert.equal((await cli.exited).code, 0, 'SIGTERM closes the tunnel and exits 0');

      // the name-first positional form still works
      const cli2 = spawnCli(['start', 'cliy', String(up.port), '--server', app.base], { TUNNEL_HOME: home, TUN_TOKEN: acc.token });
      assert.ok(await waitFor(() => cli2.state.stdout.includes('Status: Connected')));
      const list2 = await (await fetch(`${app.base}/api/tunnel/list`)).json();
      assert.ok((list2.data.tunnels || []).some((t) => t.name === 'cliy'), 'name-first positional kept working');
      cli2.child.kill('SIGTERM');
      await cli2.exited;
    } finally {
      await app.close();
      await up.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('G13: nothing listening on the local port is a warning, not a failure', async () => {
    const app = await startServer({ env: FAST_ENV });
    const home = tmpHome();
    try {
      const port = await freePort();
      const cli = spawnCli(['start', String(port), '--server', app.base], { TUNNEL_HOME: home });
      assert.ok(
        await waitFor(() => cli.state.stdout.includes('nothing is listening') && cli.state.stdout.includes('Status: Connected')),
        `expected warn + connect:\n${cli.state.stdout}\n${cli.state.stderr}`,
      );
      assert.match(cli.state.stdout, /warn: nothing is listening on http:\/\/127\.0\.0\.1:\d+ yet — continuing anyway/);
      const list = await (await fetch(`${app.base}/api/tunnel/list`)).json();
      assert.equal(list.data.tunnels.length, 1, 'the tunnel registered anyway');
      cli.child.kill('SIGTERM');
      await cli.exited;
    } finally {
      await app.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('G15: status lists tunnels LIVE with port/proto; a down server exits 1 honestly', async () => {
    const app = await startServer({ env: FAST_ENV });
    const home = tmpHome();
    try {
      const reg = await register(app.base, { name: 'statme', port: 5000 });
      const name = reg.json.data.name;
      const all = await runCli(['status', '--server', app.base], { TUNNEL_HOME: home });
      assert.equal(all.code, 0, `status run: ${all.stderr}`);
      assert.match(all.stdout, new RegExp(`${name}\\s+LIVE`));
      assert.match(all.stdout, /127\.0\.0\.1:5000 \(proto 1\)/);
      const one = await runCli(['status', name, '--server', app.base], { TUNNEL_HOME: home });
      assert.equal(one.code, 0);
      assert.match(one.stdout, /LIVE/);
      const miss = await runCli(['status', 'nosuch', '--server', app.base], { TUNNEL_HOME: home });
      assert.equal(miss.code, 0);
      assert.match(miss.stdout, /nosuch\s+OFFLINE \(not connected\)/);
    } finally {
      await app.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    const dead = await freePort();
    const down = await runCli(['status', '--server', `http://127.0.0.1:${dead}`], { TUNNEL_HOME: tmpHome() });
    assert.equal(down.code, 1, 'a down server exits 1');
    assert.match(down.stderr, /cannot reach/);
  });

  test('G15: doctor — exit 0 with the server up (node/server lines), exit 1 when it is down', async () => {
    const app = await startServer({ env: FAST_ENV });
    const home = tmpHome();
    try {
      const up = await runCli(['doctor', '--server', app.base, '--port', '1'], { TUNNEL_HOME: home, TUN_CLOUDFLARED_BIN: '/bin/true' });
      assert.equal(up.code, 0, `doctor up:\n${up.stdout}\n${up.stderr}`);
      assert.match(up.stdout, /✓ node \d/);
      assert.match(up.stdout, /server \S+ — reachable/);
      assert.match(up.stdout, /cloudflared/);
      assert.match(up.stdout, /local port 1/);
    } finally {
      await app.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    const dead = await freePort();
    const down = await runCli(['doctor', '--server', `http://127.0.0.1:${dead}`], { TUNNEL_HOME: tmpHome(), TUN_CLOUDFLARED_BIN: '/nonexistent-cf' });
    assert.equal(down.code, 1, 'a down server is the only doctor failure');
    assert.match(down.stdout, /✗ server \S+ — unreachable/);
    assert.match(down.stdout, /tunneling will not work/);
  });

  test('G16: cloudflared — prints the real captured URL, SIGTERM stops the child', async () => {
    const app = await startServer({ env: FAST_ENV });
    const home = tmpHome();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tun-cf-'));
    const script = path.join(dir, 'fake-cloudflared.sh');
    const pidfile = path.join(dir, 'child.pid');
    fs.writeFileSync(script, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "cloudflared version 2024.5.0 (fake)"; exit 0; fi',
      'echo $$ > "$CF_PIDFILE" 2>/dev/null || true',
      'echo "2024-05-01T00:00:00Z INF +-----------------------------------------------------------+" >&2',
      'echo "2024-05-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at:          |" >&2',
      'echo "2024-05-01T00:00:00Z INF |  https://test-host-abc123.trycloudflare.com" >&2',
      'sleep 30',
    ].join('\n'));
    fs.chmodSync(script, 0o755);
    try {
      const cli = spawnCli(['cloudflared', '--url', 'http://127.0.0.1:1', '--server', app.base], {
        TUNNEL_HOME: home, TUN_CLOUDFLARED_BIN: script, CF_PIDFILE: pidfile,
      });
      assert.ok(
        await waitFor(() => cli.state.stdout.includes('test-host-abc123.trycloudflare.com') && cli.state.stdout.includes('Cloudflare Quick Tunnel'), 8000),
        `the URL never appeared:\n${cli.state.stdout}\n${cli.state.stderr}`,
      );
      assert.match(cli.state.stdout, /https:\/\/test-host-abc123\.trycloudflare\.com/);
      assert.match(cli.state.stdout, /Provider    : Cloudflare Quick Tunnel \(temporary\)/);
      assert.match(cli.state.stdout, /Status: Connected \(Cloudflare Quick Tunnel\) — press Ctrl\+C to stop/);

      cli.child.kill('SIGTERM');
      const r = await Promise.race([cli.exited, sleep(5000).then(() => null)]);
      assert.ok(r, `the CLI exited within 5s (took ${Date.now() % 100000} ms wall)`);
      assert.equal(r.code, 0, 'SIGTERM exits 0');
      // the fake cloudflared child is dead too (poll briefly for the signal to land)
      const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
      assert.ok(Number.isFinite(pid) && pid > 0, 'the fake recorded its pid');
      assert.ok(
        await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 4000),
        'the cloudflared child process was killed with the CLI',
      );
    } finally {
      await app.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('G16: a missing cloudflared binary fails fast with a clear reason', async () => {
    const home = tmpHome();
    try {
      const t0 = Date.now();
      const r = await runCli(['cloudflared', '--url', 'http://127.0.0.1:1', '--server', 'http://127.0.0.1:1'], {
        TUNNEL_HOME: home, TUN_CLOUDFLARED_BIN: '/nonexistent-cf',
      }, 10000);
      assert.ok(Date.now() - t0 < 6000, `failed fast (${Date.now() - t0} ms)`);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /\/nonexistent-cf is not usable/);
      assert.match(r.stderr, /install it from/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('G15: logs prints the ring for the owner; other token and no token are refused honestly', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      const reg = await register(app.base, { name: 'logme' }, acc.token);
      const name = reg.json.data.name;
      const clientId = reg.json.data.clientId;
      for (const p of ['/one', '/two']) {
        const visitor = fetch(`${app.base}/tun/${name}${p}`);
        const picked = await pollUntil(app.base, name, clientId);
        const req = picked.json.data.request;
        await fetch(`${app.base}/api/tunnel/respond`, {
          method: 'POST',
          headers: JSONH,
          body: JSON.stringify({ name, client: clientId, id: req.id, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('hi').toString('base64') }),
        });
        await visitor;
      }
      const mine = await runCli(['logs', name, '--server', app.base], { TUN_TOKEN: acc.token });
      assert.equal(mine.code, 0, `logs run: ${mine.stderr}`);
      assert.match(mine.stdout, /GET/);
      assert.match(mine.stdout, /\/one/);
      assert.match(mine.stdout, /\/two/);
      const other = await createAccount(app.base);
      const notYours = await runCli(['logs', name, '--server', app.base], { TUN_TOKEN: other.token });
      assert.equal(notYours.code, 1);
      assert.match(notYours.stderr, /different tunnel token \(NAME_NOT_YOURS\)/);
      const noTok = await runCli(['logs', name, '--server', app.base], {});
      assert.equal(noTok.code, 1);
      assert.match(noTok.stderr, /no token stored/);
    } finally {
      await app.close();
    }
  });

  test('G15: close with no name closes the last started tunnel; with no memory it hints', async () => {
    const app = await startServer({ env: FAST_ENV });
    const up = await startUpstream();
    const home = tmpHome();
    try {
      const acc = await createAccount(app.base);
      const cli = spawnCli(['start', '--name', 'lastone', String(up.port), '--server', app.base], { TUNNEL_HOME: home, TUN_TOKEN: acc.token });
      assert.ok(await waitFor(() => cli.state.stdout.includes('Status: Connected')), 'the tunnel started');
      cli.child.kill('SIGKILL'); // hard stop: no close API call, the tunnel stays connected server-side
      await cli.exited;
      assert.ok(
        await waitFor(async () => {
          const list = await (await fetch(`${app.base}/api/tunnel/list`)).json();
          return (list.data.tunnels || []).some((t) => t.name === 'lastone');
        }),
        'the tunnel is still connected after the hard kill',
      );
      const closed = await runCli(['close', '--server', app.base], { TUNNEL_HOME: home });
      assert.equal(closed.code, 0, `close run: ${closed.stderr}`);
      assert.match(closed.stdout, /tunnel "lastone" closed\./);
      const empty = await runCli(['close', '--server', app.base], { TUNNEL_HOME: tmpHome() });
      assert.equal(empty.code, 1);
      assert.match(empty.stderr, /close needs the app name/);
    } finally {
      await app.close();
      await up.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
