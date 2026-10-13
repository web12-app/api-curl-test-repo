'use strict';

// Tube social feature tests: reels and posts (kind publishing), editing, channel deletion,
// unique views, likes/dislikes, comments with votes, subscriptions, and the watch history.
// Same harness as tube.test.js: the fake GitHub is the only backend, no real token or repository.
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
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

async function startApp() {
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env: ENV, storage, releases, now: () => Date.now() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    tube: server.fileServices.tube,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withApp(fn) {
  const app = await startApp();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function signup(app, username, password = 'password-one') {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201, `signup ${username}`);
  return { username, password, cookie: sessionFrom(res), ...(await res.json()).data.user };
}

async function upload(app, cookie, name, bytes, { type = 'text/plain' } = {}) {
  const form = new FormData();
  form.append('uploadId', crypto.randomUUID());
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${app.base}/api/files/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base },
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 201, `upload ${name}`);
  return body.data.file;
}

const authed = (app, cookie, pathName, init = {}) =>
  fetch(`${app.base}${pathName}`, {
    ...init,
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base, ...(init.headers || {}) },
  });

const jsonOf = async (raw) => {
  const res = await raw;
  return { status: res.status, body: await res.json() };
};

const post = (app, cookie, pathName, payload) =>
  jsonOf(
    authed(app, cookie, pathName, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }),
  );

const put = (app, cookie, pathName, payload) =>
  jsonOf(
    authed(app, cookie, pathName, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }),
  );

const patch = (app, cookie, pathName, payload) =>
  jsonOf(
    authed(app, cookie, pathName, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }),
  );

const del = (app, cookie, pathName) =>
  jsonOf(
    authed(app, cookie, pathName, {
      method: 'DELETE',
    }),
  );

// A minimal valid mp4: an 'ftyp' box at byte 4 is what the stored-type check looks for.
const mp4Bytes = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000'), Buffer.from('not-really-a-video')]);
// A minimal "jpeg": the 3-byte SOI marker the type check looks for.
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

async function setupChannel(app) {
  const alice = await signup(app, 'alice');
  const made = await put(app, alice.cookie, '/api/tube/my-channel', { name: 'Alice Channel', description: 'all kinds' });
  assert.equal(made.status, 200);
  return alice;
}

test('reels publish like videos but carry kind=reel and a duration', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });

    const pub = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, {
      title: 'Dance reel',
      kind: 'reel',
      durationMs: 15400,
    });
    assert.equal(pub.status, 201);
    assert.equal(pub.body.data.video.kind, 'reel');
    assert.equal(pub.body.data.video.durationMs, 15400);

    const feed = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos.length, 1);
    assert.equal(feed.body.data.videos[0].kind, 'reel');
    assert.equal(feed.body.data.videos[0].durationMs, 15400);
  });
});

test('a reel rejects a non-video file, and video/reel kinds require a file', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const pic = await upload(app, alice.cookie, 'pic.jpg', jpegBytes(), { type: 'image/jpeg' });

    const wrong = await post(app, alice.cookie, `/api/tube/videos/${pic.id}/publish`, { title: 'nope', kind: 'reel' });
    assert.equal(wrong.status, 415);
    assert.equal(wrong.body.error.code, 'NOT_A_VIDEO');

    // The service refuses a file-less publish for any kind but post (the posts route forces 'post').
    await assert.rejects(
      () => app.tube.publishVideo('', alice, { title: 'nope', kind: 'video' }),
      (err) => err.code === 'FILE_REQUIRED',
    );

    const bogusKind = await post(app, alice.cookie, `/api/tube/videos/${pic.id}/publish`, { title: 'nope', kind: 'story' });
    assert.equal(bogusKind.status, 400);
    assert.equal(bogusKind.body.error.code, 'INVALID_KIND');
  });
});

test('text-only posts publish with a synthetic id and survive in the feed without a file', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);

    const pub = await post(app, alice.cookie, '/api/tube/posts', { title: 'Hello channel!', kind: 'post' });
    assert.equal(pub.status, 201);
    const postId = pub.body.data.video.fileId;
    assert.match(postId, /^[a-f0-9]{32}$/);
    assert.equal(pub.body.data.video.kind, 'post');
    assert.equal(pub.body.data.video.thumbnailFileId, null);

    const feed = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos.length, 1);
    assert.equal(feed.body.data.videos[0].fileId, postId);
    assert.equal(feed.body.data.videos[0].kind, 'post');
    assert.equal(feed.body.data.videos[0].mime, 'text/plain');
    assert.equal(feed.body.data.videos[0].channelName, 'Alice Channel');

    // A post can be unpublished again like anything else.
    const del = await post(app, alice.cookie, `/api/tube/videos/${postId}/unpublish`);
    assert.equal(del.status, 200);
    const after = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(after.body.data.videos.length, 0);
  });
});

test('a post accepts an image file; a video kind still needs video/*', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const pic = await upload(app, alice.cookie, 'pic.jpg', jpegBytes(), { type: 'image/jpeg' });

    const pub = await post(app, alice.cookie, `/api/tube/videos/${pic.id}/publish`, { title: 'Photo dump', kind: 'post' });
    assert.equal(pub.status, 201);
    assert.equal(pub.body.data.video.kind, 'post');

    const feed = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos[0].mime, 'image/jpeg');
  });
});

test('only the owner can edit a published item, and edits stick', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const bob = await signup(app, 'bob');
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, { title: 'Original', kind: 'video' });

    const stranger = await patch(app, bob.cookie, `/api/tube/videos/${clip.id}`, { title: 'Hacked' });
    assert.equal(stranger.status, 404);

    const own = await patch(app, alice.cookie, `/api/tube/videos/${clip.id}`, { title: 'Renamed', description: 'better now' });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.video.title, 'Renamed');

    const feed = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos[0].title, 'Renamed');
  });
});

test('deleting the channel removes it and unpublishes every kind', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, { title: 'V', kind: 'reel' });
    await post(app, alice.cookie, '/api/tube/posts', { title: 'P', kind: 'post' });

    const removed = await del(app, alice.cookie, '/api/tube/my-channel');
    assert.equal(removed.status, 200);
    const feed = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos.length, 0);
    const gone = await jsonOf(await authed(app, alice.cookie, '/api/tube/my-channel'));
    assert.equal(gone.body.data.channel, null);
  });
});

test('views are unique per user, and the history endpoint lists them newest first', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const bob = await signup(app, 'bob');
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, { title: 'Watch me', kind: 'video' });

    const v1 = await post(app, bob.cookie, `/api/tube/videos/${clip.id}/view`);
    assert.equal(v1.status, 200);
    assert.equal(v1.body.data.views, 1);
    const again = await post(app, bob.cookie, `/api/tube/videos/${clip.id}/view`);
    assert.equal(again.body.data.views, 1); // repeat views do not bump the count

    const feed = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos[0].views, 1);

    const mine = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/view`);
    assert.equal(mine.body.data.views, 2);

    const history = await jsonOf(await authed(app, bob.cookie, '/api/tube/history'));
    assert.equal(history.body.data.videos.length, 1);
    assert.equal(history.body.data.videos[0].fileId, clip.id);
  });
});

test('votes: one live vote per user, toggling off, and myVote in the feed', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const bob = await signup(app, 'bob');
    const carol = await signup(app, 'carol');
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, { title: 'Likeable', kind: 'video' });

    const like = await post(app, bob.cookie, `/api/tube/videos/${clip.id}/vote`, { vote: 'like' });
    assert.equal(like.status, 200);
    assert.equal(like.body.data.likes, 1);
    assert.equal(like.body.data.myVote, 'like');

    await post(app, carol.cookie, `/api/tube/videos/${clip.id}/vote`, { vote: 'dislike' });

    const switched = await post(app, carol.cookie, `/api/tube/videos/${clip.id}/vote`, { vote: 'like' });
    assert.equal(switched.body.data.likes, 2);
    assert.equal(switched.body.data.dislikes, 0);
    assert.equal(switched.body.data.myVote, 'like');

    const off = await post(app, carol.cookie, `/api/tube/videos/${clip.id}/vote`, { vote: 'like' });
    assert.equal(off.body.data.likes, 1);
    assert.equal(off.body.data.myVote, null);

    const bad = await post(app, bob.cookie, `/api/tube/videos/${clip.id}/vote`, { vote: 'meh' });
    assert.equal(bad.status, 400);

    const feed = await jsonOf(await authed(app, bob.cookie, '/api/tube/feed'));
    assert.equal(feed.body.data.videos[0].likes, 1);
    assert.equal(feed.body.data.videos[0].myVote, 'like');
    const other = await jsonOf(await authed(app, alice.cookie, '/api/tube/feed'));
    assert.equal(other.body.data.videos[0].myVote, null);
  });
});

test('comments: add, list newest first, per-user votes with my_vote', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const bob = await signup(app, 'bob');
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, { title: 'Talkable', kind: 'video' });

    const first = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/comments`, { text: 'first!' });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.comment.user, 'alice');
    const second = await post(app, bob.cookie, `/api/tube/videos/${clip.id}/comments`, { text: 'second!' });
    assert.equal(second.status, 201);

    const empty = await post(app, bob.cookie, `/api/tube/videos/${clip.id}/comments`, { text: '   ' });
    assert.equal(empty.status, 400);

    const list = await jsonOf(await authed(app, alice.cookie, `/api/tube/videos/${clip.id}/comments`));
    assert.deepEqual(
      list.body.data.comments.map((c) => c.text),
      ['second!', 'first!'],
    );
    assert.equal(list.body.data.comments[0].likes, 0);
    assert.equal(list.body.data.comments[0].myVote, null);

    const mid = second.body.data.comment.id;
    const vote = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/comments/${mid}/vote`, { vote: 'like' });
    assert.equal(vote.body.data.likes, 1);

    const relist = await jsonOf(await authed(app, alice.cookie, `/api/tube/videos/${clip.id}/comments`));
    assert.equal(relist.body.data.comments[0].myVote, 'like');

    const off = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/comments/${mid}/vote`, { vote: 'like' });
    assert.equal(off.body.data.likes, 0);

    const bad = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/comments/${mid}/vote`, { vote: 'star' });
    assert.equal(bad.status, 400);

    const missing = await post(app, alice.cookie, `/api/tube/videos/${clip.id}/comments/${'f'.repeat(12)}/vote`, { vote: 'like' });
    assert.equal(missing.status, 404);
  });
});

test('subscribe toggles, shows on the channel page, and self-subscribe is refused', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const bob = await signup(app, 'bob');

    const self = await post(app, alice.cookie, '/api/tube/channels/alice/subscribe');
    assert.equal(self.status, 400);

    const sub = await post(app, bob.cookie, '/api/tube/channels/alice/subscribe');
    assert.equal(sub.status, 200);
    assert.equal(sub.body.data.subscribed, true);
    assert.equal(sub.body.data.subscribers, 1);

    const page = await jsonOf(await authed(app, bob.cookie, '/api/tube/channels/alice'));
    assert.equal(page.body.data.channel.subscribers, 1);
    assert.equal(page.body.data.channel.subscribed, true);

    const anonPage = await jsonOf(await authed(app, alice.cookie, '/api/tube/channels/alice'));
    assert.equal(anonPage.body.data.channel.subscribed, false);

    const unsub = await post(app, bob.cookie, '/api/tube/channels/alice/subscribe');
    assert.equal(unsub.body.data.subscribed, false);
    assert.equal(unsub.body.data.subscribers, 0);

    const stranger = await post(app, bob.cookie, '/api/tube/channels/carol/subscribe');
    assert.equal(stranger.status, 404);
  });
});

test('a full channel page joins subscribers, kinds, views, and likes for the requesting viewer', async () => {
  await withApp(async (app) => {
    const alice = await setupChannel(app);
    const bob = await signup(app, 'bob');
    await post(app, bob.cookie, '/api/tube/channels/alice/subscribe');

    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await post(app, alice.cookie, `/api/tube/videos/${clip.id}/publish`, { title: 'Reel one', kind: 'reel' });
    await post(app, alice.cookie, '/api/tube/posts', { title: 'Text post', kind: 'post' });
    await post(app, bob.cookie, `/api/tube/videos/${clip.id}/vote`, { vote: 'like' });
    await post(app, bob.cookie, `/api/tube/videos/${clip.id}/view`);

    const page = await jsonOf(await authed(app, bob.cookie, '/api/tube/channels/alice'));
    assert.equal(page.status, 200);
    assert.equal(page.body.data.channel.subscribers, 1);
    assert.equal(page.body.data.videos.length, 2);
    const reel = page.body.data.videos.find((v) => v.kind === 'reel');
    assert.equal(reel.likes, 1);
    assert.equal(reel.views, 1);
    assert.equal(reel.myVote, 'like');
    assert.ok(page.body.data.videos.some((v) => v.kind === 'post' && v.title === 'Text post'));
  });
});
