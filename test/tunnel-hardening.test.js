'use strict';

// Proxy hardening for /tun/<name> (window 1): OPTIONS + HEAD forwarding,
// header hygiene, path checks, 502 disconnect semantics, WebSocket honesty,
// and the stats() activeRequests/protected shape.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, TEST_ENV } = require('./helpers');
const { Tunnels } = require('../src/tunnel');

const FAST_ENV = {
  ...TEST_ENV,
  TUNNEL_WAIT_MS: '400',
  TUNNEL_POLL_WAIT_MS: '150',
  TUNNEL_TTL_MS: '900',
};

const JSONH = { 'Content-Type': 'application/json' };

async function register(base, name) {
  const res = await fetch(`${base}/api/tunnel/register`, { method: 'POST', headers: JSONH, body: JSON.stringify({ name }) });
  return { status: res.status, json: await res.json() };
}

// A tiny upstream app: echoes method, path, headers and body back as JSON.
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

// Answer a picked-up request the way the tunnel client would: call the local
// app and post its response back.
async function answerWithUpstream(base, name, clientId, req, upstreamBase) {
  const body = Buffer.from(req.body, 'base64');
  // undici refuses to send a body (even an empty one) with GET/HEAD.
  const bodyless = ['GET', 'HEAD'].includes(req.method);
  const upstream = await fetch(`${upstreamBase}${req.path}`, {
    method: req.method,
    headers: req.headers,
    body: bodyless ? undefined : body,
  });
  const answer = await fetch(`${base}/api/tunnel/respond`, {
    method: 'POST',
    headers: JSONH,
    body: JSON.stringify({
      name,
      client: clientId,
      id: req.id,
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers),
      body: Buffer.from(await upstream.arrayBuffer()).toString('base64'),
    }),
  });
  assert.deepEqual(await answer.json(), { success: true, data: { delivered: true } });
}

// A raw HTTP request (fetch refuses to send hop-by-hop headers like Upgrade).
function rawRequest(base, path, headers) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = http.request({ hostname, port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('tunnel proxy hardening', () => {
  test('G1: OPTIONS reaches the local app and its answer comes back', async () => {
    const app = await startServer({ env: FAST_ENV });
    const up = await startUpstream();
    try {
      const reg = await register(app.base, 'opt');
      const name = reg.json.data.name;
      const visitor = fetch(`${app.base}/tun/${name}/x`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } });
      const picked = await pollUntil(app.base, name, reg.json.data.clientId);
      assert.equal(picked.status, 200, JSON.stringify(picked.json));
      assert.equal(picked.json.data.request.method, 'OPTIONS');
      await answerWithUpstream(app.base, name, reg.json.data.clientId, picked.json.data.request, `http://127.0.0.1:${up.port}`);
      const vis = await visitor;
      assert.equal(vis.status, 200);
      assert.equal(vis.headers.get('x-upstream'), 'yes');
      assert.equal((await vis.json()).method, 'OPTIONS', 'the local app itself answered the OPTIONS');
    } finally {
      await app.close();
      await up.close();
    }
  });

  test('G1: HEAD is forwarded as HEAD and answered with headers only', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const reg = await register(app.base, 'head');
      const name = reg.json.data.name;
      const visitor = fetch(`${app.base}/tun/${name}/x`, { method: 'HEAD' });
      const picked = await pollUntil(app.base, name, reg.json.data.clientId);
      const req = picked.json.data.request;
      assert.equal(req.method, 'HEAD', 'HEAD is no longer rewritten to GET');
      // Answer with a body anyway (a sloppy client): the visitor must not see it.
      const answer = await fetch(`${app.base}/api/tunnel/respond`, {
        method: 'POST',
        headers: JSONH,
        body: JSON.stringify({
          name,
          client: reg.json.data.clientId,
          id: req.id,
          status: 200,
          headers: { 'Content-Type': 'text/html', 'X-Upstream': 'yes' },
          body: Buffer.from('<html>body that must not ship</html>').toString('base64'),
        }),
      });
      assert.deepEqual(await answer.json(), { success: true, data: { delivered: true } });
      const vis = await visitor;
      assert.equal(vis.status, 200);
      assert.equal(vis.headers.get('content-type'), 'text/html');
      assert.equal(vis.headers.get('x-upstream'), 'yes');
      assert.equal(await vis.text(), '', 'the HEAD reply carries no body');
    } finally {
      await app.close();
    }
  });

  test('G2: spoofed x-forwarded-* is replaced and x-tunnel-* dropped', async () => {
    const app = await startServer({ env: FAST_ENV });
    const up = await startUpstream();
    try {
      const reg = await register(app.base, 'hdrs');
      const name = reg.json.data.name;
      const visitor = fetch(`${app.base}/tun/${name}/who`, {
        headers: {
          'X-Forwarded-For': '9.9.9.9, 10.0.0.1',
          'X-Forwarded-Host': 'evil.example',
          'X-Forwarded-Proto': 'https',
          'X-Tunnel-Error': 'local-unreachable',
          'X-Tunnel-Sneaky': '1',
        },
      });
      const picked = await pollUntil(app.base, name, reg.json.data.clientId);
      const req = picked.json.data.request;
      assert.equal(req.headers['x-forwarded-for'], '127.0.0.1', 'the socket address wins over the spoofed chain');
      assert.equal(req.headers['x-forwarded-host'], 'evil.example', 'the host the request reached is preserved');
      assert.equal(req.headers['x-forwarded-proto'], 'https', 'proto follows the same rule as publicBase');
      assert.equal(req.headers['x-tunnel-error'], undefined, 'x-tunnel-* is not visitor-settable');
      assert.equal(req.headers['x-tunnel-sneaky'], undefined);
      await answerWithUpstream(app.base, name, reg.json.data.clientId, req, `http://127.0.0.1:${up.port}`);
      assert.equal((await visitor).status, 200);
    } finally {
      await app.close();
      await up.close();
    }
  });

  test('G3: control-character and overlong paths are refused with 400 INVALID_PATH', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const reg = await register(app.base, 'path');
      const name = reg.json.data.name;
      const bad = await fetch(`${app.base}/tun/${name}/%00x`);
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.code, 'INVALID_PATH');
      const nl = await fetch(`${app.base}/tun/${name}/a%0Ab`);
      assert.equal(nl.status, 400);
      const long = await fetch(`${app.base}/tun/${name}/${'x'.repeat(2049)}`);
      assert.equal(long.status, 400);
      assert.equal((await long.json()).error.code, 'INVALID_PATH');
      // A normal path of the same length class still works (no false positives).
      const okPath = await fetch(`${app.base}/tun/${name}/${'x'.repeat(100)}`);
      assert.notEqual(okPath.status, 400, 'a long-but-plain path is not rejected');
      await okPath.text(); // it times out (504): nothing answers the tunnel, but the path was accepted
    } finally {
      await app.close();
    }
  });

  test('G4: sweep drops a stale tunnel with 502 TUNNEL_UNAVAILABLE for pending waiters (unit)', async () => {
    let now = 1000;
    const tunnels = new Tunnels({ now: () => now, waitMs: 60000, pollWaitMs: 50, ttlMs: 1000 });
    tunnels.register('died');
    const fwd = tunnels.forward({ name: 'died', method: 'GET', path: '/', headers: {}, body: '' });
    now += 2000; // past ttlMs: the client stopped polling, the forward is still pending
    assert.equal(tunnels.get('died'), null, 'the tunnel itself is dropped');
    await assert.rejects(fwd, { status: 502, code: 'TUNNEL_UNAVAILABLE', message: 'The tunnel client disconnected.' });
  });

  test('G5: an Upgrade request is refused with 501 WEBSOCKET_UNSUPPORTED', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const reg = await register(app.base, 'ws');
      const name = reg.json.data.name;
      const res = await rawRequest(app.base, `/tun/${name}/socket`, { Upgrade: 'websocket' });
      assert.equal(res.status, 501);
      assert.equal(JSON.parse(res.body).error.code, 'WEBSOCKET_UNSUPPORTED');
      // Browsers get the friendly HTML page with the same message.
      const html = await rawRequest(app.base, `/tun/${name}/socket`, { Upgrade: 'websocket', Accept: 'text/html' });
      assert.equal(html.status, 501);
      assert.match(html.body, /WebSocket forwarding is not supported\./);
    } finally {
      await app.close();
    }
  });

  test('G10: stats exposes activeRequests and the protected placeholder', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const reg = await register(app.base, 'stat');
      const name = reg.json.data.name;
      const visitor = fetch(`${app.base}/tun/${name}/x`);
      await new Promise((r) => setTimeout(r, 120));
      const json = await (await fetch(`${app.base}/api/tunnel/stats`)).json();
      assert.equal(typeof json.data.activeRequests, 'number');
      assert.equal(json.data.activeRequests, 1, 'the queued visitor request is an active request');
      assert.equal(json.data.protected, 0, 'protected is a placeholder for now');
      await visitor;
    } finally {
      await app.close();
    }
  });
});
