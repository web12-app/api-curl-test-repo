'use strict';

// Tests for the OpenAI-compatible /v1 endpoints (src/openai-compat.js).
// Server-level tests run against the real createServer with a stub llama-server
// speaking the real protocol; proxy-mode tests run against fake upstream HTTP
// servers with real fetch. No external network, no credentials.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');
const { GitHubStorage } = require('../src/github-storage');
const { GitHubReleases } = require('../src/github-releases');
const { OpenAiCompat } = require('../src/openai-compat');
const { startFakeGitHub } = require('./fake-github');

const TOKEN = 'ghp_test_token_not_real';
const DATA_REPO = 'owner/private-data';
const STORE_REPO = 'owner/files';
const ENV_BASE = {
  GITHUB_TOKEN: TOKEN,
  PRIVATE_DATA_REPO: DATA_REPO,
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-1234',
  COOKIE_SECURE: '0',
  GITHUB_OWNER: 'owner',
  GITHUB_STORAGE_REPO: 'files',
};

// A stub llama-server: same protocol as the real one (health + completions).
function startStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const last = body.messages[body.messages.length - 1].content;
        if (last.includes('!never')) return; // hold: the client must time out
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const piece of ['<th', 'ink>h', 'm</th', 'ink>', 'Par', 'is']) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '<think>hm</think>Paris' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function startApp({ env = {}, aiBaseUrl } = {}) {
  const stub = await startStub();
  const fullEnv = { ...ENV_BASE, ...env };
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({
    env: fullEnv,
    storage,
    releases,
    upstreamBase: `http://127.0.0.1:${stub.address().port}`,
    aiBaseUrl,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  for (let i = 0; i < 100 && server.modelChat.state !== 'ready'; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      stub.closeAllConnections();
      await new Promise((resolve) => stub.close(resolve));
    },
  };
}

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

describe('GET /v1/models (local mode, through the real server)', () => {
  test('lists the verified registry with owned_by local and the loaded marker, no session needed', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/v1/models`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'list');
      const ids = body.data.map((m) => m.id);
      assert.deepEqual(ids, ['qwen3-27b', 'huihui-qwen3-8b', 'lfm2-350m', 'qwen25-coder-1-5b', 'ministral-3-14b']);
      for (const m of body.data) {
        assert.equal(m.object, 'model');
        assert.equal(m.owned_by, 'local');
        assert.equal(typeof m.created, 'number');
      }
      // The stub runtime is ready with the default model loaded.
      const loaded = body.data.filter((m) => m.loaded === true).map((m) => m.id);
      assert.deepEqual(loaded, ['qwen3-27b']);
    } finally {
      await app.close();
    }
  });

  test('a disabled chat answers 503 AI_NOT_CONFIGURED with no invented models', async () => {
    const server = createServer({ env: { SESSION_SECRET: 'x'.repeat(32) } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error.code, 'AI_NOT_CONFIGURED');
      assert.equal(body.error.type, 'api_error');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('POST /v1/chat/completions (local mode, through the real server)', () => {
  test('a non-streaming completion answers the OpenAI shape with the real stub reply', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'lfm2-350m',
          messages: [{ role: 'user', content: 'capital of France?' }],
          stream: false,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'chat.completion');
      assert.equal(body.model, 'lfm2-350m'); // the hot-swap is recorded in upstream mode
      assert.equal(body.choices.length, 1);
      assert.equal(body.choices[0].index, 0);
      assert.equal(body.choices[0].message.role, 'assistant');
      assert.equal(body.choices[0].message.content, 'Paris');
      assert.equal(body.choices[0].finish_reason, 'stop');
      assert.ok(body.id.startsWith('chatcmpl-'));
      assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    } finally {
      await app.close();
    }
  });

  test('streaming returns SSE chat.completion.chunk frames ending with [DONE] and no think-tag leak', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      assert.equal(lines[lines.length - 1], 'data: [DONE]');
      const frames = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
      assert.ok(frames.every((f) => f.object === 'chat.completion.chunk' && f.model));
      const content = frames.map((f) => f.choices[0].delta.content || '').join('');
      assert.equal(content, 'Paris');
      assert.ok(!content.includes('<think>'), 'think tags never leak into OpenAI deltas');
      assert.equal(frames[frames.length - 1].choices[0].finish_reason, 'stop');
    } finally {
      await app.close();
    }
  });

  test('validation: unknown model, empty messages, bad max_tokens', async () => {
    const app = await startApp();
    try {
      const post = (payload) => fetch(`${app.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const unknown = await post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(unknown.status, 400);
      assert.equal((await unknown.json()).error.code, 'BAD_MODEL');

      const empty = await post({ messages: [] });
      assert.equal(empty.status, 400);
      assert.equal((await empty.json()).error.code, 'BAD_MESSAGES');

      const blank = await post({ messages: [{ role: 'user', content: '   ' }] });
      assert.equal(blank.status, 400);
      assert.equal((await blank.json()).error.code, 'EMPTY_PROMPT');

      const tokens = await post({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999 });
      assert.equal(tokens.status, 400);
      assert.equal((await tokens.json()).error.code, 'BAD_MAX_TOKENS');

      const notJson = await fetch(`${app.base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
      assert.equal(notJson.status, 415);
    } finally {
      await app.close();
    }
  });

  test('V1_API_KEY protects /v1/* with a bearer key when configured', async () => {
    const app = await startApp({ env: { V1_API_KEY: 'secret-key-1' } });
    try {
      const noKey = await fetch(`${app.base}/v1/models`);
      assert.equal(noKey.status, 401);
      assert.equal((await noKey.json()).error.code, 'INVALID_API_KEY');

      const wrong = await fetch(`${app.base}/v1/models`, { headers: { Authorization: 'Bearer nope' } });
      assert.equal(wrong.status, 401);

      const okModels = await fetch(`${app.base}/v1/models`, { headers: { Authorization: 'Bearer secret-key-1' } });
      assert.equal(okModels.status, 200);

      const okChat = await fetch(`${app.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-key-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(okChat.status, 200);
      assert.equal((await okChat.json()).choices[0].message.content, 'Paris');
    } finally {
      await app.close();
    }
  });
});

// ---- proxy mode (AI_BASE_URL): module-level against fake upstream servers

function upstreamServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => handler(req, res, raw));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function compat({ base, key, modelsPath, chat = { status: () => ({ enabled: false, state: 'disabled', models: [] }) } }) {
  return new OpenAiCompat({
    chat,
    upstreamBase: base,
    upstreamApiKey: key,
    upstreamModelsPath: modelsPath,
    now: () => 1700000000000,
  });
}

describe('proxy mode: GET /v1/models against a fake provider', () => {
  test('preserves the upstream entries verbatim', async () => {
    const up = await upstreamServer((req, res) => {
      assert.equal(req.url, '/v1/models');
      assert.equal(req.headers.authorization, 'Bearer up-key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'ministral-3-14b', object: 'model', created: 42, owned_by: 'unsloth' },
        { id: 'other-model', object: 'model', created: 7, owned_by: 'org' },
      ] }));
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}`, key: 'up-key' });
    try {
      const list = await v1.listModels();
      assert.equal(list.object, 'list');
      assert.deepEqual(list.data.map((m) => m.id), ['ministral-3-14b', 'other-model']);
      assert.equal(list.data[0].created, 42); // upstream fields kept, nothing invented
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });

  test('an empty upstream list stays an empty list', async () => {
    const up = await upstreamServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}` });
    try {
      const list = await v1.listModels();
      assert.deepEqual(list, { object: 'list', data: [] });
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });

  test('upstream auth failure -> 502 UPSTREAM_AUTH', async () => {
    const up = await upstreamServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}`, key: 'wrong' });
    try {
      await assert.rejects(() => v1.listModels(), (err) => err.status === 502 && err.code === 'UPSTREAM_AUTH');
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });

  test('invalid upstream JSON -> 502 UPSTREAM_INVALID', async () => {
    const up = await upstreamServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json-at-all');
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}` });
    try {
      await assert.rejects(() => v1.listModels(), (err) => err.status === 502 && err.code === 'UPSTREAM_INVALID');
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });

  test('an unreachable provider -> 502; a timing-out provider -> 504 (injected fetch)', async () => {
    const v1 = compat({ base: 'http://127.0.0.1:1' }); // port 1: nothing listens
    await assert.rejects(() => v1.listModels(), (err) => err.status === 502 && err.code === 'UPSTREAM_UNAVAILABLE');

    const slow = new OpenAiCompat({
      chat: { status: () => ({ enabled: false, state: 'disabled', models: [] }) },
      upstreamBase: 'http://slow.example',
      fetchImpl: async () => {
        const e = new Error('timed out');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    await assert.rejects(() => slow.listModels(), (err) => err.status === 504 && err.code === 'UPSTREAM_TIMEOUT');
  });

  test('AI_MODELS_PATH overrides the upstream path', async () => {
    const up = await upstreamServer((req, res) => {
      assert.equal(req.url, '/api/models');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}`, modelsPath: '/api/models' });
    try {
      const list = await v1.listModels();
      assert.deepEqual(list.data.map((m) => m.id), ['m1']);
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });
});

describe('proxy mode: POST /v1/chat/completions against a fake provider', () => {
  const baseMessages = [{ role: 'user', content: 'Reply with exactly: API WORKING' }];

  test('forwards the body and returns the upstream completion', async () => {
    let seen = null;
    const up = await upstreamServer((req, res, raw) => {
      if (req.url === '/v1/models') {
        // The pre-check list: model m1 is offered.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
        return;
      }
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'up-1', object: 'chat.completion', model: 'm1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'API WORKING' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }));
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}`, key: 'up-key' });
    try {
      const res = new FakeRes();
      await v1.chatCompletions({ headers: {} }, res, { model: 'm1', messages: baseMessages, stream: false });
      assert.equal(seen.url, '/v1/chat/completions');
      assert.equal(seen.auth, 'Bearer up-key');
      assert.equal(seen.body.model, 'm1');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.text);
      assert.equal(body.choices[0].message.content, 'API WORKING');
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });

  test('a model outside the provider list is refused before forwarding', async () => {
    const hits = [];
    const up = await upstreamServer((req, res, raw) => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}` });
    try {
      const res = new FakeRes();
      await assert.rejects(
        () => v1.chatCompletions({ headers: {} }, res, { model: 'nope', messages: baseMessages }),
        (err) => err.status === 400 && err.code === 'MODEL_NOT_AVAILABLE',
      );
      assert.deepEqual(hits, ['/v1/models'], 'the completion was never forwarded');
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });

  test('upstream errors and invalid JSON become honest gateway errors', async () => {
    const err500 = await upstreamServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'kaboom' } }));
    });
    const v1a = compat({ base: `http://127.0.0.1:${err500.address().port}` });
    try {
      await assert.rejects(
        () => v1a.chatCompletions({ headers: {} }, new FakeRes(), { messages: baseMessages }),
        (err) => err.status === 502 && err.code === 'UPSTREAM_ERROR' && err.message.includes('kaboom'),
      );
    } finally {
      err500.closeAllConnections();
      await new Promise((r) => err500.close(r));
    }

    const bad = await upstreamServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{broken');
    });
    const v1b = compat({ base: `http://127.0.0.1:${bad.address().port}` });
    try {
      await assert.rejects(
        () => v1b.chatCompletions({ headers: {} }, new FakeRes(), { messages: baseMessages }),
        (err) => err.status === 502 && err.code === 'UPSTREAM_INVALID',
      );
    } finally {
      bad.closeAllConnections();
      await new Promise((r) => bad.close(r));
    }
  });

  test('streaming proxies the SSE bytes verbatim', async () => {
    const up = await upstreamServer((req, res, raw) => {
      assert.equal(JSON.parse(raw).stream, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"API WORKING"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const v1 = compat({ base: `http://127.0.0.1:${up.address().port}` });
    try {
      const res = new FakeRes();
      await v1.chatCompletions({ headers: {} }, res, { messages: baseMessages, stream: true });
      assert.equal(res.status, 200);
      assert.ok((res.headers['Content-Type'] || '').includes('text/event-stream'));
      assert.ok(res.text.includes('API WORKING'));
      assert.ok(res.text.endsWith('data: [DONE]\n\n'));
    } finally {
      up.closeAllConnections();
      await new Promise((r) => up.close(r));
    }
  });
});

// Minimal http.ServerResponse stand-in for module-level calls.
class FakeRes {
  constructor() {
    this.status = null;
    this.headers = {};
    this.text = '';
    this.finished = false;
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  write(chunk) {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this.finished = true;
    return this;
  }
}
