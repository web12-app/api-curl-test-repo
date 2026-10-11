'use strict';

// Regression tests for "403 Cross-site requests are refused" on the login form at the ngrok URL.
//
// Root cause: every response set "Referrer-Policy: no-referrer". With that policy in effect, Chromium sends
// "Origin: null" on a non-GET form post, even when the post is same-origin. The origin check then (correctly)
// refused "null". This was reproduced in headless Chromium against the live login page.
// The fix is the page header. The origin check itself stays strict.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sessionFrom, TEST_ENV } = require('./helpers');

const PROD = 'https://precision-pledge-fled.ngrok-free.dev';
const EVIL = 'https://evil.example';
// Production-like config: the public origin is on the allowlist and cookies are Secure (the default).
const { COOKIE_SECURE, ...BASE_ENV } = TEST_ENV;
const PROD_ENV = { ...BASE_ENV, CORS_ALLOWED_ORIGINS: PROD };

// The Origin a browser sends on a same-origin form POST, given the page's Referrer-Policy.
// Chromium sends "null" under no-referrer. Any other policy sends the page's own origin.
function formPostOrigin(pageRes, pageOrigin) {
  return pageRes.headers.get('referrer-policy') === 'no-referrer' ? 'null' : pageOrigin;
}

function postForm(base, path, fields, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function withServer(env, fn) {
  const s = await startServer({ env });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

async function signupViaApi(base, username, password) {
  const res = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PROD },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201, 'test account created');
}

test('every page sends a Referrer-Policy that keeps the Origin header a real origin on form posts', async () => {
  await withServer(PROD_ENV, async (s) => {
    for (const path of ['/', '/home', '/explore', '/login', '/signup', '/dashboard', '/api/health', '/does-not-exist']) {
      const res = await fetch(`${s.base}${path}`, { redirect: 'manual' });
      assert.equal(res.headers.get('referrer-policy'), 'same-origin', `${path} sends a usable Referrer-Policy`);
    }
  });
});

test('the 403 scenario: the login form post from the login page is not refused', async () => {
  await withServer(PROD_ENV, async (s) => {
    await signupViaApi(s.base, 'form_login_user', 'password-one');
    const page = await fetch(`${s.base}/login`);
    const origin = formPostOrigin(page, PROD);
    const res = await postForm(s.base, '/login',
      { username: 'form_login_user', password: 'password-one' }, { Origin: origin });
    assert.notEqual(res.status, 403, 'a same-origin form post must not be refused');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/home');
    assert.match(sessionFrom(res) || '', /^session=/);
  });
});

test('a wrong password from the login form redirects back with an error, not a 403', async () => {
  await withServer(PROD_ENV, async (s) => {
    await signupViaApi(s.base, 'form_wrong_pw', 'password-one');
    const page = await fetch(`${s.base}/login`);
    const res = await postForm(s.base, '/login',
      { username: 'form_wrong_pw', password: 'not-the-password' }, { Origin: formPostOrigin(page, PROD) });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login?error=INVALID_CREDENTIALS');
    assert.equal(sessionFrom(res), null, 'no session for a wrong password');
    const shown = await (await fetch(`${s.base}/login?error=INVALID_CREDENTIALS`)).text();
    assert.match(shown, /Wrong username or password\./);
  });
});

test('Origin "null" is still refused on every form post (the check stays strict)', async () => {
  await withServer(PROD_ENV, async (s) => {
    for (const path of ['/login', '/signup', '/logout']) {
      const res = await postForm(s.base, path, { username: 'x_user', password: 'password-one' }, { Origin: 'null' });
      assert.equal(res.status, 403, `${path} refuses Origin: null`);
      assert.equal(res.headers.get('set-cookie'), null, `${path} sets no cookie on refusal`);
    }
  });
});

test('a form post from an origin that is not on the allowlist is refused and creates no session', async () => {
  await withServer(PROD_ENV, async (s) => {
    await signupViaApi(s.base, 'form_evil_target', 'password-one');
    const res = await postForm(s.base, '/login',
      { username: 'form_evil_target', password: 'password-one' }, { Origin: EVIL });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
    const body = await res.text();
    assert.doesNotMatch(body, /session=/);
  });
});

test('the production origin is accepted for signup, login, and logout forms', async () => {
  await withServer(PROD_ENV, async (s) => {
    const page = await fetch(`${s.base}/signup`);
    const origin = formPostOrigin(page, PROD);
    const signup = await postForm(s.base, '/signup',
      { username: 'prod_form_user', password: 'password-one' }, { Origin: origin });
    assert.equal(signup.status, 303);
    assert.equal(signup.headers.get('location'), '/home');

    const login = await postForm(s.base, '/login',
      { username: 'prod_form_user', password: 'password-one' }, { Origin: origin });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/home');

    const logout = await postForm(s.base, '/logout', {}, { Origin: origin, Cookie: sessionFrom(login) });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get('location'), '/');
    assert.match(logout.headers.get('set-cookie') || '', /session=;.*Max-Age=0/);
  });
});

test('browser-style flow: login form, session cookie accepted, home shown, logout', async () => {
  await withServer(PROD_ENV, async (s) => {
    await signupViaApi(s.base, 'flow_user', 'password-one');

    // 1. Open /login directly and submit valid credentials from the form.
    const page = await fetch(`${s.base}/login`);
    const origin = formPostOrigin(page, PROD);
    const login = await postForm(s.base, '/login',
      { username: 'flow_user', password: 'password-one' }, { Origin: origin });
    assert.equal(login.status, 303, 'successful login redirects');
    assert.equal(login.headers.get('location'), '/home');

    // 3. The cookie keeps its settings: HttpOnly, SameSite=Lax, Secure.
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /; Secure/);
    const cookie = sessionFrom(login);
    assert.ok(cookie);

    // 3. The app home accepts the cookie and shows the username. The old dashboard link lands there too.
    const dash = await fetch(`${s.base}/home`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(dash.status, 200);
    assert.match(await dash.text(), /flow_user/);
    const oldDash = await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(oldDash.status, 303);
    assert.equal(oldDash.headers.get('location'), '/home');

    // 4. The data API reports the same user with the cookie, and no one without it.
    const withCookie = await (await fetch(`${s.base}/api/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(withCookie.data.user.username, 'flow_user');
    const without = await (await fetch(`${s.base}/api/me`)).json();
    assert.equal(without.data.user, null);

    // 5. The home page and the old dashboard link redirect anonymous visitors to login.
    const anon = await fetch(`${s.base}/home`, { redirect: 'manual' });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login');
    const anonOld = await fetch(`${s.base}/dashboard`, { redirect: 'manual' });
    assert.equal(anonOld.status, 303);
    assert.equal(anonOld.headers.get('location'), '/home');
  });
});
