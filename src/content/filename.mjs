// @ts-check
// Parse Wiktionary pronunciation filenames into structured fields, then
// format friendly names (`english_australian_Georgian.ogg`) and display
// strings (`English Australian 'Georgian' .ogg`). Unparseable input falls
// back to the stem so we never lose a file.
//
// Patterns handled:
//   En-au-Georgian.ogg                -> lang=en, dialect=au, word=Georgian
//   De-Wasser.ogg                     -> lang=de, word=Wasser
//   LL-Q1860_(eng)-Speaker-water.wav  -> lang=eng, speaker, word=water
//
// Pure module: no DOM / chrome.* / location. Node-importable for tests.

/**
 * @typedef {object} ParsedFilename
 * @property {string|null} lang
 * @property {string|null} dialect
 * @property {string|null} speaker
 * @property {string} word
 * @property {string|null} extra
 * @property {string} ext
 */

// 639-3 -> 639-1 lift for LinguaLibre's parens-form codes (Intl doesn't
// resolve 3-letter codes reliably). Language display itself comes from
// Intl.DisplayNames.
const ISO_639_3_TO_1 = {
  eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it',
  jpn: 'ja', zho: 'zh', cmn: 'zh', yue: 'zh', por: 'pt',
  nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  pol: 'pl', rus: 'ru', ara: 'ar', hin: 'hi', kor: 'ko',
  tur: 'tr', ukr: 'uk', ces: 'cs', ell: 'el', heb: 'he',
  tha: 'th', vie: 'vi', ron: 'ro', hun: 'hu', ind: 'id',
};

// Non-ISO codes seen as Wiktionary file prefixes for variety-specific
// recordings. Verified against the live sweep.
const LANG_OVERRIDES = {
  qc: 'quebec-french',
  jer: 'jèrriais',
};

// Adjective form for filename use (Intl returns nouns: "United States" vs
// "american"). Unlisted codes fall through to Intl's region name.
// Separator convention: `-` within a field, `_` between fields.
const DIALECT_ADJECTIVES = {
  us: 'american', uk: 'british', gb: 'british',
  au: 'australian', ca: 'canadian', ie: 'irish',
  nz: 'new-zealand', za: 'south-african', in: 'indian',
  mx: 'mexican', ar: 'argentinian', br: 'brazilian',
  at: 'austrian', ch: 'swiss', be: 'belgian',
  'am-lat': 'latin-american', 'am_lat': 'latin-american',
  // English regional tags seen in real Wiktionary audio.
  inlandnorth: 'inland-north', gen: 'general', gam: 'general-american',
  cmn: 'mandarin', yue: 'cantonese', wuu: 'shanghainese',
  nan: 'min-nan', hak: 'hakka',
  // Regional French.
  qc: 'quebec',
};

// Intl.DisplayNames instances cached per locale. `[locale, 'en']` lets the
// runtime fall back to English if the requested locale is missing from
// ICU data.
const LANG_DISPLAY_CACHE = new Map();
function getLangDisplay(locale) {
  if (LANG_DISPLAY_CACHE.has(locale)) return LANG_DISPLAY_CACHE.get(locale);
  let inst = null;
  try { inst = new Intl.DisplayNames([locale, 'en'], { type: 'language', fallback: 'code' }); }
  catch { /* runtime missing Intl.DisplayNames or unsupported locale */ }
  LANG_DISPLAY_CACHE.set(locale, inst);
  return inst;
}
const REGION_DISPLAY_CACHE = new Map();
function getRegionDisplay(locale) {
  if (REGION_DISPLAY_CACHE.has(locale)) return REGION_DISPLAY_CACHE.get(locale);
  let inst = null;
  try { inst = new Intl.DisplayNames([locale, 'en'], { type: 'region', fallback: 'code' }); }
  catch { /* runtime missing Intl.DisplayNames or unsupported locale */ }
  REGION_DISPLAY_CACHE.set(locale, inst);
  return inst;
}

// Within a single field, multi-word values use `-`. "United States" -> "united-states".
function slugifyName(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Source `_` and whitespace -> `-` so within-field separators don't
// collide with the `_` we use between fields.
function normalizeFieldValue(v) {
  if (v === null || v === undefined) return v;
  return String(v).replace(/[_\s]+/g, '-');
}

// Stable English slug for filenames. Locale-independent so the same audio
// file produces the same on-disk filename regardless of which Wiktionary
// edition the user is on.
function describeLanguage(code) {
  if (!code) return null;
  let key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANG_OVERRIDES, key)) {
    return LANG_OVERRIDES[key];
  }
  if (Object.prototype.hasOwnProperty.call(ISO_639_3_TO_1, key)) {
    key = ISO_639_3_TO_1[key];
  }
  const display = getLangDisplay('en');
  if (display) {
    try {
      const name = display.of(key);
      if (name && name.toLowerCase() !== key) return slugifyName(name);
    } catch { /* fall through */ }
  }
  return normalizeFieldValue(key);
}

function describeDialect(code) {
  if (!code) return null;
  const key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DIALECT_ADJECTIVES, key)) {
    return DIALECT_ADJECTIVES[key];
  }
  const REGION_DISPLAY = getRegionDisplay('en');
  // Compound: `us-inlandnorth` -> `american-inland-north`, piece by piece.
  if (key.includes('-') || key.includes('_')) {
    const parts = key.split(/[-_]/);
    const mapped = parts.map((p) => {
      if (Object.prototype.hasOwnProperty.call(DIALECT_ADJECTIVES, p)) {
        return DIALECT_ADJECTIVES[p];
      }
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
      const display = REGION_DISPLAY.of(key.toUpperCase());
      if (display && display.toLowerCase() !== key) return slugifyName(display);
    } catch { /* fall through */ }
  }
  return normalizeFieldValue(key);
}

// Localized name for display. Returns Intl output verbatim (preserves
// Unicode and case) so a French Wiktionary page shows "Anglais" rather
// than the English "English", and a German page shows "Englisch". Falls
// back to the LANG_OVERRIDES adjective form for non-ISO codes.
function describeLanguageDisplay(code, locale) {
  if (!code) return null;
  let key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANG_OVERRIDES, key)) {
    return LANG_OVERRIDES[key];
  }
  if (Object.prototype.hasOwnProperty.call(ISO_639_3_TO_1, key)) {
    key = ISO_639_3_TO_1[key];
  }
  const display = getLangDisplay(locale);
  if (display) {
    try {
      const name = display.of(key);
      if (name && name.toLowerCase() !== key) return name;
    } catch { /* fall through */ }
  }
  return key;
}

// Dialect display intentionally reuses describeDialect (English region
// adjectives). Dialect labels are typically anglocentric short forms
// ('American', 'British') that are not meaningfully localized; mixing
// languages on the panel (e.g. "Anglais American") is a clearer tradeoff
// than translating only the language portion.

// Escape set is sufficient for non-`u`-flag regexes. If any consumer ever
// adds the `u` flag, also escape `-` and `/` (significant in `u` mode
// character classes).
/** @param {string} s */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `knownWord` (the page title) anchors the trailing word segment when set,
// which disambiguates hyphenated speakers (LL-Q1860-Speaker-Name-water)
// from hyphenated words (well-known) that look the same structurally.
/**
 * @param {string} raw  filename or URL; query/fragment stripped
 * @param {string|null} [knownWord]
 * @returns {ParsedFilename}
 */
export function parseAudioFilename(raw, knownWord = null) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', extra: null, ext: '' };

  let decoded = String(raw).split('?')[0].split('#')[0];
  try { decoded = decodeURIComponent(decoded); } catch { /* malformed %XX */ }
  const base = decoded.split('/').pop() || decoded;

  const extMatch = base.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;

  // Each pattern has two flavors: anchored (uses knownWord as trailing
  // word) and unanchored (greedy speaker, last token as word).
  const wordAnchor = knownWord ? escapeRegex(knownWord) : null;

  // LinguaLibre parens-form: LL-Q<num>_(<lang3>)-<speaker>-<word>
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-Q\\d+_\\(([a-z]{2,3})\\)-(.+)-(${wordAnchor})$`, 'i'));
    if (m) return { lang: m[1].toLowerCase(), dialect: null, speaker: m[2], word: m[3], extra: null, ext };
  }
  const ll1 = stem.match(/^LL-Q\d+_\(([a-z]{2,3})\)-(.+)-([^-]+)$/i);
  if (ll1) {
    return { lang: ll1[1].toLowerCase(), dialect: null, speaker: ll1[2], word: ll1[3], extra: null, ext };
  }

  // LL-Q<num>-<speaker>-<word>; Q-number is a Wikidata language ref we
  // don't resolve, so lang stays null here.
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-Q\\d+-(.+)-(${wordAnchor})$`));
    if (m) return { lang: null, dialect: null, speaker: m[1], word: m[2], extra: null, ext };
  }
  const ll2 = stem.match(/^LL-Q\d+-(.+)-([^-]+)$/);
  if (ll2) {
    return { lang: null, dialect: null, speaker: ll2[1], word: ll2[2], extra: null, ext };
  }

  // LinguaLibre speaker-first hyphen form: LL-<speaker>-<lang2or3>-<word>
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-(.+)-([a-z]{2,3})-(${wordAnchor})$`));
    if (m) return { lang: m[2].toLowerCase(), dialect: null, speaker: m[1], word: m[3], extra: null, ext };
  }
  const ll3 = stem.match(/^LL-(.+)-([a-z]{2,3})-([^-]+)$/);
  if (ll3) {
    return { lang: ll3[2].toLowerCase(), dialect: null, speaker: ll3[1], word: ll3[3], extra: null, ext };
  }

  // <Lang>-<dialect>-<word>, with anchored vs unanchored flavors. The
  // anchored form lets dialect be arbitrarily long (catches compound
  // tags like `us-inlandnorth`) without breaking variant-index cases
  // like `En-us-hello-4`.
  if (wordAnchor) {
    // `pageTitle` or `pageTitle-<short-suffix>` (variant recordings).
    const shortTail = `(?:${wordAnchor}|${wordAnchor}-[a-z0-9]{1,12})`;
    const reShort = new RegExp(`^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,28}[a-z])-(${shortTail})$`);
    const m1 = stem.match(reShort);
    if (m1) {
      return { lang: m1[1].toLowerCase(), dialect: m1[2], speaker: null, word: m1[3], extra: null, ext };
    }
    // `pageTitle-<long-hyphenated-suffix>` (phonetic features like
    // En-us-water-cot-caught-merger). The tail is captured as `extra`
    // so display can render it parenthetical.
    const reExtra = new RegExp(`^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,28}[a-z])-(${wordAnchor})-(.+)$`);
    const m2 = stem.match(reExtra);
    if (m2) {
      return { lang: m2[1].toLowerCase(), dialect: m2[2], speaker: null, word: m2[3], extra: m2[4], ext };
    }
  }
  const langDialect = stem.match(/^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,5}[a-z])-(.+)$/);
  if (langDialect) {
    return {
      lang: langDialect[1].toLowerCase(),
      dialect: langDialect[2],
      speaker: null,
      word: langDialect[3],
      extra: null,
      ext,
    };
  }

  // <Lang>-<word>  e.g. De-Wasser
  const langWord = stem.match(/^([A-Z][a-z]{0,2})-(.+)$/);
  if (langWord) {
    return { lang: langWord[1].toLowerCase(), dialect: null, speaker: null, word: langWord[2], extra: null, ext };
  }

  return { lang: null, dialect: null, speaker: null, word: stem, extra: null, ext };
}

// Filename for chrome.downloads. `_` between fields, `-` within fields.
/** @param {ParsedFilename} parsed @returns {string} */
export function friendlyAudioFilename(parsed) {
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

// Human display for the panel. Same fields, prose layout. Falls back to
// the source filename verbatim when nothing parsed.
//   En-au-friendo.ogg                  -> English Australian 'friendo' .ogg
//   De-Wasser.ogg                      -> German 'Wasser' .ogg
//   LL-Q1860_(eng)-Stebbington-water   -> English 'water' by Stebbington .wav
function titleCasePart(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {ParsedFilename} parsed
 * @param {string} originalFilename
 * @param {string} [locale]  page locale (from pickLocale); defaults to English.
 *   When set, language and dialect names render in the page's language
 *   instead of forcing English on every Wiktionary edition.
 */
export function humanReadableName(parsed, originalFilename, locale = 'en') {
  if (!parsed.lang && !parsed.dialect && !parsed.speaker) {
    return originalFilename;
  }
  const parts = [];
  if (parsed.lang) {
    const lang = describeLanguageDisplay(parsed.lang, locale);
    if (lang) parts.push(lang.split('-').map(titleCasePart).join(' '));
  }
  if (parsed.dialect) {
    const dialect = describeDialect(parsed.dialect);
    if (dialect) parts.push(dialect.split('-').map(titleCasePart).join(' '));
  }
  parts.push(`'${String(parsed.word).replace(/_/g, ' ')}'`);
  if (parsed.extra) {
    // "cot-caught-merger" -> "(cot caught merger)".
    parts.push(`(${String(parsed.extra).replace(/[-_]/g, ' ')})`);
  }
  if (parsed.speaker) {
    parts.push(`by ${String(parsed.speaker).replace(/_/g, ' ')}`);
  }
  return parts.join(' ') + (parsed.ext ? ` .${parsed.ext}` : '');
}
