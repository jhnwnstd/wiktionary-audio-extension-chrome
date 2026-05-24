#!/usr/bin/env bash
# Build dist/wiktionary-audio-downloader-<version>.zip from src/.
#
# Unzipping yields a single folder (wiktionary-audio-downloader-<version>/)
# containing the extension root, so the user has one obvious thing to point
# chrome://extensions -> Load unpacked at. Version is read from package.json.
# globals.d.ts is excluded (TypeScript-only, ignored at runtime).
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME="wiktionary-audio-downloader-${VERSION}"
OUT="dist/${NAME}.zip"

rm -rf dist
mkdir -p "dist/${NAME}"

cp -r src/. "dist/${NAME}/"
rm -f "dist/${NAME}/globals.d.ts"

(cd dist && zip -qr "${NAME}.zip" "${NAME}")
rm -rf "dist/${NAME}"

echo "Built: ${OUT}"
echo "Size:  $(du -h "${OUT}" | cut -f1)"
echo "Files: $(unzip -l "${OUT}" | tail -1 | awk '{print $2}')"
