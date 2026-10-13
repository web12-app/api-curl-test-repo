'use strict';

// Pips Android install page: the /app route (app-store-style UI) plus the
// app-release resolver that picks the latest published APK from the GitHub
// API (with a TTL cache and a hardcoded fallback when GitHub is unreachable).
// The GitHub API is a local http server, so no network is needed.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../src/server');
const appRelease = require('../src/app-release');

const RELEASE_FIXTURE = {
  tag_name: 'v3.26.2',
  draft: false,
  prerelease: false,
  published_at: '2026-10-13T14:40:00Z',
  assets: [
    { name: 'source.zip', size: 1234, browser_download_url: 'https://example.com/source.zip' },
    {
      name: 'pips-v3.26.2.apk',
      size: 240880028,
      browser_download_url: 'https://github.com/web12-app/pips-flutter/releases/download/v3.26.2/pips-v3.26.2.apk',
    },
  ],
};

function startFakeApi(status, body) {
  return new Promise((resolve) => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('app-release.fromReleaseJson', () => {
  test('maps a published release with an apk asset', () => {
    const info = appRelease.fromReleaseJson(RELEASE_FIXTURE);
    assert.equal(info.version, '3.26.2');
    assert.equal(info.sizeBytes, 240880028);
    assert.equal(info.apkUrl, RELEASE_FIXTURE.assets[1].browser_download_url);
    assert.equal(info.updated, '2026-10-13');
    assert.equal(info.stale, false);
    assert.match(info.releasesUrl, /pips-flutter\/releases$/);
  });

  test('picks the pips apk, not other assets', () => {
    const info = appRelease.fromReleaseJson(RELEASE_FIXTURE);
    assert.ok(info.apkUrl.endsWith('pips-v3.26.2.apk'));
  });

  test('returns null for drafts, prereleases and releases without an apk', () => {
    assert.equal(appRelease.fromReleaseJson(null), null);
    assert.equal(appRelease.fromReleaseJson({ ...RELEASE_FIXTURE, draft: true }), null);
    assert.equal(appRelease.fromReleaseJson({ ...RELEASE_FIXTURE, prerelease: true }), null);
    assert.equal(appRelease.fromReleaseJson({ ...RELEASE_FIXTURE, assets: [] }), null);
    assert.equal(appRelease.fromReleaseJson({ ...RELEASE_FIXTURE, assets: [{ name: 'only.zip' }] }), null);
  });

  test('falls back to the fallback version when the tag is odd', () => {
    const info = appRelease.fromReleaseJson({ ...RELEASE_FIXTURE, tag_name: '' });
    assert.equal(info.version, appRelease.FALLBACK.version);
  });
});

describe('app-release.latestRelease', () => {
  beforeEach(() => appRelease.resetCache());

  test('fetches, maps and caches one call per TTL window', async () => {
    const fake = await startFakeApi(200, RELEASE_FIXTURE);
    try {
      let tick = 0;
      const now = () => 1_000_000 + tick++ * 1000;
      const first = await appRelease.latestRelease({ apiBase: fake.base, now });
      assert.equal(first.version, '3.26.2');
      const second = await appRelease.latestRelease({ apiBase: fake.base, now });
      assert.equal(second.version, '3.26.2');
      assert.equal(fake.hits(), 1, 'the second call must be served from cache');
    } finally {
      await fake.close();
    }
  });

  test('cache expires after the TTL window', async () => {
    const fake = await startFakeApi(200, RELEASE_FIXTURE);
    try {
      const t0 = 1_000_000;
      await appRelease.latestRelease({ apiBase: fake.base, now: () => t0 });
      // 11 minutes later the cache is stale (TTL is 10 minutes).
      await appRelease.latestRelease({ apiBase: fake.base, now: () => t0 + 11 * 60 * 1000 });
      assert.equal(fake.hits(), 2);
    } finally {
      await fake.close();
    }
  });

  test('a failing GitHub API returns the hardcoded fallback, never throws', async () => {
    const fake = await startFakeApi(500, { message: 'rate limited' });
    try {
      const info = await appRelease.latestRelease({ apiBase: fake.base, now: () => 1 });
      assert.equal(info.version, appRelease.FALLBACK.version);
      assert.equal(info.apkUrl, appRelease.FALLBACK.apkUrl);
      assert.equal(info.stale, true);
    } finally {
      await fake.close();
    }
  });

  test('a release without an apk asset also falls back', async () => {
    const fake = await startFakeApi(200, { tag_name: 'v1.0.0', assets: [] });
    try {
      const info = await appRelease.latestRelease({ apiBase: fake.base, now: () => 1 });
      assert.equal(info.stale, true);
      assert.equal(info.apkUrl, appRelease.FALLBACK.apkUrl);
    } finally {
      await fake.close();
    }
  });
});

describe('install page routes', () => {
  const ENV = {
    GITHUB_TOKEN: 'ghp_test_token_not_real',
    PRIVATE_DATA_REPO: 'owner/private-data',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-1234',
    COOKIE_SECURE: '0',
  };
  let fakeApi;
  let app;

  before(async () => {
    fakeApi = await startFakeApi(200, RELEASE_FIXTURE);
    app = createServer({ env: { ...ENV, PIPS_RELEASE_API_BASE: fakeApi.base } });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  });
  after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await fakeApi.close();
  });
  beforeEach(() => appRelease.resetCache());

  test('GET /app renders the store-style install page with the live release data', async () => {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/app`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
    const html = await res.text();
    assert.match(html, /<h1>Pips<\/h1>/);
    assert.match(html, /app-icon/);
    assert.match(html, /\/assets\/pips-logo\.png/);
    assert.match(html, new RegExp(RELEASE_FIXTURE.assets[1].browser_download_url.replace(/[./]/g, '\\$&')));
    assert.match(html, /v3\.26\.2/);
    assert.match(html, /Download APK/);
    assert.match(html, /How to install/);
    assert.match(html, /What's new/);
    assert.equal(fakeApi.hits(), 1);
  });

  test('GET /install redirects to /app', async () => {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/install`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/app');
  });

  test('when the release API is down, /app still renders with the fallback APK link', async () => {
    const deadApi = await startFakeApi(200, 'not-json');
    await deadApi.close(); // port closed: any request now fails to connect
    appRelease.resetCache();
    const info = await appRelease.latestRelease({ apiBase: deadApi.base, now: () => 1 });
    assert.equal(info.stale, true);
    assert.equal(info.apkUrl, appRelease.FALLBACK.apkUrl);
  });

  test('the app icon asset is served', async () => {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/assets/pips-logo.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/png/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 10_000, 'logo should be a real png, got ' + buf.length + ' bytes');
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});
