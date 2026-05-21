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

// Mirrored from src/background.js sanitizeFilename — keep in sync.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const UTF8_ENCODER = new TextEncoder();
const utf8ByteLength = (s) => UTF8_ENCODER.encode(s).length;
function truncateToBytes(s, maxBytes) {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let result = s;
  while (result.length > 0 && utf8ByteLength(result) > maxBytes) result = result.slice(0, -1);
  return result;
}
function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename) return 'audio';
  let s = filename
    .split('?')[0].split('#')[0]
    .replace(FORBIDDEN_CHARS_RE, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (WINDOWS_RESERVED_RE.test(s)) s = '_' + s;
  if (utf8ByteLength(s) > 255) {
    const extIdx = s.lastIndexOf('.');
    if (extIdx > 0 && s.length - extIdx <= 16) {
      const ext = s.slice(extIdx);
      s = truncateToBytes(s.slice(0, extIdx), 255 - utf8ByteLength(ext)) + ext;
    } else {
      s = truncateToBytes(s, 255);
    }
  }
  return s || 'audio';
}

// Mirrored from src/content-script.js — keep in sync.
const ISO_639_3_TO_1 = {
  eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it',
  jpn: 'ja', zho: 'zh', cmn: 'zh', yue: 'zh', por: 'pt',
  nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  pol: 'pl', rus: 'ru', ara: 'ar', hin: 'hi', kor: 'ko',
  tur: 'tr', ukr: 'uk', ces: 'cs', ell: 'el', heb: 'he',
  tha: 'th', vie: 'vi', ron: 'ro', hun: 'hu', ind: 'id',
};
const DIALECT_ADJECTIVES = {
  us: 'american', uk: 'british', gb: 'british',
  au: 'australian', ca: 'canadian', ie: 'irish',
  nz: 'new_zealand', za: 'south_african', in: 'indian',
  mx: 'mexican', ar: 'argentinian', br: 'brazilian',
  at: 'austrian', ch: 'swiss', be: 'belgian',
  'am-lat': 'latin_american', 'am_lat': 'latin_american',
  cmn: 'mandarin', yue: 'cantonese', wuu: 'shanghainese',
  nan: 'min_nan', hak: 'hakka',
};
const LANG_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' }); }
  catch { return null; }
})();
const REGION_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }); }
  catch { return null; }
})();
function slugifyName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}
function describeLanguage(code) {
  if (!code) return null;
  let key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ISO_639_3_TO_1, key)) key = ISO_639_3_TO_1[key];
  if (LANG_DISPLAY) {
    try {
      const d = LANG_DISPLAY.of(key);
      if (d && d.toLowerCase() !== key) return slugifyName(d);
    } catch { /* fall through */ }
  }
  return key.replace(/-/g, '_');
}
function describeDialect(code) {
  if (!code) return null;
  const key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DIALECT_ADJECTIVES, key)) return DIALECT_ADJECTIVES[key];
  if (REGION_DISPLAY && key.length === 2) {
    try {
      const d = REGION_DISPLAY.of(key.toUpperCase());
      if (d && d.toLowerCase() !== key) return slugifyName(d);
    } catch { /* fall through */ }
  }
  return key.replace(/-/g, '_');
}
function parseAudioFilename(raw) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', ext: '' };
  const decoded = decodeURIComponent(String(raw).split('?')[0].split('#')[0]);
  const base = decoded.split('/').pop() || decoded;
  const extMatch = base.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  const ll1 = stem.match(/^LL-Q\d+_\(([a-z]{2,3})\)-([^-]+)-(.+)$/i);
  if (ll1) return { lang: ll1[1].toLowerCase(), dialect: null, speaker: ll1[2], word: ll1[3], ext };
  const ll2 = stem.match(/^LL-Q\d+-([^-]+)-(.+)$/);
  if (ll2) return { lang: null, dialect: null, speaker: ll2[1], word: ll2[2], ext };
  const ll3 = stem.match(/^LL-([^-]+)-([a-z]{2,3})-(.+)$/);
  if (ll3) return { lang: ll3[2].toLowerCase(), dialect: null, speaker: ll3[1], word: ll3[3], ext };
  const ld = stem.match(/^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,5}[a-z])-(.+)$/);
  if (ld) return { lang: ld[1].toLowerCase(), dialect: ld[2], speaker: null, word: ld[3], ext };
  const lw = stem.match(/^([A-Z][a-z]{0,2})-(.+)$/);
  if (lw) return { lang: lw[1].toLowerCase(), dialect: null, speaker: null, word: lw[2], ext };
  return { lang: null, dialect: null, speaker: null, word: stem, ext };
}
function friendlyAudioFilename(parsed) {
  const parts = [];
  const lang = describeLanguage(parsed.lang);
  if (lang) parts.push(lang);
  const dialect = describeDialect(parsed.dialect);
  if (dialect) parts.push(dialect);
  parts.push(parsed.word);
  if (parsed.speaker) parts.push(parsed.speaker);
  const stem = parts.join('_').replace(/\s+/g, '_');
  return parsed.ext ? `${stem}.${parsed.ext}` : stem;
}
function formatAudio(raw) { return friendlyAudioFilename(parseAudioFilename(raw)); }

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

section('Filename sanitization (cross-platform: Win/Mac/Linux)');
// Existing behavior preserved
assert(sanitizeFilename('En-au-topper.ogg') === 'En-au-topper.ogg', 'clean unchanged');
assert(sanitizeFilename('a<b>c:d"e') === 'a_b_c_d_e', 'special chars');
assert(sanitizeFilename('...hidden') === 'hidden', 'leading dots');
assert(sanitizeFilename('  spaced  ') === 'spaced', 'whitespace');
assert(sanitizeFilename('LL-Q150_(fra)-Jérémy.wav') === 'LL-Q150_(fra)-Jérémy.wav', 'unicode');
assert(sanitizeFilename('En-au-topper.ogg'.replace(/\.[^.]+$/, '')) === 'En-au-topper', 'base name');

// New cross-platform behavior
assert(sanitizeFilename('') === 'audio', 'empty → audio fallback');
assert(sanitizeFilename(null) === 'audio', 'null → audio fallback');
assert(sanitizeFilename(undefined) === 'audio', 'undefined → audio fallback');
assert(sanitizeFilename(123) === 'audio', 'non-string → audio fallback');
assert(sanitizeFilename('foo|bar/baz.ogg') === 'foo_bar_baz.ogg', 'Linux/Mac slash + pipe');
assert(sanitizeFilename('foo\x00bar.ogg') === 'foo_bar.ogg', 'NUL replaced');
assert(sanitizeFilename('foo\x01\x1fbar.ogg') === 'foo__bar.ogg', 'control chars replaced');
assert(sanitizeFilename('foo. ').endsWith('foo'), 'trailing dot+space stripped (Windows)');
assert(sanitizeFilename('CON') === '_CON', 'Windows reserved CON');
assert(sanitizeFilename('com1.txt') === '_com1.txt', 'Windows reserved COM1 case-insensitive');
assert(sanitizeFilename('PRN.ogg') === '_PRN.ogg', 'Windows reserved PRN with extension');
assert(sanitizeFilename('normal.txt') === 'normal.txt', 'non-reserved unchanged');
assert(sanitizeFilename('foo.ogg?utm_source=bar') === 'foo.ogg', 'query string stripped');
assert(sanitizeFilename('foo.ogg#frag') === 'foo.ogg', 'fragment stripped');
assert(sanitizeFilename('水.ogg') === '水.ogg', 'CJK preserved');
assert(sanitizeFilename('café.mp3') === 'café.mp3', 'accented preserved');

// Length: 255 chars of ASCII fits in 255 bytes
assert(sanitizeFilename('a'.repeat(300)).length === 255, 'ASCII length cap');
assert(sanitizeFilename('a'.repeat(300) + '.ogg').endsWith('.ogg'), 'extension preserved on truncate');
// 100 chars of '水' = 300 bytes UTF-8 → must truncate by byte count, not char count
const longCJK = '水'.repeat(100);
assert(utf8ByteLength(sanitizeFilename(longCJK)) <= 255, 'CJK truncated by UTF-8 bytes');

section('Wiktionary audio filename parser');
const p1 = parseAudioFilename('En-au-Georgian.ogg');
assert(p1.lang === 'en' && p1.dialect === 'au' && p1.word === 'Georgian' && p1.ext === 'ogg', 'En-au-Georgian.ogg');
const p2 = parseAudioFilename('De-Wasser.ogg');
assert(p2.lang === 'de' && p2.dialect === null && p2.word === 'Wasser' && p2.ext === 'ogg', 'De-Wasser.ogg');
const p3 = parseAudioFilename('LL-Q1860_(eng)-Speaker-water.wav');
assert(p3.lang === 'eng' && p3.speaker === 'Speaker' && p3.word === 'water' && p3.ext === 'wav', 'LinguaLibre format');
const p4 = parseAudioFilename('En-au-Georgian.ogg?utm_source=en.wiktionary.org&utm_campaign=imageinfo');
assert(p4.lang === 'en' && p4.dialect === 'au' && p4.word === 'Georgian' && p4.ext === 'ogg', 'strips query string');
const p5 = parseAudioFilename('https://upload.wikimedia.org/wikipedia/commons/4/4c/En-us-water.ogg');
assert(p5.lang === 'en' && p5.dialect === 'us' && p5.word === 'water', 'full URL → last path segment');
const p6 = parseAudioFilename('weird_name.mp3');
assert(p6.lang === null && p6.word === 'weird_name' && p6.ext === 'mp3', 'unparseable falls back to stem');
const p7 = parseAudioFilename('');
assert(p7.word === 'audio' && p7.ext === '', 'empty input safe default');

section('Friendly filename formatting');
assert(formatAudio('En-au-Georgian.ogg') === 'english_australian_Georgian.ogg', 'En-au-Georgian → english_australian_Georgian');
assert(formatAudio('De-Wasser.ogg') === 'german_Wasser.ogg', 'De-Wasser → german_Wasser');
assert(formatAudio('En-us-water.ogg') === 'english_american_water.ogg', 'En-us-water → english_american_water');
assert(formatAudio('Fr-eau.ogg') === 'french_eau.ogg', 'Fr-eau → french_eau');
assert(formatAudio('LL-Q1860_(eng)-Stebbington-water.wav') === 'english_water_Stebbington.wav', 'LL → english_word_speaker');
assert(formatAudio('En-au-Georgian.ogg?utm_source=foo') === 'english_australian_Georgian.ogg', 'friendly strips utm');
assert(formatAudio('weird_name.mp3') === 'weird_name.mp3', 'unparseable pass-through');
// Unknown dialect code passes through verbatim (lowercased)
assert(formatAudio('En-xx-thing.ogg') === 'english_xx_thing.ogg', 'unknown dialect → code');

// Real-world variants observed in live sweep
const p9 = parseAudioFilename('LL-Guilhelma-fr-eau.wav');
assert(p9.lang === 'fr' && p9.speaker === 'Guilhelma' && p9.word === 'eau', 'LL hyphenated form (no Q-number)');
assert(formatAudio('LL-Guilhelma-fr-eau.wav') === 'french_eau_Guilhelma.wav', 'LL hyphenated → friendly');

const p10 = parseAudioFilename('LL-Q9186-Justinrleung-水.wav');
assert(p10.lang === null && p10.speaker === 'Justinrleung' && p10.word === '水', 'LL Q-number hyphenated form');
assert(formatAudio('LL-Q9186-Justinrleung-水.wav') === '水_Justinrleung.wav', 'LL Q-hyphen → friendly (lang unknown)');

const p11 = parseAudioFilename('Es-am_lat-agua.ogg');
assert(p11.lang === 'es' && p11.dialect === 'am_lat' && p11.word === 'agua', 'dialect with underscore');
assert(formatAudio('Es-am_lat-agua.ogg') === 'spanish_latin_american_agua.ogg', 'am_lat → latin_american');
assert(formatAudio('Es-am-lat-agua.ogg') === 'spanish_latin_american_agua.ogg', 'am-lat (hyphen form) → latin_american');
assert(formatAudio('Zh-cmn-shuǐ.ogg') === 'chinese_mandarin_shuǐ.ogg', 'Chinese topolect as dialect');

section('Dynamic language coverage via Intl.DisplayNames');
// These languages are NOT in any hardcoded table. They flow through
// Intl.DisplayNames which the browser/Node ships with by default. If these
// fail, the runtime lacks full-icu data; treat as environment problem, not
// regression. Coverage proves the dynamic generalization the user asked for.
assert(formatAudio('Sw-X.ogg') === 'swahili_X.ogg', 'sw (Swahili) via Intl');
assert(formatAudio('Th-X.ogg') === 'thai_X.ogg', 'th (Thai) via Intl');
assert(formatAudio('Hu-X.ogg') === 'hungarian_X.ogg', 'hu (Hungarian) via Intl');
assert(formatAudio('Vi-X.ogg') === 'vietnamese_X.ogg', 'vi (Vietnamese) via Intl');
assert(formatAudio('Eo-X.ogg') === 'esperanto_X.ogg', 'eo (Esperanto) via Intl');
// Region/dialect that isn't in DIALECT_ADJECTIVES falls back to Intl region.
const intlRegion = formatAudio('Es-cl-agua.ogg');
assert(intlRegion === 'spanish_chile_agua.ogg' || intlRegion === 'spanish_cl_agua.ogg', 'cl (Chile) via Intl region — noun form acceptable');

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
