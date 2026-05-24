// @ts-check
// Filename parser, formatter, and human-readable display for Wiktionary
// pronunciation audio.
//
// Wiktionary pronunciation files follow a few common patterns. We parse
// them into structured fields so the panel and downloaded file get a
// friendlier name like `english_australian_Georgian.ogg` instead of
// `En-au-Georgian.ogg`.
//
// Patterns handled:
//   En-au-Georgian.ogg              -> en, dialect=au,  word=Georgian
//   De-Wasser.ogg                   -> de, word=Wasser
//   LL-Q1860_(eng)-Speaker-water.wav -> eng, speaker=Speaker, word=water
// Unparseable input falls back to the stem, so we never lose the file.
//
// Pure module: no DOM, no chrome.*, no `location`. Node-importable for
// unit tests.

/**
 * @typedef {object} ParsedFilename
 * @property {string|null} lang
 * @property {string|null} dialect
 * @property {string|null} speaker
 * @property {string} word
 * @property {string|null} extra
 * @property {string} ext
 */

// Language coverage is delegated to the browser's Intl.DisplayNames, which
// already knows ~150 ISO 639-1 codes. We only carry a tiny 639-3 -> 639-1 lift
// table for the codes LinguaLibre uses in parens (`eng`, `deu`, etc.) since
// Intl's language type doesn't always recognize 3-letter codes.
const ISO_639_3_TO_1 = {
  eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it',
  jpn: 'ja', zho: 'zh', cmn: 'zh', yue: 'zh', por: 'pt',
  nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  pol: 'pl', rus: 'ru', ara: 'ar', hin: 'hi', kor: 'ko',
  tur: 'tr', ukr: 'uk', ces: 'cs', ell: 'el', heb: 'he',
  tha: 'th', vie: 'vi', ron: 'ro', hun: 'hu', ind: 'id',
};

// Overrides for codes that aren't standard ISO 639 (or that Intl resolves
// poorly). These usually appear in Wiktionary as the file's language prefix
// when the file is region-specific (Qc = Quebec French) or when the variety
// has its own entry on Wiktionary even though it shares a parent language
// (Jer = Jèrriais, a variety of Norman). Kept small. Only verified from
// real data in the live sweep.
const LANG_OVERRIDES = {
  qc: 'quebec-french',
  jer: 'jèrriais',
};

// Dialect adjectives. Intl returns nouns ("United States", "Australia") via
// the region API, but filenames read more naturally with adjectives. This
// table is intentionally short. Anything not listed falls through to the
// region API, then to the raw code.
//
// Separator convention: `-` joins words within a single field value; `_`
// joins different fields (handled in friendlyAudioFilename). So
// `latin-american` (one field) but `spanish_latin-american_agua` (three).
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

const LANG_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' }); }
  catch { return null; }
})();
const REGION_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }); }
  catch { return null; }
})();

// Within a single field, multi-word values use `-`. "United States" -> "united-states".
function slugifyName(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Normalize a field value pulled directly from the source filename (word or
// speaker). Source underscores and whitespace become `-` so they don't collide
// with the `_` we use to join different fields.
function normalizeFieldValue(v) {
  if (v === null || v === undefined) return v;
  return String(v).replace(/[_\s]+/g, '-');
}

function describeLanguage(code) {
  if (!code) return null;
  let key = code.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANG_OVERRIDES, key)) {
    return LANG_OVERRIDES[key];
  }
  if (Object.prototype.hasOwnProperty.call(ISO_639_3_TO_1, key)) {
    key = ISO_639_3_TO_1[key];
  }
  if (LANG_DISPLAY) {
    try {
      const display = LANG_DISPLAY.of(key);
      if (display && display.toLowerCase() !== key) return slugifyName(display);
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
  // Compound dialects like `us-inlandnorth` resolve piece-by-piece:
  // us -> 'american', inlandnorth -> 'inland-north', joined as
  // 'american-inland-north'. Falls back to the raw piece when no mapping.
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

// The escape set below covers the metacharacters meaningful in regex
// literals WITHOUT the `u` flag. If any caller ever constructs a Unicode-
// mode regex (RegExp(..., 'u') or /.../u), this set must also escape `-`
// and `/` to be safe inside character classes, and the function needs to
// handle Unicode property escapes that the non-Unicode parser tolerates.
// Today no consumer uses the `u` flag.
/** @param {string} s */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a Wiktionary audio filename into structured fields. When `knownWord`
 * (the page title) is supplied, the parser anchors the trailing `word`
 * segment to it, disambiguating hyphenated speakers from hyphenated words
 * like "well-known".
 *
 * @param {string} raw  filename or URL; query string is stripped defensively
 * @param {string|null} [knownWord]
 * @returns {ParsedFilename}
 */
export function parseAudioFilename(raw, knownWord = null) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', extra: null, ext: '' };

  // Strip query string / fragment defensively (real Wikimedia URLs don't carry
  // them, but tracking-rewriter proxies sometimes append things like
  // ?utm_source=...). Then decode and take the last path segment.
  let decoded = String(raw).split('?')[0].split('#')[0];
  try { decoded = decodeURIComponent(decoded); } catch { /* malformed pct */ }
  const base = decoded.split('/').pop() || decoded;

  const extMatch = base.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;

  // Build LL regexes once. Two flavors per pattern: anchored (uses knownWord
  // as the trailing word) and unanchored (greedy speaker, last token as word).
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

  // LinguaLibre hyphenated Q-form: LL-Q<num>-<speaker>-<word>
  // (Q-number references a Wikidata language; we leave lang null rather than
  // bake in a Q-ID -> ISO code map.)
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

  // <Lang>-<dialect>-<word>. Two flavors, in priority order:
  //
  //   (a) Anchored: word must equal pageTitle (or pageTitle with a short
  //       variant suffix like `-2`, `-fast`). This lets dialect be arbitrarily
  //       long, which is what surfaces compound regional tags like
  //       `us-inlandnorth` (American Inland North) without breaking the more
  //       common `En-us-hello-4` case (variant index).
  //
  //   (b) Unanchored: dialect capped at 7 chars total. Handles the simple
  //       case (En-au-Georgian, Es-am_lat-agua) without context.
  if (wordAnchor) {
    // (a) `pageTitle` or `pageTitle-<short-suffix>` (variant recordings).
    const shortTail = `(?:${wordAnchor}|${wordAnchor}-[a-z0-9]{1,12})`;
    const reShort = new RegExp(`^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,28}[a-z])-(${shortTail})$`);
    const m1 = stem.match(reShort);
    if (m1) {
      return { lang: m1[1].toLowerCase(), dialect: m1[2], speaker: null, word: m1[3], extra: null, ext };
    }
    // (b) `pageTitle-<long-hyphenated-suffix>` (phonetic feature, e.g.
    //     En-us-water-cot-caught-merger.ogg). The hyphenated tail is captured
    //     as `extra` so display can show it as a qualifier like
    //     `English American 'water' (cot caught merger) .ogg`.
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

/**
 * Compose the sanitized filename used for the actual chrome.downloads save.
 * `_` joins different fields; within-field separators are already `-`.
 * @param {ParsedFilename} parsed
 * @returns {string}
 */
export function friendlyAudioFilename(parsed) {
  const parts = [];
  const lang = describeLanguage(parsed.lang);
  if (lang) parts.push(lang);
  const dialect = describeDialect(parsed.dialect);
  if (dialect) parts.push(dialect);
  parts.push(normalizeFieldValue(parsed.word));
  // Phonetic qualifier (e.g. "cot-caught-merger") goes right after the word
  // so files with the same word but different features remain distinguishable.
  if (parsed.extra) parts.push(normalizeFieldValue(parsed.extra));
  // Speaker disambiguator (LinguaLibre) so multiple speakers don't collide.
  if (parsed.speaker) parts.push(normalizeFieldValue(parsed.speaker));
  // `_` joins different fields; within-field separators are already `-`.
  const stem = parts.join('_');
  return parsed.ext ? `${stem}.${parsed.ext}` : stem;
}

// Human-readable display string for the on-page panel. Same parsed fields as
// the download name, but rendered for humans: title-cased language and
// dialect, word in single quotes, optional speaker, extension separated.
//   En-au-friendo.ogg                  -> English Australian 'friendo' .ogg
//   De-Wasser.ogg                      -> German 'Wasser' .ogg
//   LL-Q1860_(eng)-Stebbington-water   -> English 'water' by Stebbington .wav
//   Unparseable input                  -> original filename, verbatim
function titleCasePart(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render a parsed filename as the human-readable string shown in the panel.
 * Unparseable inputs (no lang/dialect/speaker) fall back to the source
 * filename verbatim so the user can still recognize what they're looking at.
 * @param {ParsedFilename} parsed
 * @param {string} originalFilename
 * @returns {string}
 */
export function humanReadableName(parsed, originalFilename) {
  if (!parsed.lang && !parsed.dialect && !parsed.speaker) {
    return originalFilename;
  }
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
  if (parsed.extra) {
    // Phonetic qualifier shown in parens, with hyphens converted to spaces
    // for readability: "cot-caught-merger" -> "(cot caught merger)".
    parts.push(`(${String(parsed.extra).replace(/[-_]/g, ' ')})`);
  }
  if (parsed.speaker) {
    parts.push(`by ${String(parsed.speaker).replace(/_/g, ' ')}`);
  }
  return parts.join(' ') + (parsed.ext ? ` .${parsed.ext}` : '');
}
