// Unit tests for the pure estimation/validation helpers used by the model runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, GEOMETRY, LIMITS,
  parseBytes, fmtBytes, fullAttentionLayerCount,
  kvCacheBytes, linearStateBytes, estimateBreakdown,
  memAvailableBytes, validateInputs,
} from '../scripts/model/estimate.mjs';

test('verified model constants are the checked facts', () => {
  assert.equal(MODEL.repo, 'DevQuasar/Qwen.Qwen3.8-27B-GGUF');
  assert.equal(MODEL.quant, 'Q2_K');
  assert.equal(MODEL.path, 'Q2_K/Qwen.Qwen3.8-27B.f16.gguf.Q2_K.gguf');
  assert.equal(MODEL.sizeBytes, 10711665024);
  assert.match(MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.equal(MODEL.architecture, 'qwen35');
  assert.equal(MODEL.license, 'apache-2.0');
});

test('parseBytes handles raw numbers, decimal and binary units', () => {
  assert.equal(parseBytes(1024), 1024);
  assert.equal(parseBytes('1KB'), 1000);
  assert.equal(parseBytes('1KiB'), 1024);
  assert.equal(parseBytes('1.5GiB'), 1610612736);
  assert.equal(parseBytes('2 GB'), 2000000000);
  assert.ok(Number.isNaN(parseBytes('abc')));
  assert.ok(Number.isNaN(parseBytes(-5)));
});

test('fmtBytes renders human units', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(10711665024), '9.98 GiB');
  assert.equal(fmtBytes(NaN), 'unknown');
});

test('only every 4th layer of 64 is full attention (16 layers)', () => {
  assert.equal(fullAttentionLayerCount(), 16);
});

test('KV cache scales linearly with context and only counts full-attention layers', () => {
  const perToken = kvCacheBytes(1) ;
  assert.equal(kvCacheBytes(0), 0);
  assert.equal(kvCacheBytes(1024), perToken * 1024);
  // 16 layers * 4 kv heads * 256 head_dim * 2 (K+V) * 2 bytes (f16)
  assert.equal(perToken, 16 * 4 * 256 * 2 * 2);
  // linear attention layers keep constant state, so doubling ctx only doubles KV
  const a = estimateBreakdown(512);
  const b = estimateBreakdown(1024);
  assert.equal(b.kv, a.kv * 2);
  assert.equal(a.linear, b.linear);
});

test('linear state is constant and uses float32', () => {
  // 48 linear layers * 48 value heads * 128 * 128 * 4 bytes
  assert.equal(linearStateBytes(), 48 * 48 * 128 * 128 * 4);
});

test('required memory grows with context and exceeds raw file size', () => {
  const small = estimateBreakdown(256).required;
  const big = estimateBreakdown(8192).required;
  assert.ok(big > small);
  assert.ok(estimateBreakdown(1024).required > MODEL.sizeBytes);
  const d = estimateBreakdown(1024);
  assert.equal(d.required, d.weights + d.kv + d.linear + d.compute + d.overhead);
});

test('default context 1024 needs roughly 13 GiB (fits a 16 GiB runner)', () => {
  const req = estimateBreakdown(1024).required;
  assert.ok(req > 12 * 1024 ** 3 && req < 15 * 1024 ** 3, `unexpected estimate ${req}`);
});

test('memAvailableBytes parses /proc/meminfo format', () => {
  const text = 'MemTotal:       16384000 kB\nMemFree:         1024000 kB\nMemAvailable:   13631488 kB\n';
  assert.equal(memAvailableBytes(text), 13631488 * 1024);
  assert.ok(Number.isNaN(memAvailableBytes('no match')));
});

test('validateInputs accepts good input with defaults', () => {
  const r = validateInputs({ prompt: 'hello world' });
  assert.equal(r.ok, true);
  assert.equal(r.context, 1024);
  assert.equal(r.maxTokens, 256);
});

test('validateInputs rejects empty prompt with EMPTY_PROMPT', () => {
  for (const p of ['', '   ', null, undefined]) {
    const r = validateInputs({ prompt: p });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'EMPTY_PROMPT');
  }
});

test('validateInputs enforces context and token ranges', () => {
  assert.equal(validateInputs({ prompt: 'x', context_length: 128 }).errors[0].code, 'BAD_CONTEXT');
  assert.equal(validateInputs({ prompt: 'x', context_length: 99999 }).errors[0].code, 'BAD_CONTEXT');
  assert.equal(validateInputs({ prompt: 'x', context_length: 'abc' }).errors[0].code, 'BAD_CONTEXT');
  assert.equal(validateInputs({ prompt: 'x', max_tokens: 0 }).errors[0].code, 'BAD_MAX_TOKENS');
  assert.equal(validateInputs({ prompt: 'x', context_length: 4096, max_tokens: 64 }).ok, true);
  assert.equal(LIMITS.maxPromptChars, 16384);
});
