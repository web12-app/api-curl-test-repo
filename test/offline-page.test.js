// The offline fallback: /offline.html (animated shell), /sw.js (service worker), and /sw-register.js.
// All three are public, like /assets, and every page head carries the register tag.
'use strict';

const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sessionFrom } = require('./helpers');
const { startFake, withApp, signup, authed } = require('./files-fixture');

let shared;
before(async () => {
  shared = await startServer();
});
after(async () => {
  await shared.close();
});

const noRedirect = { redirect: 'manual' };

async function signupCookie(base, username) {
  const res = await fetch(`${base}/signup`, {
    ...noRedirect,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password: 'password-one' }),
  });
  assert.equal(res.status, 303);
  return sessionFrom(res);
}

test('GET /offline.html is public and serves the animated self-contained shell', async () => {
  const res = await fetch(`${shared.base}/offline.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  const html = await res.text();
  assert.ok(html.includes('/api/health'), 'the connection check endpoint');
  assert.match(html, /Checking connection/);
  assert.ok(html.includes('Try now'), 'the manual retry button');
  assert.ok(html.includes('noindex'), 'not for search engines');
  assert.ok(!html.includes('ERR_NGROK'), 'no ngrok references');
  assert.ok(html.includes('prefers-reduced-motion'), 'reduced-motion support');
});

test('GET /offline.html allows the inline script and style it needs, and nothing else', async () => {
  const res = await fetch(`${shared.base}/offline.html`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self'/);
});

test('GET /sw.js is a public service worker that falls back to the offline page', async () => {
  const res = await fetch(`${shared.base}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  const body = await res.text();
  assert.ok(body.includes('offline.html'), 'precaches the offline shell');
  assert.ok(body.includes('navigate'), 'handles navigations');
  assert.ok(body.includes('ERR_NGROK'), 'detects ngrok error pages');
  // The worker must parse as strict-mode script; a syntax error would break registration.
  new Function(body);
});

test('GET /sw-register.js is a public tiny registrar', async () => {
  const res = await fetch(`${shared.base}/sw-register.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const body = await res.text();
  assert.ok(body.includes('serviceWorker'), 'checks support');
  assert.ok(body.includes('/sw.js'), 'registers the worker');
  new Function(body);
});

test('the welcome page and the signed-in /home shell both carry the register tag', async () => {
  const welcome = await fetch(`${shared.base}/`);
  assert.equal(welcome.status, 200);
  const welcomeHtml = await welcome.text();
  assert.ok(welcomeHtml.includes('<script src="/sw-register.js" defer></script>'));

  const cookie = await signupCookie(shared.base, 'offline_fan');
  const home = await fetch(`${shared.base}/home`, { headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.ok(homeHtml.includes('<script src="/sw-register.js" defer></script>'));
});

test('server-rendered pages (login, share) carry the register tag too', async () => {
  const fake = await startFake();
  try {
    await withApp(fake, {}, async (app) => {
      const login = await fetch(`${app.base}/login`);
      assert.ok((await login.text()).includes('/sw-register.js'), 'the login page');

      const user = await signup(app);
      const form = new FormData();
      form.append('uploadId', crypto.randomUUID());
      form.append('file', new Blob(['shared bytes'], { type: 'text/plain' }), 'report.txt');
      const up = await authed(app, user.cookie, '/api/files/upload', { method: 'POST', body: form });
      const upBody = await up.json();
      assert.equal(up.status, 201, JSON.stringify(upBody));
      const fileId = upBody.data.file.id;

      const on = await authed(app, user.cookie, `/api/files/${fileId}/sharing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: true }),
      });
      const onBody = await on.json();
      assert.equal(on.status, 200, JSON.stringify(onBody));
      const sharePath = onBody.data.file.sharePath;

      const page = await fetch(`${app.base}${sharePath}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes('/sw-register.js'), 'the share page');
      assert.match(page.headers.get('content-security-policy'), /script-src 'self'/, 'the register script is allowed there');
    });
  } finally {
    await fake.close();
  }
});
