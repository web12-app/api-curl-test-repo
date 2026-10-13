# GGUF Model Runner

Run a real Hugging Face GGUF model on GitHub Actions runners (or on your own
persistent worker) - no external AI API, no mock responses.

## Verified model facts (checked live, never assumed)

Everything below was verified against the Hugging Face API and the GGUF file
header before implementation. `model-validate.yml` re-checks all of it on
every run.

| field | verified value |
|---|---|
| HF repository | `DevQuasar/Qwen.Qwen3.8-27B-GGUF` (public, not gated) |
| requested quantization | `Q2_K` (exists in the real file list) |
| GGUF file | `Q2_K/Qwen.Qwen3.8-27B.f16.gguf.Q2_K.gguf` |
| file size | `10,711,665,024` bytes (~9.98 GiB) |
| sha256 | `ac9c08aa74676ab698e054a4b945592550d7cfc321b16f15a4b2e0b5ee53121c` (HF tree API `lfs.oid`) |
| GGUF `general.architecture` | `qwen35` (read from the file header via range request) |
| GGUF `general.license` | `apache-2.0` (embedded in the file) |
| base model | `Qwen/Qwen3.8-27B` - `Qwen3_5ForConditionalGeneration`, Apache-2.0 |
| architecture shape | 64 layers, every 4th full attention (16), rest linear attention; 24 attn heads / 4 kv heads, head_dim 256; linear attention 16 key / 48 value heads of dim 128, ssm float32; vocab 248320 |
| runtime | llama.cpp **b11574** supports `LLM_ARCH_QWEN35` (`src/llama-arch.cpp`); CPU prebuilt `llama-b11574-bin-ubuntu-x64.tar.gz` |
| multimodal files | `mmproj-*.gguf` (vision projector, 927 MB) and `mtp-*.gguf` exist; this runner uses **text-only** inference from the main GGUF |

License note: the model is Apache-2.0 (both the base model and the GGUF
header). Commercial use and redistribution are permitted with the license
notice; the workflows never redistribute weights - they download from
Hugging Face at run time.

## Workflows

| workflow | trigger | purpose |
|---|---|---|
| `model-validate.yml` | dispatch + `workflow_call` | verify repo/file/arch/license, estimate RAM; outputs feed every other workflow |
| `model-download.yml` | dispatch + `workflow_call` (needs validate) | resumable, checksum-verified download; never commits weights |
| `model-build.yml` | dispatch + `workflow_call` | pinned prebuilt llama.cpp (default) or source build; versioned runtime artifact |
| `model-inference.yml` | dispatch + `workflow_call` | one job: fetch runtime → download model → memory gate → stream generation → publish `result.json` + artifact |
| `model-test.yml` | dispatch + `workflow_call` | test matrix incl. a REAL inference run (t7) and a REAL site-chat e2e (t8) |

### Run inference manually

Actions tab → **model-inference** → Run workflow → set `prompt`,
`context_length` (start at 1024), `max_tokens`. Or:

```bash
gh workflow run model-inference.yml \
  -f prompt="What is the capital of France? Answer with just the city name." \
  -f context_length=1024 -f max_tokens=48
```

Structured output: `result.json` (status, model repo/file, runtime version,
response, elapsed_ms, error) as a job output, a run summary and an artifact
(`inference-result-<run>`).

### Resource management

- Runner: `ubuntu-latest` = 4 vCPU / 16 GiB RAM / ~25 GiB free disk.
- The Q2_K file is ~9.98 GiB; estimated load footprint at ctx 1024 is ~12.9 GiB
  (weights ×1.04 + KV cache + linear-attention state + compute buffers + OS
  overhead - see `scripts/model/estimate.mjs` for the formula and the measured
  geometry it uses).
- `memory-check.sh` **measures** `MemAvailable` before loading and exits 42
  with concrete options (smaller context / smaller quant / your own worker)
  instead of letting the runner thrash.
- Start at ctx 1024; raise only after a successful run (KV cache scales
  linearly with context; only the 16 full-attention layers keep KV).
- The 10.7 GB file exceeds the 10 GiB `actions/cache` budget, so it is
  re-downloaded per run from the HF CDN (usually a few minutes, resumable)
  rather than cached. Smaller quants automatically qualify for caching.
- Never run a heavy model job and the live-tunnel workflow on assumptions of
  shared resources - each job gets its own VM; only the small runtime artifact
  (~20 MB) crosses jobs.

## Site chat interface (/chat)

The website itself can host the model: a signed-in user opens **Chat** in the
top navigation and talks to the same verified GGUF running on the server, via
`llama-server` (part of the pinned llama.cpp prebuilt). No external AI API is
involved, and no response is ever faked - if the runtime is not up, the API
says so.

### How it works

1. `src/model-chat.js` supervises a `llama-server` child process on
   `127.0.0.1` (never exposed directly) and is the only component that talks
   to it (`/v1/chat/completions`).
2. On boot it can **auto-provision**: validate the model live on Hugging Face
   (`validate-model.sh`), download it checksum-verified and resumable
   (`download-model.sh`, weights never enter git), fetch the pinned runtime,
   **measure `MemAvailable`** against the estimate, and only then start the
   server. Every phase is visible in `GET /api/chat/status`.
3. `POST /api/chat` creates an in-memory job; the client polls
   `GET /api/chat/jobs/:id` and sees partial text while the model writes
   (`<think>` blocks are split out into a collapsible "Model reasoning"
   section). `DELETE` cancels; a generation timeout (default 7 min) aborts.
4. Capacity: max 2 concurrent generations, max 2 per user (`429 MODEL_BUSY`).
   Messages ≤ 8 000 chars, last 16 exchanges sent as history. Jobs are
   per-user private, kept 30 minutes, never persisted.

### Enabling on the live tunnel

The tunnel stays fast by default. Chat is opt-in through a repository
variable:

1. Settings → Secrets and variables → Actions → **Variables** →
   `CHAT_MODEL_ENABLED = true`.
2. The next `live-tunnel` run boots the site as usual first (tunnel downtime
   unchanged), then downloads the runtime + model in the background (~10-15
   minutes on the runner's disk), and flips the chat to ready.
3. The runner has 16 GiB RAM; ctx 1024 needs ~12.1 GiB measured against
   `MemAvailable` before loading, so it fits with the site running alongside.
   If memory is short, the chat reports `MODEL_LOW_MEMORY` with options and
   the site keeps serving.

### Configuration (environment)

| variable | meaning | default |
|---|---|---|
| `LLAMA_SERVER_BIN` | path to `llama-server` | - (unset = chat disabled) |
| `MODEL_GGUF_PATH` | path to the .gguf file | - |
| `CHAT_AUTOPROVISION` | `1` fetch runtime+model when missing | `0` |
| `HF_REPO` / `MODEL_QUANT` / `LLAMA_REF` | provisioning source | verified Qwen Q2_K / b11574 |
| `MODEL_CTX` | context length (memory-gated) | `1024` |
| `MODEL_PORT` | loopback port for llama-server | `8190` |
| `MODEL_MAX_TOKENS` | per-request cap | `256` |
| `MODEL_TIMEOUT_MS` | generation timeout | `420000` |
| `MODEL_THINKING` | `1` keeps the Qwen3 `<think>` reasoning block before each answer | off (speed) |
| `MODEL_CACHE` | `off` disables the release cache for model weights | on when the data repo is configured |

Thinking is disabled by default: on the runner's CPU the reasoning block costs
about 80% of the generated tokens, so a simple "Hi" took ~35 s with thinking
and drops to single-digit seconds without it. The chat template is told via
`enable_thinking: false` (llama-server also gets `--jinja --reasoning-budget 0`
when its `--help` advertises them, probed per build). If a build rejects the
template kwarg, generation degrades gracefully to one retry without it.

### Release cache: download once, load fast forever

Every fresh CI runner used to re-download the GGUF from the Hugging Face CDN
(~10.7 GiB for the 27B model, several minutes at CDN speed). The release cache
removes that cost:

1. After a model is downloaded and checksum-verified, it is saved **once** as
   release assets in the private data repository (`src/model-cache.js`, in the
   background - the chat is never delayed by the upload).
2. The release is tagged `model-cache/<model-id>`; the GGUF is split into
   parts of at most 1.9 GiB (GitHub's 2 GiB asset ceiling), and the release
   body carries the metadata as JSON (`gguf_file`, `bytes`, `sha256`, part
   list, `status: publishing|published`).
3. On every later start the provisioning first checks the cache: a
   `published`, size-consistent entry is restored from the release (parts are
   appended as they arrive, so at most one part is ever staged on disk), and
   the reassembled file is **sha256-verified against the registry value** -
   a cache can never serve different bytes than the HF source.
4. Integrity or transfer problems degrade honestly: a sha256 mismatch deletes
   the cache entry and the start falls back to the normal HF download; a
   crashed publish (`status: publishing`) is ignored by lookups and replaced
   by the next publish; publishing failures never affect the running chat.

The cache is active whenever the data-repo credentials exist
(`GITHUB_TOKEN` + `PRIVATE_DATA_REPO`); `MODEL_CACHE=off` turns it off.
`GET /api/chat/status` reports it under `cache` (`enabled`, `publishing`).

### Chat API

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/chat/status` | - | `200`, runtime state + verified model facts | `401` |
| `POST /api/chat` | `{"message", "history?", "max_tokens?"}` | `202`, `data.id` + status | `400 EMPTY_PROMPT`/`PROMPT_TOO_LONG`/`BAD_HISTORY`/`BAD_MAX_TOKENS`, `401`, `429 MODEL_BUSY`, `503 MODEL_NOT_READY` |
| `GET /api/chat/jobs/:id` | - | `200`, `{status, partial, partial_reasoning, result, error}` (owner only) | `401`, `404` |
| `DELETE /api/chat/jobs/:id` | - | `200`, cancelled view | `401`, `404` |

Job `status`: `queued → running → done \| error \| cancelled \| timeout`.
`result` = `{text, reasoning, elapsed_ms, max_tokens, tokens}`. Error codes
include `GENERATION_TIMEOUT` (504), `GENERATION_CANCELLED`,
`MODEL_NOT_RUNNING`, `MODEL_UPSTREAM_ERROR`, `MODEL_LOW_MEMORY`.

Self-heal: when provisioning or the runtime fails, the chat stays in `error`
with the actionable reason and the rest of the site is unaffected. The next
`POST /api/chat` after a 60 s cooldown restarts the chain once per window
(`503 MODEL_RESTARTING`); finished steps are reused and partial model
downloads resume, so a retry never repeats work that already succeeded.

### Testing

- `test/model-chat.test.js` - generation, SSE reassembly, think-splitting,
  timeouts, cancellation against a stub llama-server speaking the real
  protocol.
- `test/chat-routes.test.js` - page, auth, CSRF, job lifecycle, ownership,
  busy limits through the real HTTP server.
- `model-test.yml` **t8-chat-e2e** - the full pipeline on a real runner with
  the real 10.7 GB Q2_K: provision → memory gate → load → prompt → reply;
  the job passes only when the model actually answers.

### Persistent worker (optional, for real speed)

GitHub-hosted runners are ephemeral. For a permanent server run
`scripts/model/worker-server.sh` on your own Linux box (24+ GiB RAM
recommended) behind TLS with API-key auth - full guide in
`docs/model-worker.md`. `model-inference.yml` accepts `worker_url`
(https only; token via the `WORKER_TOKEN` secret) and will send the prompt to
your worker instead of downloading the model.

### No secrets, no fabrication

- No Hugging Face token is needed (public repo); `WORKER_TOKEN` is a GitHub
  secret and never printed.
- Every failure path (missing file, bad checksum, low RAM, corrupt GGUF,
  timeout) exits non-zero with an actionable `FAIL:` message and writes
  `"status": "error"|"timeout"` to `result.json` - the workflows never fake a
  successful generation.
