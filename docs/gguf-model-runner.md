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
| `model-test.yml` | dispatch + `workflow_call` | test matrix incl. a REAL inference run (t7) |

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
