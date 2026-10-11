'use strict';

// End-to-end tests for login, file upload, storage in GitHub releases, download, delete, and isolation.
// GitHub is the local fake (test/fake-github.js), reached over real HTTP. No real token or repository is used.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
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

// A running app with its own clock. Each call builds fresh clients, so state lives only in the fake GitHub,
// the way it does in production.
async function startApp({ env = ENV, limits, clock = { t: Date.now() }, storeRepo = STORE_REPO } = {}) {
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: storeRepo, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env, storage, releases, limits, now: () => clock.t });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    clock,
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

async function signup(app, username = uniqueName('user'), password = 'password-one') {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201);
  return { username, password, cookie: sessionFrom(res), userId: (await res.json()).data.user.id };
}

async function login(app, username, password) {
  const res = await fetch(`${app.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  return { res, cookie: sessionFrom(res), body: await res.json() };
}

// Uploads one file through the real multipart endpoint.
async function upload(app, cookie, name, bytes, { type = 'text/plain', uploadId = crypto.randomUUID(), headers = {} } = {}) {
  const form = new FormData();
  form.append('uploadId', uploadId);
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${app.base}/api/files/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base, ...headers },
    body: form,
  });
  return { res, uploadId, body: await res.json() };
}

const authed = (app, cookie, path, init = {}) =>
  fetch(`${app.base}${path}`, {
    ...init,
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base, ...(init.headers || {}) },
  });

async function listFiles(app, cookie, query = '') {
  const res = await authed(app, cookie, `/api/files${query}`);
  return { status: res.status, data: (await res.json()).data };
}

// Assets in the storage repo, as the fake holds them.
const storedAssets = () => fake.assetsIn(STORE_REPO);

// ---- login contract (unchanged behavior)

test('signup returns 201, login returns 200 with valid credentials, and 401 with invalid ones', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const good = await login(app, user.username, user.password);
    assert.equal(good.res.status, 200);
    assert.ok(good.cookie);
    const bad = await login(app, user.username, 'wrong-password-here');
    assert.equal(bad.res.status, 401);
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  });
});

test('unauthenticated uploads, lists, downloads, and deletes are rejected', async () => {
  await withApp({}, async (app) => {
    const up = await fetch(`${app.base}/api/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'X-Requested-With': 'fetch', Origin: app.base },
      body: 'x',
    });
    assert.equal(up.status, 401);
    const id = crypto.randomBytes(16).toString('hex');
    const list = await fetch(`${app.base}/api/files`);
    assert.equal(list.status, 401);
    assert.equal((await list.json()).error.code, 'NOT_AUTHENTICATED');
    assert.equal((await fetch(`${app.base}/api/files/${id}/download`)).status, 401);
    const del = await fetch(`${app.base}/api/files/${id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Origin: app.base } });
    assert.equal(del.status, 401);
  });
});

test('an authenticated upload succeeds, and the bytes are stored as a release asset in the private storage repo', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const bytes = Buffer.from('hello from the test\n', 'utf8');
    const { res, body } = await upload(app, user.cookie, 'notes.txt', bytes);
    assert.equal(res.status, 201);
    const file = body.data.file;
    assert.equal(file.name, 'notes.txt');
    assert.equal(file.size, bytes.length);
    assert.equal(file.type, 'text/plain; charset=utf-8');

    const assets = storedAssets();
    assert.equal(assets.length, 1);
    assert.equal(assets[0].name, `${file.id}.txt`);
    assert.ok(assets[0].buf.equals(bytes));
    assert.ok(fake.tags.has(`${STORE_REPO}:upload-${file.id}`), 'one release tag per upload');

    // The response never shows GitHub internals.
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /upload-|assetId|releaseId|api\.github|uploads\.github|ghp_/);
  });
});

test('file metadata persists across an application restart', async () => {
  const clock = { t: Date.now() };
  let userCookie;
  let fileId;
  await withApp({ clock }, async (app) => {
    const user = await signup(app);
    userCookie = user.cookie;
    fileId = (await upload(app, user.cookie, 'survives.txt', 'still here')).body.data.file.id;
  });
  // Brand-new process state: a new server, new clients. Only GitHub holds the data.
  await withApp({ clock }, async (app) => {
    const { status, data } = await listFiles(app, userCookie);
    assert.equal(status, 200);
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0].id, fileId);
    const dl = await authed(app, userCookie, `/api/files/${fileId}/download`);
    assert.equal(await dl.text(), 'still here');
  });
});

test('a download returns the original bytes with safe headers, and the token is not sent to the storage host', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const { body } = await upload(app, user.cookie, 'picture.png', bytes, { type: 'image/png' });
    fake.resetCalls();

    const res = await authed(app, user.cookie, `/api/files/${body.data.file.id}/download`);
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength === bytes.length);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="picture\.png"/);

    const storageHop = fake.calls.filter((c) => c.path.startsWith('/blob/'));
    assert.equal(storageHop.length, 1);
    assert.equal(storageHop[0].authed, false, 'the signed storage URL is fetched without the GitHub token');
  });
});

test('a download with a non-ASCII name keeps the name in filename*', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'résumé final.txt', 'cv');
    const res = await authed(app, user.cookie, `/api/files/${body.data.file.id}/download`);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''r%C3%A9sum%C3%A9%20final\.txt/);
    assert.equal(await res.text(), 'cv');
  });
});

test('one user cannot list, download, or delete another user\'s file', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));
    const { body } = await upload(app, alice.cookie, 'private.txt', 'alice only');
    const id = body.data.file.id;

    assert.equal((await listFiles(app, bob.cookie)).data.files.length, 0);
    assert.equal((await authed(app, bob.cookie, `/api/files/${id}/download`)).status, 404);
    const del = await authed(app, bob.cookie, `/api/files/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 404);

    // Alice still has it, and it is still in storage.
    assert.equal((await listFiles(app, alice.cookie)).data.files.length, 1);
    assert.equal(storedAssets().length, 1);
    const still = await authed(app, alice.cookie, `/api/files/${id}/download`);
    assert.equal(await still.text(), 'alice only');
  });
});

test('delete removes the asset, its release and tag, and the record', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'gone.txt', 'bye');
    const id = body.data.file.id;
    const res = await authed(app, user.cookie, `/api/files/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { id, deleted: true });

    assert.equal(storedAssets().length, 0);
    assert.equal(fake.tags.has(`${STORE_REPO}:upload-${id}`), false);
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 0);
    // Deleting it again is a clean 404.
    assert.equal((await authed(app, user.cookie, `/api/files/${id}`, { method: 'DELETE' })).status, 404);
  });
});

test('mismatched contents are rejected, and nothing is stored', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    // A PNG name with text inside is refused on content, not on name.
    const fakePng = await upload(app, user.cookie, 'fake.png', 'definitely not a png', { type: 'image/png' });
    assert.equal(fakePng.res.status, 415);
    assert.equal(fakePng.body.error.code, 'FILE_CONTENT_MISMATCH');
    // Text files must be valid UTF-8 with no NUL bytes.
    const nul = await upload(app, user.cookie, 'bad.txt', Buffer.from('ok\u0000no'));
    assert.equal(nul.body.error.code, 'FILE_CONTENT_MISMATCH');

    assert.equal(storedAssets().length, 0);
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 0);
  });
});

test('an oversized upload is refused with 413 before it is stored, both with and without Content-Length', async () => {
  await withApp({ env: ENV, limits: { maxFileBytes: 1000 } }, async (app) => {
    const user = await signup(app);
    const port = new URL(app.base).port;
    const boundary = 'b' + crypto.randomBytes(6).toString('hex');
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${crypto.randomUUID()}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const chunk = 'x'.repeat(4096);

    // Declared length far above the limit: refused from the header alone.
    const declared = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/files/upload',
        headers: {
          Cookie: user.cookie,
          'X-Requested-With': 'fetch',
          Origin: app.base,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(10 * 1024 * 1024),
        },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.write(head);
      req.end(chunk);
    });
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.code, 'FILE_TOO_LARGE');

    // No Content-Length (chunked): refused while streaming, once the limit is passed.
    const streamed = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/files/upload',
        headers: {
          Cookie: user.cookie,
          'X-Requested-With': 'fetch',
          Origin: app.base,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Transfer-Encoding': 'chunked',
        },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write(head);
      for (let i = 0; i < 8; i++) req.write(chunk);
      req.end(tail);
    });
    assert.equal(streamed.status, 413);
    assert.equal(storedAssets().length, 0);
  });
});

test('unsafe file names are reduced to a plain display name and never used as a storage path', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { res, body } = await upload(app, user.cookie, '../../etc/passwd.txt', 'x');
    assert.equal(res.status, 201);
    assert.equal(body.data.file.name, 'passwd.txt');
    const [asset] = storedAssets();
    assert.match(asset.name, /^[a-f0-9]{32}\.txt$/, 'storage name is the generated id, never the client name');

    const dots = await upload(app, user.cookie, '..', 'x');
    assert.equal(dots.res.status, 400);
    assert.equal(dots.body.error.code, 'INVALID_FILENAME');
  });
});

test('repeating an upload with the same uploadId stores the file once', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    const first = await upload(app, user.cookie, 'once.txt', 'same', { uploadId });
    const second = await upload(app, user.cookie, 'once.txt', 'same', { uploadId });
    assert.equal(first.res.status, 201);
    assert.equal(second.res.status, 200);
    assert.equal(second.body.data.file.id, first.body.data.file.id);
    assert.equal(storedAssets().length, 1);
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 1);
  });
});

test('concurrent uploads by one user are all recorded', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const results = await Promise.all(
      ['a.txt', 'b.txt', 'c.txt'].map((name) => upload(app, user.cookie, name, `content ${name}`)),
    );
    results.forEach((r) => assert.equal(r.res.status, 201));
    const { data } = await listFiles(app, user.cookie);
    assert.deepEqual(data.files.map((f) => f.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(storedAssets().length, 3);
  });
});

test('a GitHub failure while storing the asset leaves no file behind and reports the error', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    fake.fault('POST', /^\/uploads\/repos\//, 500, { times: 1 });
    const { res, body } = await upload(app, user.cookie, 'flaky.txt', 'data');
    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'UPSTREAM_ERROR');
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 0);
    assert.equal(storedAssets().length, 0);
    assert.equal(fake.releases.size, 0, 'the empty release from the failed attempt is removed');
  });
});

test('a failed release creation is not retried automatically, and the account stays clean', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    fake.resetCalls();
    fake.fault('POST', /\/releases$/, 500, { times: 1 });
    const { res } = await upload(app, user.cookie, 'once-only.txt', 'data');
    assert.equal(res.status, 503);
    const releaseWrites = fake.calls.filter((c) => c.method === 'POST' && /\/releases$/.test(c.path));
    assert.equal(releaseWrites.length, 1, 'a failed write is not sent again');
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 0);
  });
});

test('a GitHub rate limit is reported with its own code', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    fake.fault('POST', /^\/uploads\/repos\//, 403, {
      times: 1,
      headers: { 'x-ratelimit-remaining': '0' },
      body: { message: 'API rate limit exceeded' },
    });
    const { res, body } = await upload(app, user.cookie, 'limited.txt', 'data');
    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'RATE_LIMITED');
  });
});

test('when the record cannot be saved after the asset is stored, the file is not shown and the record is cleaned up later', async () => {
  const clock = { t: Date.now() };
  await withApp({ clock }, async (app) => {
    const user = await signup(app);
    // Manifest writes in order: 1) reservation, 2) mark ready. Let the first through and fail the second.
    const manifestPath = new RegExp(`^/repos/${DATA_REPO}/contents/uploads/${user.userId}/manifest\\.json$`);
    fake.fault('PUT', manifestPath, 500, { times: 1, skip: 1 });
    fake.resetCalls();

    const { res } = await upload(app, user.cookie, 'half.txt', 'half done');
    assert.equal(res.status, 503);
    const manifestWrites = fake.calls.filter((c) => c.method === 'PUT' && manifestPath.test(c.path));
    assert.equal(manifestWrites.length, 2, 'the failed write is not retried');
    assert.equal(storedAssets().length, 1, 'the bytes did reach storage');
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 0, 'the record is pending, so it is not shown');

    // 16 minutes later the abandoned record is cleaned up together with its release, and uploads work again.
    clock.t += 16 * 60 * 1000;
    const next = await upload(app, user.cookie, 'after.txt', 'fresh');
    assert.equal(next.res.status, 201);
    assert.equal(storedAssets().length, 1, 'only the new file remains in storage');
    assert.equal(fake.releases.size, 1, 'the abandoned release is gone');
    assert.equal((await listFiles(app, user.cookie)).data.files.map((f) => f.name).join(), 'after.txt');
  });
});

test('a failed cleanup keeps the record for a later retry, and the next write retries it', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    // Asset upload fails, and removing the empty release also fails once.
    fake.fault('POST', /^\/uploads\/repos\//, 500, { times: 1 });
    fake.fault('DELETE', /^\/repos\/owner\/files\/releases\/\d+$/, 500, { times: 1 });
    const failed = await upload(app, user.cookie, 'leftover.txt', 'x');
    assert.equal(failed.res.status, 503);
    assert.equal(fake.releases.size, 1, 'the release could not be removed the first time');

    // The next upload's cleanup retries the removal and succeeds.
    const ok = await upload(app, user.cookie, 'next.txt', 'y');
    assert.equal(ok.res.status, 201);
    assert.equal(fake.releases.size, 1, 'the leftover release was removed; only the new one remains');
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 1);
  });
});

test('a failed asset delete leaves the file marked "deleting" and a retry finishes the job', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'retry-me.txt', 'data');
    const id = body.data.file.id;
    fake.fault('DELETE', /^\/repos\/owner\/files\/releases\/assets\/\d+$/, 500, { times: 1 });
    const first = await authed(app, user.cookie, `/api/files/${id}`, { method: 'DELETE' });
    assert.equal(first.status, 503);

    const listed = await listFiles(app, user.cookie);
    assert.equal(listed.data.files.length, 1);
    assert.equal(listed.data.files[0].status, 'deleting');

    const retry = await authed(app, user.cookie, `/api/files/${id}`, { method: 'DELETE' });
    assert.equal(retry.status, 200);
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 0);
    assert.equal(storedAssets().length, 0);
  });
});

test('a file whose asset was removed outside the app returns 404 with a clear code', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'vanished.txt', 'data');
    const asset = storedAssets()[0];
    fake.assets.delete(`${STORE_REPO}:${asset.id}`);
    const res = await authed(app, user.cookie, `/api/files/${body.data.file.id}/download`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'FILE_MISSING');
  });
});

test('uploads are refused when the storage repository is not private', async () => {
  const publicRepo = 'owner/public-files';
  fake.setRepo(publicRepo, { private: false, push: true });
  const env = { ...ENV, GITHUB_STORAGE_REPO: 'public-files' };
  await withApp({ env, storeRepo: publicRepo }, async (app) => {
    const user = await signup(app);
    const { res, body } = await upload(app, user.cookie, 'public.txt', 'data');
    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'UPSTREAM_ERROR');
    assert.equal(storedAssets().length, 0, 'nothing reached the public repository');
    assert.equal(fake.releases.size, 0);
  });
});

test('there is no total storage limit: many files past the old 200 MB quota are accepted', async () => {
  await withApp({ limits: { maxFileBytes: 1000 } }, async (app) => {
    const user = await signup(app);
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const r = await upload(app, user.cookie, name, 'x'.repeat(1000));
      assert.equal(r.res.status, 201, name);
    }
    const { data } = await listFiles(app, user.cookie);
    assert.equal(data.quota.usedBytes, 3000);
    assert.equal(data.quota.limitBytes, undefined, 'no limit is reported');
    assert.equal(data.files.length, 3);
  });
});

test('search and category filters narrow the list', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    await upload(app, user.cookie, 'meeting-notes.txt', 'n');
    await upload(app, user.cookie, 'holiday.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { type: 'image/png' });
    assert.equal((await listFiles(app, user.cookie, '?category=image')).data.files.map((f) => f.name).join(), 'holiday.png');
    assert.equal((await listFiles(app, user.cookie, '?q=NOTES')).data.files.map((f) => f.name).join(), 'meeting-notes.txt');
    assert.equal((await listFiles(app, user.cookie, '?category=video')).status, 200);
    assert.equal((await listFiles(app, user.cookie, '?category=bogus')).status, 400);
  });
});

test('a cross-site upload or delete is refused with 403, whatever the cookie', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'mine.txt', 'data');
    const evil = { Origin: 'https://evil.example' };
    const up = await upload(app, user.cookie, 'attack.txt', 'x', { headers: evil });
    assert.equal(up.res.status, 403);
    assert.equal(up.body.error.code, 'CROSS_SITE_REFUSED');
    const del = await authed(app, user.cookie, `/api/files/${body.data.file.id}`, { method: 'DELETE', headers: evil });
    assert.equal(del.status, 403);
    assert.equal((await listFiles(app, user.cookie)).data.files.length, 1);
  });
});

test('upload and delete require the X-Requested-With header', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'csrf.txt', 'data');
    const form = new FormData();
    form.append('uploadId', crypto.randomUUID());
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'no-header.txt');
    const up = await fetch(`${app.base}/api/files/upload`, {
      method: 'POST',
      headers: { Cookie: user.cookie, Origin: app.base },
      body: form,
    });
    assert.equal(up.status, 403);
    assert.equal((await up.json()).error.code, 'CSRF_HEADER_REQUIRED');
    const del = await fetch(`${app.base}/api/files/${body.data.file.id}`, {
      method: 'DELETE',
      headers: { Cookie: user.cookie, Origin: app.base },
    });
    assert.equal(del.status, 403);
  });
});

test('logout ends the session on the server: a copied cookie stops working in every browser', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const second = await login(app, user.username, user.password);
    const first = user.cookie;
    assert.equal((await (await authed(app, first, '/api/me')).json()).data.user.username, user.username);

    const out = await fetch(`${app.base}/api/logout`, { method: 'POST', headers: { Cookie: first, Origin: app.base } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /session=;.*Max-Age=0/);

    // Both the logged-out cookie and the other device's cookie are refused.
    assert.equal((await (await authed(app, first, '/api/me')).json()).data.user, null);
    assert.equal((await (await authed(app, second.cookie, '/api/me')).json()).data.user, null);
    assert.equal((await authed(app, second.cookie, '/home', { redirect: 'manual' })).status, 303);
    assert.equal((await listFiles(app, second.cookie).then((r) => r.status)), 401);

    // A new login works.
    const again = await login(app, user.username, user.password);
    assert.equal((await (await authed(app, again.cookie, '/api/me')).json()).data.user.username, user.username);
  });
});

test('file routes say which setting is missing when storage is not configured, and login still works', async () => {
  const env = { ...ENV };
  delete env.GITHUB_OWNER;
  await withApp({ env }, async (app) => {
    const user = await signup(app);
    const res = await authed(app, user.cookie, '/api/files');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'FILES_NOT_CONFIGURED');
    assert.match(body.error.message, /GITHUB_OWNER/);
    assert.doesNotMatch(body.error.message, /ghp_|private-data/);
    const dash = await authed(app, user.cookie, '/explore');
    assert.match(await dash.text(), /File storage is not set up/);
  });
});

test('the storage repository cannot be the same as the private data repository', async () => {
  const env = { ...ENV, GITHUB_STORAGE_REPO: 'private-data', GITHUB_OWNER: 'owner' };
  const { loadFileConfig } = require('../src/config');
  const loaded = loadFileConfig(env, { privateDataRepo: DATA_REPO });
  assert.equal(loaded.ok, false);
  assert.match(loaded.missing[0], /must differ/);
});

test('the explore page ships the React app shell with the bootstrap data, and contains no GitHub details', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    await upload(app, user.cookie, 'listed.txt', 'data');
    const res = await authed(app, user.cookie, '/explore');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), APP_SHELL_CSP);
    const html = await res.text();
    for (const marker of ['id="root"', 'id="app-bootstrap"', 'src="/assets/app.js"', '"page":"explore"', '"filesEnabled":true', 'application/json']) {
      assert.ok(html.includes(marker), marker);
    }
    assert.match(html, /"maxBytes":\d+/);
    assert.doesNotMatch(html, /ghp_|api\.github|uploads\.github|upload-[a-f0-9]{8}|assetId/);
    assert.match(html, new RegExp(user.username));
    assert.doesNotMatch(html, /listed\.txt/, 'the page loads the list itself; it is not rendered into the HTML');
    const anon = await fetch(`${app.base}/explore`, { redirect: 'manual' });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login');
    // The home page shows no file list: no table and no upload queue.
    const home = await authed(app, user.cookie, '/home');
    const homeHtml = await home.text();
    assert.match(homeHtml, new RegExp(user.username));
    assert.doesNotMatch(homeHtml, /id="files"|id="drop"|id="search"/);
  });
});

const APP_SHELL_CSP =
  "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";

test('the React bundle is served from /assets with a JavaScript content type', async () => {
  await withApp({}, async (app) => {
    const res = await fetch(`${app.base}/assets/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = await res.text();
    assert.ok(body.length > 1000, 'the bundle is not empty');
    assert.doesNotMatch(body, /ghp_|SESSION_SECRET/);
    const missing = await fetch(`${app.base}/assets/nope.js`);
    assert.equal(missing.status, 404);
    const wrongType = await fetch(`${app.base}/assets/app.exe`);
    assert.equal(wrongType.status, 404);
    // The pattern only accepts one plain path segment, so traversal names cannot reach the disk.
    const traversal = await fetch(`${app.base}/assets/..%2Fserver.js`);
    assert.notEqual(traversal.status, 200);
  });
});

test('several uploads, including each id, never reveal a token in any response body', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const bodies = [];
    bodies.push(JSON.stringify((await upload(app, user.cookie, 'a.txt', 'a')).body));
    bodies.push(await (await authed(app, user.cookie, '/api/files')).text());
    for (const text of bodies) {
      assert.doesNotMatch(text, new RegExp(TOKEN));
      assert.doesNotMatch(text, /api\.github|uploads\.github|\/blob\//);
    }
  });
});

test('uploads are capped in flight, and an abandoned upload frees its slot', async () => {
  await withApp({ limits: { maxConcurrentUploads: 1 } }, async (app) => {
    const user = await signup(app);
    const url = new URL(app.base);
    const boundary = 'stuck-boundary-1';
    // An upload that starts and then stalls, so it holds the only slot.
    const stuck = http.request({
      host: url.hostname,
      port: url.port,
      method: 'POST',
      path: '/api/files/upload',
      headers: {
        Cookie: user.cookie,
        Origin: app.base,
        'X-Requested-With': 'fetch',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': 100000,
      },
    });
    stuck.on('error', () => {});
    stuck.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello`);
    await new Promise((r) => setTimeout(r, 150));

    const blocked = await upload(app, user.cookie, 'b.txt', 'b');
    assert.equal(blocked.res.status, 429);
    assert.equal(blocked.body.error.code, 'TOO_MANY_UPLOADS');

    // The client goes away. The slot is released and the next upload succeeds.
    stuck.destroy();
    let last = null;
    for (let i = 0; i < 100; i++) {
      last = await upload(app, user.cookie, 'c.txt', 'c');
      if (last.res.status === 201) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(last.res.status, 201, `status ${last.res.status}`);
    assert.equal(storedAssets().length, 1, 'the abandoned upload stored nothing');
  });
});

// ---- preview

test('preview: an owner sees a previewable file inline with a sandboxed policy; other types are refused', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
    const { body } = await upload(app, user.cookie, 'pic.png', png, { type: 'image/png' });
    const res = await authed(app, user.cookie, `/api/files/${body.data.file.id}/preview`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'), /^inline;/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', 'the dashboard can frame it, other sites cannot');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const zip = await upload(app, user.cookie, 'bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), { type: 'application/zip' });
    const refused = await authed(app, user.cookie, `/api/files/${zip.body.data.file.id}/preview`);
    assert.equal(refused.status, 415);
    assert.equal((await refused.json()).error.code, 'PREVIEW_NOT_AVAILABLE');
  });
});

// ---- sharing

const putSharing = (app, cookie, id, makePublic) =>
  authed(app, cookie, `/api/files/${id}/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public: makePublic }),
  });

test('sharing: private by default; a link works without login; turning it off ends the link', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const bytes = 'shared bytes\n';
    const { body } = await upload(app, user.cookie, 'report.txt', bytes);
    const id = body.data.file.id;
    let { data } = await listFiles(app, user.cookie);
    assert.equal(data.files[0].visibility, 'private');
    assert.equal(data.files[0].sharePath, null);

    const on = await putSharing(app, user.cookie, id, true);
    assert.equal(on.status, 200);
    const sharePath = (await on.json()).data.file.sharePath;
    assert.match(sharePath, /^\/s\/[A-Za-z0-9_-]{43}$/);
    const token = sharePath.slice(3);

    // No cookie and no Origin: the link stands on its own.
    const dl = await fetch(`${app.base}/s/${token}/download`);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), bytes);
    assert.match(dl.headers.get('content-disposition'), /^attachment;/);

    const page = await fetch(`${app.base}/s/${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /report\.txt/);
    assert.doesNotMatch(html, /api\.github|upload-|releases|assets|ghp_/i, 'no storage details on the public page');

    const off = await putSharing(app, user.cookie, id, false);
    assert.equal(off.status, 200);
    assert.equal((await fetch(`${app.base}/s/${token}/download`)).status, 404);
    assert.equal((await fetch(`${app.base}/s/${token}`)).status, 404);
    ({ data } = await listFiles(app, user.cookie));
    assert.equal(data.files[0].visibility, 'private');
  });
});

test('sharing: turning it on again makes a new link, and the old link stays dead', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'a.txt', 'hello');
    const id = body.data.file.id;
    const first = (await (await putSharing(app, user.cookie, id, true)).json()).data.file.sharePath.slice(3);
    // Turning it on while already on keeps the same link.
    const again = (await (await putSharing(app, user.cookie, id, true)).json()).data.file.sharePath.slice(3);
    assert.equal(again, first);
    await putSharing(app, user.cookie, id, false);
    const second = (await (await putSharing(app, user.cookie, id, true)).json()).data.file.sharePath.slice(3);
    assert.notEqual(second, first);
    assert.equal((await fetch(`${app.base}/s/${first}/download`)).status, 404, 'the old link is dead');
    assert.equal(await (await fetch(`${app.base}/s/${second}/download`)).text(), 'hello');
  });
});

test('sharing: deleting a shared file ends its link', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'gone.txt', 'soon gone');
    const id = body.data.file.id;
    const token = (await (await putSharing(app, user.cookie, id, true)).json()).data.file.sharePath.slice(3);
    assert.equal(await (await fetch(`${app.base}/s/${token}/download`)).text(), 'soon gone');
    const del = await authed(app, user.cookie, `/api/files/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${app.base}/s/${token}/download`)).status, 404);
  });
});

test('sharing: a share link keeps working after a process restart', async () => {
  const first = await startApp({});
  const user = await signup(first);
  const { body } = await upload(first, user.cookie, 'keep.txt', 'kept across restart');
  const token = (await (await putSharing(first, user.cookie, body.data.file.id, true)).json()).data.file.sharePath.slice(3);
  await first.close();

  const second = await startApp({});
  try {
    const res = await fetch(`${second.base}/s/${token}/download`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'kept across restart');
  } finally {
    await second.close();
  }
});

test('sharing and preview are owner-only: another user gets 404 and cannot change the file', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app);
    const bob = await signup(app);
    const { body } = await upload(app, alice.cookie, 'alice.txt', 'alice only');
    const id = body.data.file.id;
    assert.equal((await putSharing(app, bob.cookie, id, true)).status, 404);
    assert.equal((await authed(app, bob.cookie, `/api/files/${id}/preview`)).status, 404);
    const { data } = await listFiles(app, alice.cookie);
    assert.equal(data.files[0].visibility, 'private', 'bob could not make it public');
  });
});

test('sharing: needs a session and the X-Requested-With header', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'a.txt', 'x');
    const id = body.data.file.id;
    const noSession = await fetch(`${app.base}/api/files/${id}/sharing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: app.base },
      body: JSON.stringify({ public: true }),
    });
    assert.equal(noSession.status, 401);
    const noHeader = await fetch(`${app.base}/api/files/${id}/sharing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: app.base, Cookie: user.cookie },
      body: JSON.stringify({ public: true }),
    });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error.code, 'CSRF_HEADER_REQUIRED');
  });
});

test('sharing: a bad body is refused, and unknown or malformed links are 404', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'a.txt', 'x');
    const id = body.data.file.id;
    const bad = await authed(app, user.cookie, `/api/files/${id}/sharing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: 'yes' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_BODY');

    // A never-shared file has no link, and a made-up token matches nothing.
    assert.equal((await fetch(`${app.base}/s/${'A'.repeat(43)}/download`)).status, 404);
    assert.equal((await fetch(`${app.base}/s/short/download`)).status, 404);
    assert.equal((await fetch(`${app.base}/s/${'A'.repeat(43)}`)).status, 404);
  });
});

test('shared preview is inline and sandboxed, and only for previewable types', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'note.txt', 'preview me');
    const token = (await (await putSharing(app, user.cookie, body.data.file.id, true)).json()).data.file.sharePath.slice(3);
    const res = await fetch(`${app.base}/s/${token}/preview`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'preview me');
    assert.match(res.headers.get('content-disposition'), /^inline;/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  });
});


// ---- any file type, video, and anonymous upload links (Task 12)

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from('rest of the movie')]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm body')]);

test('any type is accepted: unknown and active types are stored as octet-stream and only downloaded as attachments', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    for (const [name, bytes] of [
      ['page.html', '<script>alert(1)</script>'],
      ['vector.svg', '<svg onload="alert(1)"></svg>'],
      ['program.exe', 'MZ\u0000\u0000'],
    ]) {
      const { res, body } = await upload(app, user.cookie, name, bytes, { type: 'text/html' });
      assert.equal(res.status, 201, name);
      assert.equal(body.data.file.category, 'other', name);
      const id = body.data.file.id;

      const dl = await authed(app, user.cookie, `/api/files/${id}/download`);
      assert.equal(dl.status, 200, name);
      assert.equal(dl.headers.get('content-type'), 'application/octet-stream', name);
      assert.match(dl.headers.get('content-disposition'), /^attachment;/, name);
      assert.equal(dl.headers.get('x-content-type-options'), 'nosniff', name);

      const pv = await authed(app, user.cookie, `/api/files/${id}/preview`);
      assert.equal(pv.status, 415, name);
      assert.equal((await pv.json()).error.code, 'PREVIEW_NOT_AVAILABLE', name);
    }
    const { data } = await listFiles(app, user.cookie);
    assert.equal(data.files.every((f) => f.previewable === false), true, 'none of these can be previewed');
  });
});

test('video and audio: the signature must match, and a valid file is accepted and listed as video', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const ok1 = await upload(app, user.cookie, 'Holiday.MP4', MP4, { type: 'video/mp4' });
    assert.equal(ok1.res.status, 201);
    assert.equal(ok1.body.data.file.category, 'video');
    assert.equal(ok1.body.data.file.type, 'video/mp4');
    const ok2 = await upload(app, user.cookie, 'clip.webm', WEBM, { type: 'video/webm' });
    assert.equal(ok2.res.status, 201);
    const fake = await upload(app, user.cookie, 'fake.mp4', 'this is not a video', { type: 'video/mp4' });
    assert.equal(fake.res.status, 415);
    assert.equal(fake.body.error.code, 'FILE_CONTENT_MISMATCH');
    const { data } = await listFiles(app, user.cookie, '?category=video');
    assert.deepEqual(data.files.map((f) => f.name).sort(), ['Holiday.MP4', 'clip.webm'].sort());
  });
});

test('a video preview is inline with its own type and the sandbox policy', async () => {
  await withApp({}, async (app) => {
    const user = await signup(app);
    const { body } = await upload(app, user.cookie, 'movie.mp4', MP4, { type: 'video/mp4' });
    const res = await authed(app, user.cookie, `/api/files/${body.data.file.id}/preview`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.match(res.headers.get('content-disposition'), /^inline;/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(res.headers.get('content-security-policy'), /media-src 'self'/, 'a browser tab may play the video');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  });
});

const createLink = (app, cookie, label = '') =>
  authed(app, cookie, '/api/upload-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });

// Anonymous upload through a link: no cookie, no CSRF header. Only the path (with the token) is needed.
async function uploadViaLink(app, uploadPath, name, bytes, { type = 'text/plain', origin = null } = {}) {
  const form = new FormData();
  form.append('uploadId', crypto.randomUUID());
  form.append('file', new Blob([bytes], { type }), name);
  const headers = origin ? { Origin: origin } : {};
  const res = await fetch(`${app.base}${uploadPath}/upload`, { method: 'POST', headers, body: form, redirect: 'manual' });
  return { res, text: await res.text() };
}

test('upload link: the owner creates a link, anyone uploads with no login, and the owner sees and manages the upload', async () => {
  await withApp({}, async (app) => {
    const owner = await signup(app);
    const made = await createLink(app, owner.cookie, 'Photos from the trip');
    assert.equal(made.status, 201);
    const { link } = (await made.json()).data;
    assert.match(link.uploadPath, /^\/u\/[A-Za-z0-9_-]{43}$/);
    assert.equal(link.label, 'Photos from the trip');

    const page = await fetch(`${app.base}${link.uploadPath}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /enctype="multipart\/form-data"/);
    assert.match(html, /name="uploadId"/);
    assert.doesNotMatch(html, /<script/i, 'the form needs no script');
    assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);

    // A cross-site origin still works: the token is the credential, and the route has no cookie to abuse.
    const sent = await uploadViaLink(app, link.uploadPath, 'trip.txt', 'hello from a guest', { origin: 'https://elsewhere.example' });
    assert.equal(sent.res.status, 200, sent.text);
    assert.match(sent.text, /was stored/);

    const { data } = await listFiles(app, owner.cookie);
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0].viaLink, true);
    assert.equal(data.files[0].name, 'trip.txt');

    const links = await (await authed(app, owner.cookie, '/api/upload-links')).json();
    assert.equal(links.data.links[0].uploads, 1);
    assert.equal(links.data.links[0].active, true);

    // The manifest keeps the link id only. It never stores the uploader's address.
    const stored = fake.contents.get(`${DATA_REPO}:uploads/${owner.userId}/manifest.json`).buf.toString();
    assert.match(stored, /"linkId": ?"[a-f0-9]{32}"/);
    assert.doesNotMatch(stored, /127\.0\.0\.1|::1|"ip"/);
    // The stored bytes are the guest's bytes.
    const dl = await authed(app, owner.cookie, `/api/files/${data.files[0].id}/download`);
    assert.equal(await dl.text(), 'hello from a guest');
  });
});

test('upload link: revoke stops new uploads at once and keeps the files already uploaded', async () => {
  await withApp({}, async (app) => {
    const owner = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie, 'temp')).json()).data;
    assert.equal((await uploadViaLink(app, link.uploadPath, 'before.txt', 'a')).res.status, 200);

    // Revoke needs the session and the CSRF header.
    const noHeader = await fetch(`${app.base}/api/upload-links/${link.id}`, {
      method: 'DELETE',
      headers: { Cookie: owner.cookie, Origin: app.base },
    });
    assert.equal(noHeader.status, 403);

    const revoked = await authed(app, owner.cookie, `/api/upload-links/${link.id}`, { method: 'DELETE' });
    assert.equal(revoked.status, 200);
    const view = (await revoked.json()).data.link;
    assert.equal(view.active, false);
    assert.equal(view.uploadPath, null, 'a revoked link shows no path');

    assert.equal((await fetch(`${app.base}${link.uploadPath}`)).status, 404);
    const after = await uploadViaLink(app, link.uploadPath, 'after.txt', 'b');
    assert.equal(after.res.status, 404);
    assert.equal((await listFiles(app, owner.cookie)).data.files.map((f) => f.name).join(), 'before.txt');

    // Revoking again is harmless.
    assert.equal((await authed(app, owner.cookie, `/api/upload-links/${link.id}`, { method: 'DELETE' })).status, 200);
  });
});

test('upload link: another user cannot revoke a link or see it, and a link never uploads into someone else\'s account', async () => {
  await withApp({}, async (app) => {
    const owner = await signup(app);
    const other = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie, 'mine')).json()).data;

    assert.equal((await authed(app, other.cookie, `/api/upload-links/${link.id}`, { method: 'DELETE' })).status, 404);
    const theirs = await (await authed(app, other.cookie, '/api/upload-links')).json();
    assert.equal(theirs.data.links.length, 0);
    assert.equal((await authed(app, owner.cookie, `/api/upload-links/${link.id}`, { method: 'DELETE' })).status, 200);
  });
});

test('upload link: multiple uploaders through one link all land in the owner\'s list, and other accounts see none', async () => {
  await withApp({}, async (app) => {
    const owner = await signup(app);
    const bystander = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie, 'shared')).json()).data;
    const names = ['one.txt', 'two.txt', 'three.txt'];
    const results = await Promise.all(names.map((n) => uploadViaLink(app, link.uploadPath, n, `contents of ${n}`)));
    for (const r of results) assert.equal(r.res.status, 200, r.text);

    const { data } = await listFiles(app, owner.cookie);
    assert.deepEqual(data.files.map((f) => f.name).sort(), names.slice().sort());
    assert.ok(data.files.every((f) => f.viaLink));
    assert.equal((await listFiles(app, bystander.cookie)).data.files.length, 0);
    const links = await (await authed(app, owner.cookie, '/api/upload-links')).json();
    assert.equal(links.data.links[0].uploads, 3);
  });
});

test('upload link: a link stops at its own file limit, and uploads by the owner are not affected', async () => {
  await withApp({ limits: { linkMaxFiles: 2 } }, async (app) => {
    const owner = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie, '')).json()).data;
    assert.equal((await uploadViaLink(app, link.uploadPath, 'a.txt', 'a')).res.status, 200);
    assert.equal((await uploadViaLink(app, link.uploadPath, 'b.txt', 'b')).res.status, 200);
    const third = await uploadViaLink(app, link.uploadPath, 'c.txt', 'c');
    assert.equal(third.res.status, 507);
    assert.match(third.text, /file limit/);
    const own = await upload(app, owner.cookie, 'own.txt', 'owner file');
    assert.equal(own.res.status, 201, 'the owner can still upload');
  });
});

test('upload link: a link stops at its own size limit', async () => {
  await withApp({ limits: { maxFileBytes: 1000, linkMaxBytes: 2500 } }, async (app) => {
    const owner = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie)).json()).data;
    assert.equal((await uploadViaLink(app, link.uploadPath, 'a.txt', 'x'.repeat(1000))).res.status, 200);
    assert.equal((await uploadViaLink(app, link.uploadPath, 'b.txt', 'x'.repeat(1000))).res.status, 200);
    const over = await uploadViaLink(app, link.uploadPath, 'c.txt', 'x'.repeat(1000));
    assert.equal(over.res.status, 507);
    assert.match(over.text, /size limit/);
  });
});

test('upload link: uploads count toward the owner\'s account file cap', async () => {
  await withApp({ limits: { maxFiles: 2 } }, async (app) => {
    const owner = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie)).json()).data;
    assert.equal((await upload(app, owner.cookie, 'own.txt', 'o')).res.status, 201);
    assert.equal((await uploadViaLink(app, link.uploadPath, 'guest.txt', 'g')).res.status, 200);
    const over = await uploadViaLink(app, link.uploadPath, 'more.txt', 'm');
    assert.equal(over.res.status, 507);
    assert.match(over.text, /keep up to 2 files/);
  });
});

test('upload link: a file over the per-file cap is refused, and a bad page or token is 404', async () => {
  await withApp({ limits: { maxFileBytes: 1000 } }, async (app) => {
    const owner = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie)).json()).data;
    const big = await uploadViaLink(app, link.uploadPath, 'big.txt', 'x'.repeat(5000));
    assert.equal(big.res.status, 413);
    assert.equal((await fetch(`${app.base}/u/${'A'.repeat(43)}`)).status, 404);
    assert.equal((await fetch(`${app.base}/u/short`)).status, 404);
    assert.equal((await listFiles(app, owner.cookie)).data.files.length, 0);
  });
});

test('logs: upload, link, and sharing events print masked names and short references only', async () => {
  const captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    await withApp({}, async (app) => {
      const owner = await signup(app);
      const secretName = 'Quarterly-Salary-Plan.txt';
      const own = await upload(app, owner.cookie, secretName, 'numbers');
      const fileId = own.body.data.file.id;
      const made = await createLink(app, owner.cookie, 'Confidential label');
      const { link } = (await made.json()).data;
      const guest = await uploadViaLink(app, link.uploadPath, 'Board-Minutes-2026.pdf', '%PDF-1.4 minutes', { type: 'application/pdf' });
      assert.equal(guest.res.status, 200, guest.text);
      const shared = await putSharing(app, owner.cookie, fileId, true);
      assert.equal(shared.status, 200);
      const token = (await shared.json()).data.file.sharePath.slice(3);
      await authed(app, owner.cookie, `/api/upload-links/${link.id}`, { method: 'DELETE' });

      const log = captured.join('\n');
      assert.match(log, /upload stored: file=Q…\.txt id=[a-f0-9]{8}/, 'masked name and short id');
      assert.match(log, /upload stored: file=B…\.pdf/);
      assert.match(log, /upload link created: link=[a-f0-9]{8}/);
      assert.match(log, /link=[a-f0-9]{8}/);
      assert.match(log, /share enabled: file=Q…\.txt/);
      assert.match(log, /upload link revoked: link=[a-f0-9]{8}/);

      // Nothing sensitive: no full name, no label, no token, no full link, no full id.
      for (const secret of [secretName, 'Board-Minutes', 'Confidential', token, link.uploadPath, link.id, fileId, link.uploadPath.slice(3)]) {
        assert.equal(log.includes(secret), false, `log must not contain ${secret.slice(0, 6)}…`);
      }
      assert.equal(/[a-f0-9]{32}/.test(log), false, 'no full 32-character id');
      assert.equal(/[A-Za-z0-9_-]{43}/.test(log), false, 'no full token');
    });
  } finally {
    console.log = original;
  }
});

test('upload links: /u/ requests are limited per address, and the limit answers 429 with Retry-After', async () => {
  await withApp({}, async (app) => {
    const bogus = `${app.base}/u/${'A'.repeat(43)}`;
    let last = null;
    for (let i = 0; i <= 300; i++) {
      last = await fetch(bogus);
      await last.arrayBuffer();
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429, 'the 301st request from one address is refused');
    assert.equal(last.headers.get('retry-after'), '900');
  });
});

test('the per-file cap applies to chunked uploads too, through the owner and through an upload link', async () => {
  await withApp({ limits: { maxFileBytes: 1000 } }, async (app) => {
    const owner = await signup(app);
    const { link } = (await (await createLink(app, owner.cookie)).json()).data;
    const boundary = 'chunkedboundary' + crypto.randomBytes(4).toString('hex');
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${crypto.randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;

    // Sends the body with Transfer-Encoding: chunked (no Content-Length), so the size is only known while streaming.
    const sendChunked = (path, headers) =>
      new Promise((resolve, reject) => {
        const url = new URL(`${app.base}${path}`);
        const req = http.request(
          { host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked', ...headers } },
          (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, text }));
          },
        );
        req.on('error', (err) => resolve({ status: 0, text: String(err && err.code) }));
        req.write(head);
        for (let i = 0; i < 8; i++) req.write('x'.repeat(1000));
        req.end(tail);
      });

    const viaOwner = await sendChunked('/api/files/upload', { Cookie: owner.cookie, 'X-Requested-With': 'fetch', Origin: app.base });
    assert.equal(viaOwner.status, 413, 'owner chunked upload refused');
    const viaLink = await sendChunked(`${link.uploadPath}/upload`, {});
    assert.equal(viaLink.status, 413, 'link chunked upload refused');
    assert.equal((await listFiles(app, owner.cookie)).data.files.length, 0, 'nothing was stored');
  });
});
