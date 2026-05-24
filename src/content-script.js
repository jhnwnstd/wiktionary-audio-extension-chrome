// @ts-check
// content-script.js: Wiktionary audio discovery, UI panel, download actions.

/**
 * One pronunciation audio entry surfaced by Action API discovery. Every
 * field is always present (no optionals) so the V8 hidden class stays
 * stable across the lifecycle: audioItemsFromPages builds the full shape,
 * main() fills the computed fields, the panel reads them.
 *
 * @typedef {object} AudioItem
 * @property {string} title  MediaWiki File: title
 * @property {string} url  direct upload.wikimedia.org URL
 * @property {string} filename  source filename (e.g. "En-us-water.ogg")
 * @property {string|null} mime
 * @property {number|null} size
 * @property {string} downloadName  sanitized friendly filename for chrome.downloads
 * @property {string} displayName  human readable form rendered in the panel
 * @property {string|null} lang  parsed ISO 639 code, used by the English first sort
 */

/**
 * Structured fields extracted from a Wiktionary audio filename. Any field
 * can be null when the parser can't recover it; downstream formatters skip
 * null fields rather than emitting an empty token.
 * @typedef {object} ParsedFilename
 * @property {string|null} lang
 * @property {string|null} dialect
 * @property {string|null} speaker
 * @property {string} word
 * @property {string|null} extra  phonetic qualifier (e.g. "cot-caught-merger")
 * @property {string} ext  extension without leading dot, lowercased
 */

// IIFE keeps `logError` file-scoped (background.js has its own). The
// shared DownloadResponse type is ambient in src/globals.d.ts.
(() => {

const logError = console.error.bind(console);

// ============== EXTENSION CONTEXT ==============

function isExtensionContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

/**
 * Send a message to the service worker, race it against a timeout, and
 * surface chrome.runtime.lastError as a rejection. Resolves with whatever
 * the background's `sendResponse` produced.
 * @param {object} message
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<DownloadResponse | undefined>}
 */
async function safeSendMessage(message, { timeoutMs = 90000 } = {}) {
  if (!isExtensionContextValid()) {
    showContextInvalidatedMessage();
    throw new Error('Extension context invalidated');
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function showContextInvalidatedMessage() {
  if (document.querySelector('.wiktionary-audio-context-notice')) return;
  const notice = document.createElement('div');
  notice.className = 'wiktionary-audio-context-notice';
  notice.style.cssText = `
    position:fixed;top:20px;right:20px;z-index:2147483647;
    background:#f44336;color:#fff;padding:12px 16px;border-radius:8px;
    font:14px system-ui;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,.2)`;

  // Built with DOM APIs (not innerHTML) so the page's CSP can't block the
  // reload handler, and so future translation strings can't accidentally
  // introduce HTML they shouldn't.
  const strong = document.createElement('strong');
  strong.textContent = t.extensionReloaded;
  notice.appendChild(strong);
  notice.appendChild(document.createElement('br'));
  notice.appendChild(document.createTextNode(t.refreshMessage));

  const reloadBtn = document.createElement('button');
  reloadBtn.textContent = t.refreshButton;
  reloadBtn.style.cssText = 'margin-left:8px;padding:4px 8px;background:#fff;color:#f44336;border:none;border-radius:4px;cursor:pointer';
  reloadBtn.addEventListener('click', () => location.reload());
  notice.appendChild(reloadBtn);

  document.documentElement.appendChild(notice);
}

// ============== INTERNATIONALIZATION ==============

const i18n = {
  en: {
    downloadButton: 'Download',
    downloadAllButton: 'Download All',
    audioFiles: 'Audio Files',
    downloaded: 'Downloaded',
    failed: 'Failed',
    preparingConverter: 'Converting...',
    extensionReloaded: 'Extension Reloaded',
    refreshMessage: 'Please refresh this page to continue using Wiktionary Audio Downloader.',
    refreshButton: 'Refresh'
  },
  de: {
    downloadButton: 'Download',
    downloadAllButton: 'Alle herunterladen',
    audioFiles: 'Audiodateien',
    downloaded: 'Heruntergeladen',
    failed: 'Fehlgeschlagen',
    preparingConverter: 'Konvertiere...',
    extensionReloaded: 'Extension neu geladen',
    refreshMessage: 'Bitte aktualisiere diese Seite, um Wiktionary Audio Downloader weiter zu verwenden.',
    refreshButton: 'Aktualisieren'
  },
  fr: {
    downloadButton: 'Télécharger',
    downloadAllButton: 'Tout télécharger',
    audioFiles: 'Fichiers audio',
    downloaded: 'Téléchargé',
    failed: 'Échec',
    preparingConverter: 'Conversion...',
    extensionReloaded: 'Extension rechargée',
    refreshMessage: 'Veuillez actualiser cette page pour continuer à utiliser Wiktionary Audio Downloader.',
    refreshButton: 'Actualiser'
  },
  es: {
    downloadButton: 'Descargar',
    downloadAllButton: 'Descargar todo',
    audioFiles: 'Archivos de audio',
    downloaded: 'Descargado',
    failed: 'Falló',
    preparingConverter: 'Convirtiendo...',
    extensionReloaded: 'Extensión recargada',
    refreshMessage: 'Por favor actualiza esta página para continuar usando Wiktionary Audio Downloader.',
    refreshButton: 'Actualizar'
  },
  it: {
    downloadButton: 'Scarica',
    downloadAllButton: 'Scarica tutto',
    audioFiles: 'File audio',
    downloaded: 'Scaricato',
    failed: 'Fallito',
    preparingConverter: 'Conversione...',
    extensionReloaded: 'Estensione ricaricata',
    refreshMessage: 'Si prega di aggiornare questa pagina per continuare a utilizzare Wiktionary Audio Downloader.',
    refreshButton: 'Aggiorna'
  },
  ja: {
    downloadButton: 'ダウンロード',
    downloadAllButton: 'すべてダウンロード',
    audioFiles: '音声ファイル',
    downloaded: 'ダウンロード済み',
    failed: '失敗',
    preparingConverter: '変換中...',
    extensionReloaded: '拡張機能が再読み込みされました',
    refreshMessage: 'Wiktionary Audio Downloaderを続けて使用するには、このページを更新してください。',
    refreshButton: '更新'
  },
  zh: {
    downloadButton: '下载',
    downloadAllButton: '下载全部',
    audioFiles: '音频文件',
    downloaded: '已下载',
    failed: '失败',
    preparingConverter: '转换中...',
    extensionReloaded: '扩展已重新加载',
    refreshMessage: '请刷新此页面以继续使用Wiktionary Audio Downloader。',
    refreshButton: '刷新'
  }
};

const currentLang = (() => {
  const match = location.hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const lang = match?.[1] || 'en';
  return i18n[lang] ? lang : 'en';
})();
const t = i18n[currentLang];

// ============== FILENAME FORMATTING ==============
//
// Wiktionary pronunciation files follow a few common patterns. We parse them
// into structured fields so the panel and downloaded file get a friendlier
// name like `english_australian_Georgian.ogg` instead of `En-au-Georgian.ogg`.
//
// Patterns handled:
//   En-au-Georgian.ogg              -> en, dialect=au,  word=Georgian
//   De-Wasser.ogg                   -> de, word=Wasser
//   LL-Q1860_(eng)-Speaker-water.wav -> eng, speaker=Speaker, word=water
// Unparseable input falls back to the stem, so we never lose the file.

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
function parseAudioFilename(raw, knownWord = null) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', extra: null, ext: '' };

  // Strip query string / fragment defensively (real Wikimedia URLs don't carry
  // them, but tracking-rewriter proxies sometimes append things like
  // ?utm_source=...). Then decode and take the last path segment.
  const decoded = safeDecodeURIComponent(String(raw).split('?')[0].split('#')[0]);
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
function friendlyAudioFilename(parsed) {
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
function humanReadableName(parsed, originalFilename) {
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

// ============== AUDIO DISCOVERY ==============
//
// Single discovery path: MediaWiki Action API with `generator=images` +
// `prop=imageinfo`. One roundtrip per page (more for long entries via
// continuation). Filters by `mediatype=AUDIO` from imageinfo, falling back
// to MIME and then the filename extension. Works across all Wiktionary
// editions because it bypasses per-edition template/DOM differences.
//
// Page title comes from URL (content scripts run in an isolated world so
// `mw.config.get(...)` from the page isn't directly accessible). API base
// is derived from `location.origin` so en/de/fr/... all just work.

const pageTitle = safeDecodeURIComponent(location.pathname.split('/wiki/')[1] ?? '');
const apiEndpoint = `${location.origin}/w/api.php`;

// Non-audio-prefix MIMEs that should still be treated as audio. The broad
// `audio/*` check below already covers all audio MIMEs; this set only holds
// the few that don't start with `audio/` (Wiktionary serves .ogg files with
// `application/ogg`, not `audio/ogg`).
const AUDIO_MIMES = new Set([
  'application/ogg',
]);

// Extensions that are unambiguously audio by file format or convention.
// `.m4a` is the audio-only naming variant of MPEG-4 Part 14; `.aac` is a
// raw AAC stream (no container, so no video). `.webm` is excluded because
// the WebM container can carry video and Wiktionary doesn't serve audio
// in WebM, so a mislabeled .webm slipping through here would risk treating
// a video file as audio.
const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|flac|m4a|aac)$/i;

// Allowlist of hostnames that may serve audio bytes to this extension.
// Wikimedia serves all Wiktionary pronunciation audio from upload.wikimedia.org;
// nothing else should ever appear in an API response. Anything outside the
// allowlist is dropped before it reaches the panel, the prefetch cache,
// chrome.downloads, or FFmpeg. Mirrored in background.js -- keep in sync.
const AUDIO_HOST_ALLOWLIST = new Set(['upload.wikimedia.org']);

/** @param {string} url */
function isAllowedAudioUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUDIO_HOST_ALLOWLIST.has(u.hostname);
  } catch { return false; }
}

// Mirror of background.js PER_FILE_MAX_BYTES. Used to drop oversize items
// from the panel before they ever reach prefetch or download. 5 MB covers
// every real pronunciation file; anything larger is an anomaly.
const PER_FILE_MAX_BYTES = 5 * 1024 * 1024;

// decodeURIComponent throws URIError on malformed `%XX` sequences. Wrapping
// it once means a single bad URL or title can't disable the extension on
// the whole page. Falls back to the raw string so we still produce
// something usable downstream.
/** @param {string} s */
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); }
  catch { return String(s); }
}

function isAudioInfo(info) {
  if (!info) return false;
  // Authoritative: if Wikimedia tagged this with a non-empty mediatype,
  // trust it. Any non-AUDIO value (VIDEO, BITMAP, DRAWING, ...) is a hard
  // reject. This is the strongest signal we have and it stops video files
  // from slipping through on extension-only matches below.
  if (typeof info.mediatype === 'string' && info.mediatype.length > 0) {
    return info.mediatype.toUpperCase() === 'AUDIO';
  }
  if (typeof info.mime === 'string') {
    const m = info.mime.toLowerCase();
    if (m.startsWith('audio/')) return true;
    if (AUDIO_MIMES.has(m)) return true;
  }
  if (typeof info.url === 'string' && AUDIO_EXT_RE.test(info.url)) return true;
  return false;
}

/**
 * Single explicit acceptance check for the MediaWiki imageinfo shape we
 * depend on. Replaces the prior pattern of field-by-field optional-chain
 * access (which was "valid by lucky absence of throw" rather than "valid
 * by inspection"). Returns true only when every consumed field has a
 * type we can act on; falsy/absent optional fields are tolerated.
 *
 * @param {any} info
 */
function validImageInfo(info) {
  if (!info || typeof info !== 'object') return false;
  if (typeof info.url !== 'string' || info.url.length === 0) return false;
  if (info.mime !== undefined && info.mime !== null && typeof info.mime !== 'string') return false;
  if (info.mediatype !== undefined && info.mediatype !== null && typeof info.mediatype !== 'string') return false;
  if (info.size !== undefined && info.size !== null) {
    if (typeof info.size !== 'number' || !Number.isFinite(info.size) || info.size < 0) return false;
  }
  return true;
}

/**
 * Extract the filename tail from a URL via a single URL parse + one split,
 * dropping query/fragment automatically (URL.pathname has neither). Falls
 * back to 'audio' if pathname has no tail. One allocation instead of the
 * three-or-four-string split chain.
 *
 * @param {string} url
 */
function urlTail(url) {
  try {
    const p = new URL(url).pathname;
    const i = p.lastIndexOf('/');
    const tail = i >= 0 ? p.slice(i + 1) : p;
    return tail || 'audio';
  } catch { return 'audio'; }
}

/**
 * Filter an Action API `pages` array down to audio entries with the fields
 * we care about. The shape validator runs at the boundary so downstream
 * code operates on a known-shape AudioItem.
 *
 * Every result is built with the full AudioItem field set (downloadName,
 * displayName, lang as their empty/null defaults) so the V8 hidden class
 * stays stable when main() fills them in. Adding properties later would
 * force a second shape transition per item.
 *
 * @param {any[]} pages
 * @returns {AudioItem[]}
 */
function audioItemsFromPages(pages) {
  if (!Array.isArray(pages)) return [];
  const results = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!validImageInfo(info)) continue;
    if (!isAudioInfo(info)) continue;
    if (!isAllowedAudioUrl(info.url)) continue;
    // Drop oversized files reported by the API before they ever reach
    // prefetch. Wikimedia's imageinfo size is authoritative; we only pay
    // the network round trip for files within budget.
    if (typeof info.size === 'number' && info.size > PER_FILE_MAX_BYTES) continue;
    results.push({
      title: page.title,
      url: info.url,
      filename: safeDecodeURIComponent(urlTail(info.url)),
      mime: info.mime ?? null,
      size: typeof info.size === 'number' ? info.size : null,
      downloadName: '',
      displayName: '',
      lang: null,
    });
  }
  return results;
}

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return null;
  // response.json() rejects on a malformed body. Without this catch, a
  // single bad continuation pass would propagate out of discoverAudio's
  // 5-pass loop and abort the entire panel for the page. Treat parse
  // failure like a transport failure: return null and let the caller
  // continue with whatever it already has.
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * True for ISO 639-1 `en` and 639-3 `eng` so English entries can be pinned
 * to the top of the panel regardless of where they appear on the page.
 * @param {string|null|undefined} lang
 * @returns {boolean}
 */
function isEnglishLang(lang) {
  if (!lang) return false;
  const code = String(lang).toLowerCase();
  return code === 'en' || code === 'eng';
}

/**
 * Discover all audio files attached to a page via Action API. Handles
 * generator continuation so long entries (e.g. fr/eau with 33+ items)
 * aren't truncated.
 *
 * @param {string} title
 * @returns {Promise<AudioItem[]>}
 */
async function discoverAudio(title) {
  const baseParams = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    titles: title,
    generator: 'images',
    gimlimit: 'max',
    prop: 'imageinfo',
    iiprop: 'url|mime|mediatype|size',
  };

  const results = [];
  const seen = new Set();
  let cont = null;
  // Hard cap on continuation passes to avoid pathological loops.
  for (let pass = 0; pass < 5; pass++) {
    const params = new URLSearchParams(baseParams);
    if (cont) applyContinuation(params, cont);
    const data = await fetchJson(`${apiEndpoint}?${params}`);
    if (!data) break;

    // Dedupe by canonical URL: different File: titles can resolve to the
    // same upload.wikimedia.org asset (redirects, file aliases). Deduping
    // by title would still surface those as separate panel rows and trigger
    // redundant prefetches.
    for (const item of audioItemsFromPages(data.query?.pages)) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }

    cont = isPlainContinue(data.continue) ? data.continue : null;
    if (!cont) break;
  }
  return results;
}

// Only the continuation keys our specific query (generator=images +
// prop=imageinfo) can legitimately produce. The MediaWiki Action API uses
// `continue` as an indicator string plus per-module keys; for us the only
// module emitting a continuation is the `images` generator (`gimcontinue`).
// Anything else returned by the API is silently dropped instead of being
// spread into URLSearchParams.
const CONTINUE_KEYS = new Set(['continue', 'gimcontinue']);

/**
 * True iff `c` is a non-null plain object (not an array, not a primitive,
 * no exotic prototype). Defensive against an API response that returns
 * `continue` as a string, array, or null.
 * @param {unknown} c
 */
function isPlainContinue(c) {
  if (c === null || typeof c !== 'object') return false;
  if (Array.isArray(c)) return false;
  const proto = Object.getPrototypeOf(c);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy allowed continuation parameters from `cont` into `params`. Keys not
 * in the allowlist are ignored; values must be strings (MediaWiki always
 * returns string continuation tokens).
 * @param {URLSearchParams} params
 * @param {Record<string, unknown>} cont
 */
function applyContinuation(params, cont) {
  for (const k of CONTINUE_KEYS) {
    const v = cont[k];
    if (typeof v === 'string') params.set(k, v);
  }
}

// ============== DOWNLOAD LOGIC ==============

async function sendDownload(item, mode, folder) {
  const timeoutMs = mode === 'convert' ? 120000 : 90000;
  return safeSendMessage({
    type: 'DOWNLOAD_AUDIO',
    url: item.url,
    originalFilename: item.downloadName || item.filename,
    folder,
    mode
  }, { timeoutMs });
}

// Subfolder name used when the user clicks Download All. Distinctive enough
// to find in the Downloads folder and tied to the source page.
//   en.wiktionary.org/wiki/water  -> Wiktionary-en-water
//   de.wiktionary.org/wiki/Wasser -> Wiktionary-de-Wasser
//   ja.wiktionary.org/wiki/水     -> Wiktionary-ja-水
function batchFolderName(hostname, title) {
  const match = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const edition = match?.[1] || 'wiktionary';
  return `Wiktionary-${edition}-${title || 'audio'}`;
}

// Feedback states. `progress` is an open ended state (no auto-reset)
// shown while async work is in flight. `success` also persists so the
// user can see at a glance which items they've already downloaded; only
// `error` and `partial` auto-reset so the button stays clickable for a
// retry. State is per panel render: a page refresh wipes everything
// (no persistence layer).
const FEEDBACK_COLORS = {
  progress: '#fbbc04',  // amber: "working"
  success:  '#34a853',  // green
  error:    '#ea4335',  // red
  partial:  '#fb8c00',  // orange: "some files saved, some failed"
};
const FEEDBACK_IDLE_BG = '#1a73e8';
const FEEDBACK_RESET_MS = 2000;

function showFeedback(button, message, kind = 'success') {
  if (button._feedbackTimer) clearTimeout(button._feedbackTimer);
  if (!button._originalText) button._originalText = button.textContent;

  button.textContent = message;
  button.style.background = FEEDBACK_COLORS[kind] || FEEDBACK_COLORS.success;
  // success keeps the button clickable so the user can re-download. progress
  // disables while work is in flight; error/partial disable briefly then
  // auto-reset back to the idle state.
  button.disabled = kind !== 'success';

  // progress and success stay until something else replaces them. Only
  // error and partial auto-clear.
  if (kind === 'progress' || kind === 'success') return;

  button._feedbackTimer = setTimeout(() => {
    button.textContent = button._originalText;
    button.style.background = FEEDBACK_IDLE_BG;
    button.disabled = false;
    delete button._originalText;
    delete button._feedbackTimer;
  }, FEEDBACK_RESET_MS);
}

// Mode is read on every download click; without local caching that's an
// async chrome.storage.sync round-trip on the hot path (~5ms in practice
// but more importantly an awaited boundary). We read once on first use
// and invalidate via storage.onChanged so the popup's "Save" still takes
// effect immediately on this tab.
/** @type {'original' | 'convert' | 'both' | null} */
let cachedMode = null;
/** @type {Promise<'original' | 'convert' | 'both'> | null} */
let cachedModePromise = null;

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.mode) {
      cachedMode = null;
      cachedModePromise = null;
    }
  });
} catch { /* extension context not yet ready; first getMode() will populate */ }

async function getMode() {
  if (!isExtensionContextValid()) {
    showContextInvalidatedMessage();
    return null;
  }
  if (cachedMode) return cachedMode;
  if (cachedModePromise) return cachedModePromise;
  cachedModePromise = (async () => {
    const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    const m = mode === 'convert' || mode === 'both' ? mode : 'original';
    cachedMode = m;
    return m;
  })();
  try {
    return await cachedModePromise;
  } finally {
    cachedModePromise = null;
  }
}

// Map UI mode to one or more concrete send-download modes. Mode 'both' fans
// out to original + convert in parallel.
function subModesFor(mode) {
  return mode === 'both' ? ['original', 'convert'] : [mode];
}

// Promise.allSettled is used everywhere so we get per mode results without
// a thrown exception triggering a silent fallback (which previously
// confused users: a file would still land while the button said "Failed").
// Returns true iff every sub-mode succeeded; caller uses this to drive
// per-panel "all downloaded" bookkeeping.
async function downloadFile(item, button) {
  const mode = await getMode();
  if (!mode) return false;
  const subModes = subModesFor(mode);

  if (subModes.includes('convert')) showFeedback(button, t.preparingConverter, 'progress');

  const settled = await Promise.allSettled(subModes.map(m => sendDownload(item, m)));
  const okCount = settled.filter(s => s.status === 'fulfilled' && s.value?.ok).length;

  if (okCount === subModes.length) {
    showFeedback(button, t.downloaded, 'success');
    return true;
  } else if (okCount === 0) {
    if (settled.find(s => s.status === 'rejected')) {
      logError('Download failed:', settled.find(s => s.status === 'rejected').reason);
    }
    showFeedback(button, t.failed, 'error');
    return false;
  } else {
    // Partial: only meaningful in `both` mode when one sub-mode succeeded.
    showFeedback(button, `${okCount}/${subModes.length} ${t.downloaded}`, 'partial');
    return false;
  }
}

async function downloadAll(items, button) {
  const mode = await getMode();
  if (!mode) return;
  const subModes = subModesFor(mode);
  const folder = batchFolderName(location.hostname, pageTitle);

  let okItems = 0;
  for (let i = 0; i < items.length; i++) {
    // Per-item progress so a long batch doesn't look frozen.
    showFeedback(button, `${i + 1}/${items.length}`, 'progress');
    const settled = await Promise.allSettled(
      subModes.map(m => sendDownload(items[i], m, folder))
    );
    if (settled.every(s => s.status === 'fulfilled' && s.value?.ok)) okItems++;
  }

  const summary = `${okItems}/${items.length} ${t.downloaded}`;
  if (okItems === items.length) {
    showFeedback(button, summary, 'success');
  } else if (okItems === 0) {
    showFeedback(button, t.failed, 'error');
  } else {
    showFeedback(button, summary, 'partial');
  }
}

// ============== UI ==============

// SVG glyphs for preview controls. No emoji: vector icons render cleanly
// at any size and inherit page color via currentColor.
const PLAY_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>`;

// Single shared Audio for the panel. Switching previews swaps src on this
// one instance instead of constructing a new HTMLAudioElement each time;
// that avoids piling up event listeners and lets the previous src/decode
// be torn down explicitly via `pause(); src = ''; load()` rather than
// waiting for GC to reclaim a paused-but-still-referenced element.
const previewState = {
  /** @type {HTMLAudioElement | null} */
  audio: null,
  /** @type {HTMLButtonElement | null} */
  button: null,
};

function ensurePreviewAudio() {
  if (previewState.audio) return previewState.audio;
  const a = new Audio();
  // Listeners attached once; they read from previewState so swapping the
  // active button doesn't leave handlers pointing at stale buttons.
  a.addEventListener('play', () => {
    if (previewState.button) previewState.button.innerHTML = PAUSE_SVG;
  });
  a.addEventListener('pause', () => {
    if (previewState.button) previewState.button.innerHTML = PLAY_SVG;
  });
  const reset = () => {
    if (previewState.button) previewState.button.innerHTML = PLAY_SVG;
    previewState.button = null;
  };
  a.addEventListener('ended', reset);
  a.addEventListener('error', reset);
  previewState.audio = a;
  return a;
}

function previewAudio(item, button) {
  const audio = ensurePreviewAudio();

  // Toggle if the user clicked the currently-loaded item.
  if (previewState.button === button) {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
    return;
  }

  // Switching to a different item: tear down the previous src explicitly
  // so the browser stops loading/decoding it instead of waiting for GC.
  if (previewState.button) previewState.button.innerHTML = PLAY_SVG;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  previewState.button = button;
  audio.src = item.url;
  audio.play().catch(() => {
    if (previewState.button === button) {
      button.innerHTML = PLAY_SVG;
      previewState.button = null;
    }
  });
}

// Warm the TCP+TLS connection to upload.wikimedia.org while the user is
// looking at the panel, so the eventual audio fetch (preview, download, or
// offscreen convert) skips the handshake. Idempotent via the data attribute.
function preconnectToUploadWikimedia() {
  if (document.querySelector('link[data-wad-preconnect="upload-wikimedia"]')) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = 'https://upload.wikimedia.org';
  link.crossOrigin = 'anonymous';
  link.dataset.wadPreconnect = 'upload-wikimedia';
  document.head.appendChild(link);
}

// Inline style strings, defined once. Inside a closed shadow root none of
// these need ID prefixing, and page CSS can't reach them anyway.
const PANEL_STYLE = 'background:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);width:clamp(260px, 22vw, 380px);max-width:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden';
const HEADER_STYLE = 'padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;display:flex;justify-content:space-between;align-items:center;flex-shrink:0';
const MINIMIZE_STYLE = 'border:0;background:none;color:#666;cursor:pointer;font-size:16px;padding:4px;border-radius:4px';
const BODY_STYLE = 'flex:1 1 auto;overflow:auto;max-height:clamp(180px, 55vh, 500px)';
const ROW_STYLE = 'display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #f6f6f6';
const PREVIEW_STYLE = 'border:0;border-radius:6px;width:28px;height:28px;display:grid;place-items:center;background:#eef2f7;color:#1a73e8;cursor:pointer;flex-shrink:0';
const NAME_STYLE = 'flex:1;min-width:0;line-height:1.3;overflow-wrap:anywhere';
const DOWNLOAD_STYLE = 'border:0;border-radius:8px;padding:6px 12px;background:#1a73e8;color:#fff;cursor:pointer;flex-shrink:0';
const FOOTER_STYLE = 'display:flex;gap:8px;padding:10px 12px;flex-shrink:0';
const DOWNLOAD_ALL_STYLE = 'border:0;border-radius:8px;padding:8px 12px;background:#1a73e8;color:#fff;cursor:pointer';
const HOST_STYLE = [
  '--wad-edge-gap:clamp(8px, 1.25vw, 16px)',
  'position:fixed',
  'right:var(--wad-edge-gap)',
  'bottom:var(--wad-edge-gap)',
  'z-index:2147483647',
  'font:13px system-ui',
  'max-width:calc(100vw - (2 * var(--wad-edge-gap)))',
  'max-height:calc(100vh - (2 * var(--wad-edge-gap)))',
  'display:flex',
  'flex-direction:column',
].join(';');

function createUI(items) {
  if (!items.length) return;
  preconnectToUploadWikimedia();

  // The host lives in light DOM (page can see it) but its contents render
  // inside an open shadow root for CSS + DOM-mutation encapsulation. The
  // load-bearing security primitive is closure-based item binding: every
  // button captures its own AudioItem, so there is no DOM attribute a
  // page could rewrite to retarget a real user click to a different
  // download. event.isTrusted on every handler additionally blocks any
  // script-dispatched click. Open mode is used so Playwright (and other
  // tooling) can introspect for tests; the security guarantee does not
  // depend on shadow opacity.
  const host = document.createElement('div');
  host.style.cssText = HOST_STYLE;
  const root = host.attachShadow({ mode: 'open' });

  const panel = document.createElement('div');
  panel.id = 'audio-panel';
  panel.setAttribute('data-testid', 'wad-panel');
  panel.style.cssText = PANEL_STYLE;

  const header = document.createElement('div');
  header.style.cssText = HEADER_STYLE;
  header.title = 'Pronunciation audio found on this Wiktionary page by the Wiktionary Audio Downloader extension';
  const headerText = document.createElement('span');
  headerText.textContent = t.audioFiles;
  const minimizeBtn = document.createElement('button');
  minimizeBtn.setAttribute('data-testid', 'wad-minimize');
  minimizeBtn.style.cssText = MINIMIZE_STYLE;
  minimizeBtn.title = 'Minimize panel';
  minimizeBtn.textContent = '\u2212';
  header.append(headerText, minimizeBtn);

  const body = document.createElement('div');
  body.className = 'audio-panel-body';
  body.style.cssText = BODY_STYLE;

  // Per-panel completion tracking. When every individual Download button
  // has succeeded the Download All button auto-flips to "Downloaded" too,
  // even if the user never clicked it. We key the Set on the AudioItem
  // object so there is no integer index in play that a page could spoof.
  /** @type {Set<unknown>} */
  const downloadedItems = new Set();
  /** @type {HTMLButtonElement | null} */
  let batchBtn = null;

  for (const item of items) {
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'wad-audio-item');
    row.style.cssText = ROW_STYLE;
    row.title = item.filename;

    const previewBtn = document.createElement('button');
    previewBtn.setAttribute('data-testid', 'wad-preview');
    previewBtn.style.cssText = PREVIEW_STYLE;
    previewBtn.title = 'Preview';
    previewBtn.innerHTML = PLAY_SVG;
    previewBtn.addEventListener('click', (e) => {
      // event.isTrusted is false for any script-generated event. Combined
      // with the closed shadow root (page can't dispatch directly onto
      // shadow content from outside, and our closure-captured `item`
      // makes attribute-driven retargeting impossible), this means only
      // real user clicks can drive privileged audio playback.
      if (!e.isTrusted) return;
      previewAudio(item, previewBtn);
    });

    const name = document.createElement('div');
    name.setAttribute('data-testid', 'wad-audio-filename');
    name.style.cssText = NAME_STYLE;
    name.textContent = item.displayName || item.filename;

    const dlBtn = document.createElement('button');
    dlBtn.setAttribute('data-testid', 'wad-download');
    dlBtn.style.cssText = DOWNLOAD_STYLE;
    dlBtn.textContent = t.downloadButton;
    dlBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      // `item` is closure captured per row, so even a tampered DOM
      // (which would require breaking shadow encapsulation) can't reroute
      // this click to a different audio file.
      downloadFile(item, dlBtn).then((ok) => {
        if (!ok) return;
        downloadedItems.add(item);
        if (batchBtn && downloadedItems.size === items.length) {
          showFeedback(batchBtn, t.downloaded, 'success');
        }
      });
    });

    row.append(previewBtn, name, dlBtn);
    body.appendChild(row);
  }

  panel.append(header, body);

  let footer = /** @type {HTMLElement | null} */ (null);
  if (items.length > 1) {
    footer = document.createElement('div');
    footer.className = 'audio-panel-footer';
    footer.style.cssText = FOOTER_STYLE;
    batchBtn = document.createElement('button');
    batchBtn.setAttribute('data-testid', 'wad-download-all');
    batchBtn.style.cssText = DOWNLOAD_ALL_STYLE;
    batchBtn.textContent = t.downloadAllButton;
    batchBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      downloadAll(items, batchBtn);
    });
    footer.appendChild(batchBtn);
    panel.appendChild(footer);
  }

  // Minimize/restore pauses any active preview when collapsing. Also
  // gates prefetch lifecycle: minimizing for >2s tells the background to
  // evict this page's bytes (user has signaled they won't use the panel);
  // re-opening after that triggers a fresh prefetch.
  let minimized = false;
  const itemUrls = items.map(i => i.url);
  const prefetchItems = items.map(i => ({ url: i.url, downloadName: i.downloadName }));
  /** @type {number | null} */
  let dismissTimer = null;
  let dismissed = false;

  minimizeBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    minimized = !minimized;
    if (minimized && previewState.audio) previewState.audio.pause();
    body.style.display = minimized ? 'none' : '';
    if (footer) footer.style.display = minimized ? 'none' : 'flex';
    minimizeBtn.textContent = minimized ? '+' : '\u2212';
    minimizeBtn.title = minimized ? 'Expand panel' : 'Minimize panel';

    if (minimized) {
      dismissTimer = /** @type {any} */ (setTimeout(() => {
        dismissTimer = null;
        dismissed = true;
        safeSendMessage({ type: 'PANEL_DISMISSED', urls: itemUrls }, { timeoutMs: 5000 })
          .catch(() => { /* opportunistic */ });
      }, 2000));
    } else {
      if (dismissTimer !== null) {
        clearTimeout(dismissTimer);
        dismissTimer = null;
      }
      if (dismissed) {
        dismissed = false;
        safeSendMessage({ type: 'PREFETCH_AUDIO', items: prefetchItems }, { timeoutMs: 5000 })
          .catch(() => { /* opportunistic */ });
      }
    }
  });
  minimizeBtn.addEventListener('mouseover', () => { minimizeBtn.style.background = '#f0f1f3'; });
  minimizeBtn.addEventListener('mouseout', () => { minimizeBtn.style.background = 'none'; });

  root.appendChild(panel);
  document.documentElement.appendChild(host);
}

// ============== MAIN ==============

(async () => {
  if (!pageTitle) return;

  try {
    const audioFiles = await discoverAudio(pageTitle);

    // Precompute names once per item:
    //   downloadName: sanitized friendly filename used for the actual save
    //   displayName:  human readable form for the on-page panel
    //   lang:         parsed language code, used by the English first sort
    // Pass pageTitle as the word anchor so hyphenated speakers and compound
    // words (e.g. "well-known") both parse correctly.
    audioFiles.forEach(item => {
      const parsed = parseAudioFilename(item.filename, pageTitle);
      item.downloadName = friendlyAudioFilename(parsed);
      item.displayName = humanReadableName(parsed, item.filename);
      item.lang = parsed.lang;
    });

    // Display order: English entries first (Wiktionary's primary user base),
    // then everything else alphabetically by the displayed name. Within each
    // group, displayName comparison gives a stable, intuitive ordering:
    // English dialects sort together, non-English languages sort by name.
    audioFiles.sort((a, b) => {
      const aEn = isEnglishLang(a.lang);
      const bEn = isEnglishLang(b.lang);
      if (aEn !== bEn) return aEn ? -1 : 1;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });

    if (audioFiles.length) {
      createUI(audioFiles);
      // Fire and forget prefetch: tell background to start pulling the
      // audio bytes into its cache while the user reads the panel. By the
      // time they click Download, the bytes are usually ready and both
      // Original and Convert paths skip their network round trip. Pass
      // downloadName along so background can speculatively transcode item 0
      // in Convert/Both mode. Not awaited; panel UX doesn't depend on
      // prefetch finishing.
      safeSendMessage({
        type: 'PREFETCH_AUDIO',
        items: audioFiles.map(item => ({
          url: item.url,
          downloadName: item.downloadName,
        })),
      }, { timeoutMs: 5000 }).catch(() => { /* opportunistic; ignore failures */ });
    }
  } catch (error) {
    logError('[Wiktionary Audio] Discovery failed:', error);
  }
})();

})();
