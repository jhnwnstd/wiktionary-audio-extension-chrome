// content-script.js — Wiktionary audio discovery, UI panel, download actions

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
//   En-au-Georgian.ogg              → en, dialect=au,  word=Georgian
//   De-Wasser.ogg                   → de, word=Wasser
//   LL-Q1860_(eng)-Speaker-water.wav → eng, speaker=Speaker, word=water
// Unparseable input falls back to the stem, so we never lose the file.

// Language coverage is delegated to the browser's Intl.DisplayNames, which
// already knows ~150 ISO 639-1 codes. We only carry a tiny 639-3 → 639-1 lift
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

// Dialect adjectives. Intl returns nouns ("United States", "Australia") via
// the region API, but filenames read more naturally with adjectives. This
// table is intentionally short — anything not listed falls through to the
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
  cmn: 'mandarin', yue: 'cantonese', wuu: 'shanghainese',
  nan: 'min-nan', hak: 'hakka',
};

const LANG_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' }); }
  catch { return null; }
})();
const REGION_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }); }
  catch { return null; }
})();

// Within a single field, multi-word values use `-`. "United States" → "united-states".
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
// title (e.g. "water" or "well-known") — when supplied, the parser anchors
// the word to a trailing match of that title, which correctly handles both
// hyphenated speakers ("Jérémy-Günther-Heinz Jähnick") and hyphenated words
// ("well-known") in the same call. Without context, we assume speakers are
// more likely to have hyphens than words.
function parseAudioFilename(raw, knownWord = null) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', ext: '' };

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
    if (m) return { lang: m[1].toLowerCase(), dialect: null, speaker: m[2], word: m[3], ext };
  }
  const ll1 = stem.match(/^LL-Q\d+_\(([a-z]{2,3})\)-(.+)-([^-]+)$/i);
  if (ll1) {
    return { lang: ll1[1].toLowerCase(), dialect: null, speaker: ll1[2], word: ll1[3], ext };
  }

  // LinguaLibre hyphenated Q-form: LL-Q<num>-<speaker>-<word>
  // (Q-number references a Wikidata language; we leave lang null rather than
  // bake in a Q-ID → ISO code map.)
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-Q\\d+-(.+)-(${wordAnchor})$`));
    if (m) return { lang: null, dialect: null, speaker: m[1], word: m[2], ext };
  }
  const ll2 = stem.match(/^LL-Q\d+-(.+)-([^-]+)$/);
  if (ll2) {
    return { lang: null, dialect: null, speaker: ll2[1], word: ll2[2], ext };
  }

  // LinguaLibre speaker-first hyphen form: LL-<speaker>-<lang2or3>-<word>
  if (wordAnchor) {
    const m = stem.match(new RegExp(`^LL-(.+)-([a-z]{2,3})-(${wordAnchor})$`));
    if (m) return { lang: m[2].toLowerCase(), dialect: null, speaker: m[1], word: m[3], ext };
  }
  const ll3 = stem.match(/^LL-(.+)-([a-z]{2,3})-([^-]+)$/);
  if (ll3) {
    return { lang: ll3[2].toLowerCase(), dialect: null, speaker: ll3[1], word: ll3[3], ext };
  }

  // <Lang>-<dialect>-<word>  e.g. En-au-Georgian, Es-am_lat-agua, Es-am-lat-agua
  // Dialect tags may include underscores or hyphens internally (Latin American
  // Spanish is tagged both ways). Greedy with backtracking yields the longest
  // dialect that still leaves a valid `-word` tail.
  const langDialect = stem.match(/^([A-Z][a-z]{0,2})-([a-z][a-z_-]{0,5}[a-z])-(.+)$/);
  if (langDialect) {
    return {
      lang: langDialect[1].toLowerCase(),
      dialect: langDialect[2],
      speaker: null,
      word: langDialect[3],
      ext,
    };
  }

  // <Lang>-<word>  e.g. De-Wasser
  const langWord = stem.match(/^([A-Z][a-z]{0,2})-(.+)$/);
  if (langWord) {
    return { lang: langWord[1].toLowerCase(), dialect: null, speaker: null, word: langWord[2], ext };
  }

  return { lang: null, dialect: null, speaker: null, word: stem, ext };
}

function friendlyAudioFilename(parsed) {
  const parts = [];
  const lang = describeLanguage(parsed.lang);
  if (lang) parts.push(lang);
  const dialect = describeDialect(parsed.dialect);
  if (dialect) parts.push(dialect);
  parts.push(normalizeFieldValue(parsed.word));
  // Speaker disambiguator (LinguaLibre) so multiple speakers don't collide.
  if (parsed.speaker) parts.push(normalizeFieldValue(parsed.speaker));
  // `_` joins different fields; within-field separators are already `-`.
  const stem = parts.join('_');
  return parsed.ext ? `${stem}.${parsed.ext}` : stem;
}

function formatAudio(rawFilename) {
  return friendlyAudioFilename(parseAudioFilename(rawFilename));
}

// Human-readable display string for the on-page panel. Same parsed fields as
// the download name, but rendered for humans: title-cased language and
// dialect, word in single quotes, optional speaker, extension separated.
//   En-au-friendo.ogg                  → English Australian 'friendo' .ogg
//   De-Wasser.ogg                      → German 'Wasser' .ogg
//   LL-Q1860_(eng)-Stebbington-water   → English 'water' by Stebbington .wav
//   Unparseable input                  → original filename, verbatim
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
      results.push({
        title: page.title,
        url: info.url,
        filename: decodeURIComponent(info.url.split('/').pop() || 'audio'),
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

// Discover all audio files attached to a page via Action API. Handles
// generator continuation so long entries (e.g. fr/eau with 33+ items) aren't
// truncated. formatversion=2 gives us pages as an array — cleaner than the
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
//   en.wiktionary.org/wiki/water  → Wiktionary-en-water
//   de.wiktionary.org/wiki/Wasser → Wiktionary-de-Wasser
//   ja.wiktionary.org/wiki/水     → Wiktionary-ja-水
function batchFolderName(hostname, title) {
  const match = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const edition = match?.[1] || 'wiktionary';
  return `Wiktionary-${edition}-${title || 'audio'}`;
}

function showFeedback(button, message, isSuccess = true) {
  if (button._feedbackTimer) clearTimeout(button._feedbackTimer);
  if (!button._originalText) button._originalText = button.textContent;

  button.textContent = message;
  button.style.background = isSuccess ? '#34a853' : '#ea4335';
  button.disabled = true;

  button._feedbackTimer = setTimeout(() => {
    button.textContent = button._originalText;
    button.style.background = '#1a73e8';
    button.disabled = false;
    delete button._originalText;
    delete button._feedbackTimer;
  }, 2000);
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

async function downloadFile(item, button) {
  const mode = await getMode();
  if (!mode) return;
  const subModes = subModesFor(mode);

  try {
    if (subModes.includes('convert')) showFeedback(button, t.preparingConverter);
    const results = await Promise.all(subModes.map(m => sendDownload(item, m)));
    const allOk = results.every(r => r?.ok);
    showFeedback(button, allOk ? t.downloaded : t.failed, allOk);
  } catch (error) {
    logError('Download failed:', error);
    showFeedback(button, t.failed, false);
    // Fallback: at least try to save the original.
    try { await sendDownload(item, 'original'); } catch {}
  }
}

async function downloadAll(items, button) {
  const mode = await getMode();
  if (!mode) return;
  const subModes = subModesFor(mode);
  const folder = batchFolderName(location.hostname, pageTitle);

  let ok = 0;
  for (const item of items) {
    try {
      const results = await Promise.all(subModes.map(m => sendDownload(item, m, folder)));
      if (results.every(r => r?.ok)) ok++;
    } catch { /* counted as fail */ }
  }

  if (ok > 0) {
    showFeedback(button, `${ok}/${items.length} ${t.downloaded}`);
  } else {
    showFeedback(button, t.failed, false);
    // Fallback: retry all as original (still grouped in the same folder).
    for (const item of items) {
      try { await sendDownload(item, 'original', folder); } catch {}
    }
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
    //   downloadName — sanitized friendly filename used for the actual save
    //   displayName  — human-readable form for the on-page panel
    // Pass pageTitle as the word anchor so hyphenated speakers / compound
    // words (e.g. "well-known") both parse correctly.
    audioFiles.forEach(item => {
      const parsed = parseAudioFilename(item.filename, pageTitle);
      item.downloadName = friendlyAudioFilename(parsed);
      item.displayName = humanReadableName(parsed, item.filename);
    });

    if (audioFiles.length) createUI(audioFiles);
  } catch (error) {
    logError('[Wiktionary Audio] Discovery failed:', error);
  }
})();
