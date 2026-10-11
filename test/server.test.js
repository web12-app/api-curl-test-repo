'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET / returns the home page as HTML', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Hello from Node\.js/);
});

test('GET /api/health returns ok as JSON', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('unknown paths return 404 JSON', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('non-GET methods are rejected with 405', async () => {
  const res = await fetch(`${base}/api/health`, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
});

test('responses set X-Content-Type-Options: nosniff', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
