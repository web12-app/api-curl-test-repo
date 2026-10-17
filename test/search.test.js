'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const search = require('../src/search');

const tube = {
  async feed() {
    return [
      { fileId: 'v1', title: 'Chennai street food tour', description: 'food', owner: 'cross', channelName: 'Cross Channel', publishedAt: '2026-10-01', views: 5, likes: 2 },
      { fileId: 'v2', title: 'Rust basics', description: '', owner: 'ferris', channelName: 'Ferris', publishedAt: '2026-10-02', views: 1, likes: 0 },
    ];
  },
  async listChannels() {
    return [
      { username: 'cross', name: 'Cross Channel', description: 'Travel and food', subscribers: 3 },
      { username: 'ferris', name: 'Ferris', description: 'Systems programming', subscribers: 9 },
    ];
  },
};
const files = {
  async list(uid, { q }) {
    const all = [
      { id: 'f1', name: 'food-notes.txt', category: 'document', size: 10, uploadedAt: '2026-10-03' },
      { id: 'f2', name: 'holiday.mp4', category: 'video', size: 20, uploadedAt: '2026-10-04' },
    ];
    return { files: all.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase())), quota: {} };
  },
};

test('search matches videos, channels and files case-insensitively', async () => {
  const r = await search.run({ tube, files, uid: 'u1', username: 'me', q: 'FOOD' });
  assert.deepEqual(r.videos.map((v) => v.id), ['v1']);
  assert.deepEqual(r.channels.map((c) => c.id), ['cross']);
  assert.deepEqual(r.files.map((f) => f.id), ['f1']);
});

test('kind limits the search to one area', async () => {
  const r = await search.run({ tube, files, uid: 'u1', username: 'me', q: 'food', kind: 'files' });
  assert.equal(r.videos.length, 0);
  assert.equal(r.channels.length, 0);
  assert.equal(r.files.length, 1);
});

test('an empty query returns nothing and an unknown kind is refused', async () => {
  const empty = await search.run({ tube, files, uid: 'u1', username: 'me', q: '   ' });
  assert.deepEqual([empty.videos, empty.channels, empty.files], [[], [], []]);
  await assert.rejects(search.run({ tube, files, uid: 'u1', username: 'me', q: 'x', kind: 'nope' }),
    (e) => e.status === 400 && e.code === 'INVALID_KIND');
});

test('suggestions put prefix matches first and never repeat', async () => {
  const s = await search.suggest({ tube, files, uid: 'u1', username: 'me', q: 'ru' });
  assert.deepEqual(s.suggestions, ['Rust basics']);
  const t = await search.suggest({ tube, files, uid: 'u1', username: 'me', q: 'f' });
  assert.equal(t.suggestions[0], 'Ferris');
  assert.equal(new Set(t.suggestions).size, t.suggestions.length);
});

test('AI answer sends the free model list and returns the cited sources', async () => {
  let sent = null;
  const fakeFetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, json: async () => ({ model: 'google/gemma-4-31b-it:free', choices: [{ message: { content: 'Street food tours [1].' } }] }) };
  };
  const results = await search.run({ tube, files, uid: 'u1', username: 'me', q: 'food' });
  const out = await search.answer({ query: 'what food videos?', results, apiKey: 'k-test', fetchImpl: fakeFetch });
  assert.equal(out.answer, 'Street food tours [1].');
  assert.equal(out.model, 'google/gemma-4-31b-it:free');
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer k-test');
  assert.deepEqual(sent.body.models, search.FREE_MODELS);
  assert.match(sent.body.messages[1].content, /\[1\] video \| Chennai street food tour/);
  assert.ok(out.sources.length >= 1);
});

test('AI answer without a key is 503 and never calls the network', async () => {
  let called = false;
  await assert.rejects(search.answer({ query: 'hi', results: { videos: [], channels: [], files: [] }, apiKey: '', fetchImpl: async () => { called = true; } }),
    (e) => e.status === 503 && e.code === 'AI_UNAVAILABLE');
  assert.equal(called, false);
});

test('AI errors and empty replies become honest 503s, and the key is not in the message', async () => {
  const bad = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(search.answer({ query: 'hi', results: { videos: [], channels: [], files: [] }, apiKey: 'secret-key-123', fetchImpl: bad }),
    (e) => e.status === 503 && e.code === 'AI_UNREACHABLE' && !String(e.message).includes('secret-key-123'));
  const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '  ' } }] }) });
  await assert.rejects(search.answer({ query: 'hi', results: { videos: [], channels: [], files: [] }, apiKey: 'k', fetchImpl: empty }),
    (e) => e.status === 503 && e.code === 'AI_EMPTY');
});
