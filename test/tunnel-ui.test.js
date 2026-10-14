'use strict';

// Tunnel manager UI tests: a signed-in site user creates tunnel tokens
// (POST /api/tunnel/tokens), reserves stable names (POST /api/tunnel/claim),
// releases and revokes them, and the /tunnel page shows it all. The reserve →
// whoami → register loop closes against the real CLI endpoints. Uses the
// memory storage harness like test/tunnel-v2.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, TEST_ENV, sessionFrom } = require('./helpers');

const FAST_ENV = {
  ...TEST_ENV,
  TUNNEL_SAVE_MS: '20',
};

const JSONH = { 'Content-Type': 'application/json' };

const uniqueName = (prefix) => `${prefix}_${crypto.randomBytes(3).toString('hex')}`;

// Signup, returning the minted sat_ API token and the browser cookie.
async function signup(app, username = uniqueName('user'), password = 'password-one') {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201, 'signup');
  const body = await res.json();
  return { username, password, cookie: sessionFrom(res), user: body.data.user, token: body.data.api_token.token };
}

// An authed browser fetch: session cookie + the CSRF header the site JS sends.
async function authed(app, user, method, path, body) {
  const res = await fetch(`${app.base}${path}`, {
    method,
    headers: {
      Cookie: user.cookie,
      Origin: app.base,
      'X-Requested-With': 'fetch',
      ...(body === undefined ? {} : { ...JSONH }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

// Create a tunnel token as a signed-in site user. Returns the full token once.
async function createToken(app, user, label) {
  const { res, json } = await authed(app, user, 'POST', '/api/tunnel/tokens', { label });
  assert.equal(res.status, 201, JSON.stringify(json));
  return json.data;
}

describe('tunnel ui: tokens', () => {
  test('a signed-in user creates multiple tunnel tokens; list shows masks only', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const user = await signup(app);

      const first = await createToken(app, user, 'cli');
      assert.match(first.token, /^tunt_[0-9a-f]{40}$/);
      assert.match(first.tokenMask, /…/);
      assert.equal(first.label, 'cli');

      const second = await createToken(app, user, 'ci');
      assert.notEqual(second.id, first.id);
      assert.notEqual(second.token, first.token);

      const list = await authed(app, user, 'GET', '/api/tunnel/tokens');
      assert.equal(list.res.status, 200);
      assert.equal(list.json.data.tokens.length, 2);
      assert.deepEqual(list.json.data.tokens.map((t) => t.label).sort(), ['ci', 'cli']);
      for (const t of list.json.data.tokens) {
        assert.ok(t.tokenMask && t.tokenMask.length < 20, 'mask only');
        assert.equal(t.token, undefined, 'no full token in list');
        assert.equal(t.names, 0);
      }
    } finally {
      await app.close();
    }
  });

  test('a Bearer sat_ token authorizes tunnel token creation without cookies or CSRF headers', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const user = await signup(app);
      const res = await fetch(`${app.base}/api/tunnel/tokens`, {
        method: 'POST',
        headers: { ...JSONH, Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ label: 'via sat_' }),
      });
      assert.equal(res.status, 201);
      const data = (await res.json()).data;
      assert.match(data.token, /^tunt_/);
      assert.equal(data.label, 'via sat_');
    } finally {
      await app.close();
    }
  });

  test('unauthenticated token creation is refused', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const res = await fetch(`${app.base}/api/tunnel/tokens`, {
        method: 'POST',
        headers: { ...JSONH, Origin: app.base, 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ label: 'nope' }),
      });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.code, 'NOT_AUTHENTICATED');
    } finally {
      await app.close();
    }
  });
});

describe('tunnel ui: names', () => {
  test('claim → whoami → register: the stable-name loop closes', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const user = await signup(app);
      const tok = await createToken(app, user, 'cli');

      const claim = await authed(app, user, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: tok.id });
      assert.equal(claim.res.status, 201);
      assert.equal(claim.json.data.name, 'mytun');
      assert.equal(claim.json.data.reserved, true);

      // The tunt_ token sees the reserved name, and the CLI can register it.
      const me = await fetch(`${app.base}/api/tunnel/whoami`, { headers: { Authorization: `Bearer ${tok.token}` } });
      assert.equal(me.status, 200);
      assert.deepEqual((await me.json()).data.names.map((n) => n.name), ['mytun']);

      const reg = await fetch(`${app.base}/api/tunnel/register`, {
        method: 'POST',
        headers: { ...JSONH, Authorization: `Bearer ${tok.token}` },
        body: JSON.stringify({ name: 'mytun' }),
      });
      assert.equal(reg.status, 201);
      assert.equal((await reg.json()).data.reserved, true);
    } finally {
      await app.close();
    }
  });

  test('name conflicts: taken, invalid, and someone else\u2019s token', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const alice = await signup(app);
      const bob = await signup(app);
      const atok = await createToken(app, alice, 'a');
      const btok = await createToken(app, bob, 'b');
      await authed(app, alice, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: atok.id });

      const taken = await authed(app, bob, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: btok.id });
      assert.equal(taken.res.status, 409);
      assert.equal(taken.json.error.code, 'NAME_TAKEN');

      const invalid = await authed(app, alice, 'POST', '/api/tunnel/claim', { name: 'Bad Name!', accountId: atok.id });
      assert.equal(invalid.res.status, 400);
      assert.equal(invalid.json.error.code, 'INVALID_NAME');

      const stranger = await authed(app, bob, 'POST', '/api/tunnel/claim', { name: 'freeone', accountId: atok.id });
      assert.equal(stranger.res.status, 404);
      assert.equal(stranger.json.error.code, 'TUNNEL_TOKEN_NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});

describe('tunnel ui: pages', () => {
  test('GET /tunnel shows tokens, reserved names and nav for its owner; anon is redirected', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const user = await signup(app);
      const tok = await createToken(app, user, 'cli');
      await authed(app, user, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: tok.id });

      const page = await fetch(`${app.base}/tunnel`, { headers: { Cookie: user.cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes(tok.tokenMask), 'token mask visible');
      assert.ok(html.includes('mytun'), 'reserved name visible');
      assert.ok(html.includes('href="/tunnel"'), 'nav link present');
      assert.ok(html.includes('nav-link active'), 'tunnel nav is active');
      assert.ok(!html.includes(tok.token), 'full token never rendered');

      const anon = await fetch(`${app.base}/tunnel`, { redirect: 'manual' });
      assert.equal(anon.status, 303);
      assert.equal(anon.headers.get('location'), '/login');
    } finally {
      await app.close();
    }
  });

  test('GET /tun links to the tunnel manager; layout pages carry the /tunnel nav link', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const landing = await fetch(`${app.base}/tun`);
      assert.equal(landing.status, 200);
      const landingHtml = await landing.text();
      assert.match(landingHtml, /href="[^"]*\/tunnel"/, 'landing links to /tunnel');

      const user = await signup(app);
      // The /tunnel page is the one layout()-chrome page a logged-in user
      // reaches (/home and /explore are React appShell pages). Its nav must
      // carry the Tunnel link next to Home and Explore.
      const page = await fetch(`${app.base}/tunnel`, { headers: { Cookie: user.cookie } });
      assert.equal(page.status, 200);
      const pageHtml = await page.text();
      assert.ok(pageHtml.includes('href="/home"') && pageHtml.includes('href="/explore"'), 'layout nav present');
      assert.ok(pageHtml.includes('href="/tunnel"'), 'layout chrome has the tunnel link');
    } finally {
      await app.close();
    }
  });

  test('the React app shell (/home) carries the server-rendered Tunnel link', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const user = await signup(app);
      const home = await fetch(`${app.base}/home`, { headers: { Cookie: user.cookie } });
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.ok(html.includes('class="shell-tunnel-link" href="/tunnel"'), 'shell tunnel link present');
      assert.ok(html.includes('>Tunnel</span>'), 'labelled Tunnel');
      // No bootstrap user, no link (defensive: shells are always behind login).
      assert.ok(html.includes('id="app-bootstrap"'), 'bootstrap present');
    } finally {
      await app.close();
    }
  });
});

describe('tunnel ui: revoke and release', () => {
  test('releasing a name frees it for anyone; revoking a token releases its names', async () => {
    const app = await startServer({ env: FAST_ENV });
    try {
      const alice = await signup(app);
      const bob = await signup(app);
      const atok = await createToken(app, alice, 'a');
      await authed(app, alice, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: atok.id });

      // Release by the owner: the name goes back to the pool.
      const release = await authed(app, alice, 'POST', '/api/tunnel/release', { name: 'mytun' });
      assert.equal(release.res.status, 200);
      assert.equal(release.json.data.released, true);

      const btok = await createToken(app, bob, 'b');
      const nowFree = await authed(app, bob, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: btok.id });
      assert.equal(nowFree.res.status, 201);
      await authed(app, bob, 'POST', '/api/tunnel/release', { name: 'mytun' });

      // Alice re-claims, then revokes her token: the name is released again.
      await authed(app, alice, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: atok.id });
      const revoke = await authed(app, alice, 'DELETE', `/api/tunnel/tokens/${atok.id}`);
      assert.equal(revoke.res.status, 200);
      assert.equal(revoke.json.data.revoked, true);
      assert.deepEqual(revoke.json.data.released, ['mytun']);

      const list = await authed(app, alice, 'GET', '/api/tunnel/tokens');
      assert.equal(list.json.data.tokens.length, 0);

      const third = await createToken(app, bob, 'c');
      const claim3 = await authed(app, bob, 'POST', '/api/tunnel/claim', { name: 'mytun', accountId: third.id });
      assert.equal(claim3.res.status, 201, 'freed by revoke');
    } finally {
      await app.close();
    }
  });
});
