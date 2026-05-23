// Sync src/manifest.json's `version` field from package.json. Invoked by
// npm's `version` lifecycle script. Run `npm version minor` (etc.) and
// this keeps the Chrome extension manifest aligned with package.json
// without touching any other field or reformatting the file.

const fs = require('node:fs');
const path = require('node:path');

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const manifestPath = path.resolve(__dirname, '..', 'src', 'manifest.json');

const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const src = fs.readFileSync(manifestPath, 'utf8');
const next = src.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`);

if (next === src) {
  // Either the version was already correct, or the pattern didn't match.
  // Differentiate so a typo in the regex doesn't silently no-op.
  const m = src.match(/"version":\s*"([^"]+)"/);
  if (m && m[1] === version) {
    console.log(`manifest.json already at ${version}`);
  } else {
    console.error(`sync-manifest-version: pattern not found in ${manifestPath}`);
    process.exit(1);
  }
} else {
  fs.writeFileSync(manifestPath, next);
  console.log(`manifest.json -> ${version}`);
}
