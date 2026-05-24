// Unit tests for Wiktionary Audio Extension. ES module so we can import
// production source directly instead of mirroring it.
//
// Run: npm test

import { AUDIO_HOST_ALLOWLIST, isAllowedAudioUrl } from '../../src/shared/audio-allowlist.mjs';
import {
  AUDIO_MIMES, AUDIO_EXT_RE, isAudioInfo, validImageInfo, urlTail,
} from '../../src/shared/audio-info.mjs';
import {
  PER_FILE_MAX_BYTES, OUTPUT_MAX_BYTES,
} from '../../src/shared/limits.mjs';
import {
  sanitizeFilename, truncateToBytes, utf8ByteLength,
} from '../../src/shared/sanitize-filename.mjs';
import { pathWithFolder, batchFolderName } from '../../src/shared/paths.mjs';
import { ByteBoundedCache } from '../../src/shared/byte-bounded-cache.mjs';
import { i18n, pickLocale, translations } from '../../src/shared/i18n.mjs';
import {
  parseAudioFilename, friendlyAudioFilename, humanReadableName,
} from '../../src/content/filename.mjs';
import {
  audioItemsFromPages, safeDecodeURIComponent,
  isPlainContinue, applyContinuation, isEnglishLang,
} from '../../src/content/discovery.mjs';

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}
function section(name) { console.log(name); }

// Test convenience shims. `isAudioFile` is the legacy filename+mime path,
// derived from the shared isAudioInfo by constructing the right shape.
// `formatAudio` and `humanReadable` chain parseAudioFilename with the
// downstream formatters since most tests are end-to-end on a raw name.
function isAudioFile(filename, mime) {
  return isAudioInfo({ url: filename || '', mime: mime || undefined });
}
function formatAudio(raw) { return friendlyAudioFilename(parseAudioFilename(raw)); }
function humanReadable(raw) { return humanReadableName(parseAudioFilename(raw), raw); }

// extractTitle is a one-liner mirroring the entry's URL parse. detectLang
// mirrors pickLocale's behavior with the local i18n shipped here.
function extractTitle(pathname) {
  try { return decodeURIComponent(pathname.split('/wiki/')[1] ?? ''); }
  catch { return ''; }
}
function detectLang(hostname) { return pickLocale(hostname); }

// arrayBufferToBase64 is private to background.js (chunked btoa, used only
// for sub-DATA_URL_THRESHOLD_BYTES bytes). Mirrored here as a test helper
// because it's tiny and isn't worth exposing as a module export.
function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

// ============ TESTS ============

section('MIME detection');
assert(isAudioFile('t.ogg', 'audio/ogg'), 'audio/ogg');
assert(isAudioFile('t.ogg', 'application/ogg'), 'application/ogg (Wiktionary actual)');
assert(isAudioFile('t.mp3', 'audio/mpeg'), 'audio/mpeg');
assert(isAudioFile('t.wav', 'audio/wav'), 'audio/wav');
assert(isAudioFile('t.opus', 'audio/opus'), 'audio/opus');
assert(isAudioFile('t.ogg', 'video/ogg'), '.ogg extension wins even when MIME claims video/ogg (no authoritative mediatype)');
assert(isAudioFile('t.ogg', null), '.ogg fallback');
assert(isAudioFile('t.opus', undefined), '.opus fallback');
assert(isAudioFile('t.mp3'), '.mp3 no mime arg');
assert(isAudioFile('t.flac'), '.flac');
assert(isAudioFile('t.oga'), '.oga');
assert(isAudioFile('t.m4a'), '.m4a (audio-only MP4 variant)');
assert(isAudioFile('t.aac'), '.aac (raw AAC stream)');
assert(!isAudioFile('t.webm'), 'reject .webm (could be video container)');
assert(!isAudioFile('t.jpg', 'image/jpeg'), 'reject jpg');
assert(!isAudioFile('', ''), 'reject empty');
// isAudioInfo: mediatype authority overrides extension/MIME
assert(!isAudioInfo({ mediatype: 'VIDEO', url: 'x.ogg' }), 'mediatype=VIDEO overrides .ogg extension');
assert(!isAudioInfo({ mediatype: 'VIDEO', mime: 'audio/ogg', url: 'x.ogg' }), 'mediatype=VIDEO overrides audio MIME');
assert(!isAudioInfo({ mediatype: 'BITMAP', url: 'x.jpg' }), 'mediatype=BITMAP is rejected');
assert(isAudioInfo({ mediatype: 'AUDIO', url: 'x.ogg' }), 'mediatype=AUDIO accepted');
assert(isAudioInfo({ mediatype: '', url: 'x.ogg' }), 'empty mediatype falls through to URL match');

section('Parse Action API responses (formatversion=2 array form)');
const oggPages = [
  { title: 'File:En-au-topper.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/4/4c/En-au-topper.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }] },
  { title: 'File:Nl-topper.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/8/85/Nl-topper.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }] },
];
assert(audioItemsFromPages(oggPages).length === 2, '2 OGG files with mediatype=AUDIO');
assert(audioItemsFromPages(null).length === 0, 'null pages');
assert(audioItemsFromPages([]).length === 0, 'empty pages array');
assert(audioItemsFromPages(/** @type {any} */ ({ '-1': { title: 'File:t.ogg' } })).length === 0, 'rejects v1 object form');
assert(audioItemsFromPages([{ title: 'File:t.ogg' }]).length === 0, 'no imageinfo');
assert(
  audioItemsFromPages([{ title: 'File:t.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/x/t.jpg', mime: 'image/jpeg', mediatype: 'BITMAP' }] }]).length === 0,
  'image page filtered by mediatype'
);

// mediatype is the primary filter; fall back to mime and then extension.
assert(
  audioItemsFromPages([{ title: 'File:x.opus', imageinfo: [{ url: 'https://upload.wikimedia.org/x/y.opus', mediatype: 'AUDIO' }] }]).length === 1,
  'mediatype-only (no mime) still passes'
);
assert(
  audioItemsFromPages([{ title: 'File:x.mp3', imageinfo: [{ url: 'https://upload.wikimedia.org/x/y.mp3', mime: 'audio/mpeg' }] }]).length === 1,
  'mime-only audio/* passes when mediatype absent'
);

const waterPages = [
  { title: 'File:water.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/a/b/En-us-water.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }] },
  { title: 'File:water.wav', imageinfo: [{ url: 'https://upload.wikimedia.org/a/b/LL-Q1860_%28eng%29-water.wav', mime: 'audio/wav', mediatype: 'AUDIO' }] },
];
const wr = audioItemsFromPages(waterPages);
assert(wr.length === 2, 'mixed formats');
assert(wr[1].filename === 'LL-Q1860_(eng)-water.wav', 'URL decoded filename');

// audioItemsFromPages also enforces the Wikimedia host allowlist.
const offHost = [{ title: 'File:x.ogg', imageinfo: [{ url: 'https://attacker.example/x.ogg', mime: 'audio/ogg', mediatype: 'AUDIO' }] }];
assert(audioItemsFromPages(offHost).length === 0, 'non-Wikimedia URL dropped at discovery boundary');

section('Filename sanitization (cross-platform: Win/Mac/Linux)');
assert(sanitizeFilename('En-au-topper.ogg') === 'En-au-topper.ogg', 'clean unchanged');
assert(sanitizeFilename('a<b>c:d"e') === 'a_b_c_d_e', 'special chars');
assert(sanitizeFilename('...hidden') === 'hidden', 'leading dots');
assert(sanitizeFilename('  spaced  ') === 'spaced', 'whitespace');
assert(sanitizeFilename('LL-Q150_(fra)-Jérémy.wav') === 'LL-Q150_(fra)-Jérémy.wav', 'unicode');
assert(sanitizeFilename('En-au-topper.ogg'.replace(/\.[^.]+$/, '')) === 'En-au-topper', 'base name');
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
const llNaomi = parseAudioFilename('LL-Q1860_(eng)-Naomi_Persephone_Amethyst-cat.wav');
assert(llNaomi.speaker === 'Naomi_Persephone_Amethyst', 'parser keeps source speaker verbatim');
assert(
  formatAudio('LL-Q1860_(eng)-Naomi_Persephone_Amethyst-cat.wav') === 'english_cat_Naomi-Persephone-Amethyst.wav',
  'speaker underscores normalize to hyphens (within speaker field)'
);
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
const hs1 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-water.wav');
assert(
  hs1.lang === 'fra' && hs1.speaker === 'Jérémy-Günther' && hs1.word === 'water',
  'hyphenated speaker, simple word: speaker=Jérémy-Günther, word=water'
);
const hs2 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-water.wav', 'water');
assert(
  hs2.speaker === 'Jérémy-Günther' && hs2.word === 'water',
  'hyphenated speaker with anchor: same result'
);
const hs3 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-Heinz Jähnick-water.wav');
assert(
  hs3.speaker === 'Jérémy-Günther-Heinz Jähnick' && hs3.word === 'water',
  'multi-hyphen compound name resolves to single speaker'
);

const cw1 = parseAudioFilename('LL-Q1860_(eng)-Stebbington-well-known.wav');
assert(
  cw1.speaker === 'Stebbington-well' && cw1.word === 'known',
  'no anchor: compound word degrades (acceptable fallback)'
);
const cw2 = parseAudioFilename('LL-Q1860_(eng)-Stebbington-well-known.wav', 'well-known');
assert(
  cw2.speaker === 'Stebbington' && cw2.word === 'well-known',
  'knownWord anchor recovers compound word'
);
const cw3 = parseAudioFilename('LL-Q150_(fra)-Jérémy-Günther-well-known.wav', 'well-known');
assert(
  cw3.speaker === 'Jérémy-Günther' && cw3.word === 'well-known',
  'both-have-hyphens disambiguated by knownWord'
);

const llQH1 = parseAudioFilename('LL-Q9186-Justinrleung-Wang-水.wav', '水');
assert(
  llQH1.speaker === 'Justinrleung-Wang' && llQH1.word === '水',
  'LL2 hyphenated speaker with CJK anchor'
);

const llSH1 = parseAudioFilename('LL-Foo-Bar-fr-eau.wav', 'eau');
assert(
  llSH1.lang === 'fr' && llSH1.speaker === 'Foo-Bar' && llSH1.word === 'eau',
  'LL3 hyphenated speaker with anchor'
);

const llSH2 = parseAudioFilename('LL-Speaker-fr-eau.wav');
assert(
  llSH2.lang === 'fr' && llSH2.speaker === 'Speaker' && llSH2.word === 'eau',
  'LL3 simple case unchanged'
);

assert(parseAudioFilename('En-au-Georgian.ogg', 'Georgian').dialect === 'au', 'non-LL parser still works with anchor arg');
assert(parseAudioFilename('De-Wasser.ogg').lang === 'de', 'non-LL parser still works without anchor arg');

section('Findings from real Wiktionary data');
assert(formatAudio('Qc-café.ogg') === 'quebec-french_café.ogg', 'Qc -> quebec-french in filename');
assert(humanReadable('Qc-café.ogg') === "Quebec French 'café' .ogg", 'Qc -> Quebec French in display');

assert(formatAudio('Jer-cat.ogg') === 'jèrriais_cat.ogg', 'Jer -> jèrriais in filename');
assert(humanReadable('Jer-cat.ogg') === "Jèrriais 'cat' .ogg", 'Jer -> Jèrriais in display');

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

const mergerNoAnchor = parseAudioFilename('En-us-water-cot-caught-merger.ogg');
assert(
  mergerNoAnchor.extra === null,
  'no anchor: extra stays null (degrades gracefully)'
);

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
assert(
  pathWithFolder('bad/folder', 'foo.ogg') === 'bad_folder/foo.ogg',
  'slash in folder sanitized to underscore'
);
assert(
  pathWithFolder('folder', 'bad/file.ogg') === 'folder/bad_file.ogg',
  'slash in filename sanitized to underscore'
);

section('Dynamic language coverage via Intl.DisplayNames');
assert(formatAudio('Sw-X.ogg') === 'swahili_X.ogg', 'sw (Swahili) via Intl');
assert(formatAudio('Th-X.ogg') === 'thai_X.ogg', 'th (Thai) via Intl');
assert(formatAudio('Hu-X.ogg') === 'hungarian_X.ogg', 'hu (Hungarian) via Intl');
assert(formatAudio('Vi-X.ogg') === 'vietnamese_X.ogg', 'vi (Vietnamese) via Intl');
assert(formatAudio('Eo-X.ogg') === 'esperanto_X.ogg', 'eo (Esperanto) via Intl');
const intlRegion = formatAudio('Es-cl-agua.ogg');
assert(intlRegion === 'spanish_chile_agua.ogg' || intlRegion === 'spanish_cl_agua.ogg', 'cl (Chile) via Intl region: noun form acceptable');

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

section('i18n locale key parity');
// Previously read content-script.js text to find drift across mirrored
// locale blocks. With a single source of truth in shared/i18n.mjs the
// check becomes a direct object compare.
const enKeys = Object.keys(i18n.en).sort().join(',');
assert(Object.keys(i18n).length >= 2, `multiple locales present (got ${Object.keys(i18n).length})`);
for (const [code, table] of Object.entries(i18n)) {
  if (code === 'en') continue;
  const keys = Object.keys(table).sort().join(',');
  assert(keys === enKeys, `i18n.${code} has same keys as en (got ${Object.keys(table).length}, expected ${Object.keys(i18n.en).length})`);
}
// translations(hostname) routes through pickLocale.
assert(translations('en.wiktionary.org') === i18n.en, 'translations(en) -> en table');
assert(translations('de.wiktionary.org') === i18n.de, 'translations(de) -> de table');
assert(translations('zz.wiktionary.org') === i18n.en, 'unknown lang falls back to en');
assert(translations('example.com') === i18n.en, 'non-wiktionary host -> en');
assert(translations(undefined) === i18n.en, 'undefined hostname -> en');

section('MediaWiki imageinfo schema validator');
assert(validImageInfo({ url: 'https://upload.wikimedia.org/x.ogg' }), 'minimum: url only');
assert(validImageInfo({ url: 'https://x/y.ogg', mime: 'audio/ogg', mediatype: 'AUDIO', size: 1234 }), 'full shape');
assert(validImageInfo({ url: 'https://x/y.ogg', mime: null, mediatype: null, size: null }), 'nulls in optionals');
assert(validImageInfo({ url: 'https://x/y.ogg', size: 0 }), 'zero size accepted');
assert(!validImageInfo(null), 'null rejected');
assert(!validImageInfo(undefined), 'undefined rejected');
assert(!validImageInfo('string'), 'string rejected');
assert(!validImageInfo({}), 'no url rejected');
assert(!validImageInfo({ url: '' }), 'empty url rejected');
assert(!validImageInfo({ url: 123 }), 'non-string url rejected');
assert(!validImageInfo({ url: 'https://x/y.ogg', mime: 123 }), 'non-string mime rejected');
assert(!validImageInfo({ url: 'https://x/y.ogg', mediatype: [] }), 'array mediatype rejected');
assert(!validImageInfo({ url: 'https://x/y.ogg', size: 'big' }), 'string size rejected');
assert(!validImageInfo({ url: 'https://x/y.ogg', size: Infinity }), 'Infinity size rejected');
assert(!validImageInfo({ url: 'https://x/y.ogg', size: NaN }), 'NaN size rejected');
assert(!validImageInfo({ url: 'https://x/y.ogg', size: -1 }), 'negative size rejected');
assert(
  audioItemsFromPages([{ title: 'F:x.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/y.ogg', mediatype: 'AUDIO', size: NaN }] }]).length === 0,
  'item with NaN size dropped'
);
assert(
  audioItemsFromPages([{ title: 'F:x.ogg', imageinfo: [{ url: 'https://upload.wikimedia.org/y.ogg', mediatype: 'AUDIO', mime: 42 }] }]).length === 0,
  'item with non-string mime dropped'
);

section('URL tail extraction');
assert(urlTail('https://upload.wikimedia.org/a/b/file.ogg') === 'file.ogg', 'basic path');
assert(urlTail('https://upload.wikimedia.org/a/b/file.ogg?utm_source=x') === 'file.ogg', 'query stripped');
assert(urlTail('https://upload.wikimedia.org/a/b/file.ogg#frag') === 'file.ogg', 'fragment stripped');
assert(urlTail('https://upload.wikimedia.org/a/b/file.ogg?u=1#f') === 'file.ogg', 'query + fragment stripped');
assert(urlTail('https://upload.wikimedia.org/') === 'audio', 'empty tail -> audio fallback');
assert(urlTail('https://upload.wikimedia.org/LL-Q1860_%28eng%29-water.wav') === 'LL-Q1860_%28eng%29-water.wav', 'pathname stays percent-encoded');
assert(urlTail('not a url') === 'audio', 'malformed -> audio fallback');

section('safeDecodeURIComponent');
assert(safeDecodeURIComponent('foo%20bar') === 'foo bar', 'normal decode');
assert(safeDecodeURIComponent('%E6%B0%B4') === '水', 'CJK decode');
assert(safeDecodeURIComponent('%E0%A4%A') === '%E0%A4%A', 'malformed sequence falls back to raw');

section('Continuation handling');
assert(isPlainContinue({}), 'empty object is plain');
assert(isPlainContinue({ gimcontinue: '1' }), 'object literal is plain');
assert(isPlainContinue(Object.create(null)), 'null-proto object is plain');
assert(!isPlainContinue(null), 'null not plain');
assert(!isPlainContinue('string'), 'string not plain');
assert(!isPlainContinue([]), 'array not plain');
assert(!isPlainContinue(123), 'number not plain');
const cp1 = new URLSearchParams();
applyContinuation(cp1, { gimcontinue: 'abc|123', continue: 'gim||' });
assert(cp1.get('gimcontinue') === 'abc|123', 'allowlisted key copied');
assert(cp1.get('continue') === 'gim||', 'continue indicator copied');
const cp2 = new URLSearchParams();
applyContinuation(cp2, { evil: 'x', __proto__: 'y', gimcontinue: 'ok' });
assert(cp2.get('evil') === null, 'non-allowlisted key dropped');
assert(cp2.get('__proto__') === null, 'prototype-poisoning key dropped');
assert(cp2.get('gimcontinue') === 'ok', 'allowlisted still copied');
const cp3 = new URLSearchParams();
applyContinuation(cp3, { gimcontinue: 42, continue: null });
assert(cp3.get('gimcontinue') === null, 'non-string value dropped');
assert(cp3.get('continue') === null, 'null value dropped');

section('isEnglishLang');
assert(isEnglishLang('en'), 'en');
assert(isEnglishLang('eng'), 'eng');
assert(isEnglishLang('EN'), 'EN case-insensitive');
assert(!isEnglishLang('de'), 'de not english');
assert(!isEnglishLang(null), 'null not english');
assert(!isEnglishLang(undefined), 'undefined not english');

section('truncateToBytes: UTF-8 boundary correctness');
function isValidUtf8Bytes(s) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(s);
  try { decoder.decode(bytes); return true; } catch { return false; }
}
assert(truncateToBytes('hello', 100) === 'hello', 'no-op when under cap');
assert(truncateToBytes('hello', 5) === 'hello', 'exact fit');
assert(truncateToBytes('hello', 3) === 'hel', 'ASCII truncation');
assert(truncateToBytes('', 10) === '', 'empty input');
assert(truncateToBytes('é', 1) === '', 'partial 2-byte sequence rounded down');
assert(truncateToBytes('é', 2) === 'é', 'full 2-byte sequence kept');
assert(truncateToBytes('水', 1) === '', 'partial 3-byte at 1 rounded down');
assert(truncateToBytes('水', 2) === '', 'partial 3-byte at 2 rounded down');
assert(truncateToBytes('水', 3) === '水', 'full 3-byte sequence kept');
assert(truncateToBytes('🎵', 3) === '', 'partial 4-byte rounded down');
assert(truncateToBytes('🎵', 4) === '🎵', 'full 4-byte sequence kept');
const mixed = 'abc水def🎵ghi';
for (let maxBytes = 0; maxBytes <= utf8ByteLength(mixed) + 5; maxBytes++) {
  const out = truncateToBytes(mixed, maxBytes);
  assert(utf8ByteLength(out) <= maxBytes, `truncated to <= ${maxBytes} bytes`);
  assert(isValidUtf8Bytes(out), `valid UTF-8 at maxBytes=${maxBytes}`);
}

section('AUDIO_HOST_ALLOWLIST + URL guard');
// Old test grepped each context's source for a mirrored literal. With a
// single shared module the parity is structural; verify the guard behaves
// as documented instead.
assert(AUDIO_HOST_ALLOWLIST.has('upload.wikimedia.org'), 'allowlist contains upload.wikimedia.org');
assert(AUDIO_HOST_ALLOWLIST.size === 1, 'allowlist has exactly one host (broaden carefully)');
assert(isAllowedAudioUrl('https://upload.wikimedia.org/x.ogg'), 'allowlist allows https Wikimedia');
assert(!isAllowedAudioUrl('http://upload.wikimedia.org/x.ogg'), 'http rejected even for allowlisted host');
assert(!isAllowedAudioUrl('https://attacker.example/x.ogg'), 'non-allowlisted host rejected');
assert(!isAllowedAudioUrl('https://upload.wikimedia.org.attacker.example/'), 'host suffix attack rejected');
assert(!isAllowedAudioUrl('not a url'), 'malformed rejected');
assert(!isAllowedAudioUrl(null), 'null rejected');
assert(!isAllowedAudioUrl(undefined), 'undefined rejected');
assert(!isAllowedAudioUrl(/** @type {any} */ (42)), 'number rejected');

section('Byte-cap invariants');
// OUTPUT_MAX_BYTES is offscreen-local; the documented invariant is that
// the output cap exceeds the input cap (PCM expands lossy sources so
// transcoded WAV is always larger than the source).
assert(OUTPUT_MAX_BYTES > PER_FILE_MAX_BYTES,
  `OUTPUT_MAX_BYTES (${OUTPUT_MAX_BYTES}) > PER_FILE_MAX_BYTES (${PER_FILE_MAX_BYTES})`);
assert(PER_FILE_MAX_BYTES > 0, 'PER_FILE_MAX_BYTES positive');

section('ByteBoundedCache: invariants and eviction order');
// Trivial case: empty cache.
const c0 = new ByteBoundedCache(100);
assert(c0.size() === 0, 'empty: size=0');
assert(c0.bytes() === 0, 'empty: bytes=0');
assert(c0.peek('x') === null, 'empty: peek returns null');
assert(c0.delete('x') === false, 'empty: delete returns false');

// Basic set/peek/delete.
const c1 = new ByteBoundedCache(100);
assert(c1.set('a', 'A', 10) === true, 'set: first entry stored');
assert(c1.size() === 1, 'set: size=1');
assert(c1.bytes() === 10, 'set: bytes=10');
assert(c1.has('a'), 'has: true after set');
assert(c1.peek('a') === 'A', 'peek: returns value');
assert(c1.delete('a') === true, 'delete: returns true on hit');
assert(c1.size() === 0, 'delete: size=0 after');
assert(c1.bytes() === 0, 'delete: bytes=0 after');

// set refuses duplicates and oversize entries; caller keeps ownership.
const evictions = [];
const c2 = new ByteBoundedCache(50, v => evictions.push(v));
assert(c2.set('a', 'A', 10) === true, 'set: first store');
assert(c2.set('a', 'A2', 10) === false, 'set: duplicate refused');
assert(c2.peek('a') === 'A', 'duplicate refused: original kept');
assert(c2.set('big', 'BIG', 51) === false, 'set: oversize refused');
assert(evictions.length === 0, 'oversize refused: onEvict NOT called for refused value');

// Eviction order is insertion order (LRU = oldest at head).
const c3 = new ByteBoundedCache(30, v => evictions.push(v));
evictions.length = 0;
c3.set('a', 'A', 10);
c3.set('b', 'B', 10);
c3.set('c', 'C', 10);
assert(c3.bytes() === 30, 'three at cap: bytes=30');
c3.set('d', 'D', 10);
assert(evictions.join(',') === 'A', 'oldest evicted first');
assert(c3.has('a') === false, 'oldest gone after eviction');
assert(c3.has('d'), 'newest present after eviction');
assert(c3.bytes() === 30, 'bytes still at cap after eviction');

// peek refreshes recency: a touched entry survives the next eviction.
evictions.length = 0;
const c4 = new ByteBoundedCache(30, v => evictions.push(v));
c4.set('a', 'A', 10);
c4.set('b', 'B', 10);
c4.set('c', 'C', 10);
c4.peek('a');
c4.set('d', 'D', 10);
assert(evictions.join(',') === 'B', 'peek refreshed recency: b evicted instead of a');
assert(c4.has('a'), 'a survived after peek-refresh');
assert(c4.has('d'), 'd inserted');

// Bytes invariant holds through mixed sequences.
evictions.length = 0;
const c5 = new ByteBoundedCache(100, v => evictions.push(v));
const ops = [
  () => c5.set('x', 'X', 30),
  () => c5.set('y', 'Y', 25),
  () => c5.set('z', 'Z', 40),
  () => c5.peek('x'),
  () => c5.delete('y'),
  () => c5.set('w', 'W', 50),
  () => c5.peek('z'),
  () => c5.set('v', 'V', 90),
];
for (const op of ops) op();
let expectedBytes = 0;
for (const k of c5.keys()) {
  expectedBytes += ({ x: 30, y: 25, z: 40, w: 50, v: 90 })[k] || 0;
}
assert(c5.bytes() === expectedBytes,
  `bytes invariant: cache reports ${c5.bytes()}, sum of live entries is ${expectedBytes}`);

// onEvict on explicit delete (transcoded cache's blob-revoke contract).
evictions.length = 0;
const c6 = new ByteBoundedCache(100, v => evictions.push(v));
c6.set('a', 'A', 10);
c6.delete('a');
assert(evictions.join(',') === 'A', 'delete calls onEvict');

// Reject inputs that would corrupt the bytes counter. NaN slips past a
// bare `> maxBytes` because NaN comparisons are always false; without the
// Number.isFinite gate the NaN would land in #bytes and never recover.
const c7 = new ByteBoundedCache(100);
assert(c7.set('nan', 'X', NaN) === false, 'NaN byteCost refused');
assert(c7.set('neg', 'X', -1) === false, 'negative byteCost refused');
assert(c7.set('inf', 'X', Infinity) === false, 'Infinity byteCost refused');
assert(c7.size() === 0 && c7.bytes() === 0, 'refused inserts left cache empty');
assert(c7.set('ok', 'X', 0) === true, 'zero byteCost accepted (some payloads legitimately have no cost)');
assert(c7.bytes() === 0, 'zero-byteCost entry contributes 0 to bytes()');

// onEvict-throws keeps cache invariants intact. The contract: a throwing
// callback propagates the error to set/delete, but #bytes stays in sync
// with #map and the entry is consistently removed.
const c8 = new ByteBoundedCache(30, () => { throw new Error('boom'); });
c8.set('a', 'A', 10);
c8.set('b', 'B', 10);
c8.set('c', 'C', 10);
let threwOnEviction = false;
try { c8.set('d', 'D', 10); } catch { threwOnEviction = true; }
assert(threwOnEviction, 'throwing onEvict propagates to set caller');
// After the throw: the cache state must still be coherent. 'a' was the
// eviction target (it should be gone), and the failed onEvict shouldn't
// leave its bytes in the counter.
assert(c8.has('a') === false, 'invariant: evicted entry is gone even though onEvict threw');
assert(c8.bytes() === c8.size() * 10, 'invariant: #bytes still equals sum of live entries after throw');
let deleteThrew = false;
const c9 = new ByteBoundedCache(100, () => { throw new Error('boom'); });
c9.set('a', 'A', 10);
try { c9.delete('a'); } catch { deleteThrew = true; }
assert(deleteThrew, 'throwing onEvict propagates from delete too');
assert(c9.has('a') === false, 'delete: entry gone even though onEvict threw');
assert(c9.bytes() === 0, 'delete: #bytes correct even though onEvict threw');

section('createModeCache: transient failure does not poison the cache');
const { createModeCache } = await import('../../src/shared/mode-cache.mjs');

// Helper: build a `get` that scripts a sequence of returns. Each call
// pops the next entry; a string resolves, an Error rejects.
function scriptedGet(...steps) {
  let i = 0;
  const calls = [];
  const get = async () => {
    calls.push(i);
    const step = steps[i++];
    if (step instanceof Error) throw step;
    return { mode: step };
  };
  return { get, calls };
}

// 1. Happy path: first call hits storage, subsequent calls hit cache.
{
  const { get, calls } = scriptedGet('convert', 'both' /* never reached */);
  const getMode = createModeCache({ get });
  assert((await getMode()) === 'convert', 'first call resolves to convert');
  assert((await getMode()) === 'convert', 'second call also returns convert');
  assert((await getMode()) === 'convert', 'third call also returns convert');
  assert(calls.length === 1, 'storage was only hit once after first resolution');
}

// 2. Concurrent calls during the first await share the same Promise.
{
  const { get, calls } = scriptedGet('both');
  const getMode = createModeCache({ get });
  const [a, b, c] = await Promise.all([getMode(), getMode(), getMode()]);
  assert(a === 'both' && b === 'both' && c === 'both', 'all concurrent calls see same value');
  assert(calls.length === 1, 'concurrent calls deduped to single storage round-trip');
}

// 3. Transient failure returns 'original' but does NOT cache it.
//    The next call retries and gets the real preference.
{
  const { get, calls } = scriptedGet(new Error('transport'), 'convert');
  const getMode = createModeCache({ get });
  assert((await getMode()) === 'original', 'failure: returns original for this call');
  assert((await getMode()) === 'convert', 'next call retries and gets real value');
  assert(calls.length === 2, 'two storage round-trips: one failed, one retried');
  assert((await getMode()) === 'convert', 'subsequent call uses cached real value');
  assert(calls.length === 2, 'no third round-trip after successful cache');
}

// 4. onChanged invalidates the cache.
{
  /** @type {((changes: any, area: string) => void) | null} */
  let listener = null;
  const { get, calls } = scriptedGet('convert', 'both');
  const getMode = createModeCache({
    get,
    onChanged: (cb) => { listener = cb; },
  });
  assert((await getMode()) === 'convert', 'initial value cached');
  assert(listener !== null, 'onChanged was registered');
  // Simulate the popup changing the mode.
  /** @type {(changes: any, area: string) => void} */
  const l = listener;
  l({ mode: { newValue: 'both' } }, 'sync');
  assert((await getMode()) === 'both', 'cache invalidated; next call re-fetches');
  assert(calls.length === 2, 'two fetches: initial + post-invalidation');
}

// 5. onChanged ignores irrelevant changes (different area, different key).
{
  /** @type {((changes: any, area: string) => void) | null} */
  let listener = null;
  const { get, calls } = scriptedGet('convert');
  const getMode = createModeCache({
    get,
    onChanged: (cb) => { listener = cb; },
  });
  assert((await getMode()) === 'convert', 'initial value cached');
  /** @type {(changes: any, area: string) => void} */
  const l = listener;
  l({ mode: { newValue: 'both' } }, 'local');   // wrong area
  l({ unrelated: { newValue: 'x' } }, 'sync');  // unrelated key
  assert((await getMode()) === 'convert', 'cache survived irrelevant changes');
  assert(calls.length === 1, 'no second fetch');
}

// 6. Unknown mode values coerce to 'original'.
{
  const { get } = scriptedGet('garbage');
  const getMode = createModeCache({ get });
  assert((await getMode()) === 'original', 'unknown string coerced to original');
}
{
  const { get } = scriptedGet(undefined);
  const getMode = createModeCache({ get });
  assert((await getMode()) === 'original', 'missing mode defaults to original');
}

section('isAudioContentType predicate');
const { isAudioContentType } = await import('../../src/shared/content-type.mjs');
// Positive cases.
assert(isAudioContentType('audio/ogg'), 'audio/ogg accepted');
assert(isAudioContentType('audio/mpeg'), 'audio/mpeg accepted');
assert(isAudioContentType('audio/wav'), 'audio/wav accepted');
assert(isAudioContentType('audio/flac'), 'audio/flac accepted');
assert(isAudioContentType('AUDIO/OGG'), 'case insensitive');
assert(isAudioContentType('application/ogg'), 'Wikimedia legacy application/ogg accepted');
assert(isAudioContentType('application/ogg; codecs=opus'), 'parameters tolerated on application/ogg');
assert(isAudioContentType('audio/ogg; codecs=vorbis'), 'parameters tolerated on audio/*');
// Negative cases.
assert(!isAudioContentType('text/html'), 'text/html rejected');
assert(!isAudioContentType('image/png'), 'image/png rejected');
assert(!isAudioContentType('video/mp4'), 'video/mp4 rejected');
assert(!isAudioContentType('application/pdf'), 'application/pdf rejected');
assert(!isAudioContentType('application/octet-stream'), 'application/octet-stream rejected');
assert(!isAudioContentType(''), 'empty string rejected');
assert(!isAudioContentType(null), 'null rejected');
assert(!isAudioContentType(undefined), 'undefined rejected');

// ============ SUMMARY ============
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed.');
