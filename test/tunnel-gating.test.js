'use strict';

// Tunnel hardening window 2 (G6-G9): protected names (per-name access gate),
// the owner-facing logs endpoint, register port/proto enrichment, and the
// per-IP register/account rate limit. Auth pattern: createAccount → Bearer
// tunt_ (same as tunnel-v2).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, TEST_ENV } = require('./helpers');
const { RateLimiter } = require('../src/rate-limit');
const { TunnelStore } = require('../src/tunnel-store');

const FAST_ENV = {
  ...TEST_ENV,
  TUNNEL_WAIT_MS: '800',
  TUNNEL_POLL_WAIT_MS: '120',
  TUNNEL_TTL_MS: '20000',
  TUNNEL_SAVE_MS: '20',
};

const JSONH = { 'Content-Type': 'application/json' };
const BROWSER = { Accept: 'text/html,application/xhtml+xml' };

async function register(base, body, token) {
  const headers = token ? { ...JSONH, Authorization: `Bearer ${token}` } : JSONH;
  const res = await fetch(`${base}/api/tunnel/register`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function createAccount(base, label) {
  const res = await fetch(`${base}/api/tunnel/account`, { method: 'POST', headers: JSONH, body: JSON.stringify({ label: label || '' }) });
  const json = await res.json();
  return { status: res.status, json, token: json.data && json.data.token };
}

async function post(base, path, body, token) {
  const headers = token ? { ...JSONH, Authorization: `Bearer ${token}` } : JSONH;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

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

// One visitor request answered by the test-side client (register/poll/respond).
async function serveOne(base, name, clientId, visitorUrl, visitorHeaders = BROWSER) {
  const visitor = fetch(visitorUrl, { headers: visitorHeaders });
  const picked = await pollUntil(base, name, clientId);
  assert.equal(picked.status, 200, JSON.stringify(picked.json));
  const req = picked.json.data.request;
  await fetch(`${base}/api/tunnel/respond`, {
    method: 'POST',
    headers: JSONH,
    body: JSON.stringify({ name, client: clientId, id: req.id, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok').toString('base64') }),
  });
  const res = await visitor;
  return { status: res.status, text: await res.text() };
}

describe('G6 protected names', () => {
  test('protect gates the proxy; access= / x-tunnel-access pass; unprotect opens it; stats counts', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      await register(app.base, { name: 'gated' }, acc.token);
      const live = await register(app.base, { name: 'gated' }, acc.token);
      const clientId = live.json.data.clientId;

      const prot = await post(app.base, '/api/tunnel/protect', { name: 'gated' }, acc.token);
      assert.equal(prot.status, 201);
      assert.equal(prot.json.data.protected, true);
      assert.match(prot.json.data.token, /^[0-9a-f]{32}$/, 'a random 32-hex access token, shown once');
      assert.ok(prot.json.data.tokenMask.includes('…'));

      // Without a token: 401, JSON for API clients and the friendly page for browsers.
      const denied = await fetch(`${app.base}/tun/gated/`);
      assert.equal(denied.status, 401);
      assert.equal((await denied.json()).error.code, 'ACCESS_REQUIRED');
      const deniedHtml = await fetch(`${app.base}/tun/gated/`, { headers: BROWSER });
      assert.equal(deniedHtml.status, 401);
      assert.match(await deniedHtml.text(), /requires an access token/);

      // Wrong token is still 401.
      const wrong = await fetch(`${app.base}/tun/gated/?access=not-the-token-not`);
      assert.equal(wrong.status, 401);

      // The real token works via the query and via the header.
      const okq = await serveOne(app.base, 'gated', clientId, `${app.base}/tun/gated/x?access=${prot.json.data.token}`);
      assert.equal(okq.status, 200);
      const okh = await serveOne(app.base, 'gated', clientId, `${app.base}/tun/gated/y`, { ...BROWSER, 'x-tunnel-access': prot.json.data.token });
      assert.equal(okh.status, 200);

      // stats() counts the gated name (window-1 placeholder now real).
      let stats = await (await fetch(`${app.base}/api/tunnel/stats`)).json();
      assert.equal(stats.data.protected, 1);

      // A caller-supplied token (16-128 chars) is honored as-is; short ones 400.
      const custom = await post(app.base, '/api/tunnel/protect', { name: 'gated', token: 'my-secret-token-16' }, acc.token);
      assert.equal(custom.status, 201);
      assert.equal(custom.json.data.token, 'my-secret-token-16');
      const okc = await serveOne(app.base, 'gated', clientId, `${app.base}/tun/gated/z?access=my-secret-token-16`);
      assert.equal(okc.status, 200);
      const short = await post(app.base, '/api/tunnel/protect', { name: 'gated', token: 'short' }, acc.token);
      assert.equal(short.status, 400);
      assert.equal(short.json.error.code, 'INVALID_ACCESS_TOKEN');

      // Non-owner 403, unknown name 404.
      const other = await createAccount(app.base);
      const notYours = await post(app.base, '/api/tunnel/protect', { name: 'gated' }, other.token);
      assert.equal(notYours.status, 403);
      assert.equal(notYours.json.error.code, 'NAME_NOT_YOURS');
      const ghost = await post(app.base, '/api/tunnel/protect', { name: 'ghost' }, acc.token);
      assert.equal(ghost.status, 404);
      assert.equal(ghost.json.error.code, 'NAME_NOT_FOUND');

      // Unprotect opens the tunnel again and drops the stats count.
      const open = await post(app.base, '/api/tunnel/unprotect', { name: 'gated' }, acc.token);
      assert.equal(open.status, 200);
      assert.equal(open.json.data.protected, false);
      const reopened = await serveOne(app.base, 'gated', clientId, `${app.base}/tun/gated/open`);
      assert.equal(reopened.status, 200);
      stats = await (await fetch(`${app.base}/api/tunnel/stats`)).json();
      assert.equal(stats.data.protected, 0);
    } finally {
      await app.close();
    }
  });

  test('store unit: protect/unprotect/checkAccess/isProtected/countProtected', () => {
    const store = new TunnelStore({ saveDelayMs: 0 });
    store.noteRegister('app', 'a' + '0123456789abcdef012345');
    const { token, tokenMask } = store.protectName('app', 'a' + '0123456789abcdef012345');
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(tokenMask);
    assert.equal(store.isProtected('app'), true);
    assert.equal(store.checkAccess('app', token), true);
    assert.equal(store.checkAccess('app', 'nope-nope-nope-nope'), false);
    assert.equal(store.countProtected(), 1);
    store.unprotectName('app', 'a' + '0123456789abcdef012345');
    assert.equal(store.isProtected('app'), false);
    assert.equal(store.checkAccess('app', ''), true, 'ungated names let everyone through');
    assert.equal(store.countProtected(), 0);
  });
});

describe('G7 logs endpoint', () => {
  test('owner sees the request ring; errors: 400 missing name, 401 bad token, 404 unknown, 403 not yours', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      const reg = await register(app.base, { name: 'logged' }, acc.token);
      const name = reg.json.data.name;
      const clientId = reg.json.data.clientId;
      await serveOne(app.base, name, clientId, `${app.base}/tun/${name}/one`);
      await serveOne(app.base, name, clientId, `${app.base}/tun/${name}/two`);

      const logs = await fetch(`${app.base}/api/tunnel/logs?name=${name}`, { headers: { Authorization: `Bearer ${acc.token}` } });
      assert.equal(logs.status, 200);
      const json = await logs.json();
      assert.equal(json.data.name, name);
      assert.ok(json.data.logs.length >= 2, `expected the served requests in the ring: ${JSON.stringify(json.data.logs)}`);
      assert.equal(json.data.logs[0].method, 'GET');
      assert.equal(json.data.logs[0].status, 200);
      assert.ok(json.data.logs[0].path.startsWith('/'));
      assert.ok(json.data.logs[0].ms >= 0);

      const missing = await fetch(`${app.base}/api/tunnel/logs`, { headers: { Authorization: `Bearer ${acc.token}` } });
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).error.code, 'INVALID_NAME');
      const badtok = await fetch(`${app.base}/api/tunnel/logs?name=${name}`);
      assert.equal(badtok.status, 401);
      assert.equal((await badtok.json()).error.code, 'INVALID_TOKEN');
      const ghost = await fetch(`${app.base}/api/tunnel/logs?name=ghost`, { headers: { Authorization: `Bearer ${acc.token}` } });
      assert.equal(ghost.status, 404);
      assert.equal((await ghost.json()).error.code, 'NAME_NOT_FOUND');
      const other = await createAccount(app.base);
      const notYours = await fetch(`${app.base}/api/tunnel/logs?name=${name}`, { headers: { Authorization: `Bearer ${other.token}` } });
      assert.equal(notYours.status, 403);
      assert.equal((await notYours.json()).error.code, 'NAME_NOT_YOURS');
    } finally {
      await app.close();
    }
  });

  test('the store keeps a 50-row ring', () => {
    const store = new TunnelStore({ saveDelayMs: 0 });
    const accountId = 'a' + '0123456789abcdef012345';
    store.noteRegister('ring', accountId);
    for (let i = 0; i < 55; i++) {
      store.noteTraffic('ring', { method: 'GET', path: `/r/${i}`, status: 200, ms: 1, bytes: i });
    }
    const out = store.logsFor('ring', accountId);
    assert.equal(out.logs.length, 50, 'the ring is capped at LOG_LIMIT rows');
    assert.equal(out.logs[0].path, '/r/54', 'newest first');
    assert.equal(out.logs[49].path, '/r/5', 'oldest kept row');
  });
});

describe('G8 register enrichment (port/proto)', () => {
  test('port and proto are stored on the live tunnel and shown in list rows; defaults apply', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      const reg = await register(app.base, { name: 'enriched', port: 5000, proto: 2 }, acc.token);
      assert.equal(reg.status, 201);
      const anon = await register(app.base, { port: 8080 });

      const list = await (await fetch(`${app.base}/api/tunnel/list`)).json();
      const rows = new Map(list.data.tunnels.map((t) => [t.name, t]));
      const owned = rows.get('enriched');
      assert.equal(owned.port, 5000);
      assert.equal(owned.proto, 2);
      const anonRow = rows.get(anon.json.data.name);
      assert.equal(anonRow.port, 8080, 'anonymous registers take port too');
      assert.equal(anonRow.proto, 1, 'proto defaults to 1');
      assert.ok(rows.get('enriched').port !== undefined);
    } finally {
      await app.close();
    }
  });

  test('bad port/proto values are refused with 400', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      for (const bad of [0, -1, 70000, 'abc', 1.5]) {
        const res = await register(app.base, { name: 'enriched', port: bad }, acc.token);
        assert.equal(res.status, 400, `port ${JSON.stringify(bad)} must be refused`);
        assert.equal(res.json.error.code, 'INVALID_PORT');
      }
      const proto = await register(app.base, { name: 'enriched', proto: 10 }, acc.token);
      assert.equal(proto.status, 400);
      assert.equal(proto.json.error.code, 'INVALID_PROTO');
    } finally {
      await app.close();
    }
  });
});

describe('G9 register rate limit', () => {
  test('unit: the sliding-window limiter blocks past N and resets when the window expires', () => {
    let now = 1000;
    const rl = new RateLimiter(() => now);
    const key = 'tunreg:10.9.9.9';
    for (let i = 0; i < 3; i++) {
      assert.ok(rl.count(key, 60000) < 3, `hit ${i + 1} within budget`);
      rl.record(key);
    }
    assert.equal(rl.count(key, 60000) >= 3, true, 'budget exhausted after 3 hits');
    now += 60001;
    assert.equal(rl.count(key, 60000), 0, 'the window slid past the old hits');
  });

  test('integration: TUNNEL_REGISTER_RATE=3 caps register and account per IP with 429 RATE_LIMITED', async () => {
    const app = await startServer({ env: { ...FAST_ENV, TUNNEL_REGISTER_RATE: '3' } });
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await register(app.base, { name: 'r' });
        assert.equal(ok.status, 201, `registration ${i + 1} within budget`);
      }
      const blocked = await register(app.base, { name: 'r' });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error.code, 'RATE_LIMITED');
      // /api/tunnel/account shares the same per-IP budget.
      const accBlocked = await createAccount(app.base);
      assert.equal(accBlocked.status, 429);
      assert.equal(accBlocked.json.error.code, 'RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});
