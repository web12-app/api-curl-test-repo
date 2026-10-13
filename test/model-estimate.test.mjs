// Unit tests for the pure estimation/validation helpers used by the model runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, GEOMETRY, LIMITS, MODELS, DEFAULT_MODEL_ID,
  modelById, requiredBytesForModel,
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

test('model registry holds the two verified chat models', () => {
  assert.deepEqual(Object.keys(MODELS), ['qwen3-27b', 'huihui-qwen3-8b']);
  assert.equal(DEFAULT_MODEL_ID, 'qwen3-27b');
  assert.equal(modelById('qwen3-27b').repo, 'DevQuasar/Qwen.Qwen3.8-27B-GGUF');
  assert.equal(modelById('nope'), null);

  const huihui = modelById('huihui-qwen3-8b');
  // Facts verified live against the HF API on 2026-10-13.
  assert.equal(huihui.repo, 'DevQuasar/huihui-ai.Qwen3-8B-abliterated-GGUF');
  assert.equal(huihui.quant, 'Q2_K');
  assert.equal(huihui.path, 'huihui-ai.Qwen3-8B-abliterated.Q2_K.gguf');
  assert.equal(huihui.sizeBytes, 3281728768);
  assert.equal(huihui.sha256, 'e2c01eff34523c23284ca4f585bf53a3161b4d150c6bed0d71290126ae5e3396');
  assert.equal(huihui.architecture, 'qwen3');
  assert.equal(huihui.license, 'apache-2.0');
});

test('the 8B model uses dense qwen3 geometry and needs far less RAM', () => {
  const g = modelById('huihui-qwen3-8b').geometry;
  assert.equal(g.layers, 36);
  assert.equal(fullAttentionLayerCount(g), 36); // every layer, no linear attention
  assert.equal(linearStateBytes(g), 0);          // no recurrent state on qwen3-8b
  // KV at 1024: 36 layers * 8 kv heads * 128 head_dim * 2 (K+V) * 2 bytes
  assert.equal(kvCacheBytes(1024, g), 36 * 1024 * 8 * 128 * 2 * 2);

  const req8 = requiredBytesForModel(modelById('huihui-qwen3-8b'), 1024);
  const req27 = requiredBytesForModel(modelById('qwen3-27b'), 1024);
  assert.ok(req8 > modelById('huihui-qwen3-8b').sizeBytes, '8B estimate must exceed its file size');
  assert.ok(req8 < req27 / 2, `8B (${req8}) should need under half the 27B (${req27}) RAM`);
  // ~4-6 GiB at ctx 1024, matching the live validate-model.sh estimate.
  assert.ok(req8 > 4 * 1024 ** 3 && req8 < 6 * 1024 ** 3, `unexpected 8B estimate ${req8}`);
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
