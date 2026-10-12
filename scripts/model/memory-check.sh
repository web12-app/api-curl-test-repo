#!/usr/bin/env bash
# Memory gate: measure actual available RAM and compare with the estimate for
# (model size, context length). Measured, never assumed: reads /proc/meminfo.
#
# Env / args:
#   MODEL_BYTES   (or $1) size of the model file in bytes
#   CONTEXT       (or $2) context length planned for the run (default 1024)
#   FORCE_REQUIRED_BYTES  override the estimate (used by tests)
#
# Exit codes: 0 enough memory, 42 insufficient (actionable message), 1 usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_BYTES="${MODEL_BYTES:-${1:-}}"
CONTEXT="${CONTEXT:-${2:-1024}}"
FORCE_REQUIRED_BYTES="${FORCE_REQUIRED_BYTES:-}"

[ -n "$MODEL_BYTES" ] || { echo "FAIL: MODEL_BYTES (or \$1) is required" >&2; exit 1; }
command -v node >/dev/null || fail() { echo "FAIL: node is required" >&2; exit 1; }

EST="$(node "${SCRIPT_DIR}/estimate.mjs" required --ctx "$CONTEXT" --model-bytes "$MODEL_BYTES")"
REQUIRED="$(echo "$EST" | python3 -c 'import json,sys; print(json.load(sys.stdin)["required"])')"
[ -n "$FORCE_REQUIRED_BYTES" ] && REQUIRED="$FORCE_REQUIRED_BYTES"

AVAILABLE="$(node "${SCRIPT_DIR}/estimate.mjs" available)"
AVAIL="$(echo "$AVAILABLE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["available"])')"

python3 - "$REQUIRED" "$AVAIL" "$CONTEXT" <<'PY'
import json, subprocess, sys
req, avail, ctx = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
print(f"memory check: required ~{req/1073741824:.2f} GiB | MemAvailable {avail/1073741824:.2f} GiB | context {ctx}")
PY

if [ "$AVAIL" -lt "$REQUIRED" ]; then
  node "${SCRIPT_DIR}/estimate.mjs" required --ctx "$CONTEXT" --model-bytes "$MODEL_BYTES" >/dev/null
  # Print the actionable guidance and exit with the dedicated code.
  {
    echo "FAIL: not enough memory to load the model at context ${CONTEXT}."
    echo "Required ~$((REQUIRED / 1073741824)) GiB; MemAvailable $((AVAIL / 1073741824)) GiB."
    echo "Options:"
    echo "  1. Re-run with a smaller context_length."
    echo "  2. Use a smaller quantization."
    echo "  3. Run on a self-hosted worker with more RAM - see docs/model-worker.md."
  } >&2
  exit 42
fi

echo "OK: memory check passed"
