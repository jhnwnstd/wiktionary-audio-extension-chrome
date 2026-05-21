// content-script.js -- Wiktionary audio discovery, UI panel, download actions

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

// ============== EXTENSION CONTEXT ==============

function isExtensionContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

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
  notice.innerHTML = `
    <strong>${t.extensionReloaded}</strong><br>${t.refreshMessage}
    <button onclick="location.reload()" style="margin-left:8px;padding:4px 8px;background:#fff;color:#f44336;border:none;border-radius:4px;cursor:pointer">${t.refreshButton}</button>`;
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
// (Jer = Jèrriais, a variety of Norman). Kept small -- only verified from
// real data in the live sweep.
const LANG_OVERRIDES = {
  qc: 'quebec-french',
  jer: 'jèrriais',
};

// Dialect adjectives. Intl returns nouns ("United States", "Australia") via
// the region API, but filenames read more naturally with adjectives. This
// table is intentionally short -- anything not listed falls through to the
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse a Wiktionary audio filename. The optional `knownWord` is the page
// title (e.g. "water" or "well-known") -- when supplied, the parser anchors
// the word to a trailing match of that title, which correctly handles both
// hyphenated speakers ("Jérémy-Günther-Heinz Jähnick") and hyphenated words
// ("well-known") in the same call. Without context, we assume speakers are
// more likely to have hyphens than words.
function parseAudioFilename(raw, knownWord = null) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', extra: null, ext: '' };

  // Strip query string / fragment defensively (real Wikimedia URLs don't carry
  // them, but tracking-rewriter proxies sometimes append things like
  // ?utm_source=...). Then decode and take the last path segment.
  const decoded = decodeURIComponent(String(raw).split('?')[0].split('#')[0]);
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

const pageTitle = decodeURIComponent(location.pathname.split('/wiki/')[1] ?? '');
const apiEndpoint = `${location.origin}/w/api.php`;

const AUDIO_MIMES = new Set([
  'application/ogg',
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/wave',
  'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/opus',
  'video/ogg', 'video/webm',
]);
const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|webm|m4a|aac|flac)$/i;

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
      // Strip any URL query/fragment before extracting the filename so
      // tracking junk (e.g. ?utm_source=... that Wikimedia attaches to some
      // imageinfo URLs) doesn't leak into display or download names.
      const cleanTail = (info.url.split('/').pop() || 'audio').split('?')[0].split('#')[0];
      results.push({
        title: page.title,
        url: info.url,
        filename: decodeURIComponent(cleanTail),
        mime: info.mime,
        size: info.size,
      });
    }
  }
  return results;
}

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return null;
  return response.json();
}

// Walk the rendered page to find which audio files appear and in what order.
// We use this as a presentation hint: items returned by the Action API are
// sorted to match the order the user sees on the page. Items that aren't
// referenced in the DOM (rare) drop to the end of the list in API order.
//
// Cross-edition note: Wiktionary file-page links use the `File:` prefix on
// English but localized prefixes on other editions (Datei: on de, Fichier:
// on fr, etc.). We match by the trailing audio-file extension instead of
// the prefix, so this works on any edition.
function findDomAudioOrder() {
  const order = new Map();
  let counter = 0;
  // <audio><source> is the canonical rendered form; <a href="...File:...ogg">
  // catches edits that link to file pages directly.
  const candidates = document.querySelectorAll('audio source[src], a[href]');
  for (const el of candidates) {
    const url = el.getAttribute('src') || el.getAttribute('href') || '';
    const m = url.match(/[/:]([^/?#:]+\.(?:ogg|oga|opus|mp3|wav|webm|m4a|aac|flac))(?:[?#]|$)/i);
    if (!m) continue;
    const filename = decodeURIComponent(m[1]);
    if (!order.has(filename)) order.set(filename, counter++);
  }
  return order;
}

// Discover all audio files attached to a page via Action API. Handles
// generator continuation so long entries (e.g. fr/eau with 33+ items) aren't
// truncated. formatversion=2 gives us pages as an array -- cleaner than the
// v1 object-keyed-by-pageid format.
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
    iiprop: 'url|mime|mediatype|size|canonicaltitle',
  };

  const results = [];
  const seen = new Set();
  let cont = null;
  // Hard cap on continuation passes to avoid pathological loops.
  for (let pass = 0; pass < 5; pass++) {
    const params = new URLSearchParams(baseParams);
    if (cont) {
      for (const [k, v] of Object.entries(cont)) params.set(k, v);
    }
    const data = await fetchJson(`${apiEndpoint}?${params}`);
    if (!data) break;

    for (const item of audioItemsFromPages(data.query?.pages)) {
      if (seen.has(item.title)) continue;
      seen.add(item.title);
      results.push(item);
    }

    if (data.continue) cont = data.continue;
    else break;
  }
  return results;
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

// Feedback states. `progress` is an open-ended state (no auto-reset) shown
// while async work is in flight. Terminal states (`success`, `error`,
// `partial`) auto-reset the button back to its idle look after 2s so the
// reader has time to register the outcome without the button being stuck.
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
  button.disabled = true;

  // Progress states stay until they are explicitly replaced by a terminal
  // state. Terminal states auto-clear so the button is reusable.
  if (kind === 'progress') return;

  button._feedbackTimer = setTimeout(() => {
    button.textContent = button._originalText;
    button.style.background = FEEDBACK_IDLE_BG;
    button.disabled = false;
    delete button._originalText;
    delete button._feedbackTimer;
  }, FEEDBACK_RESET_MS);
}

async function getMode() {
  if (!isExtensionContextValid()) {
    showContextInvalidatedMessage();
    return null;
  }
  const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
  return mode;
}

// Map UI mode to one or more concrete send-download modes. Mode 'both' fans
// out to original + convert in parallel.
function subModesFor(mode) {
  return mode === 'both' ? ['original', 'convert'] : [mode];
}

// Promise.allSettled is used everywhere so we get per-mode results without a
// thrown exception triggering a silent fallback (which previously confused
// users: a file would still land while the button said "Failed").
async function downloadFile(item, button) {
  const mode = await getMode();
  if (!mode) return;
  const subModes = subModesFor(mode);

  if (subModes.includes('convert')) showFeedback(button, t.preparingConverter, 'progress');

  const settled = await Promise.allSettled(subModes.map(m => sendDownload(item, m)));
  const okCount = settled.filter(s => s.status === 'fulfilled' && s.value?.ok).length;

  if (okCount === subModes.length) {
    showFeedback(button, t.downloaded, 'success');
  } else if (okCount === 0) {
    if (settled.find(s => s.status === 'rejected')) {
      logError('Download failed:', settled.find(s => s.status === 'rejected').reason);
    }
    showFeedback(button, t.failed, 'error');
  } else {
    // Partial: only meaningful in `both` mode when one sub-mode succeeded.
    showFeedback(button, `${okCount}/${subModes.length} ${t.downloaded}`, 'partial');
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

// SVG glyphs for preview controls. No emoji \u2014 vector icons render cleanly at
// any size and play nicely with currentColor for theming.
const PLAY_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>`;

// Single Audio instance is enough \u2014 switching items pauses the previous one.
let activePreview = null;

function previewAudio(item, button) {
  // Toggle behavior if this button's audio is what's currently loaded.
  if (activePreview && activePreview.button === button) {
    if (activePreview.audio.paused) {
      activePreview.audio.play().catch(() => {});
    } else {
      activePreview.audio.pause();
    }
    return;
  }

  // Stop any other preview and reset its button.
  if (activePreview) {
    activePreview.audio.pause();
    activePreview.button.innerHTML = PLAY_SVG;
  }

  const audio = new Audio(item.url);
  activePreview = { audio, button };
  audio.addEventListener('play', () => { button.innerHTML = PAUSE_SVG; });
  audio.addEventListener('pause', () => { button.innerHTML = PLAY_SVG; });
  audio.addEventListener('ended', () => {
    button.innerHTML = PLAY_SVG;
    if (activePreview && activePreview.audio === audio) activePreview = null;
  });
  audio.addEventListener('error', () => {
    button.innerHTML = PLAY_SVG;
    if (activePreview && activePreview.audio === audio) activePreview = null;
  });
  audio.play().catch(() => { button.innerHTML = PLAY_SVG; });
}

function createUI(items) {
  if (!items.length) return;

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px system-ui';
  panel.innerHTML = `
    <div id="audio-panel" data-testid="wad-panel" style="background:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);min-width:280px;max-width:380px">
      <div style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>${t.audioFiles}</span>
        <button id="minimize-btn" data-testid="wad-minimize" style="border:0;background:none;color:#666;cursor:pointer;font-size:16px;padding:4px;border-radius:4px" title="Minimize panel">\u2212</button>
      </div>
      <div class="audio-panel-body" style="max-height:350px;overflow:auto">
        ${items.map((item, i) => `
          <div data-testid="wad-audio-item" style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #f6f6f6" title="${escapeHtml(item.filename)}">
            <button data-testid="wad-preview" data-preview="${i}" style="border:0;border-radius:6px;width:28px;height:28px;display:grid;place-items:center;background:#eef2f7;color:#1a73e8;cursor:pointer;flex-shrink:0" title="Preview">${PLAY_SVG}</button>
            <div style="flex:1;word-break:break-all" data-testid="wad-audio-filename">${escapeHtml(item.displayName || item.filename)}</div>
            <button data-testid="wad-download" data-i="${i}" style="border:0;border-radius:8px;padding:6px 12px;background:#1a73e8;color:#fff;cursor:pointer">${t.downloadButton}</button>
          </div>`).join('')}
      </div>
      ${items.length > 1 ? `
      <div class="audio-panel-footer" style="display:flex;gap:8px;padding:10px 12px">
        <button id="dl-all" data-testid="wad-download-all" style="border:0;border-radius:8px;padding:8px 12px;background:#1a73e8;color:#fff;cursor:pointer">${t.downloadAllButton}</button>
      </div>` : ''}
    </div>`;

  // Delegated click handling for preview + download buttons.
  panel.addEventListener('click', e => {
    const preview = e.target.closest('button[data-preview]');
    if (preview) {
      previewAudio(items[Number(preview.dataset.preview)], preview);
      return;
    }
    const dl = e.target.closest('button[data-i]');
    if (dl) downloadFile(items[Number(dl.dataset.i)], dl);
  });

  // Batch button
  const batchBtn = panel.querySelector('#dl-all');
  if (batchBtn) batchBtn.onclick = () => downloadAll(items, batchBtn);

  // Minimize/restore \u2014 pauses any active preview when collapsing.
  const minimizeBtn = panel.querySelector('#minimize-btn');
  const body = panel.querySelector('.audio-panel-body');
  const footer = panel.querySelector('.audio-panel-footer');
  let minimized = false;

  minimizeBtn.onclick = () => {
    minimized = !minimized;
    if (minimized && activePreview) activePreview.audio.pause();
    if (body) body.style.display = minimized ? 'none' : '';
    if (footer) footer.style.display = minimized ? 'none' : 'flex';
    minimizeBtn.textContent = minimized ? '+' : '\u2212';
    minimizeBtn.title = minimized ? 'Expand panel' : 'Minimize panel';
  };
  minimizeBtn.onmouseover = () => minimizeBtn.style.background = '#f0f1f3';
  minimizeBtn.onmouseout = () => minimizeBtn.style.background = 'none';

  document.documentElement.appendChild(panel);
}

// ============== MAIN ==============

(async () => {
  if (!pageTitle) return;

  try {
    const audioFiles = await discoverAudio(pageTitle);

    // Precompute names once per item:
    //   downloadName -- sanitized friendly filename used for the actual save
    //   displayName  -- human-readable form for the on-page panel
    // Pass pageTitle as the word anchor so hyphenated speakers / compound
    // words (e.g. "well-known") both parse correctly.
    audioFiles.forEach(item => {
      const parsed = parseAudioFilename(item.filename, pageTitle);
      item.downloadName = friendlyAudioFilename(parsed);
      item.displayName = humanReadableName(parsed, item.filename);
    });

    // Reorder items to match the on-page order (what the user sees in the
    // Pronunciation section). Items not found in the DOM stay in API order
    // after the DOM-anchored items.
    const domOrder = findDomAudioOrder();
    let fallbackOrder = domOrder.size;
    audioFiles.forEach(item => {
      item.order = domOrder.has(item.filename) ? domOrder.get(item.filename) : fallbackOrder++;
    });
    audioFiles.sort((a, b) => a.order - b.order);

    if (audioFiles.length) createUI(audioFiles);
  } catch (error) {
    logError('[Wiktionary Audio] Discovery failed:', error);
  }
})();
