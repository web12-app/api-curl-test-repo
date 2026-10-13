'use strict';

// Real local model chat: supervises a llama.cpp `llama-server` process and
// talks to its OpenAI-style HTTP API. Nothing here fabricates a response -
// every generated token comes from the GGUF model running on this machine.
//
// Lifecycle (all phases surfaced through status(), never thrown at the site):
//   disabled -> validating -> provisioning-runtime -> provisioning-model
//            -> checking-memory -> loading -> ready
//   any phase -> error (with an actionable message; the site keeps serving)
//
// Configuration (environment):
//   LLAMA_SERVER_BIN      path to the llama-server executable
//   MODEL_GGUF_PATH       path to the .gguf model file
//   MODEL_CTX             context length (default 1024, conservative)
//   MODEL_THREADS         CPU threads (default: all cores)
//   MODEL_PORT            local llama-server port (default 8190, loopback only)
//   MODEL_MAX_TOKENS      per-request generation cap (default 256)
//   MODEL_TIMEOUT_MS      generation timeout (default 420000)
//   CHAT_AUTOPROVISION    "1" -> fetch the runtime and the model when missing
//   HF_REPO / MODEL_QUANT / LLAMA_REF   provisioning source (verified defaults)
//
// Provisioning reuses the audited shell scripts from scripts/model/:
//   validate-model.sh  (live HF check: file, size, sha256, architecture)
//   download-model.sh  (resumable, checksum-verified, weights never enter git)

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { AppError } = require('./errors');

const DEFAULTS = {
  hfRepo: 'DevQuasar/Qwen.Qwen3.8-27B-GGUF',
  quant: 'Q2_K',
  llamaRef: 'b11574',
  port: 8190,
  ctx: 1024,
  maxTokens: 256,
  timeoutMs: 420000,
  logLines: 120,
};

// Minimum time between two provisioning attempts after a failure. Keeps the
// self-heal bounded: a failing source is contacted at most once per window.
const RETRY_COOLDOWN_MS = 60 * 1000;

// estimate.mjs is ESM (it also feeds the workflows); load it once.
let estimatePromise = null;
function loadEstimate() {
  if (!estimatePromise) {
    const file = path.join(__dirname, '..', 'scripts', 'model', 'estimate.mjs');
    estimatePromise = import(pathToFileURL(file).href);
  }
  return estimatePromise;
}

function readIntEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Splits <think>...</think> out of a token stream. Deltas may cut the tags in
// half, so a small buffer is kept while the inside/outside state is unknown.
class ThinkSplitter {
  constructor() {
    this.buf = '';
    this.inThink = false;
    this.doneThink = false;
  }
  feed(chunk) {
    this.buf += chunk;
    let content = '';
    let reasoning = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end < 0) {
          // Keep a small tail back in case "</think>" arrives split.
          const keep = this.buf.length > 8 ? this.buf.length - 8 : 0;
          reasoning += this.buf.slice(0, keep);
          this.buf = this.buf.slice(keep);
          break;
        }
        reasoning += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
        this.doneThink = true;
      } else {
        const start = this.buf.indexOf('<think>');
        if (start < 0) {
          if (this.doneThink) {
            content += this.buf;
            this.buf = '';
          } else {
            // Before the first tag we cannot be sure yet; hold the tail.
            const keep = this.buf.length > 16 ? this.buf.length - 16 : 0;
            content += this.buf.slice(0, keep);
            this.buf = this.buf.slice(keep);
          }
          break;
        }
        content += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inThink = true;
      }
    }
    return { content, reasoning };
  }
  flush() {
    const out = { content: '', reasoning: '' };
    if (this.inThink) out.reasoning = this.buf;
    else out.content = this.buf;
    this.buf = '';
    return out;
  }
}

function splitThinkFromText(text) {
  const m = /<think>([\s\S]*?)(<\/think>|$)/.exec(text);
  if (!m) return { text: text.replace(/^\s+/, ''), reasoning: '' };
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { text: rest, reasoning: m[1].trim() };
}

class ModelChat {
  // options.upstreamBase: talk to an existing llama-server instead of spawning
  // one (used by tests and by deployments where the runtime is managed elsewhere).
  constructor(env = {}, options = {}) {
    this.env = env;
    this.opt = {
      hfRepo: env.HF_REPO || DEFAULTS.hfRepo,
      quant: env.MODEL_QUANT || DEFAULTS.quant,
      llamaRef: env.LLAMA_REF || DEFAULTS.llamaRef,
      port: readIntEnv(env, 'MODEL_PORT', DEFAULTS.port, 1024, 65535),
      ctx: readIntEnv(env, 'MODEL_CTX', DEFAULTS.ctx, 256, 32768),
      threads: readIntEnv(env, 'MODEL_THREADS', Math.max(1, os.cpus().length), 1, 128),
      maxTokens: readIntEnv(env, 'MODEL_MAX_TOKENS', DEFAULTS.maxTokens, 1, 4096),
      timeoutMs: readIntEnv(env, 'MODEL_TIMEOUT_MS', DEFAULTS.timeoutMs, 1000, 3600000),
      // Qwen3-family models spend most of their output on a <think> block
      // before the answer. The site chat disables that for speed; set
      // MODEL_THINKING=1 to keep the reasoning (slower, deeper replies).
      thinking: env.MODEL_THINKING === '1',
      // Optional default model id from the registry (CHAT_DEFAULT_MODEL).
      defaultModel: env.CHAT_DEFAULT_MODEL || '',
      binPath: env.LLAMA_SERVER_BIN || '',
      modelPath: env.MODEL_GGUF_PATH || '',
      repoExplicit: Boolean(env.HF_REPO),
      autoProvision: env.CHAT_AUTOPROVISION === '1' || env.CHAT_AUTOPROVISION === 'true',
      upstreamBase: options.upstreamBase || null,
      overrides: options.overrides || {},
    };
    this.state = 'disabled';
    this.detail = 'Model chat is not configured (set LLAMA_SERVER_BIN and MODEL_GGUF_PATH).';
    this.error = null;
    this.runtimeVersion = null;
    this.child = null;
    this.startedAt = 0;
    this.logTail = [];
    this.startPromise = null;
    this.failedAt = 0;
    this._flagsProbe = null;
    this.abortControllers = new Set();

    // Multi-model state. The registry (estimate.mjs MODELS) lists every
    // verified model the chat may load; one llama-server holds ONE model at a
    // time, so selecting another model hot-swaps the runtime.
    this.loadedModel = null;      // registry id currently loaded (or being loaded)
    this.pendingModelId = null;   // registry id the next (re)start should load
    this._switchChain = Promise.resolve(); // serializes hot-swaps
    this.models = [];             // public list for the UI, filled below
    this.defaultModelId = null;
    loadEstimate().then((est) => {
      this.models = Object.values(est.MODELS).map((m) => ({
        id: m.id,
        label: m.label,
        repo: m.repo,
        quant: m.quant,
        bytes: m.sizeBytes,
        arch: m.architecture,
        license: m.license,
      }));
      this.defaultModelId = this._defaultModelId(est);
    }).catch(() => { /* registry stays empty; status() still serves */ });

    // Real model facts recorded by the verified validation run (estimate.mjs);
    // used for reporting and as the checksum source when HF is unreachable.
    this.modelInfo = null; // { repo, quant, path, file, bytes, sha256, arch, license, validatedLive }
  }

  get enabled() {
    if (this.opt.upstreamBase) return true;
    if (this.opt.binPath && this.opt.modelPath) return true;
    // With autoprovisioning the runtime and the model are fetched on start.
    return this.opt.autoProvision;
  }

  status() {
    const base = {
      enabled: this.enabled,
      state: this.state,
      detail: this.detail,
      error: this.error,
      runtime_version: this.runtimeVersion,
      thinking: this.opt.thinking,
      context: this.opt.ctx,
      max_tokens: this.opt.maxTokens,
      timeout_ms: this.opt.timeoutMs,
      model: this.modelInfo,
      models: this.models,
      loaded_model: this.loadedModel,
      default_model: this.defaultModelId,
      pid: this.child ? this.child.pid : null,
      uptime_s: this.child && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      log_tail: this.logTail.slice(-12),
    };
    return { ...base, ...(this.opt.overrides.status || {}) };
  }

  // Starts the whole chain asynchronously. Never throws: failures land in
  // status() so the rest of the site is unaffected.
  start() {
    if (!this.enabled || this.startPromise) return this.startPromise || Promise.resolve();
    this.startPromise = this._run(this.pendingModelId)
      .catch((err) => {
        this._fail('MODEL_CHAT_FAILED', err && err.message ? err.message : String(err));
      })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  // One bounded self-heal attempt after a failure (for example a transient
  // network error during provisioning). Re-runs the whole chain; already
  // finished work is reused - the extracted runtime and the checksum-verified
  // model copy are detected on disk, so a retry never repeats what succeeded.
  // Returns true when a restart was started, false when refused (not failed,
  // still running, or inside the cooldown window).
  retry() {
    if (this.state !== 'error' || !this.enabled || this.startPromise) return false;
    if (this.failedAt && Date.now() - this.failedAt < RETRY_COOLDOWN_MS) return false;
    this.error = null;
    this.state = 'validating';
    this.detail = 'Restarting the model runtime after the previous failure.';
    this.start();
    return true;
  }

  // Default registry id: CHAT_DEFAULT_MODEL, else the env-configured repo if
  // it matches a verified entry, else the registry default. 'custom' covers
  // deployments that point HF_REPO at a repo outside the registry.
  _defaultModelId(est) {
    if (this.opt.defaultModel && est.modelById(this.opt.defaultModel)) return this.opt.defaultModel;
    if (this.opt.repoExplicit) {
      const match = Object.values(est.MODELS).find((m) => m.repo === this.opt.hfRepo && m.quant === this.opt.quant);
      if (match) return match.id;
      return 'custom';
    }
    return est.DEFAULT_MODEL_ID;
  }

  // Maps a requested model id (or null for "default / last wanted") onto a
  // verified registry entry. Unknown ids are a client error (400).
  async _resolveModel(id) {
    const est = await loadEstimate();
    const want = id === undefined || id === null || id === ''
      ? (this.pendingModelId || this._defaultModelId(est))
      : String(id);
    const entry = est.modelById(want);
    if (entry) return entry;
    if (want === 'custom' && this.opt.repoExplicit) {
      // Legacy single-model deployment with its own HF_REPO: keep it working.
      return {
        id: 'custom',
        label: `${this.opt.hfRepo} ${this.opt.quant}`,
        repo: this.opt.hfRepo,
        quant: this.opt.quant,
        path: null,
        sizeBytes: est.MODEL.sizeBytes,
        sha256: null,
        architecture: null,
        license: null,
        geometry: est.GEOMETRY,
        custom: true,
      };
    }
    throw new AppError(400, 'BAD_MODEL', `unknown model "${want}". Available models: ${Object.keys(est.MODELS).join(', ')}.`);
  }

  // Selects the model the NEXT generations run on. If a different model is
  // already loaded and healthy this is a no-op; otherwise the runtime
  // hot-swaps: unload the current model, wait for its RAM to actually come
  // back, then provision (usually a no-op: both models stay cached) and load
  // the requested one. Serialized so two concurrent selections cannot
  // double-spawn llama-server.
  async select(modelId) {
    const entry = await this._resolveModel(modelId);
    if (this.opt.upstreamBase) {
      // An external runtime manages its own model set: record the choice,
      // keep serving. Tests and worker deployments use this mode.
      this.pendingModelId = entry.id;
      this.loadedModel = entry.id;
      this.modelInfo = this._modelInfoFromEntry(entry, false);
      return entry;
    }
    if (this.state === 'ready' && this.loadedModel === entry.id && !this.startPromise) return entry;
    const prev = this._switchChain;
    let release;
    this._switchChain = new Promise((r) => { release = r; });
    await prev;
    try {
      if (this.state === 'ready' && this.loadedModel === entry.id && !this.startPromise) return entry;
      if (this.startPromise) await this.startPromise.catch(() => {});
      if (this.state === 'ready' && this.loadedModel === entry.id) return entry;
      this.pendingModelId = entry.id;
      await this._switchTo(entry);
      if (this.state !== 'ready') {
        const err = this.error || {};
        throw new AppError(503, err.code || 'MODEL_NOT_READY', err.message || this.detail || 'the model did not become ready');
      }
      return entry;
    } finally {
      release();
    }
  }

  // Hot-swap body: stop the loaded model, wait for its RAM, then run the
  // normal provisioning + health chain for the new entry.
  async _switchTo(entry) {
    this.state = 'loading';
    this.detail = `Switching to ${entry.label}. Unloading the loaded model first.`;
    console.log(`[model-chat] switching to ${entry.id}`);
    this.stop();
    if (!(await this._awaitMemoryFree(entry))) return; // _fail already recorded
    this.startPromise = this._run(entry.id).catch((err) => {
      this._fail('MODEL_CHAT_FAILED', err && err.message ? err.message : String(err));
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  // After stopping a model the RAM is not free instantly (llama-server is
  // still exiting). Poll MemAvailable until the next model fits, or fail with
  // the same actionable memory message the workflows use.
  async _awaitMemoryFree(entry, timeoutMs = 45000) {
    const est = this.est || (await loadEstimate());
    const required = est.requiredBytesForModel(entry, this.opt.ctx, entry.sizeBytes);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let available = Number.NaN;
      try { available = est.memAvailableBytes(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { return true; }
      if (!Number.isFinite(available) || available >= required) return true;
      if (Date.now() >= deadline) {
        this._fail('MODEL_LOW_MEMORY', est.actionableMemoryMessage(required, available, this.opt.ctx));
        return false;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async _run(modelId) {
    const est = await loadEstimate();
    this.est = est;

    const entry = await this._resolveModel(modelId);
    this.pendingModelId = entry.id;

    if (this.opt.upstreamBase) {
      // External runtime: assume it is already serving.
      this.state = 'ready';
      this.detail = 'Using an existing llama-server endpoint.';
      this.loadedModel = entry.id;
      this.modelInfo = this._modelInfoFromEntry(entry, false);
      return;
    }

    this.state = 'validating';
    this.detail = `Checking the runtime and ${entry.label} model files.`;

    let binPath = this.opt.binPath;
    let modelPath = this.opt.modelPath;

    if (!binPath || !isExecutable(binPath)) {
      if (!this.opt.autoProvision) {
        this._fail('MODEL_RUNTIME_MISSING', `llama-server not found at "${binPath || '(unset)'}". Set LLAMA_SERVER_BIN or enable CHAT_AUTOPROVISION=1.`);
        return;
      }
      binPath = await this._provisionRuntime();
      if (!binPath) return; // _provisionRuntime set the error state
    }

    let bytes = 0;
    if (!modelPath || !fs.existsSync(modelPath)) {
      if (!this.opt.autoProvision) {
        this._fail('MODEL_FILE_MISSING', `model file not found at "${modelPath || '(unset)'}". Set MODEL_GGUF_PATH or enable CHAT_AUTOPROVISION=1.`);
        return;
      }
      const fetched = await this._provisionModel(entry);
      if (!fetched) return;
      modelPath = fetched.path;
      bytes = fetched.bytes;
    }
    if (!bytes) {
      try { bytes = fs.statSync(modelPath).size; } catch { bytes = 0; }
    }

    // Report the model facts for directly configured files too (provisioning
    // fills this from the live HF validation instead).
    if (!this.modelInfo || this.modelInfo.repo !== entry.repo || this.modelInfo.quant !== entry.quant) {
      this.modelInfo = {
        repo: entry.repo,
        quant: entry.quant,
        path: modelPath,
        file: path.basename(modelPath),
        bytes,
        sha256: entry.sha256,
        arch: entry.architecture,
        license: entry.license,
        validated_live: false,
      };
    }
    if (!this.runtimeVersion && binPath) {
      this.runtimeVersion = await this._binaryVersion(binPath);
    }

    // Memory gate, measured like the workflows do - never assumed, and using
    // the selected model's own geometry.
    this.state = 'checking-memory';
    this.detail = `Checking free memory for ${entry.label} at context ${this.opt.ctx}.`;
    const required = est.requiredBytesForModel(entry, this.opt.ctx, bytes || entry.sizeBytes);
    let available = Number.NaN;
    try { available = est.memAvailableBytes(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { /* non-Linux */ }
    if (Number.isFinite(available) && available < required) {
      this._fail(
        'MODEL_LOW_MEMORY',
        est.actionableMemoryMessage(required, available, this.opt.ctx),
      );
      return;
    }

    await this._spawnServer(binPath, modelPath);
  }

  _modelInfoFromEntry(entry, validatedLive) {
    return {
      repo: entry.repo,
      quant: entry.quant,
      path: entry.path,
      file: path.basename(entry.path || ''),
      bytes: entry.sizeBytes,
      sha256: entry.sha256,
      arch: entry.architecture,
      license: entry.license,
      validated_live: validatedLive,
    };
  }

  _fail(code, message) {
    this.state = 'error';
    this.error = { code, message: String(message).slice(0, 2000) };
    this.failedAt = Date.now();
    this.detail = `Model chat failed: ${code}.`;
    console.error(`[model-chat] ${code}: ${String(message).slice(0, 300)}`);
  }

  _log(line) {
    this.logTail.push(String(line).slice(0, 300));
    if (this.logTail.length > DEFAULTS.logLines) this.logTail.shift();
  }

  // Runs a helper command. Shell scripts (*.sh) are interpreted with bash;
  // anything else is an executable program and is spawned directly. Wrapping a
  // binary like "/usr/bin/env curl ..." in bash makes bash read the ELF binary
  // as a script, which fails with "cannot execute binary file" (exit 126).
  _runScript(script, args, env, phase) {
    return new Promise((resolve, reject) => {
      const isShellScript = script.endsWith('.sh');
      const cmd = isShellScript ? 'bash' : script;
      const argv = isShellScript ? [script, ...args] : args.slice();
      const display = isShellScript ? path.basename(script) : `${script} ${args[0] || ''}`.trim();
      const child = spawn(cmd, argv, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const collect = (stream) => {
        let buffered = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buffered += chunk;
          for (const line of chunk.split('\n')) if (line.trim()) this._log(`[${phase}] ${line.trim()}`);
          out += chunk;
          if (out.length > 1024 * 1024) out = out.slice(-512 * 1024);
        });
        stream.on('end', () => {
          if (buffered && !buffered.endsWith('\n')) { /* nothing; out already has it */ }
        });
      };
      collect(child.stdout);
      collect(child.stderr);
      child.on('error', (err) => reject(new Error(`${phase}: could not run ${display}: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`${phase}: ${display} exited with code ${code}. Last output: ${out.slice(-600).trim()}`));
      });
    });
  }

  parseKeyValues(text) {
    const map = {};
    for (const line of String(text).split('\n')) {
      const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) map[m[1]] = m[2];
    }
    return map;
  }

  async _provisionRuntime() {
    this.state = 'provisioning-runtime';
    const dir = process.env.RUNNER_TEMP || os.tmpdir();
    const marker = path.join(dir, `llama-${this.opt.llamaRef}-chat`);
    fs.mkdirSync(marker, { recursive: true });
    const existing = this._findBinary(marker, 'llama-server');
    if (existing) {
      this.detail = `llama.cpp runtime found at ${existing}.`;
      this.runtimeVersion = await this._binaryVersion(existing);
      return existing;
    }
    this.detail = `Downloading the llama.cpp ${this.opt.llamaRef} runtime (about 40 MB).`;
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${this.opt.llamaRef}/llama-${this.opt.llamaRef}-bin-ubuntu-x64.tar.gz`;
    const tgz = path.join(marker, 'runtime.tar.gz');
    await this._runScript('/usr/bin/env', ['curl', '-fL', '--retry', '3', '--retry-delay', '5', '--connect-timeout', '30', '-o', tgz, url], {}, 'runtime');
    await this._runScript('/usr/bin/env', ['tar', '-xzf', tgz, '-C', marker], {}, 'runtime');
    try { fs.unlinkSync(tgz); } catch { /* best effort */ }
    const bin = this._findBinary(marker, 'llama-server');
    if (!bin) {
      this._fail('MODEL_RUNTIME_MISSING', `llama-server was not in the ${this.opt.llamaRef} archive. Check model-build.yml output.`);
      return null;
    }
    this.runtimeVersion = await this._binaryVersion(bin);
    return bin;
  }

  _findBinary(dir, name) {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === name && isExecutable(full)) return full;
      }
    }
    return null;
  }

  _binaryVersion(bin) {
    return new Promise((resolve) => {
      let out = '';
      const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve((out.split('\n')[0] || '').trim() || null));
    });
  }

  async _provisionModel(entry) {
    this.state = 'provisioning-model';
    this.detail = `Fetching ${entry.label} (resumable, checksum verified).`;
    const destDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'model-cache');
    fs.mkdirSync(destDir, { recursive: true });

    // Live validation first: the repository may have changed or gone away.
    let meta = null;
    try {
      const out = await this._runScript(
        path.join(__dirname, '..', 'scripts', 'model', 'validate-model.sh'),
        [],
        { HF_REPO: entry.repo, QUANT: entry.quant },
        'validate',
      );
      const kv = this.parseKeyValues(out);
      if (kv.download_url && kv.gguf_sha256) meta = kv;
    } catch (err) {
      this._log(`[validate] live validation failed: ${err.message}`);
    }

    const est = this.est;
    const localPath = path.join(destDir, path.basename((meta && meta.gguf_file) || entry.path || 'unknown.gguf'));
    let sha = meta ? meta.gguf_sha256 : entry.sha256;
    let bytes = meta ? Number(meta.gguf_size_bytes) : entry.sizeBytes;

    if (fs.existsSync(localPath) && sha) {
      try {
        const { execFile } = require('node:child_process');
        const ok = await new Promise((resolve) => {
          execFile('sha256sum', [localPath], (err, stdout) =>
            resolve(!err && String(stdout).trim().startsWith(sha)),
          );
        });
        if (ok) {
          this.detail = `Verified ${entry.label} copy already on disk.`;
          this.modelInfo = this._infoFrom(meta, entry, localPath, bytes, Boolean(meta));
          return { path: localPath, bytes };
        }
        this._log('[download] local copy failed its checksum; re-downloading');
        fs.unlinkSync(localPath);
      } catch { /* fall through to download */ }
    }

    if (!meta) {
      // HF unreachable: fall back to the recorded verified metadata, but only
      // if a verified copy already exists (checked above) or the download can
      // still be checksum-verified against the recorded sha256. Entries with
      // no recorded checksum (custom HF_REPO) must never download blind.
      if (!entry.sha256) {
        this._fail('MODEL_VALIDATION_UNAVAILABLE', `Hugging Face validation failed for ${entry.repo} and no verified checksum is recorded for it; refusing to download unverified weights.`);
        return null;
      }
      sha = entry.sha256;
      bytes = entry.sizeBytes;
      this.detail = 'HF validation unavailable; using the recorded verified metadata for the download.';
    }

    this.detail = `Downloading ${path.basename(localPath)} (resumable, checksum verified).`;
    const out = await this._runScript(
      path.join(__dirname, '..', 'scripts', 'model', 'download-model.sh'),
      [],
      {
        DOWNLOAD_URL: meta ? meta.download_url : `https://huggingface.co/${entry.repo}/resolve/main/${entry.path}`,
        DEST_DIR: destDir,
        EXPECTED_SHA256: sha,
        EXPECTED_SIZE: String(bytes),
      },
      'download',
    );
    const kv = this.parseKeyValues(out);
    const finalPath = kv.model_path || localPath;
    if (!fs.existsSync(finalPath)) {
      this._fail('MODEL_FILE_MISSING', 'the model download finished without producing a file');
      return null;
    }
    this.modelInfo = this._infoFrom(meta, entry, finalPath, bytes, Boolean(meta));
    return { path: finalPath, bytes };
  }

  _infoFrom(meta, entry, localPath, bytes, validatedLive) {
    return {
      repo: (meta && meta.hf_repo) || entry.repo,
      quant: (meta && meta.quant) || entry.quant,
      path: (meta && meta.gguf_file) || entry.path,
      file: path.basename(localPath),
      bytes: bytes || 0,
      sha256: (meta && meta.gguf_sha256) || entry.sha256,
      arch: (meta && meta.gguf_arch) || entry.architecture,
      license: (meta && meta.gguf_license) || entry.license,
      validated_live: validatedLive,
    };
  }

  _spawnServer(binPath, modelPath) {
    return this._serverFlags(binPath).then((flags) => this._spawnServerWithFlags(binPath, modelPath, flags));
  }

  // llama-server flags that depend on the build. Probed once through --help so
  // an older binary never dies on an unknown flag.
  _serverFlags(binPath) {
    if (!this._flagsProbe) {
      this._flagsProbe = new Promise((resolve) => {
        let out = '';
        const child = spawn(binPath, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(out));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10000);
      });
    }
    return this._flagsProbe.then((help) => {
      if (this.opt.thinking) return [];
      if (help.includes('--jinja') && help.includes('--reasoning-budget')) {
        return ['--jinja', '--reasoning-budget', '0'];
      }
      return [];
    });
  }

  _spawnServerWithFlags(binPath, modelPath, extraFlags) {
    return new Promise((resolve) => {
      this.state = 'loading';
      this.detail = 'Starting llama-server and loading the model into memory.';
      const args = [
        '-m', modelPath,
        '-c', String(this.opt.ctx),
        '-t', String(this.opt.threads),
        ...extraFlags,
        '--host', '127.0.0.1',
        '--port', String(this.opt.port),
      ];
      const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.startedAt = Date.now();
      this.binPath = binPath;
      this.modelPath = modelPath;
      const watch = (stream) => {
        stream.setEncoding('utf8');
        let rest = '';
        stream.on('data', (chunk) => {
          rest += chunk;
          const lines = rest.split('\n');
          rest = lines.pop();
          for (const line of lines) if (line.trim()) this._log(line.trim());
        });
        stream.on('end', () => { if (rest.trim()) this._log(rest.trim()); });
      };
      watch(child.stdout);
      watch(child.stderr);

      let settled = false;
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        this._fail('MODEL_RUNTIME_FAILED', `llama-server could not start: ${err.message}`);
        resolve();
      });
      child.on('close', (code, signal) => {
        this.child = null;
        if (settled) return;
        settled = true;
        this._fail('MODEL_RUNTIME_EXITED', `llama-server exited early (code ${code}${signal ? `, signal ${signal}` : ''}). Check MODEL_LOW_MEMORY or a bad model file in the log tail.`);
        resolve();
      });

      // Poll /health until the model is loaded (or the process dies).
      const deadline = Date.now() + 15 * 60 * 1000;
      const poll = async () => {
        while (!settled && Date.now() < deadline) {
          const health = await this._health();
          if (health === 'ok') {
            settled = true;
            this.state = 'ready';
            this.loadedModel = this.pendingModelId || this.loadedModel;
            this.detail = 'Model loaded. Chat is ready.';
            console.log(`[model-chat] ready on 127.0.0.1:${this.opt.port} (pid ${child.pid})`);
            resolve();
            return;
          }
          await new Promise((r) => setTimeout(r, health === 'loading' ? 1500 : 3000));
        }
        if (!settled) {
          settled = true;
          this._fail('MODEL_LOAD_TIMEOUT', 'llama-server did not become healthy within 15 minutes.');
          child.kill('SIGKILL');
          resolve();
        }
      };
      poll();
    });
  }

  _health() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.opt.port, path: '/health', timeout: 4000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200 ? 'ok' : 'loading');
        },
      );
      req.on('timeout', () => { req.destroy(); resolve('loading'); });
      req.on('error', () => resolve('starting'));
    });
  }

  stop() {
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
      const child = this.child;
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
      this.child = null;
    }
  }

  // One generation against llama-server's /v1/chat/completions.
  // messages: [{ role: 'user'|'assistant'|'system', content }, ...]
  // onDelta: optional ({ content, reasoning }) callback for streamed tokens.
  async generate({ messages, maxTokens, signal, onDelta, temperature = 0.7 } = {}) {
    if (this.state !== 'ready') {
      throw new AppError(
        503,
        this.state === 'error' ? (this.error && this.error.code) || 'MODEL_NOT_READY' : 'MODEL_NOT_READY',
        this.detail || 'the model is not ready',
      );
    }
    const est = await loadEstimate();
    const valid = est.validateInputs({ prompt: messages.length ? messages[messages.length - 1].content : '', context_length: this.opt.ctx, max_tokens: maxTokens });
    if (!valid.ok) {
      const e = valid.errors[0];
      throw new AppError(400, e.code, e.message);
    }
    const capped = Math.min(valid.maxTokens, this.opt.maxTokens);
    const payload = {
      messages,
      max_tokens: capped,
      temperature,
      stream: Boolean(onDelta),
      cache_prompt: true,
    };
    if (!this.opt.thinking) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }
    const body = JSON.stringify(payload);
    const started = Date.now();
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.opt.timeoutMs);
    this.abortControllers.add(controller);
    try {
      if (onDelta) return await this._generateStream(body, controller, onDelta, started, capped);
      return await this._generateOnce(body, controller, started, capped);
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new AppError(504, 'GENERATION_TIMEOUT', `generation exceeded the ${Math.round(this.opt.timeoutMs / 1000)} s limit and was cancelled`);
      }
      if (signal?.aborted) {
        throw new AppError(499, 'GENERATION_CANCELLED', 'generation was cancelled');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.abortControllers.delete(controller);
    }
  }

  _upstreamRequest(body, controller) {
    const base = this.opt.upstreamBase || `http://127.0.0.1:${this.opt.port}`;
    const url = new URL('/v1/chat/completions', base);
    return fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  }

  _bodyWithoutTemplateKwargs(body) {
    // `body` is the JSON-stringified payload; strip the kwarg from the object
    // and re-stringify so the retry request is truly kwarg-free.
    let obj = body;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch { return null; }
    }
    if (!obj || typeof obj !== 'object' || !obj.chat_template_kwargs) return null;
    const { chat_template_kwargs, ...rest } = obj;
    return JSON.stringify(rest);
  }

  async _generateOnce(body, controller, started, capped, retried) {
    let res;
    try {
      res = await this._upstreamRequest(body, controller);
    } catch (err) {
      if (controller.signal.aborted) throw err;
      throw new AppError(503, 'MODEL_NOT_RUNNING', 'could not reach llama-server; the model runtime is not running');
    }
    const raw = await res.text();
    if (!res.ok) {
      const retryBody = retried ? null : this._bodyWithoutTemplateKwargs(body);
      if (retryBody && /chat_template_kwargs|enable_thinking/i.test(raw)) {
        // This build/template rejects the kwarg: degrade gracefully once.
        return this._generateOnce(retryBody, controller, started, capped, true);
      }
      throw new AppError(502, 'MODEL_UPSTREAM_ERROR', `llama-server returned ${res.status}: ${raw.slice(0, 300)}`);
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new AppError(502, 'MODEL_UPSTREAM_ERROR', 'llama-server sent a non-JSON response');
    }
    const message = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message
      : { content: '' };
    const split = splitThinkFromText(String(message.content || ''));
    return this._result(split.text, split.reasoning || message.reasoning_content || '', started, capped, data.usage);
  }

  async _generateStream(body, controller, onDelta, started, capped, retried) {
    let res;
    try {
      res = await this._upstreamRequest(body, controller);
    } catch (err) {
      if (controller.signal.aborted) throw err;
      throw new AppError(503, 'MODEL_NOT_RUNNING', 'could not reach llama-server; the model runtime is not running');
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const retryBody = retried ? null : this._bodyWithoutTemplateKwargs(body);
      if (retryBody && /chat_template_kwargs|enable_thinking/i.test(raw)) {
        return this._generateStream(retryBody, controller, onDelta, started, capped, true);
      }
      throw new AppError(502, 'MODEL_UPSTREAM_ERROR', `llama-server returned ${res.status}: ${raw.slice(0, 300)}`);
    }
    const splitter = new ThinkSplitter();
    let text = '';
    let reasoning = '';
    let usage = null;
    const decoder = new TextDecoder();
    let buffer = '';
    const finish = () => {
      const tail = splitter.flush();
      if (tail.content) text += tail.content;
      if (tail.reasoning) reasoning += tail.reasoning;
    };

    const onChunk = (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onDelta({ content: '', reasoning: delta.reasoning_content });
        }
        if (delta.content) {
          const pieces = splitter.feed(delta.content);
          if (pieces.content) text += pieces.content;
          if (pieces.reasoning) reasoning += pieces.reasoning;
          if (pieces.content || pieces.reasoning) {
            onDelta({ content: pieces.content || '', reasoning: pieces.reasoning || '' });
          }
        }
      }
    };

    try {
      for await (const chunk of res.body) onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } finally {
      finish();
    }
    return this._result(text.trim(), reasoning.trim(), started, capped, usage);
  }

  _result(text, reasoning, started, capped, usage) {
    return {
      text,
      reasoning: reasoning || '',
      elapsed_ms: Date.now() - started,
      max_tokens: capped,
      tokens: usage && Number.isInteger(usage.completion_tokens) ? { completion: usage.completion_tokens, prompt: usage.prompt_tokens ?? null } : null,
    };
  }
}

module.exports = { ModelChat, ThinkSplitter, splitThinkFromText };
