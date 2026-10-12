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
