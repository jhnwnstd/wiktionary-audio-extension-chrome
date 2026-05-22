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

// Mirrored from src/content-script.js -- keep in sync.
function isAudioInfo(info) {
  if (!info) return false;
  if (typeof info.mediatype === 'string' && info.mediatype.toUpperCase() === 'AUDIO') return true;
  if (typeof info.mime === 'string') {
    if (info.mime.startsWith('audio/')) return true;
    if (AUDIO_MIMES.has(info.mime.toLowerCase())) return true;
  }
  if (typeof info.url === 'string' && AUDIO_EXT_RE.test(info.url)) return true;
  return false;
}

function audioItemsFromPages(pages) {
  if (!Array.isArray(pages)) return [];
  const results = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (info?.url && isAudioInfo(info)) {
      const cleanTail = (info.url.split('/').pop() || 'audio').split('?')[0].split('#')[0];
      results.push({
        title: page.title,
        url: info.url,
        filename: decodeURIComponent(cleanTail),
      });
    }
  }
  return results;
}

// Mirrored from src/background.js sanitizeFilename -- keep in sync.
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

// Mirrored from src/content-script.js -- keep in sync.
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
  nz: 'new-zealand', za: 'south-african', in: 'indian',
  mx: 'mexican', ar: 'argentinian', br: 'brazilian',
  at: 'austrian', ch: 'swiss', be: 'belgian',
  'am-lat': 'latin-american', 'am_lat': 'latin-american',
  inlandnorth: 'inland-north', gen: 'general', gam: 'general-american',
  cmn: 'mandarin', yue: 'cantonese', wuu: 'shanghainese',
  nan: 'min-nan', hak: 'hakka',
  qc: 'quebec',
};
const LANG_OVERRIDES = {
  qc: 'quebec-french',
  jer: 'jèrriais',
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
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
function normalizeFieldValue(v) {
  if (v === null || v === undefined) return v;
  return String(v).replace(/[_\s]+/g, '-');
}
function describeLanguage(code) {
  if (!code) return null;
  let key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANG_OVERRIDES, key)) return LANG_OVERRIDES[key];
  if (Object.prototype.hasOwnProperty.call(ISO_639_3_TO_1, key)) key = ISO_639_3_TO_1[key];
  if (LANG_DISPLAY) {
    try {
      const d = LANG_DISPLAY.of(key);
      if (d && d.toLowerCase() !== key) return slugifyName(d);
    } catch { /* fall through */ }
  }
  return normalizeFieldValue(key);
}
function describeDialect(code) {
  if (!code) return null;
  const key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DIALECT_ADJECTIVES, key)) return DIALECT_ADJECTIVES[key];
  if (key.includes('-') || key.includes('_')) {
    const parts = key.split(/[-_]/);
    const mapped = parts.map((p) => {
      if (Object.prototype.hasOwnProperty.call(DIALECT_ADJECTIVES, p)) return DIALECT_ADJECTIVES[p];
      if (REGION_DISPLAY && p.length === 2) {
        try {
          const d = REGION_DISPLAY.of(p.toUpperCase());
          if (d && d.toLowerCase() !== p) return slugifyName(d);
        } catch { /* fall through */ }
      }
      return p;
    });
    return mapped.join('-');
  }
  if (REGION_DISPLAY && key.length === 2) {
    try {
      const d = REGION_DISPLAY.of(key.toUpperCase());
      if (d && d.toLowerCase() !== key) return slugifyName(d);
    } catch { /* fall through */ }
  }
  return normalizeFieldValue(key);
}
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parseAudioFilename(raw, knownWord = null) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', extra: null, ext: '' };
  const decoded = decodeURIComponent(String(raw).split('?')[0].split('#')[0]);
  const base = decoded.split('/').pop() || decoded;
  const extMatch = base.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  const wordAnchor = knownWord ? escapeRegex(knownWord) : null;
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-Q\\d+_\\(([a-z]{2,3})\\)-(.+)-(${wordAnchor})$`, 'i'));
    if (m) return { lang: m[1].toLowerCase(), dialect: null, speaker: m[2], word: m[3], extra: null, ext };
  }
  const ll1 = stem.match(/^LL-Q\d+_\(([a-z]{2,3})\)-(.+)-([^-]+)$/i);
  if (ll1) return { lang: ll1[1].toLowerCase(), dialect: null, speaker: ll1[2], word: ll1[3], extra: null, ext };
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-Q\\d+-(.+)-(${wordAnchor})$`));
    if (m) return { lang: null, dialect: null, speaker: m[1], word: m[2], extra: null, ext };
  }
  const ll2 = stem.match(/^LL-Q\d+-(.+)-([^-]+)$/);
  if (ll2) return { lang: null, dialect: null, speaker: ll2[1], word: ll2[2], extra: null, ext };
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-(.+)-([a-z]{2,3})-(${wordAnchor})$`));
    if (m) return { lang: m[2].toLowerCase(), dialect: null, speaker: m[1], word: m[3], extra: null, ext };
  }
  const ll3 = stem.match(/^LL-(.+)-([a-z]{2,3})-([^-]+)$/);
  if (ll3) return { lang: ll3[2].toLowerCase(), dialect: null, speaker: ll3[1], word: ll3[3], extra: null, ext };
  if (wordAnchor) {
    const shortTail = `(?:${wordAnchor}|${wordAnchor}-[a-z0-9]{1,12})`;
    const m1 = stem.match(new RegExp(`^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,28}[a-z])-(${shortTail})$`));
    if (m1) return { lang: m1[1].toLowerCase(), dialect: m1[2], speaker: null, word: m1[3], extra: null, ext };
    const m2 = stem.match(new RegExp(`^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,28}[a-z])-(${wordAnchor})-(.+)$`));
    if (m2) return { lang: m2[1].toLowerCase(), dialect: m2[2], speaker: null, word: m2[3], extra: m2[4], ext };
  }
  const ld = stem.match(/^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,5}[a-z])-(.+)$/);
  if (ld) return { lang: ld[1].toLowerCase(), dialect: ld[2], speaker: null, word: ld[3], extra: null, ext };
  const lw = stem.match(/^([A-Z][a-z]{0,2})-(.+)$/);
  if (lw) return { lang: lw[1].toLowerCase(), dialect: null, speaker: null, word: lw[2], extra: null, ext };
  return { lang: null, dialect: null, speaker: null, word: stem, extra: null, ext };
}
function friendlyAudioFilename(parsed) {
  const parts = [];
  const lang = describeLanguage(parsed.lang);
  if (lang) parts.push(lang);
  const dialect = describeDialect(parsed.dialect);
  if (dialect) parts.push(dialect);
  parts.push(normalizeFieldValue(parsed.word));
  if (parsed.extra) parts.push(normalizeFieldValue(parsed.extra));
  if (parsed.speaker) parts.push(normalizeFieldValue(parsed.speaker));
  const stem = parts.join('_');
  return parsed.ext ? `${stem}.${parsed.ext}` : stem;
}
function formatAudio(raw) { return friendlyAudioFilename(parseAudioFilename(raw)); }

function titleCasePart(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function humanReadableName(parsed, originalFilename) {
  if (!parsed.lang && !parsed.dialect && !parsed.speaker) return originalFilename;
  const parts = [];
  if (parsed.lang) {
    const lang = describeLanguage(parsed.lang);
    if (lang) parts.push(lang.split('-').map(titleCasePart).join(' '));
  }
  if (parsed.dialect) {
    const dialect = describeDialect(parsed.dialect);
    if (dialect) parts.push(dialect.split('-').map(titleCasePart).join(' '));
  }
  parts.push(`'${String(parsed.word).replace(/_/g, ' ')}'`);
  if (parsed.extra) parts.push(`(${String(parsed.extra).replace(/[-_]/g, ' ')})`);
  if (parsed.speaker) parts.push(`by ${String(parsed.speaker).replace(/_/g, ' ')}`);
  return parts.join(' ') + (parsed.ext ? ` .${parsed.ext}` : '');
}
function humanReadable(raw) { return humanReadableName(parseAudioFilename(raw), raw); }

// Mirrored from src/content-script.js batchFolderName -- keep in sync.
function batchFolderName(hostname, title) {
  const m = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const edition = m?.[1] || 'wiktionary';
  return `Wiktionary-${edition}-${title || 'audio'}`;
}

// Mirrored from src/background.js pathWithFolder -- keep in sync.
function pathWithFolder(folder, filename) {
  const file = sanitizeFilename(filename);
  if (!folder) return file;
  return sanitizeFilename(folder) + '/' + file;
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

section('Parse Action API responses (formatversion=2 array form)');
const oggPages = [
  { title: 'File:En-au-topper.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/4/4c/En-au-topper.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }] },
  { title: 'File:Nl-topper.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/8/85/Nl-topper.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }] },
];
assert(audioItemsFromPages(oggPages).length === 2, '2 OGG files with mediatype=AUDIO');
assert(audioItemsFromPages(null).length === 0, 'null pages');
assert(audioItemsFromPages([]).length === 0, 'empty pages array');
assert(audioItemsFromPages({ '-1': { title: 'File:t.ogg' } }).length === 0, 'rejects v1 object form');
assert(audioItemsFromPages([{ title: 'File:t.ogg' }]).length === 0, 'no imageinfo');
assert(
  audioItemsFromPages([{ title: 'File:t.jpg', imageinfo: [{ url: 'https://x/t.jpg', mime: 'image/jpeg', mediatype: 'BITMAP' }] }]).length === 0,
  'image page filtered by mediatype'
);

// mediatype is the primary filter; fall back to mime and then extension.
assert(
  audioItemsFromPages([{ title: 'File:x.opus', imageinfo: [{ url: 'https://x/y.opus', mediatype: 'AUDIO' }] }]).length === 1,
  'mediatype-only (no mime) still passes'
);
assert(
  audioItemsFromPages([{ title: 'File:x.mp3', imageinfo: [{ url: 'https://x/y.mp3', mime: 'audio/mpeg' }] }]).length === 1,
  'mime-only audio/* passes when mediatype absent'
);

const waterPages = [
  { title: 'File:water.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/a/b/En-us-water.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }] },
  { title: 'File:water.wav', imageinfo: [{ url: 'https://upload.wikimedia.org/a/b/LL-Q1860_%28eng%29-water.wav', mime: 'audio/wav', mediatype: 'AUDIO' }] },
];
const wr = audioItemsFromPages(waterPages);
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
assert(sanitizeFilename('') === 'audio', 'empty -> audio fallback');
assert(sanitizeFilename(null) === 'audio', 'null -> audio fallback');
assert(sanitizeFilename(undefined) === 'audio', 'undefined -> audio fallback');
assert(sanitizeFilename(123) === 'audio', 'non-string -> audio fallback');
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
// 100 chars of '水' = 300 bytes UTF-8 -> must truncate by byte count, not char count
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
assert(p5.lang === 'en' && p5.dialect === 'us' && p5.word === 'water', 'full URL -> last path segment');
const p6 = parseAudioFilename('weird_name.mp3');
assert(p6.lang === null && p6.word === 'weird_name' && p6.ext === 'mp3', 'unparseable falls back to stem');
const p7 = parseAudioFilename('');
assert(p7.word === 'audio' && p7.ext === '', 'empty input safe default');

section('Friendly filename formatting');
assert(formatAudio('En-au-Georgian.ogg') === 'english_australian_Georgian.ogg', 'En-au-Georgian -> english_australian_Georgian');
assert(formatAudio('De-Wasser.ogg') === 'german_Wasser.ogg', 'De-Wasser -> german_Wasser');
assert(formatAudio('En-us-water.ogg') === 'english_american_water.ogg', 'En-us-water -> english_american_water');
assert(formatAudio('Fr-eau.ogg') === 'french_eau.ogg', 'Fr-eau -> french_eau');
assert(formatAudio('LL-Q1860_(eng)-Stebbington-water.wav') === 'english_water_Stebbington.wav', 'LL -> english_word_speaker');
assert(formatAudio('En-au-Georgian.ogg?utm_source=foo') === 'english_australian_Georgian.ogg', 'friendly strips utm');
assert(formatAudio('weird_name.mp3') === 'weird-name.mp3', 'unparseable: underscore in word -> hyphen (within-field)');
// Unknown dialect code passes through verbatim (lowercased)
assert(formatAudio('En-xx-thing.ogg') === 'english_xx_thing.ogg', 'unknown dialect -> code');

// Real-world variants observed in live sweep
const p9 = parseAudioFilename('LL-Guilhelma-fr-eau.wav');
assert(p9.lang === 'fr' && p9.speaker === 'Guilhelma' && p9.word === 'eau', 'LL hyphenated form (no Q-number)');
assert(formatAudio('LL-Guilhelma-fr-eau.wav') === 'french_eau_Guilhelma.wav', 'LL hyphenated -> friendly');

const p10 = parseAudioFilename('LL-Q9186-Justinrleung-水.wav');
assert(p10.lang === null && p10.speaker === 'Justinrleung' && p10.word === '水', 'LL Q-number hyphenated form');
assert(formatAudio('LL-Q9186-Justinrleung-水.wav') === '水_Justinrleung.wav', 'LL Q-hyphen -> friendly (lang unknown)');

const p11 = parseAudioFilename('Es-am_lat-agua.ogg');
assert(p11.lang === 'es' && p11.dialect === 'am_lat' && p11.word === 'agua', 'dialect with underscore');
assert(formatAudio('Es-am_lat-agua.ogg') === 'spanish_latin-american_agua.ogg', 'am_lat -> latin-american (hyphen within field)');
assert(formatAudio('Es-am-lat-agua.ogg') === 'spanish_latin-american_agua.ogg', 'am-lat (hyphen form) -> latin-american');
assert(formatAudio('Zh-cmn-shuǐ.ogg') === 'chinese_mandarin_shuǐ.ogg', 'Chinese topolect as dialect');

section('Separator convention: _ between fields, - within a field');
// LinguaLibre speakers often have underscores in source (Naomi_Persephone_Amethyst);
// those are inside one field (speaker) so they normalize to hyphens.
const llNaomi = parseAudioFilename('LL-Q1860_(eng)-Naomi_Persephone_Amethyst-cat.wav');
assert(llNaomi.speaker === 'Naomi_Persephone_Amethyst', 'parser keeps source speaker verbatim');
assert(
  formatAudio('LL-Q1860_(eng)-Naomi_Persephone_Amethyst-cat.wav') === 'english_cat_Naomi-Persephone-Amethyst.wav',
  'speaker underscores normalize to hyphens (within speaker field)'
);
// Multi-word region from Intl (e.g., New Zealand) stays as a single field with `-`.
assert(formatAudio('En-nz-kia_ora.ogg') === 'english_new-zealand_kia-ora.ogg', 'nz -> new-zealand; word underscore -> hyphen');

section('Human-readable panel display');
assert(humanReadable('En-au-friendo.ogg') === "English Australian 'friendo' .ogg", 'En-au-friendo -> display');
assert(humanReadable('En-us-water.ogg') === "English American 'water' .ogg", 'En-us-water -> display');
assert(humanReadable('De-Wasser.ogg') === "German 'Wasser' .ogg", 'De-Wasser (no dialect) -> display');
assert(humanReadable('LL-Q1860_(eng)-Stebbington-water.wav') === "English 'water' by Stebbington .wav", 'LL parens form -> display with speaker');
assert(humanReadable('LL-Guilhelma-fr-eau.wav') === "French 'eau' by Guilhelma .wav", 'LL hyphen form -> display with speaker');
assert(humanReadable('Es-am_lat-agua.ogg') === "Spanish Latin American 'agua' .ogg", 'compound dialect -> Title Case with space');
assert(humanReadable('BY-Wasser.ogg') === 'BY-Wasser.ogg', 'unparseable -> original filename verbatim');
assert(humanReadable('weird_name.mp3') === 'weird_name.mp3', 'unparseable with underscore -> original verbatim');
assert(
  humanReadable('LL-Q1860_(eng)-Naomi_Persephone_Amethyst-cat.wav') === "English 'cat' by Naomi Persephone Amethyst .wav",
  'speaker underscores -> spaces in display'
);
assert(humanReadable('Zh-cmn-shuǐ.ogg') === "Chinese Mandarin 'shuǐ' .ogg", 'Chinese topolect dialect -> display');

section('Hyphenated speakers and compound words (parser ambiguity)');
// Hyphenated speaker, simple word -- greedy speaker handles this without context.
const hs1 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-water.wav');
assert(
  hs1.lang === 'fra' && hs1.speaker === 'Jérémy-Günther' && hs1.word === 'water',
  'hyphenated speaker, simple word: speaker=Jérémy-Günther, word=water'
);
// Same file with explicit knownWord -- still parses correctly.
const hs2 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-water.wav', 'water');
assert(
  hs2.speaker === 'Jérémy-Günther' && hs2.word === 'water',
  'hyphenated speaker with anchor: same result'
);
// Real-world case from the live sweep: long compound name with space.
const hs3 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-Heinz Jähnick-water.wav');
assert(
  hs3.speaker === 'Jérémy-Günther-Heinz Jähnick' && hs3.word === 'water',
  'multi-hyphen compound name resolves to single speaker'
);

// Compound WORD without anchor: degrades -- last token becomes word.
const cw1 = parseAudioFilename('LL-Q1860_(eng)-Stebbington-well-known.wav');
assert(
  cw1.speaker === 'Stebbington-well' && cw1.word === 'known',
  'no anchor: compound word degrades (acceptable fallback)'
);
// With knownWord='well-known', anchor recovers the right split.
const cw2 = parseAudioFilename('LL-Q1860_(eng)-Stebbington-well-known.wav', 'well-known');
assert(
  cw2.speaker === 'Stebbington' && cw2.word === 'well-known',
  'knownWord anchor recovers compound word'
);
// Ambiguous case: both speaker AND word have hyphens. Anchor disambiguates.
const cw3 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-well-known.wav', 'well-known');
assert(
  cw3.speaker === 'Jérémy-Günther' && cw3.word === 'well-known',
  'both-have-hyphens disambiguated by knownWord'
);

// LL hyphenated Q-form still works with hyphenated speakers + anchor.
const llQH1 = parseAudioFilename('LL-Q9186-Justinrleung-Wang-水.wav', '水');
assert(
  llQH1.speaker === 'Justinrleung-Wang' && llQH1.word === '水',
  'LL2 hyphenated speaker with CJK anchor'
);

// LL speaker-first form: speaker can also have hyphens here.
const llSH1 = parseAudioFilename('LL-Foo-Bar-fr-eau.wav', 'eau');
assert(
  llSH1.lang === 'fr' && llSH1.speaker === 'Foo-Bar' && llSH1.word === 'eau',
  'LL3 hyphenated speaker with anchor'
);

// Compound word with greedy default (no anchor) -- speaker absorbs hyphen
// regions but the lang code anchor still works because lang must be 2-3 chars.
const llSH2 = parseAudioFilename('LL-Speaker-fr-eau.wav');
assert(
  llSH2.lang === 'fr' && llSH2.speaker === 'Speaker' && llSH2.word === 'eau',
  'LL3 simple case unchanged'
);

// Non-LL cases unaffected by the new regex.
assert(parseAudioFilename('En-au-Georgian.ogg', 'Georgian').dialect === 'au', 'non-LL parser still works with anchor arg');
assert(parseAudioFilename('De-Wasser.ogg').lang === 'de', 'non-LL parser still works without anchor arg');

section('Findings from real Wiktionary data');
// Quebec French -- region used as language prefix, no separate lang code.
assert(formatAudio('Qc-café.ogg') === 'quebec-french_café.ogg', 'Qc -> quebec-french in filename');
assert(humanReadable('Qc-café.ogg') === "Quebec French 'café' .ogg", 'Qc -> Quebec French in display');

// Jèrriais -- variety with its own Wiktionary entry but no ISO 639-1 code.
assert(formatAudio('Jer-cat.ogg') === 'jèrriais_cat.ogg', 'Jer -> jèrriais in filename');
assert(humanReadable('Jer-cat.ogg') === "Jèrriais 'cat' .ogg", 'Jer -> Jèrriais in display');

// Long regional dialect tag -- only resolves cleanly with knownWord anchor.
// Without context, the dialect is capped at 7 chars to avoid greedy over-match
// in the common "En-us-hello-4" case (where us-hello would otherwise be eaten).
const inlandRaw = parseAudioFilename('En-inlandnorth-cat.ogg');
assert(
  inlandRaw.lang === 'en' && inlandRaw.word === 'inlandnorth-cat' && !inlandRaw.dialect,
  'without anchor: long dialect not recognized (falls through to word)'
);
const inlandAnchored = parseAudioFilename('En-inlandnorth-cat.ogg', 'cat');
assert(
  inlandAnchored.dialect === 'inlandnorth' && inlandAnchored.word === 'cat',
  'with anchor: inlandnorth parsed as dialect, cat as word'
);
assert(
  friendlyAudioFilename(inlandAnchored) === 'english_inland-north_cat.ogg',
  'anchored: inlandnorth -> inland-north in filename'
);
assert(
  humanReadableName(inlandAnchored, 'En-inlandnorth-cat.ogg') === "English Inland North 'cat' .ogg",
  'anchored: inlandnorth -> Inland North in display'
);

// Compound dialect (us-inlandnorth) -- needs anchor + compound-split.
const compoundDialect = parseAudioFilename('En-us-inlandnorth-cat.ogg', 'cat');
assert(
  compoundDialect.dialect === 'us-inlandnorth' && compoundDialect.word === 'cat',
  'anchor resolves us-inlandnorth as compound dialect'
);
assert(
  friendlyAudioFilename(compoundDialect) === 'english_american-inland-north_cat.ogg',
  'compound dialect: split + lookup each piece'
);
assert(
  humanReadableName(compoundDialect, 'En-us-inlandnorth-cat.ogg') === "English American Inland North 'cat' .ogg",
  'compound dialect -> multi-word display'
);

// Variant-indexed file (En-us-hello-4) -- anchor accepts pageTitle-<suffix>
// so dialect stays at `us` and the suffix rides on the word.
const variantAnchored = parseAudioFilename('En-us-hello-4.ogg', 'hello');
assert(
  variantAnchored.dialect === 'us' && variantAnchored.word === 'hello-4',
  'variant suffix: dialect=us, word=hello-4 (kept together)'
);
assert(
  humanReadableName(variantAnchored, 'En-us-hello-4.ogg') === "English American 'hello-4' .ogg",
  'variant suffix display'
);

section('Phonetic extra (e.g. cot-caught merger)');
// Real example from en/water page: file has phonetic feature in name.
const merger = parseAudioFilename('En-us-water-cot-caught-merger.ogg', 'water');
assert(
  merger.dialect === 'us' && merger.word === 'water' && merger.extra === 'cot-caught-merger',
  'cot-caught-merger captured as extra (word stays "water")'
);
assert(
  friendlyAudioFilename(merger) === 'english_american_water_cot-caught-merger.ogg',
  'extra appears in filename between word and ext'
);
assert(
  humanReadableName(merger, 'En-us-water-cot-caught-merger.ogg') === "English American 'water' (cot caught merger) .ogg",
  'extra rendered in parens with spaces in display'
);

// Long-form: "without the cot-caught merger" (a different recording variant).
const without = parseAudioFilename('En-us-water-without-the-cot-caught-merger.ogg', 'water');
assert(
  without.word === 'water' && without.extra === 'without-the-cot-caught-merger',
  'long phonetic phrase preserved as extra'
);
assert(
  humanReadableName(without, 'En-us-water-without-the-cot-caught-merger.ogg') ===
    "English American 'water' (without the cot caught merger) .ogg",
  'long phonetic phrase rendered with spaces'
);

// Anchor failure case: without knownWord, the extra-capture pattern doesn't
// run, so the parser falls back to the older greedy regex (word absorbs the
// whole tail). This is the documented degraded behavior when context is
// unavailable.
const mergerNoAnchor = parseAudioFilename('En-us-water-cot-caught-merger.ogg');
assert(
  mergerNoAnchor.extra === null,
  'no anchor: extra stays null (degrades gracefully)'
);

// URL query string from Wikimedia API leaks should be stripped at the
// discovery layer, not just at parser layer. Verify audioItemsFromPages
// cleans the filename pulled from info.url.
const trackedPages = [{
  title: 'File:BY-Wasser.ogg',
  imageinfo: [{
    url: 'https://upload.wikimedia.org/x/BY-Wasser.ogg?utm_source=de.wiktionary.org&utm_campaign=imageinfo',
    mime: 'application/ogg',
    mediatype: 'AUDIO',
  }],
}];
const cleaned = audioItemsFromPages(trackedPages);
assert(cleaned.length === 1 && cleaned[0].filename === 'BY-Wasser.ogg', 'query string stripped from filename at discovery');

section('Batch download folder grouping');
assert(batchFolderName('en.wiktionary.org', 'water') === 'Wiktionary-en-water', 'en/water folder name');
assert(batchFolderName('de.wiktionary.org', 'Wasser') === 'Wiktionary-de-Wasser', 'de/Wasser folder name');
assert(batchFolderName('ja.wiktionary.org', '水') === 'Wiktionary-ja-水', 'CJK folder name preserved');
assert(batchFolderName('fr.wiktionary.org', 'eau') === 'Wiktionary-fr-eau', 'fr/eau folder name');
assert(batchFolderName('example.com', 'foo') === 'Wiktionary-wiktionary-foo', 'non-wiktionary fallback edition');
assert(batchFolderName('en.wiktionary.org', '') === 'Wiktionary-en-audio', 'empty title falls back to "audio"');

// pathWithFolder composes the final chrome.downloads filename.
assert(pathWithFolder(null, 'foo.ogg') === 'foo.ogg', 'no folder -> just filename');
assert(pathWithFolder('', 'foo.ogg') === 'foo.ogg', 'empty folder -> just filename');
assert(
  pathWithFolder('Wiktionary-en-water', 'english_american_water.ogg') === 'Wiktionary-en-water/english_american_water.ogg',
  'folder + file joined with /'
);
assert(
  pathWithFolder('Wiktionary-ja-水', 'chinese_shuǐ.ogg') === 'Wiktionary-ja-水/chinese_shuǐ.ogg',
  'unicode preserved in both folder and filename'
);
// Defense in depth: a `/` in the folder or file gets sanitized away before
// the separator is added, so the user can't accidentally escape into a deeper
// directory tree.
assert(
  pathWithFolder('bad/folder', 'foo.ogg') === 'bad_folder/foo.ogg',
  'slash in folder sanitized to underscore'
);
assert(
  pathWithFolder('folder', 'bad/file.ogg') === 'folder/bad_file.ogg',
  'slash in filename sanitized to underscore'
);

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
assert(intlRegion === 'spanish_chile_agua.ogg' || intlRegion === 'spanish_cl_agua.ogg', 'cl (Chile) via Intl region -- noun form acceptable');

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

// Reads src/content-script.js as text and pulls keys out of each locale block
// in `const i18n = { ... }`. Catches drift where a new key is added to `en`
// but missed in fr/de/etc., which would silently fall back to undefined in
// the UI. No eval -- pure regex extraction so the test stays safe even if
// the source ever picked up a hostile string.
section('i18n locale key parity');
const fs = require('node:fs');
const path = require('node:path');
const contentSrc = fs.readFileSync(
  path.join(__dirname, '../../src/content-script.js'), 'utf8');
const i18nStart = contentSrc.indexOf('const i18n = {');
const i18nEnd = contentSrc.indexOf('\n};', i18nStart);
assert(i18nStart !== -1 && i18nEnd !== -1, 'i18n block located');
const i18nBlock = contentSrc.slice(i18nStart, i18nEnd);

const localeRe = /^ {2}([a-z]{2,3}):\s*\{$([\s\S]*?)^ {2}\}/gm;
const locales = {};
let lm;
while ((lm = localeRe.exec(i18nBlock)) !== null) {
  const [, code, body] = lm;
  const keyRe = /^ {4}([A-Za-z_$][A-Za-z0-9_$]*):/gm;
  const keys = [];
  let km;
  while ((km = keyRe.exec(body)) !== null) keys.push(km[1]);
  locales[code] = keys.sort();
}
assert(Object.keys(locales).length >= 2, `extracted multiple locales (got ${Object.keys(locales).length})`);
assert(locales.en && locales.en.length > 0, 'en locale extracted with keys');
const enKeys = locales.en.join(',');
for (const [code, keys] of Object.entries(locales)) {
  if (code === 'en') continue;
  assert(
    keys.join(',') === enKeys,
    `i18n.${code} has same keys as en (got ${keys.length}, expected ${locales.en.length})`
  );
}

// ============ SUMMARY ============
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed.');
