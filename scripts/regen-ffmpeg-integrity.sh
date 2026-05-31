#!/usr/bin/env bash
# Recompute SHA-256 hashes of the vendored FFmpeg core and rewrite
# tests/fixtures/ffmpeg-integrity.json. Run this after replacing the
# files in src/vendor/ffmpeg/core/ with a new vendor drop.
set -euo pipefail

cd "$(dirname "$0")/.."

JS_HASH=$(sha256sum src/vendor/ffmpeg/core/ffmpeg-core.js | awk '{print $1}')
WASM_HASH=$(sha256sum src/vendor/ffmpeg/core/ffmpeg-core.wasm | awk '{print $1}')

cat > tests/fixtures/ffmpeg-integrity.json <<EOF
{
  "comment": "SHA-256 hashes of the vendored FFmpeg core. Verified by tests/unit/test.mjs and .github/workflows/ci.yml. Update via scripts/regen-ffmpeg-integrity.sh after vendoring a new core.",
  "algorithm": "sha256",
  "files": {
    "src/vendor/ffmpeg/core/ffmpeg-core.js": "${JS_HASH}",
    "src/vendor/ffmpeg/core/ffmpeg-core.wasm": "${WASM_HASH}"
  }
}
EOF

echo "Updated tests/fixtures/ffmpeg-integrity.json"
echo "  ffmpeg-core.js   ${JS_HASH}"
echo "  ffmpeg-core.wasm ${WASM_HASH}"
