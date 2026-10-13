'use strict';

// Chat route tests: /chat page, /api/chat/status, POST /api/chat job lifecycle,
// cancel, ownership, and the disabled-server behavior. The llama-server is a
// real local HTTP stub (same protocol), reached over real HTTP - no mocking of
// the site code, only of the (external) runtime process.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');
const { GitHubStorage } = require('../src/github-storage');
const { GitHubReleases } = require('../src/github-releases');
const { startFakeGitHub } = require('./fake-github');
const { sessionFrom } = require('./helpers');

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

// A stub llama-server: /health and /v1/chat/completions. Behavior markers:
//   !never -> never answers (cancel/timeout paths)
function startStub() {
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
      if (last.includes('!never')) return;
      if (body.stream) {
        // The real llama-server answers stream:true with SSE deltas.
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function startApp({ env = {} } = {}) {
  const stub = await startStub();
  const fullEnv = { ...ENV_BASE, ...env };
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env: fullEnv, storage, releases, upstreamBase: `http://127.0.0.1:${stub.address().port}` });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // Wait until the white-box upstream mode flipped the runtime to ready.
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

async function signup(app, username, password = 'password-one') {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201, `signup ${username}`);
  return { username, password, cookie: sessionFrom(res), ...(await res.json()).data.user };
}

const authed = (app, cookie, options = {}) => ({
  ...options,
  headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base, ...(options.headers || {}) },
});

async function pollUntil(app, cookie, jobId, statuses, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const res = await fetch(`${app.base}/api/chat/jobs/${jobId}`, authed(app, cookie));
    assert.equal(res.status, 200);
    const view = (await res.json()).data;
    if (statuses.includes(view.status)) return view;
    if (Date.now() > deadline) throw new Error(`job did not reach ${statuses}: ${JSON.stringify(view)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('chat page redirects signed-out visitors and renders the shell for users', async () => {
  const app = await startApp();
  try {
    const anon = await fetch(`${app.base}/chat`, { redirect: 'manual' });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login');

    const user = await signup(app, 'alice');
    const page = await fetch(`${app.base}/chat`, { headers: { Cookie: user.cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('"page":"chat"'), 'bootstrap carries the chat page key');
    assert.ok(html.includes('chat-root') || html.includes('chat'), 'chat css/shell present');
  } finally {
    await app.close();
  }
});

test('chat status requires login and reports the stub runtime as ready', async () => {
  const app = await startApp();
  try {
    const anon = await fetch(`${app.base}/api/chat/status`);
    assert.equal(anon.status, 401);

    const user = await signup(app, 'bob');
    const res = await fetch(`${app.base}/api/chat/status`, authed(app, user.cookie));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.state, 'ready');
    assert.equal(typeof body.data.context, 'number');
  } finally {
    await app.close();
  }
});

test('a chat POST creates a job, polling reaches done, and the reply is real', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'carol');
    const res = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is the capital of France?' }),
    }));
    assert.equal(res.status, 202);
    const created = (await res.json()).data;
    assert.ok(created.id);
    // The job starts synchronously, so either state is a correct 202 answer.
    assert.ok(['queued', 'running'].includes(created.status), `status ${created.status}`);

    const view = await pollUntil(app, user.cookie, created.id, ['done']);
    assert.equal(view.result.text, 'Paris');
    assert.equal(view.result.reasoning, 'hm');
    assert.ok(view.result.elapsed_ms >= 0);
  } finally {
    await app.close();
  }
});

test('the CSRF header is required on chat POST', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'dave');
    const res = await fetch(`${app.base}/api/chat`, {
      method: 'POST',
      headers: { Cookie: user.cookie, 'Content-Type': 'application/json', Origin: app.base },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'CSRF_HEADER_REQUIRED');
  } finally {
    await app.close();
  }
});

test('empty and oversized messages are rejected before any generation', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'erin');
    const empty = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    }));
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'EMPTY_PROMPT');

    const big = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(8001) }),
    }));
    assert.equal(big.status, 400);
    assert.equal((await big.json()).error.code, 'PROMPT_TOO_LONG');
  } finally {
    await app.close();
  }
});

test('a stuck generation can be cancelled by its owner', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'frank');
    const res = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '!never answer this' }),
    }));
    const { id } = (await res.json()).data;
    await new Promise((r) => setTimeout(r, 300)); // let it enter "running"
    const del = await fetch(`${app.base}/api/chat/jobs/${id}`, authed(app, user.cookie, { method: 'DELETE' }));
    assert.equal(del.status, 200);
    const view = (await del.json()).data;
    assert.equal(view.status, 'cancelled');
    assert.equal(view.error.code, 'GENERATION_CANCELLED');
  } finally {
    await app.close();
  }
});

test('jobs are private: another user gets a 404, not the content', async () => {
  const app = await startApp();
  try {
    const alice = await signup(app, 'alice2');
    const mallory = await signup(app, 'mallory');
    const res = await fetch(`${app.base}/api/chat`, authed(app, alice.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'secret question' }),
    }));
    const { id } = (await res.json()).data;
    await pollUntil(app, alice.cookie, id, ['done']);
    const other = await fetch(`${app.base}/api/chat/jobs/${id}`, authed(app, mallory.cookie));
    assert.equal(other.status, 404);
    const unknown = await fetch(`${app.base}/api/chat/jobs/11111111-1111-4111-8111-111111111111`, authed(app, alice.cookie));
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }
});

test('a user with two active generations gets MODEL_BUSY on the third', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'grace');
    const make = () => fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '!never mind' }),
    }));
    const first = await make();
    const second = await make();
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const third = await make();
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error.code, 'MODEL_BUSY');

    // Free a slot by cancelling the first job; then a new request fits again.
    const firstId = (await first.json()).data.id;
    const del = await fetch(`${app.base}/api/chat/jobs/${firstId}`, authed(app, user.cookie, { method: 'DELETE' }));
    assert.equal(del.status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const fourth = await make();
    assert.equal(fourth.status, 202);
  } finally {
    await app.close();
  }
});

test('an unconfigured server reports the chat as disabled and refuses generation', async () => {
  // No upstreamBase: the ModelChat has no runtime to manage.
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({ env: { ...ENV_BASE }, storage, releases });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = { base: `http://127.0.0.1:${server.address().port}` };
  try {
    const user = await signup(app, 'henry');
    const status = await fetch(`${app.base}/api/chat/status`, authed(app, user.cookie));
    const body = (await status.json()).data;
    assert.equal(body.enabled, false);
    assert.equal(body.state, 'disabled');

    const send = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    }));
    assert.equal(send.status, 503);
    assert.equal((await send.json()).error.code, 'MODEL_NOT_READY');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- Multi-model selection: the registry, per-job model choice, and the
// 400 path for unknown ids. The stub runtime serves whatever is asked, so
// these verify the site plumbing (selection lands on the job and status).

test('chat status exposes the verified model registry and the loaded model', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'modelena');
    const res = await fetch(`${app.base}/api/chat/status`, authed(app, user.cookie));
    assert.equal(res.status, 200);
    const body = (await res.json()).data;
    assert.deepEqual(
      body.models.map((m) => m.id),
      ['qwen3-27b', 'huihui-qwen3-8b'],
      'both the old and the new model are selectable',
    );
    const huihui = body.models.find((m) => m.id === 'huihui-qwen3-8b');
    assert.equal(huihui.repo, 'DevQuasar/huihui-ai.Qwen3-8B-abliterated-GGUF');
    assert.equal(huihui.quant, 'Q2_K');
    assert.equal(huihui.bytes, 3281728768);
    assert.equal(huihui.arch, 'qwen3');
    assert.equal(body.default_model, 'qwen3-27b');
    assert.equal(body.loaded_model, 'qwen3-27b');
  } finally {
    await app.close();
  }
});

test('a chat POST with the new model completes and tags the result with it', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'modeler');
    const res = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is the capital of France?', model: 'huihui-qwen3-8b' }),
    }));
    assert.equal(res.status, 202);
    const { id } = (await res.json()).data;
    const view = await pollUntil(app, user.cookie, id, ['done']);
    assert.equal(view.model, 'huihui-qwen3-8b');
    assert.equal(view.result.model, 'huihui-qwen3-8b');
    assert.equal(view.result.text, 'Paris');

    // The selection stuck: status now reports the 8B model as loaded.
    const status = await fetch(`${app.base}/api/chat/status`, authed(app, user.cookie));
    assert.equal((await status.json()).data.loaded_model, 'huihui-qwen3-8b');
  } finally {
    await app.close();
  }
});

test('an unknown model id is a 400 BAD_MODEL that names the valid options', async () => {
  const app = await startApp();
  try {
    const user = await signup(app, 'modelless');
    const res = await fetch(`${app.base}/api/chat`, authed(app, user.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', model: 'gpt-5-ultra' }),
    }));
    assert.equal(res.status, 400);
    const err = (await res.json()).error;
    assert.equal(err.code, 'BAD_MODEL');
    assert.ok(err.message.includes('qwen3-27b') && err.message.includes('huihui-qwen3-8b'), 'lists the available models');
  } finally {
    await app.close();
  }
});
