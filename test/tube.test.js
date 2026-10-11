'use strict';

// Tube feature tests: channels, publishing videos, the feed, and the extended read rule
// (a published video or an in-use channel logo can be streamed by ANY signed-in user).
// GitHub is the local fake (test/fake-github.js), reached over real HTTP. No real token or repository.
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

// A running app with its own clock. State lives only in the fake GitHub; the tube service rides on
// the same bundle the file routes use (server.fileServices.tube).
async function startApp({ env = ENV, clock = { t: Date.now() } } = {}) {
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env, storage, releases, now: () => clock.t });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    clock,
    tube: server.fileServices.tube,
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

const jsonOf = async (res) => {
  const body = await res.json();
  return { status: res.status, body };
};

// A minimal valid mp4: an 'ftyp' box at byte 4 is what the stored-type check looks for.
const mp4Bytes = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000'), Buffer.from('not-really-a-video')]);
// A minimal "jpeg": the 3-byte SOI marker the type check looks for.
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
// A minimal "png": the 8-byte signature the type check looks for.
const pngBytes = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function publishViaRoute(app, cookie, fileId, payload) {
  return jsonOf(
    await authed(app, cookie, `/api/tube/videos/${fileId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

// ---- channel validation (module functions, through the real service the routes use)

test('channel create and update validate name, description, and logo ownership', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, 'alice');
    const { tube } = app;

    await assert.rejects(() => tube.putChannel(alice, { name: '' }), (err) => err.code === 'INVALID_NAME');
    await assert.rejects(() => tube.putChannel(alice, { name: 'x'.repeat(81) }), (err) => err.code === 'INVALID_NAME');
    await assert.rejects(() => tube.putChannel(alice, { name: 'ok', description: 'x'.repeat(501) }), (err) => err.code === 'INVALID_DESCRIPTION');
    // A logo that is not the user's file (or not an image) is refused.
    await assert.rejects(() => tube.putChannel(alice, { name: 'ok', logoFileId: crypto.randomBytes(16).toString('hex') }), (err) => err.code === 'INVALID_LOGO');
    await assert.rejects(() => tube.putChannel(alice, { name: 'ok', logoFileId: 'not-an-id' }), (err) => err.code === 'INVALID_LOGO');

    const channel = await tube.putChannel(alice, { name: '  Alice Labs  ', description: 'science and stuff' });
    assert.equal(channel.name, 'Alice Labs');
    assert.equal(channel.username, 'alice');
    assert.equal(channel.logoUrl, null);
    assert.ok(channel.createdAt);

    // Update keeps the original createdAt and accepts an owned image as the logo.
    const logo = await upload(app, alice.cookie, 'logo.png', pngBytes(), { type: 'image/png' });
    const updated = await tube.putChannel(alice, { name: 'Alice Labs II', logoFileId: logo.id });
    assert.equal(updated.name, 'Alice Labs II');
    assert.equal(updated.logoUrl, `/api/files/${logo.id}/preview`);
    const again = await tube.getChannel(alice);
    assert.equal(again.createdAt, channel.createdAt);
    assert.ok(await tube.isChannelLogo(logo.id));
    assert.equal(await tube.isChannelLogo(crypto.randomBytes(16).toString('hex')), false);

    // A video file is not a valid logo even when owned.
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await assert.rejects(() => tube.putChannel(alice, { name: 'ok', logoFileId: clip.id }), (err) => err.code === 'INVALID_LOGO');

    // The channel lives in the shared tube.json document in the private data repo.
    const doc = fake.contents.get(`${DATA_REPO}:system/tube.json`);
    assert.ok(doc, 'tube.json exists in the private data repo');
    const parsed = JSON.parse(doc.buf.toString('utf8'));
    assert.equal(parsed.channels.alice.name, 'Alice Labs II');
    assert.equal(parsed.channels.alice.logoFileId, logo.id);
  });
});

test('publish requires the owner and a video/* file; unpublish removes it again', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');
    const { tube } = app;

    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    const notes = await upload(app, alice.cookie, 'notes.txt', 'text only', { type: 'text/plain' });

    // Not the owner: bob cannot publish alice's file (404, same as a missing file).
    await assert.rejects(() => tube.publishVideo(clip.id, bob, { title: 'stolen' }), (err) => err.status === 404);
    // Not a video: text files are refused with 415.
    await assert.rejects(() => tube.publishVideo(notes.id, alice, { title: 'not a video' }), (err) => err.status === 415 && err.code === 'NOT_A_VIDEO');
    // Title is required and capped.
    await assert.rejects(() => tube.publishVideo(clip.id, alice, {}), (err) => err.code === 'INVALID_TITLE');
    await assert.rejects(() => tube.publishVideo(clip.id, alice, { title: 'x'.repeat(121) }), (err) => err.code === 'INVALID_TITLE');
    await assert.rejects(() => tube.publishVideo(clip.id, alice, { title: 'ok', description: 'x'.repeat(2001) }), (err) => err.code === 'INVALID_DESCRIPTION');
    // A thumbnail must be an image the owner owns.
    await assert.rejects(() => tube.publishVideo(clip.id, alice, { title: 'ok', thumbnailFileId: crypto.randomBytes(16).toString('hex') }), (err) => err.code === 'INVALID_THUMBNAIL');

    const thumb = await upload(app, alice.cookie, 'clip.mp4.thumb.jpg', jpegBytes(), { type: 'image/jpeg' });
    const { video, created } = await tube.publishVideo(clip.id, alice, { title: 'Hello Tube', description: 'first!', thumbnailFileId: thumb.id });
    assert.equal(created, true);
    assert.equal(video.fileId, clip.id);
    assert.equal(video.owner, 'alice');
    assert.ok(await tube.isPublished(clip.id));
    assert.equal(await tube.isPublished(notes.id), false);

    // Re-publishing updates metadata but keeps the video published flag and the original date.
    const first = await tube.getVideo(clip.id);
    const again = await tube.publishVideo(clip.id, alice, { title: 'Hello Tube (edited)' });
    assert.equal(again.created, false);
    assert.equal((await tube.getVideo(clip.id)).publishedAt, first.publishedAt);
    assert.equal((await tube.getVideo(clip.id)).title, 'Hello Tube (edited)');

    // Only the owner can unpublish.
    await assert.rejects(() => tube.unpublishVideo(clip.id, bob), (err) => err.status === 404);
    await tube.unpublishVideo(clip.id, alice);
    assert.equal(await tube.isPublished(clip.id), false);
    await assert.rejects(() => tube.unpublishVideo(clip.id, alice), (err) => err.status === 404);
  });
});

test('the feed is newest-first and joins channel name, logo, mime, and size', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, 'alice');
    const { tube, clock } = app;
    await tube.putChannel(alice, { name: 'Alice Labs', description: 'lab videos' });
    const logo = await upload(app, alice.cookie, 'logo.png', pngBytes(), { type: 'image/png' });
    await tube.putChannel(alice, { name: 'Alice Labs', logoFileId: logo.id });

    const v1 = await upload(app, alice.cookie, 'first.mp4', mp4Bytes(), { type: 'video/mp4' });
    await tube.publishVideo(v1.id, alice, { title: 'First' });
    clock.t += 60000;
    const v2 = await upload(app, alice.cookie, 'second.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('ebml')]), { type: 'video/webm' });
    const thumb = await upload(app, alice.cookie, 'second.webm.thumb.jpg', jpegBytes(), { type: 'image/jpeg' });
    await tube.publishVideo(v2.id, alice, { title: 'Second', thumbnailFileId: thumb.id });

    const feed = await tube.feed();
    assert.deepEqual(feed.map((v) => v.title), ['Second', 'First']);
    const [second, first] = feed;
    assert.equal(second.owner, 'alice');
    assert.equal(second.channelName, 'Alice Labs');
    assert.equal(second.channelLogoUrl, `/api/files/${logo.id}/preview`);
    assert.equal(second.thumbnailUrl, `/api/files/${thumb.id}/preview`);
    assert.equal(second.mime, 'video/webm');
    assert.equal(second.size, v2.size);
    assert.equal(first.thumbnailUrl, null);
    assert.equal(first.mime, 'video/mp4');

    // channelVideos returns the same rows for one owner.
    const own = await tube.channelVideos(alice);
    assert.deepEqual(own.map((v) => v.title), ['Second', 'First']);

    // A published video whose file was removed drops out of the feed.
    await authed(app, alice.cookie, `/api/files/${v1.id}`, { method: 'DELETE' });
    const after = await tube.feed();
    assert.deepEqual(after.map((v) => v.title), ['Second']);
  });
});

// ---- route-level tests with the same harness

test('tube API routes require login, and writes require the CSRF header', async () => {
  await withApp({}, async (app) => {
    assert.equal((await fetch(`${app.base}/api/tube/feed`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/tube/my-channel`)).status, 401);
    const put = await fetch(`${app.base}/api/tube/my-channel`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: app.base },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(put.status, 401);
    const alice = await signup(app, 'alice');
    const noCsrf = await fetch(`${app.base}/api/tube/my-channel`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: app.base },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(noCsrf.status, 403);
    // The page shells redirect a signed-out visitor to /login.
    const page = await fetch(`${app.base}/tube`, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login');
  });
});

test('PUT my-channel then publishing a video wires the channel into the feed', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');

    const empty = await jsonOf(await authed(app, alice.cookie, '/api/tube/my-channel'));
    assert.equal(empty.body.data.channel, null);

    const put = await jsonOf(
      await authed(app, alice.cookie, '/api/tube/my-channel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice Labs', description: 'hello world' }),
      }),
    );
    assert.equal(put.status, 200);
    assert.equal(put.body.data.channel.name, 'Alice Labs');

    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    const first = await publishViaRoute(app, alice.cookie, clip.id, { title: 'Clip one' });
    assert.equal(first.status, 201);
    const second = await publishViaRoute(app, alice.cookie, clip.id, { title: 'Clip one (fixed)' });
    assert.equal(second.status, 200);

    const feed = await jsonOf(await authed(app, bob.cookie, '/api/tube/feed'));
    assert.equal(feed.status, 200);
    assert.equal(feed.body.data.videos.length, 1);
    const row = feed.body.data.videos[0];
    assert.equal(row.fileId, clip.id);
    assert.equal(row.owner, 'alice');
    assert.equal(row.channelName, 'Alice Labs');
    assert.equal(row.title, 'Clip one (fixed)');
    assert.equal(row.mime, 'video/mp4');
    assert.equal(row.thumbnailUrl, null);

    // The public channel endpoint returns the channel with its videos, joined the same way.
    const chan = await jsonOf(await authed(app, bob.cookie, '/api/tube/channels/alice'));
    assert.equal(chan.status, 200);
    assert.equal(chan.body.data.channel.name, 'Alice Labs');
    assert.deepEqual(chan.body.data.videos.map((v) => v.fileId), [clip.id]);
    // Unknown channels are 404.
    assert.equal((await authed(app, bob.cookie, '/api/tube/channels/nobody')).status, 404);

    // Unpublish through the route; the feed empties for everyone.
    const unpublish = await jsonOf(
      await authed(app, alice.cookie, `/api/tube/videos/${clip.id}/unpublish`, { method: 'POST' }),
    );
    assert.equal(unpublish.status, 200);
    assert.equal(unpublish.body.data.ok, true);
    const feedAfter = await jsonOf(await authed(app, bob.cookie, '/api/tube/feed'));
    assert.equal(feedAfter.body.data.videos.length, 0);
    // Bob cannot unpublish Alice's video (same 404 as a missing one).
    const republish = await publishViaRoute(app, alice.cookie, clip.id, { title: 'Clip one' });
    assert.equal(republish.status, 201);
    const stranger = await jsonOf(
      await authed(app, bob.cookie, `/api/tube/videos/${clip.id}/unpublish`, { method: 'POST' }),
    );
    assert.equal(stranger.status, 404);
  });
});

test('a published video streams to any signed-in user; an unpublished one stays private', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    const thumb = await upload(app, alice.cookie, 'clip.mp4.thumb.jpg', jpegBytes(), { type: 'image/jpeg' });

    // Unpublished: even the preview endpoint keeps the owner-only rule.
    assert.equal((await authed(app, bob.cookie, `/api/files/${clip.id}/preview`)).status, 404);
    assert.equal((await authed(app, bob.cookie, `/api/files/${clip.id}/download`)).status, 404);

    await publishViaRoute(app, alice.cookie, clip.id, { title: 'Shared clip', thumbnailFileId: thumb.id });

    // Published: bob can stream the video and the thumbnail through the existing endpoints.
    const video = await authed(app, bob.cookie, `/api/files/${clip.id}/preview`);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.equal(Number(video.headers.get('content-length')), mp4Bytes().length);
    const image = await authed(app, bob.cookie, `/api/files/${thumb.id}/preview`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');

    // A channel logo is covered by the same rule.
    const logo = await upload(app, alice.cookie, 'logo.png', pngBytes(), { type: 'image/png' });
    await authed(app, alice.cookie, '/api/tube/my-channel', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Labs', logoFileId: logo.id }),
    });
    assert.equal((await authed(app, bob.cookie, `/api/files/${logo.id}/preview`)).status, 200);

    // Unpublishing closes the door again.
    await authed(app, alice.cookie, `/api/files/${clip.id}`, { method: 'DELETE' });
    // (the file is gone entirely; a fresh unpublished upload is the cleaner check)
    const clip2 = await upload(app, alice.cookie, 'other.mp4', mp4Bytes(), { type: 'video/mp4' });
    assert.equal((await authed(app, bob.cookie, `/api/files/${clip2.id}/preview`)).status, 404);
    await publishViaRoute(app, alice.cookie, clip2.id, { title: 'temp' });
    assert.equal((await authed(app, bob.cookie, `/api/files/${clip2.id}/preview`)).status, 200);
    await authed(app, alice.cookie, `/api/tube/videos/${clip2.id}/unpublish`, { method: 'POST' });
    assert.equal((await authed(app, bob.cookie, `/api/files/${clip2.id}/preview`)).status, 404);
    // And the owner never loses access.
    assert.equal((await authed(app, alice.cookie, `/api/files/${clip2.id}/preview`)).status, 200);
  });
});

test('the tube page shells render with the right bootstrap data, and a missing video is 404', async () => {
  await withApp({}, async (app) => {
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');
    await authed(app, alice.cookie, '/api/tube/my-channel', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Labs' }),
    });
    const clip = await upload(app, alice.cookie, 'clip.mp4', mp4Bytes(), { type: 'video/mp4' });
    await publishViaRoute(app, alice.cookie, clip.id, { title: 'Shell clip' });

    const feed = await authed(app, bob.cookie, '/tube');
    assert.equal(feed.status, 200);
    const feedHtml = await feed.text();
    assert.match(feedHtml, /id="app-bootstrap"/);
    assert.match(feedHtml, /\/assets\/app\.js/);
    const boot = JSON.parse(feedHtml.match(/<script type="application\/json" id="app-bootstrap">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
    assert.equal(boot.page, 'tube');
    assert.equal(boot.channel, null);
    assert.equal(boot.feed.videos.length, 1);
    assert.equal(boot.feed.videos[0].channelName, 'Alice Labs');

    const watch = await authed(app, bob.cookie, `/tube/watch/${clip.id}`);
    assert.equal(watch.status, 200);
    const watchBoot = JSON.parse((await watch.text()).match(/id="app-bootstrap">([\s\S]*?)<\/script>/)[1]);
    assert.equal(watchBoot.page, 'tube-watch');
    assert.equal(watchBoot.video.title, 'Shell clip');
    assert.equal(watchBoot.channel.name, 'Alice Labs');

    const channel = await authed(app, bob.cookie, '/tube/channel/alice');
    assert.equal(channel.status, 200);
    const channelBoot = JSON.parse((await channel.text()).match(/id="app-bootstrap">([\s\S]*?)<\/script>/)[1]);
    assert.equal(channelBoot.page, 'tube-channel');
    assert.equal(channelBoot.channel.name, 'Alice Labs');
    assert.equal(channelBoot.videos.length, 1);

    // Not published -> the watch page is a 404. Unknown channel -> 404 too.
    const other = await upload(app, alice.cookie, 'hidden.mp4', mp4Bytes(), { type: 'video/mp4' });
    assert.equal((await authed(app, bob.cookie, `/tube/watch/${other.id}`)).status, 404);
    assert.equal((await authed(app, bob.cookie, '/tube/watch/not-an-id')).status, 404);
    assert.equal((await authed(app, bob.cookie, '/tube/channel/nobody')).status, 404);
  });
});

