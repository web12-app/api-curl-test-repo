#!/usr/bin/env bash
# Persistent worker: serve the GGUF model over llama.cpp's HTTP server on a
# machine YOU control (see docs/model-worker.md). Never bind this directly to
# the internet: put TLS + rate limiting in front (nginx/Caddy) and require the
# API key for every request.
#
# Usage:
#   API_KEY=... worker-server.sh --model FILE [--port 8081] [--host 127.0.0.1]
#                               [--ctx 4096] [--llama-bin llama-server] [--threads N]
#
# Env:
#   LLAMA_BIN   path to llama-server (default: llama-server on PATH)
#   MODEL       path to the GGUF file (or --model)
#   API_KEY     REQUIRED bearer token; refuse to start without one

set -euo pipefail

LLAMA_BIN="${LLAMA_BIN:-llama-server}"
MODEL="" ; PORT="8081" ; HOST="127.0.0.1" ; CTX="4096" ; THREADS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}" ; shift 2 ;;
    --port) PORT="${2:-8081}" ; shift 2 ;;
    --host) HOST="${2:-127.0.0.1}" ; shift 2 ;;
    --ctx) CTX="${2:-4096}" ; shift 2 ;;
    --threads) THREADS="${2:-}" ; shift 2 ;;
    *) echo "unknown option $1" >&2 ; exit 1 ;;
  esac
done

[ -n "$API_KEY" ] || { echo "REFUSING to start: API_KEY is required (never expose an unauthenticated inference port)" >&2 ; exit 1 ; }
[ ${#API_KEY} -ge 24 ] || { echo "REFUSING to start: API_KEY must be at least 24 characters" >&2 ; exit 1 ; }
[ -n "$MODEL" ] && [ -f "$MODEL" ] || { echo "model file required: --model FILE" >&2 ; exit 1 ; }
command -v "$LLAMA_BIN" >/dev/null 2>&1 || [ -x "$LLAMA_BIN" ] || { echo "llama-server not found: ${LLAMA_BIN}" >&2 ; exit 1 ; }
[ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ] || {
  echo "REFUSING to start: bind the server to localhost only; publish it through a TLS reverse proxy" >&2 ; exit 1 ;
}

[ -n "$THREADS" ] || THREADS="$(nproc 2>/dev/null || echo 2)"

echo "starting llama-server on ${HOST}:${PORT} (ctx ${CTX}, threads ${THREADS}) behind your TLS proxy"
exec "$LLAMA_BIN" \
  --model "$MODEL" \
  --host "$HOST" --port "$PORT" \
  --ctx-size "$CTX" --threads "$THREADS" \
  --api-key "$API_KEY" \
  --metrics-enabled
