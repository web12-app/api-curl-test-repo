'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sessionFrom, TEST_ENV } = require('./helpers');
const { createServer } = require('../src/server');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Builds a JSON POST. `path` is only for readability at the call site.
const post = (path, body, headers = {}) => ({ method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const noRedirect = { redirect: 'manual' };

// ---- public routes (shared server)

let shared;
before(async () => {
  shared = await startServer();
});
after(async () => {
  await shared.close();
});

test('GET / returns the home page as HTML with login links', async () => {
  const res = await fetch(`${shared.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Get started/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /href="\/signup"/);
});

test('GET /api/health returns ok as JSON', async () => {
  const res = await fetch(`${shared.base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('unknown paths return 404 JSON, as before', async () => {
  const res = await fetch(`${shared.base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('wrong methods are rejected with 405, an Allow header, and the original JSON body', async () => {
  const res = await fetch(`${shared.base}/api/health`, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

test('responses set security headers', async () => {
  const res = await fetch(`${shared.base}/api/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  // "same-origin", not "no-referrer" (see login-form-origin.test.js for why).
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
});

test('login and signup pages render forms that post to the same paths', async () => {
  for (const page of ['login', 'signup']) {
    const html = await (await fetch(`${shared.base}/${page}`)).text();
    assert.match(html, new RegExp(`<form method="post" action="/${page}"`));
    assert.match(html, /type="password"/);
  }
});

// ---- JSON API: signup, login, me, logout

test('signup stores a hashed password and sets an HttpOnly session', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/signup`, post('/api/signup', { username: 'Gina_1', password: 'password-one' }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.username, 'gina_1');
    assert.match(res.headers.get('set-cookie'), /session=.*HttpOnly/);

    const stored = JSON.stringify([...s.storage.files.values()]);
    assert.ok(!stored.includes('password-one'));
    assert.ok(stored.includes('scrypt$'));
  } finally {
    await s.close();
  }
});

test('login with the right password returns a session; the wrong one returns 401', async () => {
  const s = await startServer();
  try {
    await fetch(`${s.base}/api/signup`, post('/api/signup', { username: 'hank01', password: 'password-one' }));

    const bad = await fetch(`${s.base}/api/login`, post('/api/login', { username: 'hank01', password: 'nope-nope-1' }));
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).error.code, 'INVALID_CREDENTIALS');

    const good = await fetch(`${s.base}/api/login`, post('/api/login', { username: 'hank01', password: 'password-one' }));
    assert.equal(good.status, 200);
    assert.ok(sessionFrom(good));
  } finally {
    await s.close();
  }
});

test('/api/me reports the logged-in user, and null without a session', async () => {
  const s = await startServer();
  try {
    const signed = await fetch(`${s.base}/api/signup`, post('/api/signup', { username: 'ivy_22', password: 'password-one' }));
    const cookie = sessionFrom(signed);

    const me = await (await fetch(`${s.base}/api/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.data.user.username, 'ivy_22');

    const anon = await (await fetch(`${s.base}/api/me`)).json();
    assert.equal(anon.data.user, null);

    const forged = await (await fetch(`${s.base}/api/me`, { headers: { Cookie: 'session=abc.def' } })).json();
    assert.equal(forged.data.user, null);
  } finally {
    await s.close();
  }
});

test('logout clears the session cookie', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await s.close();
  }
});

test('bad input is rejected with clear codes', async () => {
  const s = await startServer();
  try {
    const bad = await fetch(`${s.base}/api/signup`, post('/api/signup', { username: 'x', password: 'password-one' }));
    assert.equal((await bad.json()).error.code, 'INVALID_USERNAME');

    const notJson = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(notJson.status, 400);
    assert.equal((await notJson.json()).error.code, 'INVALID_JSON');

    const wrongType = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(wrongType.status, 415);
  } finally {
    await s.close();
  }
});

test('request bodies over 16 KB are refused with 413', async () => {
  const s = await startServer();
  try {
    const big = JSON.stringify({ username: 'bigbody', password: 'p'.repeat(20_000) });
    const res = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    assert.equal(res.status, 413);
  } finally {
    await s.close();
  }
});

test('repeated wrong logins for one account get rate limited', async () => {
  const s = await startServer();
  try {
    await fetch(`${s.base}/api/signup`, post('/api/signup', { username: 'kate_99', password: 'password-one' }));
    for (let i = 0; i < 5; i++) {
      await fetch(`${s.base}/api/login`, post('/api/login', { username: 'kate_99', password: 'wrong-guess-1' }));
    }
    const res = await fetch(`${s.base}/api/login`, post('/api/login', { username: 'kate_99', password: 'password-one' }));
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'RATE_LIMITED');
  } finally {
    await s.close();
  }
});

// ---- browser pages and form posts

test('the app home redirects anonymous visitors to login and shows the user with a session', async () => {
  const s = await startServer();
  try {
    const anon = await fetch(`${s.base}/dashboard`, noRedirect);
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/home');
    const anonHome = await fetch(`${s.base}/home`, noRedirect);
    assert.equal(anonHome.status, 303);
    assert.equal(anonHome.headers.get('location'), '/login');

    const form = new URLSearchParams({ username: 'liam_5', password: 'password-one' });
    const signed = await fetch(`${s.base}/signup`, {
      ...noRedirect,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    assert.equal(signed.status, 303);
    assert.equal(signed.headers.get('location'), '/home');

    const page = await fetch(`${s.base}/home`, { headers: { Cookie: sessionFrom(signed) } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /liam_5/);

    // A signed-in visitor never sees the welcome page: / goes straight to the app home.
    const welcome = await fetch(`${s.base}/`, { headers: { Cookie: sessionFrom(signed) }, redirect: 'manual' });
    assert.equal(welcome.status, 303);
    assert.equal(welcome.headers.get('location'), '/home');
  } finally {
    await s.close();
  }
});

test('a form login with a wrong password redirects back with an error code', async () => {
  const s = await startServer();
  try {
    await fetch(`${s.base}/api/signup`, post('/api/signup', { username: 'mona_1', password: 'password-one' }));
    const res = await fetch(`${s.base}/login`, {
      ...noRedirect,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'mona_1', password: 'wrong-guess-1' }),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login?error=INVALID_CREDENTIALS');
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});

test('the error code in the login page is shown as fixed text, not echoed', async () => {
  const s = await startServer();
  try {
    const html = await (await fetch(`${s.base}/login?error=%3Cscript%3E`)).text();
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /Something went wrong/);
  } finally {
    await s.close();
  }
});

test('cross-site POST requests are refused and create nothing', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/signup`, {
      ...post('/api/signup', { username: 'evil_user', password: 'password-one' }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'CROSS_SITE_REFUSED');
    assert.equal(s.storage.files.size, 0);
  } finally {
    await s.close();
  }
});

test('a same-origin POST is accepted', async () => {
  const s = await startServer();
  try {
    const host = new URL(s.base).host;
    const res = await fetch(`${s.base}/api/signup`, {
      ...post('/api/signup', { username: 'same_origin', password: 'password-one' }),
      headers: { 'Content-Type': 'application/json', Origin: `http://${host}` },
    });
    assert.equal(res.status, 201);
  } finally {
    await s.close();
  }
});

// ---- configuration

test('without login configuration the public site works and auth reports what is missing', async () => {
  const server = createServer({ env: { PORT: '1' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);

    const api = await fetch(`${base}/api/signup`, post('/api/signup', { username: 'nope_nope', password: 'password-one' }));
    assert.equal(api.status, 503);
    const body = await api.json();
    assert.equal(body.error.code, 'NOT_CONFIGURED');
    assert.match(body.error.message, /GITHUB_TOKEN/);
    assert.match(body.error.message, /SESSION_SECRET/);

    const page = await fetch(`${base}/login`);
    assert.equal(page.status, 503);
    assert.doesNotMatch(await page.text(), /ghp_|SESSION_SECRET=/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a short SESSION_SECRET counts as missing', async () => {
  const s = await startServer({ env: { ...TEST_ENV, SESSION_SECRET: 'too-short' } });
  try {
    const res = await fetch(`${s.base}/api/me`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /SESSION_SECRET/);
  } finally {
    await s.close();
  }
});
