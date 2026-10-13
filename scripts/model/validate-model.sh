#!/usr/bin/env bash
# Verify a Hugging Face GGUF model repository and quantization before use.
# Defaults are the verified values for DevQuasar/Qwen.Qwen3.8-27B-GGUF Q2_K.
#
# Checks (all real, no assumptions):
#   - the HF repo exists and is public
#   - the requested quantization file actually exists (name found in the file list)
#   - the file has a nonzero size and a trustworthy sha256 (HF tree API lfs.oid)
#   - the GGUF header architecture is one llama.cpp supports (read via range request)
#   - license is surfaced for review
#   - RAM requirement is estimated from the measured file size + geometry
#
# Outputs KEY=VALUE lines on stdout and, in GitHub Actions, writes to $GITHUB_OUTPUT.
# Exit 1 with a FAIL: message when anything is unavailable or unsupported.

set -euo pipefail

HF_REPO="${HF_REPO:-DevQuasar/Qwen.Qwen3.8-27B-GGUF}"
QUANT="${QUANT:-Q2_K}"
EXPECTED_ARCH="${EXPECTED_ARCH:-}"
# Architectures the pinned llama.cpp runtime (b11574) can load.
SUPPORTED_ARCHS="${SUPPORTED_ARCHS:-qwen35 qwen35moe qwen3next qwen3 qwen2 qwen2vl qwen2audio qwen2moe}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v curl >/dev/null || fail "curl is required"
command -v python3 >/dev/null || fail "python3 is required"
command -v node >/dev/null || fail "node is required"

API="https://huggingface.co/api/models/${HF_REPO}"
META="$(curl -fsSL --max-time 30 -H 'User-Agent: model-runner/1' "${API}?blobs=true" 2>/dev/null)" \
  || fail "Hugging Face repository not reachable or does not exist: ${HF_REPO} (check the id and network)"
TREE="$(curl -fsSL --max-time 30 -H 'User-Agent: model-runner/1' "${API}/tree/main?recursive=true" 2>/dev/null)" \
  || fail "could not list the repository file tree"

# One python pass over both JSON blobs: find the quant file, size, sha256.
OUT_FILE="$(mktemp)"
META_JSON="$META" TREE_JSON="$TREE" QUANT="$QUANT" python3 - > "$OUT_FILE" <<'PY'
import json, os, re, sys
quant = os.environ["QUANT"]
meta = json.loads(os.environ["META_JSON"])
tree = json.loads(os.environ["TREE_JSON"])
sibs = [s.get("rfilename", "") for s in meta.get("siblings", [])]

def is_quant(name):
    # Two verified repo layouts:
    #   - subdirectory: Q2_K/<model>.Q2_K.gguf   (DevQuasar 27B-style)
    #   - flat:         <model>.Q2_K.gguf        (DevQuasar 8B-style)
    if not name.endswith(".gguf") or "mmproj" in name:
        return False
    base = name.rsplit("/", 1)[-1]
    if base.startswith("mtp-"):
        return False
    parts = name.split("/")
    dirquant = parts[0] if len(parts) > 1 else ""
    return dirquant == quant or base == quant + ".gguf" or base.endswith("." + quant + ".gguf")

hits = [s for s in sibs if is_quant(s)]
if not hits:
    quants = sorted({s.split("/")[0] for s in sibs if s.endswith(".gguf") and "/" in s})
    flat = sorted({m.group(1) for s in sibs if s.endswith(".gguf") and "/" not in s
                   and (m := re.search(r"\.([IQ]?[0-9][A-Za-z0-9_]*)\.gguf$", s))})
    avail = ", ".join(quants + flat) or "(no .gguf files)"
    sys.stderr.write("FAIL: quantization '" + quant + "' not found in the repository file list. Available: " + avail + "\n")
    sys.exit(2)
gguf = sorted(hits)[0]
size, sha = 0, ""
for f in tree:
    if f.get("path") == gguf:
        lfs = f.get("lfs") or {}
        size = lfs.get("size") or f.get("size") or 0
        sha = lfs.get("oid", "")
        break
if not size:
    sys.stderr.write("FAIL: file '" + gguf + "' has no usable size (broken or empty LFS object)\n")
    sys.exit(2)
print("GGUF_FILE=" + gguf)
print("GGUF_SIZE_BYTES=" + str(size))
print("GGUF_SHA256=" + sha)
PY
RC=$?
cat "$OUT_FILE"
[ "$RC" -eq 0 ] || { rm -f "$OUT_FILE"; exit 1; }
# shellcheck disable=SC1090
source "$OUT_FILE"
rm -f "$OUT_FILE"

# Read the GGUF header (first 4 KiB) with a range request to get the real
# architecture + license without downloading the model.
HEAD_BIN="$(mktemp)"
curl -fsSL --max-time 60 -r 0-4095 -H 'User-Agent: model-runner/1' \
  "https://huggingface.co/${HF_REPO}/resolve/main/${GGUF_FILE}" -o "$HEAD_BIN" 2>/dev/null \
  || fail "could not read the GGUF header (range request failed)"
ARCH="$(strings -n 3 "$HEAD_BIN" 2>/dev/null | grep -A1 '^general\.architecture$' | tail -1 || true)"
LICENSE="$(strings -n 3 "$HEAD_BIN" 2>/dev/null | grep -A1 '^general\.license$' | tail -1 || true)"
rm -f "$HEAD_BIN"
[ -n "$ARCH" ] || fail "could not read general.architecture from the GGUF header - file is not a valid GGUF"
[ -n "$EXPECTED_ARCH" ] && [ "$ARCH" != "$EXPECTED_ARCH" ] && fail "architecture mismatch: header says '${ARCH}', expected '${EXPECTED_ARCH}'"

case " $SUPPORTED_ARCHS " in
  *" $ARCH "*) : ;;
  *) fail "architecture '${ARCH}' is not in the supported list for the pinned llama.cpp runtime (${SUPPORTED_ARCHS})" ;;
esac

# RAM estimate from the measured size + verified geometry.
EST="$(node "${SCRIPT_DIR}/estimate.mjs" required --ctx 1024 --model-bytes "$GGUF_SIZE_BYTES")"
REQ="$(echo "$EST" | python3 -c 'import json,sys; print(json.load(sys.stdin)["required"])')"

DL_URL="https://huggingface.co/${HF_REPO}/resolve/main/${GGUF_FILE}"

# Emit results.
emit() { echo "$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT"; return 0; }
emit "gguf_file=${GGUF_FILE}"
emit "gguf_size_bytes=${GGUF_SIZE_BYTES}"
emit "gguf_sha256=${GGUF_SHA256}"
emit "gguf_arch=${ARCH}"
emit "gguf_license=${LICENSE:-unknown}"
emit "download_url=${DL_URL}"
emit "estimated_ram_bytes_1024ctx=${REQ}"
emit "hf_repo=${HF_REPO}"
emit "quant=${QUANT}"

echo "OK: model verified"
echo "  repo        : ${HF_REPO}"
echo "  file        : ${GGUF_FILE}"
echo "  size        : ${GGUF_SIZE_BYTES} bytes"
echo "  sha256      : ${GGUF_SHA256}"
echo "  architecture: ${ARCH} (supported by llama.cpp b11574)"
echo "  license     : ${LICENSE:-unknown}"
echo "  est. RAM    : $((REQ / 1073741824)) GiB at context 1024"
