'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GitHubStorage } = require('../src/github-storage');
const { ConflictError, StorageError } = require('../src/errors');

const TOKEN = 'ghp_token_must_never_appear_in_errors';
const REPO = 'owner/private-data';
const USER = 'a'.repeat(32);
const PATH = `users/${USER}.json`;

// A fetch stub that returns the given responses in order and records each call.
function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
  return { fetchImpl, calls };
}

const jsonFile = (data) => ({
  status: 200,
  body: { sha: 'abc123', content: Buffer.from(JSON.stringify(data)).toString('base64') },
});

test('readJson returns the decoded document and its sha; 404 means absent', async () => {
  const { fetchImpl, calls } = fakeFetch([jsonFile({ hello: 'world' }), { status: 404 }]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });

  assert.deepEqual(await store.readJson(PATH), { data: { hello: 'world' }, sha: 'abc123' });
  assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/contents/${PATH}`);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(await store.readJson(PATH), null);
});

test('reads retry on server errors and then succeed', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 500 }, { status: 503 }, jsonFile({ ok: true })]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  assert.deepEqual((await store.readJson(PATH)).data, { ok: true });
  assert.equal(calls.length, 3);
});

test('reads give up after three attempts and do not expose the token', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  await assert.rejects(store.readJson(PATH), (err) => {
    assert.ok(err instanceof StorageError);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
  assert.equal(calls.length, 3);
});

test('writes are never retried: a conflict is reported after one request', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 409 }]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  await assert.rejects(store.updateJson(PATH, { a: 1 }, 'stale-sha', 'update'), ConflictError);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).sha, 'stale-sha');
});

test('a failed create is not retried either', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 500 }]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  await assert.rejects(store.createJson(PATH, { a: 1 }, 'create'), StorageError);
  assert.equal(calls.length, 1);
});

test('createJson reports an existing path as "exists" rather than throwing', async () => {
  const { fetchImpl } = fakeFetch([{ status: 422 }]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  assert.equal(await store.createJson(PATH, { a: 1 }, 'create'), 'exists');
});

test('network failures become StorageError without the token in the message', async () => {
  const { fetchImpl } = fakeFetch([new Error(`socket hang up ${TOKEN}`)]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  await assert.rejects(store.readJson(PATH), (err) => {
    assert.ok(err instanceof StorageError);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
});

test('paths outside the allowed patterns are refused before any request', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const store = new GitHubStorage({ token: TOKEN, repo: REPO, fetchImpl });
  for (const bad of ['../secrets.json', 'users/../../x.json', 'apps/x/metadata.json', `users/${USER}.json?x=1`]) {
    await assert.rejects(store.readJson(bad), /path not allowed/, bad);
  }
  assert.equal(calls.length, 0);
});
