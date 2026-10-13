#!/usr/bin/env node
'use strict';

// REAL end-to-end chat test: boots the actual site with CHAT_AUTOPROVISION=1,
// which downloads the llama.cpp runtime and the VERIFIED Qwen Q2_K GGUF
// (validate-model.sh -> download-model.sh, checksum enforced), loads it into a
// llama-server, then drives the chat through the public HTTP API:
// signup -> POST /api/chat -> poll -> assert a real model reply.
//
// Every token in the reply comes from the model running on this machine.
// Exit codes: 0 real reply produced | 1 any failure (never fakes success).
//
// Usage: node scripts/model/chat-e2e.js [--prompt TEXT] [--out result.json]
// Env:   HF_REPO, MODEL_QUANT (QUANT), LLAMA_REF, RUNNER_TEMP, MODEL_PORT...

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../src/server');
const { MemoryStorage } = require('../../src/memory-storage');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PROMPT = flag('--prompt', 'What is the capital of France? Answer with just the city name.');
const OUT_JSON = flag('--out', 'chat-e2e-result.json');
// What a REAL reply must contain (case-insensitive). Defaults to Paris for
// the capital-of-France prompt; override with --expect for other prompts.
const EXPECT_TEXT = flag('--expect', 'Paris');
// Optional model selection: sent through the real /api/chat body. The boot
// model can be chosen separately with CHAT_DEFAULT_MODEL (registry id).
const REQUESTED_MODEL = flag('--model', '');

const READY_DEADLINE_MS = 50 * 60 * 1000;   // provisioning: runtime + 10.7 GB model download
const JOB_DEADLINE_MS = 20 * 60 * 1000;     // generation at ~1.7 tok/s on 4 vCPU

function log(ms, line) {
  console.log(`[${Math.round(ms / 1000)}s] ${line}`);
}

async function main() {
  const started = Date.now();
  const el = () => Date.now() - started;
  const server = createServer({
    env: {
      GITHUB_TOKEN: 'chat-e2e-token-not-real',
      PRIVATE_DATA_REPO: 'owner/private-data',
      SESSION_SECRET: 'chat-e2e-session-secret-0123456789abcdef',
      COOKIE_SECURE: '0',
      // The real chat configuration, exactly what the live tunnel uses when enabled:
      CHAT_AUTOPROVISION: '1',
      CHAT_DEFAULT_MODEL: process.env.CHAT_DEFAULT_MODEL || '',
      HF_REPO: process.env.HF_REPO || 'DevQuasar/Qwen.Qwen3.8-27B-GGUF',
      MODEL_QUANT: process.env.MODEL_QUANT || process.env.QUANT || 'Q2_K',
      LLAMA_REF: process.env.LLAMA_REF || 'b11574',
      MODEL_CTX: process.env.MODEL_CTX || '1024',
      MODEL_PORT: process.env.MODEL_PORT || '8921',
      MODEL_MAX_TOKENS: process.env.MODEL_MAX_TOKENS || '48',
      MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS || '600000',
    },
    storage: new MemoryStorage(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log(el(), `site listening on ${base}`);

  const shutdown = () => {
    try { server.modelChat.stop(); } catch { /* already gone */ }
    process.exit(1);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 1. Sign up through the real API.
  const su = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'chat_e2e', password: 'chat-e2e-password' }),
  });
  if (su.status !== 201) throw new Error(`signup failed: ${su.status} ${await su.text()}`);
  const cookie = (su.headers.get('set-cookie') || '').match(/session=[^;]+/)[0];
  const headers = { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: base };
  log(el(), '1. signup OK');

  // 2. Wait for the runtime: provisioning -> loading -> ready.
  let status = null;
  let lastLine = '';
  const readyDeadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    const res = await fetch(`${base}/api/chat/status`, { headers });
    status = (await res.json()).data;
    const line = `${status.state} - ${status.detail || ''}`;
    if (line !== lastLine) {
      log(el(), `2. ${line}`);
      lastLine = line;
    }
    if (status.state === 'ready') break;
    if (status.state === 'error') {
      throw new Error(`runtime failed: ${JSON.stringify(status.error)}`);
    }
    if (Date.now() > readyDeadline) {
      throw new Error(`runtime never became ready (last state: ${status.state})`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  log(el(), `2. model ready: ${JSON.stringify(status.model)}`);

  // The boot model must match the requested one (when CHAT_DEFAULT_MODEL is
  // used, the runtime loads it directly; a different id would mean the swap
  // path is being tested unintentionally).
  if (REQUESTED_MODEL && status.loaded_model && status.loaded_model !== REQUESTED_MODEL) {
    log(el(), `2. note: runtime booted with "${status.loaded_model}"; sending model "${REQUESTED_MODEL}" to exercise the selection/swap path`);
  }
  if (REQUESTED_MODEL && !(status.models || []).some((m) => m.id === REQUESTED_MODEL)) {
    throw new Error(`requested model "${REQUESTED_MODEL}" is not in the status registry: ${JSON.stringify((status.models || []).map((m) => m.id))}`);
  }

  // 3. Send a real prompt through the real chat API.
  const send = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(REQUESTED_MODEL
      ? { message: PROMPT, model: REQUESTED_MODEL }
      : { message: PROMPT }),
  });
  if (send.status !== 202) {
    throw new Error(`chat send failed: ${send.status} ${await send.text()}`);
  }
  const { id } = (await send.json()).data;
  log(el(), `3. job created: ${id}`);

  // 4. Poll until finished, printing progress.
  let view = null;
  let partial = '';
  const jobDeadline = Date.now() + JOB_DEADLINE_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${base}/api/chat/jobs/${id}`, { headers });
    if (res.status !== 200) throw new Error(`job poll failed: ${res.status}`);
    view = (await res.json()).data;
    if (view.partial && view.partial !== partial) {
      partial = view.partial;
      log(el(), `   generating: ${partial.length} chars so far`);
    }
    if (['done', 'error', 'cancelled'].includes(view.status)) break;
    if (Date.now() > jobDeadline) throw new Error(`job never finished (status: ${view.status})`);
  }
  if (view.status !== 'done' || !view.result) {
    throw new Error(`job did not succeed: ${JSON.stringify(view).slice(0, 800)}`);
  }
  const reply = view.result.text || '';
  log(el(), `4. job done: ${reply.length} chars in ${view.result.elapsed_ms} ms (model: ${view.result.model || 'n/a'})`);
  if (REQUESTED_MODEL && view.result.model !== REQUESTED_MODEL) {
    throw new Error(`the job ran on "${view.result.model}" instead of the requested "${REQUESTED_MODEL}"`);
  }

  // 5. Assert the reply is real and actually answers the prompt.
  const result = {
    status: 'success',
    prompt: PROMPT,
    expected_substring: EXPECT_TEXT,
    requested_model: REQUESTED_MODEL || null,
    loaded_model: view.result.model || status.loaded_model || null,
    reply,
    reply_chars: reply.length,
    reasoning_chars: (view.result.reasoning || '').length,
    elapsed_ms: view.result.elapsed_ms,
    max_tokens: view.result.max_tokens,
    tokens: view.result.tokens || null,
    model: status.model,
    runtime_version: status.runtime_version,
    base_url: base,
    finished_at: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`);
  console.log('----- model reply -----');
  console.log(reply);
  console.log('-----------------------');
  console.log(`result written to ${OUT_JSON}`);

  if (!reply.trim()) throw new Error('the model returned an empty reply');
  if (!new RegExp(EXPECT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(reply)) {
    throw new Error(`the reply does not contain the expected text "${EXPECT_TEXT}": ${JSON.stringify(reply.slice(0, 200))}`);
  }
  log(el(), `5. REAL reply verified (contains "${EXPECT_TEXT}")`);

  server.closeAllConnections();
  await new Promise((r) => server.close(r)); // also stops the supervised llama-server
  process.exit(0);
}

main().catch((err) => {
  console.error(`FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
