'use strict';

// Unit tests for the model chat runtime client (src/model-chat.js).
// The "llama-server" is a real local HTTP stub that speaks the same
// /v1/chat/completions protocol (streaming and non-streaming), so every code
// path here exercises real HTTP, real SSE parsing, and real timeouts.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ModelChat, ThinkSplitter, splitThinkFromText } = require('../src/model-chat');

// A stub llama-server. Content markers in the last user message change behavior:
//   !slow  -> waits 3 s before answering (timeout tests shorten the limit)
//   !never -> never answers (the client must abort)
function startStubLlama() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404);
      res.end('{"error":"not found"}');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const last = body.messages[body.messages.length - 1].content;
      const answer = '<think>hm</think>Paris';
      if (last.includes('!never')) return; // hold the connection; client aborts
      if (last.includes('!slow')) {
        setTimeout(() => finish(body, res, answer), 3000);
        return;
      }
      finish(body, res, answer);
    });
    function finish(body, res, answer) {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Split so that "<think>" and "</think>" arrive cut in half.
        const pieces = ['<th', 'ink>h', 'm</th', 'ink>', 'Par', 'is'];
        for (const piece of pieces) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 9, completion_tokens: 4 } }));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('ThinkSplitter', () => {
  test('splits a complete think block', () => {
    const s = new ThinkSplitter();
    let content = '';
    let reasoning = '';
    for (const piece of ['<th', 'ink>deep thou', 'ghts</th', 'ink>the answer']) {
      const out = s.feed(piece);
      content += out.content;
      reasoning += out.reasoning;
    }
    const tail = s.flush();
    content += tail.content;
    reasoning += tail.reasoning;
    assert.equal(content, 'the answer');
    assert.equal(reasoning, 'deep thoughts');
  });

  test('an unterminated think block goes to reasoning on flush', () => {
    const s = new ThinkSplitter();
    const a = s.feed('plain <think>still going');
    assert.equal(a.content, 'plain ');
    const tail = s.flush();
    assert.equal(a.reasoning + tail.reasoning, 'still going');
  });

  test('plain text passes through untouched', () => {
    const s = new ThinkSplitter();
    const a = s.feed('hello ');
    const b = s.feed('world');
    assert.equal(a.content + b.content + s.flush().content, 'hello world');
  });
});

describe('splitThinkFromText', () => {
  test('separates reasoning and answer from a whole reply', () => {
    const out = splitThinkFromText('<think>why</think>\n\nParis');
    assert.equal(out.text, 'Paris');
    assert.equal(out.reasoning, 'why');
  });
  test('no think block: text unchanged, leading whitespace trimmed', () => {
    const out = splitThinkFromText('   just an answer');
    assert.equal(out.text, 'just an answer');
    assert.equal(out.reasoning, '');
  });
});

describe('ModelChat.generate against a stub llama-server', () => {
  let stub;
  let base;
  before(async () => {
    stub = await startStubLlama();
    base = `http://127.0.0.1:${stub.address().port}`;
  });
  after(async () => {
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  });

  function readyChat(envOverrides = {}) {
    const chat = new ModelChat({ ...envOverrides }, { upstreamBase: base });
    chat.state = 'ready'; // white-box: upstreamBase mode skips spawning
    chat.detail = 'ready (test)';
    return chat;
  }

  test('non-streaming generation strips the think block and reports usage', async () => {
    const chat = readyChat();
    const out = await chat.generate({ messages: [{ role: 'user', content: 'capital of France?' }] });
    assert.equal(out.text, 'Paris');
    assert.equal(out.reasoning, 'hm');
    assert.deepEqual(out.tokens, { completion: 4, prompt: 9 });
    assert.ok(out.elapsed_ms >= 0);
    assert.equal(out.max_tokens, 256);
  });

  test('streaming generation reassembles split tags through onDelta', async () => {
    const chat = readyChat();
    const deltas = [];
    const out = await chat.generate({
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(out.text, 'Paris');
    assert.equal(out.reasoning, 'hm');
    assert.ok(deltas.length >= 3, `expected several deltas, got ${deltas.length}`);
    const streamedContent = deltas.map((d) => d.content).join('');
    // The streamed content never leaks the raw <think> tags to the UI layer.
    assert.ok(!streamedContent.includes('<think>'), `leaked tag: ${streamedContent}`);
    assert.ok(streamedContent.includes('Paris'));
  });

  test('max_tokens from the request wins when under the cap', async () => {
    const chat = readyChat({ MODEL_MAX_TOKENS: '48' });
    const out = await chat.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 32 });
    assert.equal(out.max_tokens, 32);
  });

  test('a request above the configured cap is capped, not rejected', async () => {
    const chat = readyChat({ MODEL_MAX_TOKENS: '48' });
    const out = await chat.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    assert.equal(out.max_tokens, 48);
  });

  test('an unready runtime refuses with 503 MODEL_NOT_READY', async () => {
    const chat = new ModelChat({}, { upstreamBase: base });
    await assert.rejects(
      () => chat.generate({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.code === 'MODEL_NOT_READY' && err.status === 503,
    );
  });

  test('an empty final message is rejected before any HTTP call', async () => {
    const chat = readyChat();
    await assert.rejects(
      () => chat.generate({ messages: [{ role: 'user', content: '   ' }] }),
      (err) => err.code === 'EMPTY_PROMPT' && err.status === 400,
    );
  });

  test('generation past the timeout aborts with GENERATION_TIMEOUT', async () => {
    const chat = readyChat({ MODEL_TIMEOUT_MS: '1200' });
    await assert.rejects(
      () => chat.generate({ messages: [{ role: 'user', content: '!never' }] }),
      (err) => err.code === 'GENERATION_TIMEOUT' && err.status === 504,
    );
  });

  test('an aborted caller signal yields GENERATION_CANCELLED', async () => {
    const chat = readyChat();
    const controller = new AbortController();
    const pending = chat.generate({ messages: [{ role: 'user', content: '!never' }], signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(() => pending, (err) => err.code === 'GENERATION_CANCELLED');
  });

  test('status() reports the verified model facts without secrets', () => {
    const chat = readyChat();
    const st = chat.status();
    assert.equal(st.enabled, true);
    assert.equal(st.state, 'ready');
    // modelInfo is filled by start(); a white-box ready chat has none yet.
    assert.equal(st.model, null);
    assert.equal(typeof st.context, 'number');
    assert.equal(typeof st.max_tokens, 'number');
  });
});

describe('_runScript', () => {
  test('spawns binary programs directly (regression: bash-wrapping /usr/bin/env caused exit 126)', async () => {
    const chat = new ModelChat({});
    const out = await chat._runScript('/usr/bin/env', [process.execPath, '-e', 'console.log("env-ok")'], {}, 'probe');
    assert.ok(out.includes('env-ok'), `stdout was: ${out}`);
  });

  test('still interprets .sh helpers with bash', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mchat-sh-'));
    const file = path.join(dir, 'helper.sh');
    fs.writeFileSync(file, '#!/usr/bin/env bash\necho "sh-ok"\n');
    const chat = new ModelChat({});
    const out = await chat._runScript(file, [], {}, 'probe');
    assert.ok(out.includes('sh-ok'), `stdout was: ${out}`);
  });

  test('failures name the phase and the failing program', async () => {
    const chat = new ModelChat({});
    await assert.rejects(
      () => chat._runScript('/usr/bin/env', ['false'], {}, 'probe'),
      (err) => /^probe: \/usr\/bin\/env false exited with code 1/.test(err.message),
    );
  });
});

describe('retry', () => {
  function failingChat() {
    // A configured but nonexistent binary fails fast (MODEL_RUNTIME_MISSING),
    // without any network access - deterministic and offline.
    return new ModelChat({ LLAMA_SERVER_BIN: '/nonexistent/llama-server', MODEL_GGUF_PATH: '/nonexistent/model.gguf' });
  }

  test('a failed start restarts once, then the cooldown blocks immediate retries', async () => {
    const chat = failingChat();
    chat.start();
    await chat.startPromise;
    assert.equal(chat.state, 'error');
    assert.equal(chat.error.code, 'MODEL_RUNTIME_MISSING');

    assert.equal(chat.retry(), false); // fresh failure: inside the cooldown window

    chat.failedAt = Date.now() - 61 * 1000; // white-box: let the cooldown window pass
    assert.equal(chat.retry(), true); // restart accepted
    await chat.startPromise; // the restarted chain fails again, honestly
    assert.equal(chat.state, 'error');
    assert.equal(chat.error.code, 'MODEL_RUNTIME_MISSING');

    assert.equal(chat.retry(), false); // new failure: cooldown again
  });

  test('retry is refused for a chat that never failed', () => {
    const chat = failingChat();
    assert.equal(chat.state, 'disabled');
    assert.equal(chat.retry(), false);
  });

  test('a running start blocks retry', async () => {
    const chat = failingChat();
    const pending = chat.start();
    assert.equal(chat.retry(), false); // startPromise is in flight
    await pending;
  });
});

describe('ChatJobs on an errored runtime', () => {
  test('create() triggers one bounded restart and reports MODEL_RESTARTING', async () => {
    const { ChatJobs } = require('../src/chat-jobs');
    const chat = new ModelChat({ LLAMA_SERVER_BIN: '/nonexistent/llama-server', MODEL_GGUF_PATH: '/nonexistent/model.gguf' });
    const jobs = new ChatJobs(chat);
    chat.start();
    await chat.startPromise;
    assert.equal(chat.state, 'error');

    assert.throws(
      () => jobs.create({ id: 'u1', username: 'u' }, { message: 'hello' }),
      (err) => err.code === 'MODEL_RUNTIME_MISSING', // fresh failure: cooldown, original error surfaced
    );

    chat.failedAt = Date.now() - 61 * 1000; // white-box: cooldown window passed
    assert.throws(
      () => jobs.create({ id: 'u1', username: 'u' }, { message: 'hello' }),
      (err) => err.code === 'MODEL_RESTARTING', // one bounded restart accepted
    );
    await chat.startPromise; // restarted chain fails again
    assert.equal(chat.state, 'error');

    assert.throws(
      () => jobs.create({ id: 'u1', username: 'u' }, { message: 'hello' }),
      (err) => err.code === 'MODEL_RUNTIME_MISSING', // cooldown again
    );
  });
});

describe('thinking toggle (speed)', () => {
  // Capturing stub: records the request body, answers with a plain reply
  // unless the handler returns {status, payload} for a custom response.
  function captureServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          const body = JSON.parse(raw);
          const out = handler(body);
          if (out && out.sse) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const piece of out.pieces) {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
            }
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (out && out.status) {
            res.writeHead(out.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out.payload));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: String(out) } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function chatOn(server, envOverrides = {}) {
    const chat = new ModelChat({ ...envOverrides }, { upstreamBase: `http://127.0.0.1:${server.address().port}` });
    chat.state = 'ready';
    return chat;
  }

  test('thinking is off by default: enable_thinking=false rides the payload', async () => {
    let seen = null;
    const srv = await captureServer((body) => { seen = body; return 'Paris'; });
    await chatOn(srv).generate({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: 16 });
    assert.equal(seen.chat_template_kwargs.enable_thinking, false);
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  test('MODEL_THINKING=1 keeps the kwarg out of the payload', async () => {
    let seen = null;
    const srv = await captureServer((body) => { seen = body; return 'Paris'; });
    await chatOn(srv, { MODEL_THINKING: '1' }).generate({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: 16 });
    assert.equal(seen.chat_template_kwargs, undefined);
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  test('a template that rejects the kwarg degrades to one retry without it', async () => {
    let kwargTries = 0;
    const srv = await captureServer((body) => {
      if (body.chat_template_kwargs) {
        kwargTries += 1;
        return { status: 500, payload: { error: { message: 'unknown field: chat_template_kwargs (entry: enable_thinking)' } } };
      }
      return 'Paris';
    });
    const out = await chatOn(srv).generate({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: 16 });
    assert.equal(kwargTries, 1);
    assert.equal(out.text, 'Paris');
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  test('streaming generation degrades the same way', async () => {
    let kwargTries = 0;
    const srv = await captureServer((body) => {
      if (body.chat_template_kwargs) {
        kwargTries += 1;
        return { status: 500, payload: { error: { message: 'invalid chat_template_kwargs' } } };
      }
      return { sse: true, pieces: ['Pa', 'ris'] };
    });
    const deltas = [];
    const out = await chatOn(srv).generate({
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 16,
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(kwargTries, 1);
    assert.equal(out.text, 'Paris');
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  test('status() reports the thinking switch', () => {
    assert.equal(new ModelChat({}).status().thinking, false);
    assert.equal(new ModelChat({ MODEL_THINKING: '1' }).status().thinking, true);
  });
});

describe('_serverFlags', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const nodePath = require('node:path');

  function fakeLlama(helpText) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'mchat-flags-'));
    const bin = nodePath.join(dir, 'llama-server');
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = "--help" ]; then echo ${JSON.stringify(helpText)}; fi\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  test('adds reasoning-budget flags when the build supports them and thinking is off', async () => {
    const bin = fakeLlama('usage: llama-server [options] --jinja --reasoning-budget N number of thinking tokens');
    const chat = new ModelChat({});
    assert.deepEqual(await chat._serverFlags(bin), ['--jinja', '--reasoning-budget', '0']);
  });

  test('an older build without the flags gets none', async () => {
    const bin = fakeLlama('usage: llama-server [options] --host HOST');
    const chat = new ModelChat({});
    assert.deepEqual(await chat._serverFlags(bin), []);
  });

  test('MODEL_THINKING=1 gets no flags even on a new build', async () => {
    const bin = fakeLlama('usage: llama-server [options] --jinja --reasoning-budget N');
    const chat = new ModelChat({ MODEL_THINKING: '1' });
    assert.deepEqual(await chat._serverFlags(bin), []);
  });
});
