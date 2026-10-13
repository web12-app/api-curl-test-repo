'use strict';

// Pips app companion endpoints: file detail/rename, the Pips DB, devices,
// and the social layer (follows, DMs, notifications, avatars). GitHub is the
// local fake (test/fake-github.js) reached over real HTTP.

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

async function startApp() {
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env: ENV, storage, releases });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withApp(fn) {
  const app = await startApp();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const uniqueName = (prefix) => `${prefix}_${crypto.randomBytes(3).toString('hex')}`;

// Signup; returns cookie + token credentials.
async function signup(app, username = uniqueName('user')) {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password: 'password-one' }),
  });
  assert.equal(res.status, 201, `signup ${username}`);
  const body = await res.json();
  return { username, cookie: sessionFrom(res), token: body.data.api_token.token };
}

const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const bearerJson = (token, body, method = 'POST') => ({
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Multipart upload with a Bearer token (no cookies, no CSRF header needed).
async function upload(app, token, name, bytes, type = 'text/plain') {
  const form = new FormData();
  form.append('uploadId', crypto.randomUUID());
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${app.base}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(res.status, 201, 'upload');
  return (await res.json()).data.file;
}

// Creates a Tube channel for a user (so the name shows up in social discovery).
async function createChannel(app, token, name) {
  const res = await fetch(`${app.base}/api/tube/my-channel`, bearerJson(token, { name }, 'PUT'));
  assert.equal(res.status, 200, 'channel create');
  return (await res.json()).data.channel;
}

// ---------------------------------------------------------------- files

test('single file GET and rename work, and stay scoped to the owner', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));
    const file = await upload(app, alice.token, 'notes.txt', 'hello world');

    const got = await fetch(`${app.base}/api/files/${file.id}`, bearer(alice.token));
    assert.equal(got.status, 200);
    assert.equal((await got.json()).data.file.name, 'notes.txt');

    const renamed = await fetch(`${app.base}/api/files/${file.id}`, bearerJson(alice.token, { name: 'renamed.txt' }, 'PATCH'));
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).data.file.name, 'renamed.txt');

    const list = await fetch(`${app.base}/api/files`, bearer(alice.token));
    assert.equal((await list.json()).data.files[0].name, 'renamed.txt');

    // Bob sees neither the detail nor can rename it.
    assert.equal((await fetch(`${app.base}/api/files/${file.id}`, bearer(bob.token))).status, 404);
    assert.equal((await fetch(`${app.base}/api/files/${file.id}`, bearerJson(bob.token, { name: 'x.txt' }, 'PATCH'))).status, 404);

    // Bad names are refused.
    assert.equal((await fetch(`${app.base}/api/files/${file.id}`, bearerJson(alice.token, { name: '' }, 'PATCH'))).status, 400);
  });
});

// ---------------------------------------------------------------- pips db

test('pips db: create, list, read, write with versions, line edit, move, remove, restore', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));

    const made = await fetch(`${app.base}/api/db`, bearerJson(alice.token, { name: 'hello.md', content: '# hi\nsecond\n' }));
    assert.equal(made.status, 201);
    const doc = (await made.json()).data.file;
    assert.match(doc.id, /^[a-f0-9]{12}$/);
    assert.equal(doc.version, 1);

    // Duplicate name refused.
    assert.equal((await fetch(`${app.base}/api/db`, bearerJson(alice.token, { name: 'hello.md', content: 'x' }))).status, 409);

    const listed = await fetch(`${app.base}/api/db`, bearer(alice.token));
    assert.equal((await listed.json()).data.files.length, 1);

    const read = await fetch(`${app.base}/api/db/${doc.id}`, bearer(alice.token));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).data.content, '# hi\nsecond\n');

    // A write snapshots the previous content as version 1.
    const write = await fetch(`${app.base}/api/db/${doc.id}`, bearerJson(alice.token, { content: '# changed\n' }, 'PUT'));
    assert.equal(write.status, 200);
    assert.equal((await write.json()).data.file.version, 2);

    // Line edit: insert at line 2.
    const line = await fetch(`${app.base}/api/db/${doc.id}/line`, bearerJson(alice.token, { line: 2, action: 'insert', text: 'inserted' }));
    assert.equal(line.status, 200);
    const afterLine = await (await fetch(`${app.base}/api/db/${doc.id}`, bearer(alice.token))).json();
    assert.equal(afterLine.data.content, '# changed\ninserted\n');

    // Move (rename).
    const moved = await fetch(`${app.base}/api/db/${doc.id}/move`, bearerJson(alice.token, { name: 'renamed.md' }));
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).data.file.name, 'renamed.md');

    // Restore the pre-write snapshot.
    const restored = await fetch(`${app.base}/api/db/${doc.id}/restore`, bearerJson(alice.token, { version: 1 }));
    assert.equal(restored.status, 200);
    const afterRestore = await (await fetch(`${app.base}/api/db/${doc.id}`, bearer(alice.token))).json();
    assert.equal(afterRestore.data.content, '# hi\nsecond\n');

    // Remove: out of the list, gone from read.
    assert.equal((await fetch(`${app.base}/api/db/${doc.id}`, bearerJson(alice.token, {}, 'DELETE'))).status, 200);
    assert.deepEqual((await (await fetch(`${app.base}/api/db`, bearer(alice.token))).json()).data.files, []);
    assert.equal((await fetch(`${app.base}/api/db/${doc.id}`, bearer(alice.token))).status, 404);

    // Another user's DB is invisible.
    const bob = await signup(app, uniqueName('bob'));
    assert.equal((await fetch(`${app.base}/api/db/${doc.id}`, bearer(bob.token))).status, 404);
  });
});

// ---------------------------------------------------------------- devices

test('devices: heartbeat upserts and counts, list marks current, remove works', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));

    await fetch(`${app.base}/api/devices`, bearerJson(alice.token, { id: 'fp-aaaabbbbccccddddeeeeffff', name: 'Pixel 9', platform: 'android' }));
    await fetch(`${app.base}/api/devices`, bearerJson(alice.token, { id: 'fp-aaaabbbbccccddddeeeeffff', name: 'Pixel 9', platform: 'android' }));
    await fetch(`${app.base}/api/devices`, bearerJson(alice.token, { id: 'fp-111122223333444455556666', name: 'Laptop', platform: 'linux' }));

    const listed = await fetch(`${app.base}/api/devices`, {
      headers: { Authorization: `Bearer ${alice.token}`, 'X-Device-Id': 'fp-111122223333444455556666' },
    });
    const devices = (await listed.json()).data.devices;
    assert.equal(devices.length, 2);
    const pixel = devices.find((d) => d.id === 'fp-aaaabbbbccccddddeeeeffff');
    const laptop = devices.find((d) => d.id === 'fp-111122223333444455556666');
    assert.equal(pixel.logins, 2);
    assert.equal(laptop.current, true);
    assert.equal(pixel.current, false);

    assert.equal((await fetch(`${app.base}/api/devices/fp-111122223333444455556666`, { method: 'DELETE', ...bearer(alice.token) })).status, 200);
    assert.equal((await fetch(`${app.base}/api/devices/fp-111122223333444455556666`, { method: 'DELETE', ...bearer(alice.token) })).status, 404);
    assert.equal((await (await fetch(`${app.base}/api/devices`, bearer(alice.token))).json()).data.devices.length, 1);
  });
});

// ---------------------------------------------------------------- social

test('social: discovery, follow, notification, unfollow', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));
    await createChannel(app, bob.token, 'Bob Channel');

    const found = await fetch(`${app.base}/api/social/users?q=${bob.username}`, bearer(alice.token));
    const users = (await found.json()).data.users;
    assert.equal(users.length, 1);
    assert.equal(users[0].username, bob.username);
    assert.equal(users[0].following, false);

    assert.equal((await fetch(`${app.base}/api/social/follow`, bearerJson(alice.token, { username: bob.username }))).status, 200);

    const after = (await (await fetch(`${app.base}/api/social/users?q=${bob.username}`, bearer(alice.token))).json()).data.users;
    assert.equal(after[0].following, true);

    // Bob is notified, and sees Alice in his own list as a follower.
    const notes = (await (await fetch(`${app.base}/api/social/notifications`, bearer(bob.token))).json()).data.items;
    assert.ok(notes.some((n) => n.text.includes('following you') && n.read === false));

    // Self-follow is refused; unknown users are 404.
    assert.equal((await fetch(`${app.base}/api/social/follow`, bearerJson(alice.token, { username: alice.username }))).status, 400);
    assert.equal((await fetch(`${app.base}/api/social/follow`, bearerJson(alice.token, { username: 'nobody_here' }))).status, 404);

    assert.equal((await fetch(`${app.base}/api/social/unfollow`, bearerJson(alice.token, { username: bob.username }))).status, 200);
    const off = (await (await fetch(`${app.base}/api/social/users?q=${bob.username}`, bearer(alice.token))).json()).data.users;
    assert.equal(off[0].following, false);
  });
});

test('direct messages: send, inbox, thread, unread clearing, likes, attachments', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));

    const sent = await fetch(`${app.base}/api/social/chat`, bearerJson(alice.token, { to: bob.username, text: 'hello bob' }));
    assert.equal(sent.status, 201);
    const message = (await sent.json()).data.message;
    assert.equal(message.from, alice.username);
    assert.deepEqual(message.likes, []);

    // Bob's inbox shows the unread thread; Alice's shows it read.
    const bobInbox = (await (await fetch(`${app.base}/api/social/inbox`, bearer(bob.token))).json()).data.threads;
    assert.equal(bobInbox.length, 1);
    assert.equal(bobInbox[0].peer, alice.username);
    assert.equal(bobInbox[0].unread, 1);
    assert.equal(bobInbox[0].last, 'hello bob');
    const aliceInbox = (await (await fetch(`${app.base}/api/social/inbox`, bearer(alice.token))).json()).data.threads;
    assert.equal(aliceInbox[0].unread, 0);

    // Opening the thread clears the unread badge.
    const thread = (await (await fetch(`${app.base}/api/social/chat/${alice.username}`, bearer(bob.token))).json()).data.messages;
    assert.equal(thread.length, 1);
    assert.equal(thread[0].text, 'hello bob');
    const bobInbox2 = (await (await fetch(`${app.base}/api/social/inbox`, bearer(bob.token))).json()).data.threads;
    assert.equal(bobInbox2[0].unread, 0);

    // Like, then unlike.
    assert.equal((await fetch(`${app.base}/api/social/chat/like`, bearerJson(bob.token, { peer: alice.username, messageId: message.id }))).status, 200);
    const liked = (await (await fetch(`${app.base}/api/social/chat/${alice.username}`, bearer(bob.token))).json()).data.messages;
    assert.deepEqual(liked[0].likes, [bob.username]);
    await fetch(`${app.base}/api/social/chat/like`, bearerJson(bob.token, { peer: alice.username, messageId: message.id }));
    const unliked = (await (await fetch(`${app.base}/api/social/chat/${alice.username}`, bearer(bob.token))).json()).data.messages;
    assert.deepEqual(unliked[0].likes, []);

    // Attachment: becomes link-shared so the peer can download it.
    const file = await upload(app, alice.token, 'clip.txt', 'attached bytes');
    const withFile = await fetch(`${app.base}/api/social/chat`, bearerJson(alice.token, { to: bob.username, text: '', fileId: file.id }));
    assert.equal(withFile.status, 201);
    const seen = (await (await fetch(`${app.base}/api/social/chat/${alice.username}`, bearer(bob.token))).json()).data.messages;
    const attach = seen.find((m) => m.file);
    assert.equal(attach.file.id, file.id);
    assert.equal(attach.file.name, 'clip.txt');
    assert.equal((await fetch(`${app.base}/api/files/${file.id}/download`, bearer(bob.token))).status, 200);

    // Guards: unknown peer, self message, empty message.
    assert.equal((await fetch(`${app.base}/api/social/chat`, bearerJson(alice.token, { to: 'nobody_here', text: 'x' }))).status, 404);
    assert.equal((await fetch(`${app.base}/api/social/chat`, bearerJson(alice.token, { to: alice.username, text: 'x' }))).status, 400);
    assert.equal((await fetch(`${app.base}/api/social/chat`, bearerJson(alice.token, { to: bob.username, text: '  ' }))).status, 400);
  });
});

test('avatars: uploaded picture is shared and served by username', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));

    // No avatar yet.
    assert.equal((await (await fetch(`${app.base}/api/social/avatar/${alice.username}`, bearer(bob.token))).json()).data.url, null);

    const file = await upload(app, alice.token, 'me.txt', 'picture bytes');
    const put = await fetch(`${app.base}/api/social/avatar`, bearerJson(alice.token, { fileId: file.id }, 'PUT'));
    assert.equal(put.status, 200);

    const url = (await (await fetch(`${app.base}/api/social/avatar/${alice.username}`, bearer(bob.token))).json()).data.url;
    assert.equal(url, `/api/files/${file.id}/preview`);
    // The avatar file was link-shared, so the peer can fetch it.
    assert.equal((await fetch(`${app.base}/api/files/${file.id}/preview`, bearer(bob.token))).status, 200);

    // Someone else's file cannot become my avatar.
    const bobsFile = await upload(app, bob.token, 'bobs.txt', 'x');
    assert.equal((await fetch(`${app.base}/api/social/avatar`, bearerJson(alice.token, { fileId: bobsFile.id }, 'PUT'))).status, 404);
  });
});

test('notifications can be marked read one by one or all at once', async () => {
  await withApp(async (app) => {
    const alice = await signup(app, uniqueName('alice'));
    const bob = await signup(app, uniqueName('bob'));

    await fetch(`${app.base}/api/social/follow`, bearerJson(alice.token, { username: bob.username }));
    await fetch(`${app.base}/api/social/chat`, bearerJson(alice.token, { to: bob.username, text: 'hi again' }));

    const before = (await (await fetch(`${app.base}/api/social/notifications`, bearer(bob.token))).json()).data.items;
    assert.equal(before.length, 2);
    assert.ok(before.every((n) => n.read === false));

    await fetch(`${app.base}/api/social/notifications/read`, bearerJson(bob.token, { id: before[0].id }));
    const half = (await (await fetch(`${app.base}/api/social/notifications`, bearer(bob.token))).json()).data.items;
    assert.equal(half.filter((n) => n.read).length, 1);

    await fetch(`${app.base}/api/social/notifications/read`, bearerJson(bob.token, {}));
    const all = (await (await fetch(`${app.base}/api/social/notifications`, bearer(bob.token))).json()).data.items;
    assert.ok(all.every((n) => n.read === true));
  });
});
