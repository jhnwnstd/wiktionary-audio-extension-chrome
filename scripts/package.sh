#!/usr/bin/env bash
# Build dist/wiktionary-audio-downloader-<version>.zip from src/.
#
# The zip is flat: unzipping yields the extension root directly, ready for
# chrome://extensions -> Load unpacked. Version is read from package.json.
# globals.d.ts is excluded (TypeScript-only, ignored at runtime).
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME="wiktionary-audio-downloader-${VERSION}"
OUT="dist/${NAME}.zip"

rm -rf dist
mkdir -p dist

# Zip contents of src/ (not src/ itself) so users get a flat layout.
(cd src && zip -qr "../${OUT}" . -x 'globals.d.ts')

echo "Built: ${OUT}"
echo "Size:  $(du -h "${OUT}" | cut -f1)"
echo "Files: $(unzip -l "${OUT}" | tail -1 | awk '{print $2}')"
