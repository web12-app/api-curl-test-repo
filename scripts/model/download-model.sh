#!/usr/bin/env bash
# Download (and verify) a model file. Resumable; refuses to leave a corrupt file.
#
# Env / args:
#   DOWNLOAD_URL   (required) direct download URL
#   DEST_DIR       (default ${RUNNER_TEMP:-./model-cache}) download destination
#   EXPECTED_SHA256  when set, the file is verified after download
#   EXPECTED_SIZE    when set, checked before (disk) and after (size) download
#
# Notes:
#   - The file is downloaded OUTSIDE the git worktree (runner temp / model-cache),
#     so model weights can never be committed to Git.
#   - actions/cache has a 10 GiB per-repository limit, so files at ~10.7 GiB are
#     re-downloaded per run from the HF CDN instead of cached (fast; see docs).
# Exit codes: 0 ok, 1 failure with actionable message.

set -euo pipefail

DOWNLOAD_URL="${DOWNLOAD_URL:?DOWNLOAD_URL is required}"
DEST_DIR="${DEST_DIR:-${RUNNER_TEMP:-./model-cache}}"
EXPECTED_SHA256="${EXPECTED_SHA256:-}"
EXPECTED_SIZE="${EXPECTED_SIZE:-}"

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v curl >/dev/null || fail "curl is required"

FILE_NAME="$(basename "${DOWNLOAD_URL%%\?*}")"
TARGET="${DEST_DIR}/${FILE_NAME}"
mkdir -p "$DEST_DIR"

# Disk space check before touching the network.
if [ -n "$EXPECTED_SIZE" ]; then
  AVAIL_KB="$(df -Pk "$DEST_DIR" | awk 'NR==2 {print $4}')"
  AVAIL_BYTES=$((AVAIL_KB * 1024))
  NEED_BYTES=$((EXPECTED_SIZE + 536870912))  # + 512 MiB slack
  if [ "$AVAIL_BYTES" -lt "$NEED_BYTES" ]; then
    fail "not enough disk space in ${DEST_DIR}: need $((NEED_BYTES / 1073741824)) GiB, have $((AVAIL_BYTES / 1073741824)) GiB. Free space or use a smaller quantization."
  fi
fi

# Skip if a complete, verified copy already exists on disk.
if [ -f "$TARGET" ]; then
  if [ -n "$EXPECTED_SHA256" ]; then
    if echo "${EXPECTED_SHA256}  ${TARGET}" | sha256sum -c --status 2>/dev/null; then
      echo "OK: verified copy already present at ${TARGET} (skipping download)"
      echo "model_path=${TARGET}"
      exit 0
    fi
    echo "existing file failed checksum; re-downloading" >&2
    rm -f "$TARGET"
  fi
fi

echo "downloading ${DOWNLOAD_URL}"
RESUME=()
[ -f "${TARGET}.part" ] && RESUME=(-C -) && echo "resuming previous download (${EXPECTED_SIZE:+target $EXPECTED_SIZE bytes})"

for attempt in 1 2 3; do
  if curl -L "${RESUME[@]}" --fail --retry 2 --retry-delay 5 --connect-timeout 30 \
       -H 'User-Agent: model-runner/1' -o "${TARGET}.part" "${DOWNLOAD_URL}"; then
    break
  fi
  echo "download attempt ${attempt} failed" >&2
  [ "$attempt" = 3 ] && fail "download failed after 3 attempts (resumable: re-run this job and it continues from where it stopped)"
  RESUME=(-C -)
  sleep 10
done

# Size check.
if [ -n "$EXPECTED_SIZE" ]; then
  ACTUAL="$(stat -c %s "${TARGET}.part")"
  [ "$ACTUAL" = "$EXPECTED_SIZE" ] || fail "downloaded size ${ACTUAL} != expected ${EXPECTED_SIZE}; the transfer is incomplete (re-run to resume)"
fi

# Checksum verification (HF tree API publishes trustworthy sha256 for LFS files).
if [ -n "$EXPECTED_SHA256" ]; then
  echo "verifying sha256 ..."
  if ! echo "${EXPECTED_SHA256}  ${TARGET}.part" | sha256sum -c --status; then
    rm -f "${TARGET}.part"
    fail "sha256 mismatch - the downloaded file is corrupt; it was deleted, re-run to download again"
  fi
  echo "sha256 verified: ${EXPECTED_SHA256}"
fi

mv "${TARGET}.part" "$TARGET"
echo "model_path=${TARGET}"
echo "OK: $(stat -c %s "$TARGET") bytes at ${TARGET}"
