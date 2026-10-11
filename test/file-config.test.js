'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFileConfig } = require('../src/config');

const GOOD = { GITHUB_OWNER: 'web12-app', GITHUB_STORAGE_REPO: 'files-store' };

test('storage config needs both GITHUB_OWNER and GITHUB_STORAGE_REPO', () => {
  assert.deepEqual(loadFileConfig({}), { ok: false, missing: ['GITHUB_OWNER', 'GITHUB_STORAGE_REPO'] });
  assert.deepEqual(loadFileConfig({ GITHUB_OWNER: 'a' }), { ok: false, missing: ['GITHUB_STORAGE_REPO'] });
  assert.deepEqual(loadFileConfig({ GITHUB_STORAGE_REPO: 'r' }), { ok: false, missing: ['GITHUB_OWNER'] });
  assert.deepEqual(loadFileConfig({ GITHUB_OWNER: '  ', GITHUB_STORAGE_REPO: 'r' }), { ok: false, missing: ['GITHUB_OWNER'] });
});

test('a valid config gives owner/repo', () => {
  assert.deepEqual(loadFileConfig(GOOD), { ok: true, config: { storageRepo: 'web12-app/files-store' } });
});

test('invalid owner or repo names are refused', () => {
  const badOwner = loadFileConfig({ ...GOOD, GITHUB_OWNER: 'bad owner!' });
  assert.equal(badOwner.ok, false);
  assert.match(badOwner.missing[0], /GITHUB_OWNER/);
  assert.equal(loadFileConfig({ ...GOOD, GITHUB_OWNER: '../evil' }).ok, false);
  assert.equal(loadFileConfig({ ...GOOD, GITHUB_STORAGE_REPO: 'a/b' }).ok, false);
  assert.equal(loadFileConfig({ ...GOOD, GITHUB_STORAGE_REPO: '..' }).ok, false);
});

test('the storage repo must differ from the private data repo, ignoring case', () => {
  const same = loadFileConfig(GOOD, { privateDataRepo: 'WEB12-APP/Files-Store' });
  assert.equal(same.ok, false);
  assert.match(same.missing[0], /must differ/);
  assert.equal(loadFileConfig(GOOD, { privateDataRepo: 'web12-app/other' }).ok, true);
});
