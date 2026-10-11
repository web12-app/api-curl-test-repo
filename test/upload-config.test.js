// Upload settings: bounds, bad values, and how buildAuth() reports them to its callers.
// No network: storage and releases are injected stubs, and nothing is started.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadUploadSettings, loadFileConfig } = require('../src/config');
const { buildAuth } = require('../src/server');
const { dashboardPage } = require('../src/pages');
const { ENV } = require('./files-fixture');

const MIN = 256 * 1024;
const MAX = 8 * 1024 * 1024;
const stubStorage = {};
const stubReleases = {};

function authWith(extra, base = ENV) {
  return buildAuth({ ...base, ...extra }, { storage: stubStorage, releases: stubReleases, now: () => 0 });
}

test('no upload settings: defaults apply and nothing is overridden', () => {
  assert.deepEqual(loadUploadSettings({}), { ok: true, limits: { chunks: {} }, tempDir: null });
  // Blank values count as unset.
  assert.deepEqual(loadUploadSettings({ UPLOAD_CHUNK_BYTES: '  ', UPLOAD_SESSION_HOURS: '', FILE_TEMP_DIR: ' ' }), {
    ok: true,
    limits: { chunks: {} },
    tempDir: null,
  });
});

test('piece size accepts exactly 256 KiB to 8 MiB, and surrounding spaces are ignored', () => {
  for (const value of [MIN, MAX, 1024 * 1024]) {
    const res = loadUploadSettings({ UPLOAD_CHUNK_BYTES: String(value) });
    assert.equal(res.ok, true, String(value));
    assert.equal(res.limits.chunks.chunkBytes, value);
  }
  const padded = loadUploadSettings({ UPLOAD_CHUNK_BYTES: ` ${MIN} ` });
  assert.equal(padded.limits.chunks.chunkBytes, MIN);
});

test('piece size rejects just outside the bounds and non-integers', () => {
  for (const value of [String(MIN - 1), String(MAX + 1), '0', '-1', '1.5', String(MIN + 0.5), 'NaN', 'Infinity', '1e100']) {
    const res = loadUploadSettings({ UPLOAD_CHUNK_BYTES: value });
    assert.equal(res.ok, false, value);
    assert.match(res.missing[0], /^UPLOAD_CHUNK_BYTES \(must be a whole number from 262144 to 8388608\)$/);
  }
});

test('session hours accept 1 to 168 and convert to milliseconds', () => {
  assert.equal(loadUploadSettings({ UPLOAD_SESSION_HOURS: '1' }).limits.chunks.sessionMs, 3600000);
  assert.equal(loadUploadSettings({ UPLOAD_SESSION_HOURS: '168' }).limits.chunks.sessionMs, 168 * 3600000);
  assert.equal(loadUploadSettings({ UPLOAD_SESSION_HOURS: '1.5' }).limits.chunks.sessionMs, 5400000);
});

test('session hours reject values outside 1 to 168 and text', () => {
  for (const value of ['0', '0.9', '168.1', '169', '-3', 'abc', 'NaN', 'Infinity']) {
    const res = loadUploadSettings({ UPLOAD_SESSION_HOURS: value });
    assert.equal(res.ok, false, value);
    assert.deepEqual(res.missing, ['UPLOAD_SESSION_HOURS (must be from 1 to 168)']);
  }
});

test('the temp directory must be an absolute path', () => {
  assert.equal(loadUploadSettings({ FILE_TEMP_DIR: '/var/tmp/files' }).tempDir, '/var/tmp/files');
  for (const value of ['relative/dir', './tmp', '~/uploads', 'tmp']) {
    const res = loadUploadSettings({ FILE_TEMP_DIR: value });
    assert.equal(res.ok, false, value);
    assert.match(res.missing[0], /^FILE_TEMP_DIR \(must be an absolute path\)$/);
  }
});

test('a bad value is reported by name only, and the first bad setting wins', () => {
  const res = loadUploadSettings({ UPLOAD_CHUNK_BYTES: '7777', UPLOAD_SESSION_HOURS: '999', FILE_TEMP_DIR: 'rel/secret-path' });
  assert.equal(res.ok, false);
  assert.equal(res.missing.length, 1);
  assert.match(res.missing[0], /^UPLOAD_CHUNK_BYTES/);
  assert.ok(!res.missing[0].includes('7777'), 'the value is not echoed');
  const dir = loadUploadSettings({ FILE_TEMP_DIR: 'rel/secret-path' });
  assert.ok(!dir.missing[0].includes('secret-path'), 'the path is not echoed');
});

test('loadFileConfig keeps its return shape, so upload keys never leak into it', () => {
  const res = loadFileConfig(ENV, { privateDataRepo: ENV.PRIVATE_DATA_REPO });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res).sort(), ['config', 'ok']);
  assert.deepEqual(Object.keys(res.config), ['storageRepo']);
});

test('buildAuth applies valid upload settings to the chunked-upload limits', () => {
  const auth = authWith({ UPLOAD_CHUNK_BYTES: String(512 * 1024), UPLOAD_SESSION_HOURS: '6', FILE_TEMP_DIR: '/var/tmp/files-test' });
  assert.equal(auth.enabled, true);
  assert.equal(auth.files.enabled, true);
  assert.ok(auth.files.service, 'a file service exists');
  assert.equal(auth.files.chunks.limits.chunkBytes, 512 * 1024);
  assert.equal(auth.files.chunks.limits.sessionMs, 6 * 3600000);
});

test('buildAuth with a bad upload setting turns file storage off and keeps login on', () => {
  const auth = authWith({ UPLOAD_CHUNK_BYTES: '5' });
  assert.equal(auth.enabled, true, 'login still works');
  assert.deepEqual(
    { enabled: auth.files.enabled, service: auth.files.service },
    { enabled: false, service: null },
  );
  assert.equal(auth.files.missing.length, 1);
  assert.match(auth.files.missing[0], /^UPLOAD_CHUNK_BYTES/);
});

test('buildAuth without login settings gives the disabled shape, with no service', () => {
  const auth = buildAuth({ ...ENV, GITHUB_TOKEN: '' }, { storage: stubStorage, releases: stubReleases });
  assert.equal(auth.enabled, false);
  assert.equal(auth.files.enabled, false);
  assert.equal(auth.files.service, null);
  assert.ok(Array.isArray(auth.files.missing));
});

test('the dashboard shows the file-storage notice and no upload controls when storage is off', () => {
  const html = dashboardPage({ username: 'ann' }, { filesEnabled: false });
  assert.match(html, /File storage is not set up/);
  assert.ok(!html.includes('id="url-form"'), 'no URL import form');
  assert.ok(!html.includes('id="drop"'), 'no drop zone');
});

test('the dashboard shows the URL import form next to the drop zone when storage is on', () => {
  const html = dashboardPage({ username: 'ann' }, { filesEnabled: true, maxBytes: 25 * 1024 * 1024 });
  const drop = html.indexOf('id="drop"');
  const form = html.indexOf('id="url-form"');
  assert.ok(drop > 0 && form > drop, 'the form follows the drop zone');
  assert.match(html, /Upload from URL/);
  assert.match(html, /placeholder="Enter direct file URL"/);
});
