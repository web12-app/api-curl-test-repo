#!/usr/bin/env bash
# Run REAL local inference with llama.cpp against a GGUF file.
# Streams generated tokens into the log while running, enforces a timeout,
# and writes a structured result JSON. Never fabricates a successful result.
#
# Usage:
#   run-inference.sh --model FILE --llama-bin FILE [--prompt-file FILE | --prompt TEXT]
#                    [--ctx 1024] [--max-tokens 256] [--timeout 900] [--threads N]
#                    [--out result.json] [--model-repo ...] [--model-file-name ...]
#
# Exit codes: 0 success | 3 input validation | 4 runtime failure | 5 timeout | 1 usage

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="" ; LLAMA_BIN="" ; PROMPT="" ; PROMPT_FILE=""
CTX="1024" ; MAX_TOKENS="256" ; TIMEOUT="900" ; THREADS=""
OUT_JSON="result.json" ; MODEL_REPO="" ; MODEL_FILE_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}" ; shift 2 ;;
    --llama-bin) LLAMA_BIN="${2:-}" ; shift 2 ;;
    --prompt) PROMPT="${2:-}" ; shift 2 ;;
    --prompt-file) PROMPT_FILE="${2:-}" ; shift 2 ;;
    --ctx) CTX="${2:-1024}" ; shift 2 ;;
    --max-tokens) MAX_TOKENS="${2:-256}" ; shift 2 ;;
    --timeout) TIMEOUT="${2:-900}" ; shift 2 ;;
    --threads) THREADS="${2:-}" ; shift 2 ;;
    --out) OUT_JSON="${2:-result.json}" ; shift 2 ;;
    --model-repo) MODEL_REPO="${2:-}" ; shift 2 ;;
    --model-file-name) MODEL_FILE_NAME="${2:-}" ; shift 2 ;;
    *) echo "FAIL: unknown option $1" >&2 ; exit 1 ;;
  esac
done

[ -n "$MODEL" ] || { echo "FAIL: --model is required" >&2 ; exit 1 ; }
[ -n "$LLAMA_BIN" ] || { echo "FAIL: --llama-bin is required" >&2 ; exit 1 ; }

write_result() { # INFER_RC RESPONSE_TEXT ERR_TAIL
  MODEL_REPO="$MODEL_REPO" MODEL_FILE_NAME="$MODEL_FILE_NAME" \
  RUNTIME_VERSION="${RUNTIME_VERSION:-}" ELAPSED_MS="${ELAPSED_MS:-0}" \
  PROMPT_CHARS="${PROMPT_CHARS:-0}" CTX="$CTX" MAX_TOKENS="$MAX_TOKENS" \
  TIMEOUT_S="$TIMEOUT" OUT_JSON="$OUT_JSON" \
  INFER_RC="${1:-0}" RESPONSE_TEXT="${2:-}" ERR_TAIL="${3:-}" \
  node -e '
    const fs = require("fs");
    const rc = Number(process.env.INFER_RC);
    let status = "success", code = null, message = null;
    if (rc === 124 || rc === 130 || rc === 137) {
      status = "timeout"; code = "GENERATION_TIMEOUT";
      message = "generation exceeded the " + process.env.TIMEOUT_S + " second limit and was cancelled";
    } else if (rc !== 0) {
      status = "error"; code = "RUNTIME_EXIT_" + rc;
      message = (process.env.ERR_TAIL || "runtime exited with code " + rc).slice(0, 1200);
    }
    const resp = (process.env.RESPONSE_TEXT || "").trim();
    const result = {
      status, code, message,
      model_repo: process.env.MODEL_REPO || null,
      model_file: process.env.MODEL_FILE_NAME || null,
      runtime_version: process.env.RUNTIME_VERSION || null,
      elapsed_ms: Number(process.env.ELAPSED_MS),
      prompt_chars: Number(process.env.PROMPT_CHARS),
      context: Number(process.env.CTX),
      max_tokens: Number(process.env.MAX_TOKENS),
      response: status === "success" ? resp : null,
      response_chars: resp.length,
      error: status === "success" ? null : { code, message },
    };
    fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(result, null, 2) + "\n");
    console.log("result: " + JSON.stringify({ status, code, elapsed_ms: result.elapsed_ms, response_chars: result.response_chars }));
  '
}

[ -f "$MODEL" ] || { write_result 4 "" "model file not found: ${MODEL}" ; echo "FAIL[MODEL_FILE_MISSING]: ${MODEL}" >&2 ; exit 4 ; }
[ -x "$LLAMA_BIN" ] || { write_result 4 "" "runtime not executable: ${LLAMA_BIN}" ; echo "FAIL[RUNTIME_NOT_EXECUTABLE]: ${LLAMA_BIN}" >&2 ; exit 4 ; }

# Input validation happens before anything expensive runs.
if [ -n "$PROMPT_FILE" ]; then
  [ -f "$PROMPT_FILE" ] || { write_result 3 "" "prompt file not found: ${PROMPT_FILE}" ; echo "FAIL[PROMPT_FILE_MISSING]" >&2 ; exit 3 ; }
  PROMPT="$(cat "$PROMPT_FILE")"
fi
PROMPT_CHARS="${#PROMPT}"
VALID="$(node "${SCRIPT_DIR}/estimate.mjs" validate-inputs --prompt-chars "$PROMPT_CHARS" --ctx "$CTX" --max-tokens "$MAX_TOKENS")" ; VRC=$?
if [ "$VRC" -ne 0 ]; then
  CODE="$(echo "$VALID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["errors"][0]["code"])' 2>/dev/null || echo INVALID_INPUT)"
  MSG="$(echo "$VALID" | python3 -c 'import json,sys;print("; ".join(e["message"] for e in json.load(sys.stdin)["errors"]))' 2>/dev/null || echo "invalid inputs")"
  write_result "$VRC" "" "${CODE}: ${MSG}"
  echo "FAIL[INVALID_INPUT]: ${CODE}: ${MSG}" >&2
  exit 3
fi
CTX="$(echo "$VALID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["context"])')"
MAX_TOKENS="$(echo "$VALID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["maxTokens"])')"

[ -n "$THREADS" ] || THREADS="$(nproc 2>/dev/null || echo 2)"

# Prompt goes through a file (never argv): avoids ARG_MAX limits and ps leaking.
TMP_PROMPT=0
if [ -z "$PROMPT_FILE" ]; then
  PROMPT_FILE="$(mktemp)"
  printf '%s' "$PROMPT" > "$PROMPT_FILE"
  TMP_PROMPT=1
fi
cleanup() { [ "$TMP_PROMPT" = 1 ] && rm -f "$PROMPT_FILE"; return 0; }
trap cleanup EXIT

RT_V="$(timeout 20 "$LLAMA_BIN" --version 2>/dev/null | head -1 || true)"
RUNTIME_VERSION="${RT_V:-unknown}"
OUT_LOG="$(mktemp)" ; ERR_LOG="$(mktemp)"
START_MS="$(date +%s%3N)"

echo "runtime: ${RUNTIME_VERSION}"
echo "model:   ${MODEL} (ctx ${CTX}, max_tokens ${MAX_TOKENS}, threads ${THREADS}, timeout ${TIMEOUT}s)"
echo "----- generated output (streaming) -----"

set +e
# llama.cpp prints generated tokens to stdout as they are produced; tee keeps
# the stream visible in the job log while capturing it for the result.
# `-no-cnv` + `--no-display-prompt` keep stdout = model response only.
timeout --signal=INT --kill-after=15 "$TIMEOUT" "$LLAMA_BIN" \
  -m "$MODEL" -f "$PROMPT_FILE" -c "$CTX" -n "$MAX_TOKENS" -t "$THREADS" \
  --temp 0.7 --no-display-prompt -no-cnv --no-warmup --simple-io \
  2> "$ERR_LOG" | tee "$OUT_LOG"
RC=${PIPESTATUS[0]}

# Flag-compatibility shim: builds that dropped/renamed a flag get one retry.
if [ "$RC" -ne 0 ] && grep -qiE "invalid argument|unknown argument|unrecognized argument|error: invalid" "$ERR_LOG"; then
  echo "retrying with a reduced flag set (flag compatibility shim)" >&2
  timeout --signal=INT --kill-after=15 "$TIMEOUT" "$LLAMA_BIN" \
    -m "$MODEL" -f "$PROMPT_FILE" -c "$CTX" -n "$MAX_TOKENS" -t "$THREADS" \
    --temp 0.7 --no-display-prompt \
    2> "$ERR_LOG" | tee "$OUT_LOG"
  RC=${PIPESTATUS[0]}
fi
set -e

END_MS="$(date +%s%3N)"
ELAPSED_MS=$((END_MS - START_MS))
RESPONSE_TEXT="$(cat "$OUT_LOG")"
ERR_TAIL="$(tail -c 1200 "$ERR_LOG" 2>/dev/null || true)"
rm -f "$OUT_LOG" "$ERR_LOG"

write_result "$RC" "$RESPONSE_TEXT" "$ERR_TAIL"

echo "----- end of output -----"
if [ "$RC" -eq 0 ]; then
  echo "OK: inference finished in ${ELAPSED_MS} ms"
  exit 0
elif [ "$RC" -eq 124 ] || [ "$RC" -eq 130 ] || [ "$RC" -eq 137 ]; then
  exit 5
else
  exit 4
fi
