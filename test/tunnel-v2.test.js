'use strict';

// Pips Tunnel v2: accounts + tokens, reserved stable names, anonymous random
// names, visitor error pages, the /tun/dashboard inspector, JSON persistence
// (system/tunnel.json) and the overload guards. Uses the memory storage
// harness; TUNNEL_SAVE_MS is tiny so the store's debounced writes stay cheap.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, TEST_ENV } = require('./helpers');
const { Tunnels, randomName } = require('../src/tunnel');
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

async function register(base, name, token) {
  const headers = token ? { ...JSONH, Authorization: `Bearer ${token}` } : JSONH;
  const res = await fetch(`${base}/api/tunnel/register`, { method: 'POST', headers, body: JSON.stringify({ name }) });
  return { status: res.status, json: await res.json() };
}

async function createAccount(base, label) {
  const res = await fetch(`${base}/api/tunnel/account`, { method: 'POST', headers: JSONH, body: JSON.stringify({ label: label || '' }) });
  const json = await res.json();
  return { status: res.status, json, token: json.data && json.data.token };
}

async function whoami(base, token) {
  const res = await fetch(`${base}/api/tunnel/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
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

// Register `name`, send one visitor GET through it, answer it via the respond
// API. Returns what the visitor received. visitorHeaders defaults to a browser
// Accept; pass {} for a curl-style request.
async function serveOne(base, name, clientId, status = 200, headers = { 'content-type': 'application/json' }, body = '{"ok":true}', visitorHeaders = BROWSER) {
  const visitor = fetch(`${base}/tun/${name}/`, { headers: visitorHeaders });
  const picked = await pollUntil(base, name, clientId);
  assert.equal(picked.status, 200, JSON.stringify(picked.json));
  const req = picked.json.data.request;
  await fetch(`${base}/api/tunnel/respond`, {
    method: 'POST',
    headers: JSONH,
    body: JSON.stringify({ name, client: clientId, id: req.id, status, headers, body: Buffer.from(body).toString('base64') }),
  });
  const res = await visitor;
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe('tunnel v2 accounts and names', () => {
  test('anonymous register gets a random name; the requested name is ignored', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const res = await register(app.base, 'test');
      assert.equal(res.status, 201);
      assert.match(res.json.data.name, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      assert.notEqual(res.json.data.name, 'test');
      assert.equal(res.json.data.reserved, false);
      assert.equal(res.json.data.account, null);
    } finally {
      await app.close();
    }
  });

  test('POST /api/tunnel/account issues a tunt_ token; whoami works; bad tokens 401', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base, 'ci box');
      assert.equal(acc.status, 201);
      assert.match(acc.json.data.token, /^tunt_[0-9a-f]{40}$/);
      assert.ok(acc.json.data.token.length >= 40);
      assert.equal(acc.json.data.label, 'ci box');

      const me = await whoami(app.base, acc.token);
      assert.equal(me.status, 200);
      assert.equal(me.json.data.account.tokenMask, acc.json.data.tokenMask);
      assert.deepEqual(me.json.data.names, []);

      const bad = await whoami(app.base, 'tunt_ffffffffffffffffffffffffffffffffffffffff');
      assert.equal(bad.status, 401);
      assert.equal(bad.json.error.code, 'INVALID_TOKEN');
    } finally {
      await app.close();
    }
  });

  test('a token holder can register and keep a stable reserved name', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      const reg = await register(app.base, 'myapp', acc.token);
      assert.equal(reg.status, 201);
      assert.equal(reg.json.data.name, 'myapp');
      assert.equal(reg.json.data.reserved, true);

      const me = await whoami(app.base, acc.token);
      assert.equal(me.status, 200);
      assert.deepEqual(me.json.data.names.map((n) => n.name), ['myapp']);
    } finally {
      await app.close();
    }
  });

  test('close then re-register keeps the reserved name working', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      const first = await register(app.base, 'myapp', acc.token);
      const close = await fetch(`${app.base}/api/tunnel/close`, {
        method: 'POST',
        headers: JSONH,
        body: JSON.stringify({ name: 'myapp', client: first.json.data.clientId }),
      });
      assert.equal((await close.json()).data.closed, true);

      const again = await register(app.base, 'myapp', acc.token);
      assert.equal(again.status, 201);
      assert.equal(again.json.data.name, 'myapp');
      assert.equal(again.json.data.reserved, true);
      assert.notEqual(again.json.data.clientId, first.json.data.clientId);
    } finally {
      await app.close();
    }
  });

  test('a reserved name refuses other accounts and stays invisible to anonymous callers', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const owner = await createAccount(app.base);
      const other = await createAccount(app.base);
      await register(app.base, 'myapp', owner.token);

      const steal = await register(app.base, 'myapp', other.token);
      assert.equal(steal.status, 403);
      assert.equal(steal.json.error.code, 'NAME_RESERVED');

      const anon = await register(app.base, 'myapp');
      assert.equal(anon.status, 201);
      assert.match(anon.json.data.name, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      assert.notEqual(anon.json.data.name, 'myapp');
    } finally {
      await app.close();
    }
  });
});

describe('tunnel v2 visitor error pages', () => {
  test('offline: reserved-but-closed name gives browsers a retry page, others JSON', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      const reg = await register(app.base, 'gone', acc.token);
      await fetch(`${app.base}/api/tunnel/close`, {
        method: 'POST',
        headers: JSONH,
        body: JSON.stringify({ name: 'gone', client: reg.json.data.clientId }),
      });

      const page = await fetch(`${app.base}/tun/gone`, { headers: BROWSER });
      assert.equal(page.status, 404);
      const html = await page.text();
      assert.match(html, /Tunnel offline/);
      assert.match(html, /\/tun\/gone/);
      assert.match(html, /retries every 10 seconds/);
      assert.match(html, /http-equiv="refresh" content="10"/);

      const api = await fetch(`${app.base}/tun/gone`);
      assert.equal(api.status, 404);
      assert.equal((await api.json()).error.code, 'TUNNEL_OFFLINE');
    } finally {
      await app.close();
    }
  });

  test('timeout: a connected but silent client gives browsers the slow page', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      await register(app.base, 'stuck', acc.token); // never polls, never answers
      const t0 = Date.now();
      const page = await fetch(`${app.base}/tun/stuck`, { headers: BROWSER });
      assert.equal(page.status, 504);
      assert.match(await page.text(), /did not answer/);
      assert.ok(Date.now() - t0 < 5000, 'the fast env keeps the wait short');
    } finally {
      await app.close();
    }
  });

  test('local-down: 502 with x-tunnel-error renders the down page for browsers, raw 502 for curl', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);

      // Browser leg: the 502 becomes an explanation page.
      const browserReg = await register(app.base, 'downy', acc.token);
      const browserOut = await serveOne(app.base, 'downy', browserReg.json.data.clientId, 502, {
        'content-type': 'application/json',
        'x-tunnel-error': 'local-unreachable',
      }, '{"died":true}');
      assert.equal(browserOut.status, 502);
      assert.match(browserOut.text, /Local app not answering/);
      assert.match(browserOut.text, /local app/i);

      // curl leg: the same upstream answer passes through untouched.
      const rawReg = await register(app.base, 'rawy', acc.token);
      const rawOut = await serveOne(app.base, 'rawy', rawReg.json.data.clientId, 502, {
        'content-type': 'application/json',
        'x-tunnel-error': 'local-unreachable',
      }, '{"died":true}', {});
      assert.equal(rawOut.status, 502);
      assert.equal(rawOut.headers.get('x-tunnel-error'), 'local-unreachable');
      assert.equal(rawOut.text, '{"died":true}');
    } finally {
      await app.close();
    }
  });
});

describe('tunnel v2 dashboard', () => {
  test('login form without token, bad token 401, good token renders account + logs', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base, 'inspector');
      const reg = await register(app.base, 'dashy', acc.token);
      const proxied = await serveOne(app.base, 'dashy', reg.json.data.clientId);
      assert.equal(proxied.status, 200);

      const home = await fetch(`${app.base}/tun/dashboard`);
      assert.equal(home.status, 200);
      const homeHtml = await home.text();
      assert.match(homeHtml, /Tunnel dashboard/);
      assert.match(homeHtml, /name="token"/);

      const badPost = await fetch(`${app.base}/tun/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=tunt_nope',
      });
      assert.equal(badPost.status, 401);
      assert.match(await badPost.text(), /not recognized/);

      const goodPost = await fetch(`${app.base}/tun/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(acc.token)}`,
      });
      assert.equal(goodPost.status, 200);
      const dash = await goodPost.text();
      assert.ok(dash.includes(acc.json.data.tokenMask), 'the masked token shows');
      assert.match(dash, /inspector/);
      assert.ok(dash.includes('/tun/dashy'), 'the owned name shows with a badge');
      assert.match(dash, /GET/);
      assert.match(dash, /status/);
      assert.ok(dash.includes('200'), 'the proxied status shows in the log row');
    } finally {
      await app.close();
    }
  });
});

describe('tunnel v2 persistence and stats', () => {
  test('accounts, reserved names and traffic survive a flush + reload', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base, 'persist');
      await register(app.base, 'keeper', acc.token);
      app.server.tunnelStore.noteTraffic('keeper', { method: 'GET', path: '/a?b=1', status: 200, bytes: 123, ms: 4 });
      await app.server.tunnelStore.flush();

      // A fresh store over the same storage sees the same document.
      const second = new TunnelStore({ storage: app.storage });
      await second.load();
      assert.ok(second.doc.accounts.length >= 1);
      const keeper = second.doc.names.keeper;
      assert.ok(keeper, 'the reserved name persisted');
      assert.equal(keeper.accountId, acc.json.data.accountId);
      assert.equal(keeper.served, 1);
      assert.equal(keeper.logs[0].path, '/a?b=1');
      assert.equal(second.claims().get('keeper'), acc.json.data.accountId);
      assert.ok(await second.verify(acc.token), 'the token still verifies from the reloaded doc');
      assert.deepEqual(second.namesFor(acc.json.data.accountId).map((n) => n.name), ['keeper']);
    } finally {
      await app.close();
    }
  });

  test('GET /api/tunnel/stats reports counters, accounts, names and uptime', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const acc = await createAccount(app.base);
      await register(app.base, 'one', acc.token);
      const res = await fetch(`${app.base}/api/tunnel/stats`);
      assert.equal(res.status, 200);
      const json = await res.json();
      for (const key of ['tunnels', 'pending', 'served', 'answered', 'accounts', 'names', 'uptimeMs']) {
        assert.ok(Object.hasOwn(json.data, key), `${key} present`);
        assert.equal(typeof json.data[key], 'number');
      }
      assert.equal(json.data.tunnels, 1);
      assert.equal(json.data.accounts, 1);
      assert.equal(json.data.names, 1);
      assert.ok(json.data.uptimeMs >= 0);
    } finally {
      await app.close();
    }
  });
});

describe('Tunnels service v2 (unit)', () => {
  test('maxTunnels and maxQueue guard against overload', () => {
    const capped = new Tunnels({ maxTunnels: 1 });
    capped.register('a');
    assert.throws(() => capped.register('b'), (err) => err.status === 429 && err.code === 'TUNNEL_LIMIT');
    capped.register('a'); // taking over your own name is fine
    assert.equal(capped.map.size, 1);

    const queued = new Tunnels({ maxQueue: 1, waitMs: 50, pollWaitMs: 50 });
    queued.register('w');
    const first = queued.forward({ name: 'w', method: 'GET', path: '/', headers: {}, body: '' });
    first.catch(() => {}); // this one expires unobserved; the next forward is the assertion
    assert.throws(
      () => queued.forward({ name: 'w', method: 'GET', path: '/', headers: {}, body: '' }),
      (err) => err.status === 503 && err.code === 'TUNNEL_BUSY',
    );
  });

  test('random names match the advertised shape', () => {
    for (let i = 0; i < 25; i++) assert.match(randomName(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });
});
