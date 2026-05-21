// Test suite for Wiktionary Audio Extension
// Run: npm test

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}
function section(name) { console.log(name); }

// ============ Replicate extension logic for testing ============

const AUDIO_MIMES = new Set([
  'application/ogg',
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/wave',
  'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/opus',
  'video/ogg', 'video/webm'
]);
const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|webm|m4a|aac|flac)$/i;

function isAudioFile(filename, mimeType) {
  if (mimeType && AUDIO_MIMES.has(mimeType.toLowerCase())) return true;
  return typeof filename === 'string' && AUDIO_EXT_RE.test(filename);
}

function parseAudioPages(pages) {
  const results = [];
  for (const page of Object.values(pages || {})) {
    const info = page?.imageinfo?.[0];
    if (info?.url && isAudioFile(info.url, info.mime)) {
      results.push({
        title: page.title,
        url: info.url,
        filename: decodeURIComponent(info.url.split('/').pop() || 'audio'),
      });
    }
  }
  return results;
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .substring(0, 255);
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  try {
    if (bytes.length < 65536) return btoa(String.fromCharCode(...bytes));
  } catch {}
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

function filterRestItems(items) {
  return items
    .filter(item => (item.audio_type && item.audio_type !== 'unknown') || isAudioFile(item.title))
    .map(item => item.title);
}

function extractTitle(pathname) {
  return decodeURIComponent(pathname.split('/wiki/')[1] ?? '');
}

function detectLang(hostname) {
  const i18n = { en: 1, de: 1, fr: 1, es: 1, it: 1, ja: 1, zh: 1 };
  const match = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const lang = match?.[1] || 'en';
  return i18n[lang] ? lang : 'en';
}

// ============ TESTS ============

section('MIME detection');
assert(isAudioFile('t.ogg', 'audio/ogg'), 'audio/ogg');
assert(isAudioFile('t.ogg', 'application/ogg'), 'application/ogg (Wiktionary actual)');
assert(isAudioFile('t.mp3', 'audio/mpeg'), 'audio/mpeg');
assert(isAudioFile('t.wav', 'audio/wav'), 'audio/wav');
assert(isAudioFile('t.opus', 'audio/opus'), 'audio/opus');
assert(isAudioFile('t.ogg', 'video/ogg'), 'video/ogg');
assert(isAudioFile('t.ogg', null), '.ogg fallback');
assert(isAudioFile('t.opus', undefined), '.opus fallback');
assert(isAudioFile('t.mp3'), '.mp3 no mime arg');
assert(isAudioFile('t.flac'), '.flac');
assert(isAudioFile('t.oga'), '.oga');
assert(isAudioFile('t.m4a'), '.m4a');
assert(isAudioFile('t.webm'), '.webm');
assert(!isAudioFile('t.jpg', 'image/jpeg'), 'reject jpg');
assert(!isAudioFile(null, null), 'reject null');
assert(!isAudioFile(undefined), 'reject undefined');
assert(!isAudioFile('', ''), 'reject empty');
assert(!isAudioFile(123), 'reject non-string');

section('Parse API responses');
const oggPages = {
  "-1": { title: "File:En-au-topper.ogg", imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/4/4c/En-au-topper.ogg", mime: "application/ogg" }] },
  "-2": { title: "File:Nl-topper.ogg", imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/8/85/Nl-topper.ogg", mime: "application/ogg" }] }
};
assert(parseAudioPages(oggPages).length === 2, '2 OGG files with application/ogg');
assert(parseAudioPages(null).length === 0, 'null pages');
assert(parseAudioPages({}).length === 0, 'empty pages');
assert(parseAudioPages({ "-1": { title: "File:t.ogg" } }).length === 0, 'no imageinfo');
assert(parseAudioPages({ "-1": { title: "File:t.jpg", imageinfo: [{ url: "https://x/t.jpg", mime: "image/jpeg" }] } }).length === 0, 'image page');

const waterPages = {
  "-1": { title: "File:water.ogg", imageinfo: [{ url: "https://upload.wikimedia.org/a/b/En-us-water.ogg", mime: "application/ogg" }] },
  "-2": { title: "File:water.wav", imageinfo: [{ url: "https://upload.wikimedia.org/a/b/LL-Q1860_%28eng%29-water.wav", mime: "audio/wav" }] }
};
const wr = parseAudioPages(waterPages);
assert(wr.length === 2, 'mixed formats');
assert(wr[1].filename === 'LL-Q1860_(eng)-water.wav', 'URL decoded filename');

section('Filename sanitization');
assert(sanitizeFilename('En-au-topper.ogg') === 'En-au-topper.ogg', 'clean unchanged');
assert(sanitizeFilename('a<b>c:d"e') === 'a_b_c_d_e', 'special chars');
assert(sanitizeFilename('...hidden') === 'hidden', 'leading dots');
assert(sanitizeFilename('  spaced  ') === 'spaced', 'whitespace');
assert(sanitizeFilename('a'.repeat(300)).length === 255, 'length cap');
assert(sanitizeFilename('LL-Q150_(fra)-Jérémy.wav') === 'LL-Q150_(fra)-Jérémy.wav', 'unicode');
assert(sanitizeFilename('En-au-topper.ogg'.replace(/\.[^.]+$/, '')) === 'En-au-topper', 'base name');

section('REST API filter');
const items = [
  { title: "File:photo.jpg", type: "image" },
  { title: "File:audio.ogg", type: "audio", audio_type: "generic" },
  { title: "File:mystery.bin", audio_type: "unknown" },
  { title: "File:unlabeled.mp3" },
];
const filtered = filterRestItems(items);
assert(filtered.length === 2, 'filter: 2 audio');
assert(filtered[0] === 'File:audio.ogg', 'filter: ogg by audio_type');
assert(filtered[1] === 'File:unlabeled.mp3', 'filter: mp3 by extension');

section('Title extraction');
assert(extractTitle('/wiki/water') === 'water', 'simple');
assert(extractTitle('/wiki/%E6%B0%B4') === '水', 'CJK');
assert(extractTitle('/wiki/caf%C3%A9') === 'café', 'accented');
assert(extractTitle('/w/index.php') === '', 'non-wiki');
assert(extractTitle('/') === '', 'root');

section('Language detection');
assert(detectLang('en.wiktionary.org') === 'en', 'en');
assert(detectLang('de.wiktionary.org') === 'de', 'de');
assert(detectLang('pt.wiktionary.org') === 'en', 'pt fallback');
assert(detectLang('example.com') === 'en', 'non-wiktionary');

section('Base64 encoding');
const small = new Uint8Array([72, 101, 108, 108, 111]).buffer;
assert(arrayBufferToBase64(small) === btoa('Hello'), 'small');
assert(arrayBufferToBase64(new Uint8Array([]).buffer) === '', 'empty');
const large = new Uint8Array(100000).fill(66).buffer;
assert(atob(arrayBufferToBase64(large)).length === 100000, 'large roundtrip');

// ============ SUMMARY ============
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed.');
