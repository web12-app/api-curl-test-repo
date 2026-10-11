'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, TEST_ENV } = require('./helpers');
const { parseCorsOrigins } = require('../src/server');

const ALLOWED = 'https://precision-pledge-fled.ngrok-free.dev';
const OTHER = 'https://evil.example';

async function withCors(value, fn) {
  const s = await startServer({ env: { ...TEST_ENV, CORS_ALLOWED_ORIGINS: value } });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test('an allowed origin gets its exact origin back with credentials, on /api/ only', async () => {
  await withCors(ALLOWED, async (s) => {
    const res = await fetch(`${s.base}/api/health`, { headers: { Origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('vary'), /Origin/);

    const home = await fetch(`${s.base}/`, { headers: { Origin: ALLOWED } });
    assert.equal(home.headers.get('access-control-allow-origin'), null);
  });
});

test('an origin not on the list gets no CORS headers', async () => {
  await withCors(ALLOWED, async (s) => {
    const res = await fetch(`${s.base}/api/health`, { headers: { Origin: OTHER } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('no wildcard is ever sent, even when no origins are configured', async () => {
  await withCors('', async (s) => {
    const res = await fetch(`${s.base}/api/health`, { headers: { Origin: ALLOWED } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
  await withCors(ALLOWED, async (s) => {
    const res = await fetch(`${s.base}/api/health`);
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('preflight from an allowed origin returns 204 with the methods and headers', async () => {
  await withCors(ALLOWED, async (s) => {
    const res = await fetch(`${s.base}/api/login`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
  });
});

test('preflight from an unlisted origin gets no allow headers', async () => {
  await withCors(ALLOWED, async (s) => {
    const res = await fetch(`${s.base}/api/login`, { method: 'OPTIONS', headers: { Origin: OTHER } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('a POST from an allowed origin is accepted, a POST from an unlisted origin is refused', async () => {
  await withCors(ALLOWED, async (s) => {
    const body = JSON.stringify({ username: 'cors_user', password: 'password-one' });
    const ok = await fetch(`${s.base}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
      body,
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED);

    const bad = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: OTHER },
      body: JSON.stringify({ username: 'cors_user', password: 'password-one' }),
    });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error.code, 'CROSS_SITE_REFUSED');
  });
});

test('invalid CORS entries stop startup with a clear message', () => {
  assert.deepEqual(parseCorsOrigins(`${ALLOWED}, http://localhost:3000`), [ALLOWED, 'http://localhost:3000']);
  assert.deepEqual(parseCorsOrigins(''), []);
  for (const bad of ['*', `${ALLOWED}/`, `${ALLOWED}/api/`, 'http://example.com', 'ftp://x.example', 'not a url']) {
    assert.throws(() => parseCorsOrigins(bad), /CORS_ALLOWED_ORIGINS has an invalid entry/, bad);
  }
});
