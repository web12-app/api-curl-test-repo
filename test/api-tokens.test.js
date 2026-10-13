'use strict';

// API token tests: every signup and login mints a unique Bearer token, tokens
// are scoped to their own user only, logout revokes exactly the presented
// token, and tokens survive a restart because they live in the data repo.
// GitHub is the local fake (test/fake-github.js) over real HTTP - no mocking of
// the site code.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { GitHubStorage } = require('../src/github-storage');
const { GitHubReleases } = require('../src/github-releases');
const { startFakeGitHub } = require('./fake-github');
const { sessionFrom } = require('./helpers');

const TOKEN = 'ghp_test_token_not_real';
const DATA_REPO = 'owner/private-data';
const STORE_REPO = 'owner/files';
const ENV = {
  GITHUB_TOKEN: TOKEN,
  PRIVATE_DATA_REPO: DATA_REPO,
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-1234',
  COOKIE_SECURE: '0',
  GITHUB_OWNER: 'owner',
  GITHUB_STORAGE_REPO: 'files',
};

let fake;
before(async () => {
  fake = await startFakeGitHub({
    privateRepos: {
      [DATA_REPO]: { private: true, push: true },
      [STORE_REPO]: { private: true, push: true },
    },
  });
});
beforeEach(() => {
  fake.reset();
});
after(async () => {
  await fake.close();
});

async function startApp({ clock = { t: Date.now() } } = {}) {
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env: ENV, storage, releases, now: () => clock.t });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withApp(opts, fn) {
  const app = await startApp(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const uniqueName = (prefix) => `${prefix}_${crypto.randomBytes(3).toString('hex')}`;

// Signup, returning the minted API token and the browser cookie.
async function signup(app, username = uniqueName('user'), password = 'password-one') {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  return {
    username,
    password,
    cookie: sessionFrom(res),
    user: body.data.user,
    token: body.data.api_token.token,
    tokenId: body.data.api_token.id,
  };
}

async function login(app, username, password) {
  const res = await fetch(`${app.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return { res, body, cookie: sessionFrom(res), token: body.data.api_token.token };
}

const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

// Multipart upload with a Bearer token and no cookie or CSRF headers at all.
async function upload(app, token, name, bytes) {
  const form = new FormData();
  form.append('uploadId', crypto.randomUUID());
  form.append('file', new Blob([bytes], { type: 'text/plain' }), name);
  const res = await fetch(`${app.base}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { res, body: await res.json() };
}

test('signup and login each mint a unique working API token', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    assert.match(user.token, /^sat_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/);

    const second = await login(app, user.username, user.password);
    assert.notEqual(second.token, user.token);
    assert.match(second.token, /^sat_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/);

    for (const token of [user.token, second.token]) {
      const res = await fetch(`${app.base}/api/me`, bearer(token));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.user.username, user.username);
      assert.equal(body.data.user.id, user.user.id);
    }
  });
});

test('a Bearer token authorizes API calls without cookies or CSRF headers', async () => {
  await withApp({}, async (app) => {
    const { token } = await signup(app);

    const listed = await fetch(`${app.base}/api/files`, bearer(token));
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).data.files, []);

    // A mutating call with neither X-Requested-With nor Origin - impossible for
    // a cross-site browser form, normal for an API client.
    const created = await fetch(`${app.base}/api/tokens`, { method: 'POST', ...bearer(token) });
    assert.equal(created.status, 201);
    assert.match((await created.json()).data.api_token.token, /^sat_/);
  });
});

test('a Bearer logout revokes exactly the presented token', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const second = await login(app, user.username, user.password);

    const out = await fetch(`${app.base}/api/logout`, { method: 'POST', ...bearer(user.token) });
    assert.equal(out.status, 200);
    assert.equal((await out.json()).data.api_token_revoked, true);

    const dead = await fetch(`${app.base}/api/files`, bearer(user.token));
    assert.equal(dead.status, 401);
    assert.equal((await dead.json()).error.code, 'NOT_AUTHENTICATED');

    const alive = await fetch(`${app.base}/api/files`, bearer(second.token));
    assert.equal(alive.status, 200);
  });
});

test('malformed and unknown Bearer tokens are refused', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const badTokens = [
      'sat_deadbeefdeadbeefdeadbeefdeadbeef.' + 'a'.repeat(44), // right shape, unknown
      'not-a-token',
      user.token + 'x', // still well-shaped, unknown
    ];
    for (const bad of badTokens) {
      const res = await fetch(`${app.base}/api/files`, bearer(bad));
      assert.equal(res.status, 401, bad);
      assert.equal((await res.json()).error.code, 'NOT_AUTHENTICATED');
    }
  });
});

test("one user's token cannot read or delete another user's files", async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));

    const up = await upload(app, alice.token, 'alice-note.txt', 'alice private data');
    assert.equal(up.res.status, 201);
    const fileId = up.body.data.file.id;

    const bobsList = await fetch(`${app.base}/api/files`, bearer(bob.token));
    assert.deepEqual((await bobsList.json()).data.files, []);

    const stolen = await fetch(`${app.base}/api/files/${fileId}/download`, bearer(bob.token));
    assert.equal(stolen.status, 404);

    const erased = await fetch(`${app.base}/api/files/${fileId}`, { method: 'DELETE', ...bearer(bob.token) });
    assert.equal(erased.status, 404);

    const mine = await fetch(`${app.base}/api/files`, bearer(alice.token));
    const mineList = (await mine.json()).data.files;
    assert.equal(mineList.length, 1);
    assert.equal(mineList[0].id, fileId);
  });
});

test('API tokens survive a server restart (they live in the data repo)', async () => {
  const clock = { t: Date.now() };
  const app1 = await startApp({ clock });
  const user = await signup(app1);
  await app1.close();

  // A fresh server over the same data repo: the token still works.
  const app2 = await startApp({ clock });
  try {
    const res = await fetch(`${app2.base}/api/files`, bearer(user.token));
    assert.equal(res.status, 200);
  } finally {
    await app2.close();
  }
});

test('token management: list, mint more, revoke by id', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);

    const minted = await fetch(`${app.base}/api/tokens`, { method: 'POST', ...bearer(user.token) });
    assert.equal(minted.status, 201);
    const extra = (await minted.json()).data.api_token;
    assert.notEqual(extra.token, user.token);

    const listed = await fetch(`${app.base}/api/tokens`, bearer(user.token));
    const { tokens, current } = (await listed.json()).data;
    assert.equal(tokens.length, 2);
    assert.ok(tokens.every((t) => t.hash === undefined && t.token === undefined));
    assert.equal(current, user.tokenId);

    const gone = await fetch(`${app.base}/api/tokens/${extra.id}`, { method: 'DELETE', ...bearer(user.token) });
    assert.equal(gone.status, 200);

    const dead = await fetch(`${app.base}/api/files`, bearer(extra.token));
    assert.equal(dead.status, 401);

    const again = await fetch(`${app.base}/api/tokens/${extra.id}`, { method: 'DELETE', ...bearer(user.token) });
    assert.equal(again.status, 404);
    assert.equal((await again.json()).error.code, 'TOKEN_NOT_FOUND');
  });
});

test('a browser (cookie) logout leaves API tokens alone', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const second = await login(app, user.username, user.password);

    const out = await fetch(`${app.base}/api/logout`, {
      method: 'POST',
      headers: { Cookie: user.cookie, 'X-Requested-With': 'fetch', Origin: app.base },
    });
    assert.equal(out.status, 200);

    const browserDead = await fetch(`${app.base}/api/files`, {
      headers: { Cookie: user.cookie, 'X-Requested-With': 'fetch', Origin: app.base },
    });
    assert.equal(browserDead.status, 401);

    const stillAlive = await fetch(`${app.base}/api/files`, bearer(second.token));
    assert.equal(stillAlive.status, 200);
  });
});
