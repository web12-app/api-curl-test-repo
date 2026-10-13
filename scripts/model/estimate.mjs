/**
 * Pure estimation + validation helpers for the GGUF model runner.
 * Node >= 18, zero dependencies. Used by scripts/model/*.sh and
 * unit-tested in test/model-estimate.test.js.
 *
 * Verified source facts (checked 2026-10-12, not assumed):
 * - Model repo : DevQuasar/Qwen.Qwen3.8-27B-GGUF (public, not gated)
 * - Q2_K file  : Q2_K/Qwen.Qwen3.8-27B.f16.gguf.Q2_K.gguf
 *                10,711,665,024 bytes, sha256 ac9c08aa...53121c (HF tree API lfs.oid)
 * - GGUF header: general.architecture = qwen35, general.license = apache-2.0
 *                (read via HTTP range request of the first 4 KiB)
 * - Base model : Qwen/Qwen3.8-27B, Qwen3_5ForConditionalGeneration, Apache-2.0
 *                64 layers (every 4th = full attention, rest linear attention),
 *                24 attn heads / 4 kv heads, head_dim 256, linear 16 key / 48 value
 *                heads of dim 128, ssm dtype float32, vocab 248320
 * - Runtime    : llama.cpp b11574 supports LLM_ARCH_QWEN35 ("qwen35") and ships
 *                llama-b11574-bin-ubuntu-x64.tar.gz (CPU) release assets.
 */

export const MODEL = {
  repo: 'DevQuasar/Qwen.Qwen3.8-27B-GGUF',
  quant: 'Q2_K',
  path: 'Q2_K/Qwen.Qwen3.8-27B.f16.gguf.Q2_K.gguf',
  sizeBytes: 10711665024,
  sha256: 'ac9c08aa74676ab698e054a4b945592550d7cfc321b16f15a4b2e0b5ee53121c',
  architecture: 'qwen35',
  license: 'apache-2.0',
};

// Geometry for standard Qwen3 dense models (Qwen3-8B family), from the
// published base-model config.json: 36 layers, all full attention (no linear
// layers on this architecture), 32 query heads / 8 kv heads, head_dim 128.
export const QWEN3_8B_GEOMETRY = {
  layers: 36,
  fullAttentionInterval: 1,
  kvHeads: 8,
  headDim: 128,
  linearKeyHeads: 0,
  linearValueHeads: 0,
  linearHeadDim: 0,
  kvBytesPerElement: 2,      // K/V cache stored f16
  ssmBytesPerElement: 4,     // unused on this architecture (no recurrent state)
  computeBufferBytes: 402653184,  // 384 MiB compute/scratch buffers for an 8B
  overheadBytes: 805306368,       // 768 MiB OS + runtime overhead beyond buffers
};

// Geometry used for memory estimation. Values come from the verified base-model
// config.json (text_config.*) — measured inputs, not guesses.
export const GEOMETRY = {
  layers: 64,
  fullAttentionInterval: 4,
  kvHeads: 4,
  headDim: 256,
  linearKeyHeads: 16,
  linearValueHeads: 48,
  linearHeadDim: 128,
  kvBytesPerElement: 2,      // K/V cache stored f16
  ssmBytesPerElement: 4,     // linear-attention recurrent state float32
  computeBufferBytes: 805306368,  // 768 MiB compute/scratch buffers for a 27B
  overheadBytes: 805306368,       // 768 MiB OS + runtime overhead beyond buffers
};

// The models the site chat can load. Every entry is a VERIFIED source (HF API
// checked, sha256 from the HF tree API, GGUF header read via range request):
//  - qwen3-27b: verified 2026-10-12 (see MODEL above)
//  - huihui-qwen3-8b: verified 2026-10-13
//    repo DevQuasar/huihui-ai.Qwen3-8B-abliterated-GGUF (public, not gated)
//    file huihui-ai.Qwen3-8B-abliterated.Q2_K.gguf, 3,281,728,768 bytes,
//    sha256 from HF lfs.oid, general.architecture = qwen3, Apache-2.0.
//    Flat repo layout (no Q2_K/ subdirectory).
export const MODELS = {
  'qwen3-27b': {
    id: 'qwen3-27b',
    label: 'Qwen3.8 27B (DevQuasar)',
    ...MODEL,
    geometry: GEOMETRY,
  },
  'huihui-qwen3-8b': {
    id: 'huihui-qwen3-8b',
    label: 'Qwen3 8B Abliterated (huihui-ai)',
    repo: 'DevQuasar/huihui-ai.Qwen3-8B-abliterated-GGUF',
    quant: 'Q2_K',
    path: 'huihui-ai.Qwen3-8B-abliterated.Q2_K.gguf',
    sizeBytes: 3281728768,
    sha256: 'e2c01eff34523c23284ca4f585bf53a3161b4d150c6bed0d71290126ae5e3396',
    architecture: 'qwen3',
    license: 'apache-2.0',
    geometry: QWEN3_8B_GEOMETRY,
  },
};

// The model loaded when no explicit selection exists (the original chat model).
export const DEFAULT_MODEL_ID = 'qwen3-27b';

export function modelById(id) {
  return MODELS[id] || null;
}

// Memory requirement for a specific registry model (its own geometry).
export function requiredBytesForModel(model, ctx, modelBytes) {
  return requiredBytes(ctx, modelBytes === undefined ? model.sizeBytes : modelBytes, model.geometry);
}

// Accepted input ranges for the inference interface.
export const LIMITS = {
  minContext: 256,
  maxContext: 32768,
  minTokens: 1,
  maxTokens: 4096,
  maxPromptChars: 16384,
};

export function parseBytes(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v !== 'string') return NaN;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)$/i.exec(v.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase().replace(/b$/, '');
  const mult = { '': 1, k: 1e3, ki: 1024, m: 1e6, mi: 1024 ** 2, g: 1e9, gi: 1024 ** 3, t: 1e12, ti: 1024 ** 4 }[unit];
  return mult ? Math.floor(n * mult) : NaN;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(2)} ${units[i]}`;
}

export function fullAttentionLayerCount(g = GEOMETRY) {
  const interval = Math.max(1, g.fullAttentionInterval);
  return Math.ceil(g.layers / interval);
}

// K/V cache bytes: only full-attention layers keep a per-token KV cache;
// linear-attention layers keep a constant-size recurrent state instead.
export function kvCacheBytes(ctx, g = GEOMETRY) {
  const c = Math.max(0, Math.floor(ctx));
  return fullAttentionLayerCount(g) * c * g.kvHeads * g.headDim * 2 * g.kvBytesPerElement;
}

// Recurrent state: [value heads x key head dim x value head dim] float32 per
// linear layer, constant regardless of context length.
export function linearStateBytes(g = GEOMETRY) {
  const linearLayers = g.layers - fullAttentionLayerCount(g);
  return linearLayers * g.linearValueHeads * g.linearHeadDim * g.linearHeadDim * g.ssmBytesPerElement;
}

export function estimateBreakdown(ctx, modelBytes = MODEL.sizeBytes, g = GEOMETRY) {
  const weights = Math.ceil(modelBytes * 1.04); // dequant spill + page-table margin
  const kv = kvCacheBytes(ctx, g);
  const linear = linearStateBytes(g);
  const compute = g.computeBufferBytes;
  const overhead = g.overheadBytes;
  return {
    weights, kv, linear, compute, overhead,
    required: weights + kv + linear + compute + overhead,
    context: Math.floor(ctx),
  };
}

export function requiredBytes(ctx, modelBytes = MODEL.sizeBytes, g = GEOMETRY) {
  return estimateBreakdown(ctx, modelBytes, g).required;
}


/** Parse MemAvailable (bytes) from the text of /proc/meminfo. */
export function memAvailableBytes(meminfoText) {
  const m = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(String(meminfoText));
  if (!m) return NaN;
  return parseInt(m[1], 10) * 1024;
}

export function validateInputs({ prompt, context_length, max_tokens } = {}) {
  const errors = [];
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    errors.push({ code: 'EMPTY_PROMPT', message: 'prompt is required and must be non-empty text' });
  } else if (prompt.length > LIMITS.maxPromptChars) {
    errors.push({ code: 'PROMPT_TOO_LONG', message: `prompt exceeds ${LIMITS.maxPromptChars} characters` });
  }
  const ctx = context_length === undefined || context_length === null || context_length === '' ? 1024 : Number(context_length);
  if (!Number.isInteger(ctx) || ctx < LIMITS.minContext || ctx > LIMITS.maxContext) {
    errors.push({ code: 'BAD_CONTEXT', message: `context_length must be an integer between ${LIMITS.minContext} and ${LIMITS.maxContext}` });
  }
  const tok = max_tokens === undefined || max_tokens === null || max_tokens === '' ? 256 : Number(max_tokens);
  if (!Number.isInteger(tok) || tok < LIMITS.minTokens || tok > LIMITS.maxTokens) {
    errors.push({ code: 'BAD_MAX_TOKENS', message: `max_tokens must be an integer between ${LIMITS.minTokens} and ${LIMITS.maxTokens}` });
  }
  return { ok: errors.length === 0, errors, context: ctx, maxTokens: tok };
}

export function actionableMemoryMessage(required, available, ctx) {
  const lines = [
    `FAIL: not enough memory to load the model at context ${ctx}.`,
    `Required ~${fmtBytes(required)}; MemAvailable ${fmtBytes(available)}.`,
    'Options:',
    `  1. Re-run with a smaller --context_length (each halving saves ~${fmtBytes(kvCacheBytes(ctx) / 2)}).`,
    '  2. Use a smaller quantization (Q2_K is already the smallest offered for this model).',
    '  3. Run on a self-hosted worker with more RAM - see docs/model-worker.md.',
  ];
  return lines.join('\n');
}

// ---- CLI surface used by the shell scripts ---------------------------------
async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'required') {
    const ctx = Number(flag('--ctx') || 1024);
    const model = flag('--model') ? modelById(flag('--model')) : null;
    if (flag('--model') && !model) {
      process.stderr.write(`FAIL: unknown model '${flag('--model')}' (known: ${Object.keys(MODELS).join(', ')})\n`);
      return 2;
    }
    const geom = model ? model.geometry : GEOMETRY;
    const modelBytes = flag('--model-bytes') ? Number(flag('--model-bytes')) : model ? model.sizeBytes : MODEL.sizeBytes;
    process.stdout.write(`${JSON.stringify(estimateBreakdown(ctx, modelBytes, geom))}\n`);
    return 0;
  }
  if (cmd === 'available') {
    const fs = await import('node:fs');
    const file = flag('--file') || '/proc/meminfo';
    const text = fs.readFileSync(file, 'utf8');
    const bytes = memAvailableBytes(text);
    if (!Number.isFinite(bytes)) {
      process.stderr.write('FAIL: could not read MemAvailable from meminfo\n');
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ available: bytes })}\n`);
    return 0;
  }
  if (cmd === 'validate-inputs') {
    const promptChars = Number(flag('--prompt-chars') || 0);
    const prompt = promptChars > 0 ? 'x'.repeat(Math.min(promptChars, LIMITS.maxPromptChars + 1)) : '';
    const r = validateInputs({ prompt, context_length: flag('--ctx'), max_tokens: flag('--max-tokens') });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return r.ok ? 0 : 3;
  }
  process.stderr.write('usage: estimate.mjs required|available|validate-inputs [...flags]\n');
  return 2;
}

const isMain = process.argv[1] && process.argv[1].endsWith('estimate.mjs');
if (isMain) {
  cli(process.argv.slice(2)).then((code) => process.exit(code));
}
