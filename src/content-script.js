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
    preparingConverter: '⏳ Preparing converter (first-time)...',
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
    preparingConverter: '⏳ Konverter vorbereiten (erstmalig)...',
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
    preparingConverter: '⏳ Préparation du convertisseur (première fois)...',
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
    preparingConverter: '⏳ Preparando convertidor (primera vez)...',
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
    preparingConverter: '⏳ Preparazione convertitore (prima volta)...',
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
    preparingConverter: '⏳ コンバーター準備中（初回）...',
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
    preparingConverter: '⏳ 准备转换器（首次）...',
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

const LANGUAGE_NAMES = {
  // ISO 639-1 (Wiktionary's wikis use these for the audio prefix).
  en: 'english', de: 'german', fr: 'french', es: 'spanish', it: 'italian',
  ja: 'japanese', zh: 'chinese', pt: 'portuguese', nl: 'dutch', sv: 'swedish',
  no: 'norwegian', da: 'danish', fi: 'finnish', pl: 'polish', ru: 'russian',
  ar: 'arabic', hi: 'hindi', ko: 'korean', tr: 'turkish', uk: 'ukrainian',
  cs: 'czech', el: 'greek', he: 'hebrew', th: 'thai', vi: 'vietnamese',
  ro: 'romanian', hu: 'hungarian', id: 'indonesian', ms: 'malay', fa: 'persian',
  ca: 'catalan', eu: 'basque', gl: 'galician', is: 'icelandic', ga: 'irish',
  // ISO 639-3 (LinguaLibre embeds these in parens).
  eng: 'english', deu: 'german', fra: 'french', spa: 'spanish', ita: 'italian',
  jpn: 'japanese', zho: 'chinese', cmn: 'mandarin', yue: 'cantonese',
  por: 'portuguese', nld: 'dutch', swe: 'swedish', nor: 'norwegian',
  dan: 'danish', fin: 'finnish', pol: 'polish', rus: 'russian',
  ara: 'arabic', hin: 'hindi', kor: 'korean', tur: 'turkish', ukr: 'ukrainian',
};

const DIALECT_NAMES = {
  // English (the most common dialect-tagged language on Wiktionary).
  us: 'american', uk: 'british', au: 'australian', ca: 'canadian',
  ie: 'irish', nz: 'new_zealand', za: 'south_african', in: 'indian',
  // Other regional tags — sparse intentionally; unknown codes pass through.
  mx: 'mexican', ar: 'argentinian', be: 'belgian', at: 'austrian', ch: 'swiss',
};

function lookupName(code, table) {
  if (!code) return null;
  const key = code.toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
}

function parseAudioFilename(raw) {
  if (!raw) return { lang: null, dialect: null, speaker: null, word: 'audio', ext: '' };

  // Strip query string / fragment defensively (real Wikimedia URLs don't carry
  // them, but tracking-rewriter proxies sometimes append things like
  // ?utm_source=...). Then decode and take the last path segment.
  const decoded = decodeURIComponent(String(raw).split('?')[0].split('#')[0]);
  const base = decoded.split('/').pop() || decoded;

  const extMatch = base.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;

  // LinguaLibre: LL-Q<number>_(<lang3>)-<speaker>-<word>
  const ll = stem.match(/^LL-Q\d+_\(([a-z]{2,3})\)-([^-]+)-(.+)$/i);
  if (ll) {
    return { lang: ll[1].toLowerCase(), dialect: null, speaker: ll[2], word: ll[3], ext };
  }

  // <Lang>-<dialect>-<word>  e.g. En-au-Georgian
  const langDialect = stem.match(/^([A-Z][a-z]{0,2})-([a-z]{2,3})-(.+)$/);
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
  const lang = lookupName(parsed.lang, LANGUAGE_NAMES);
  if (lang) parts.push(lang);
  const dialect = lookupName(parsed.dialect, DIALECT_NAMES);
  if (dialect) parts.push(dialect);
  parts.push(parsed.word);
  // Speaker disambiguator (LinguaLibre) so multiple speakers don't collide.
  if (parsed.speaker) parts.push(parsed.speaker);
  const stem = parts.join('_').replace(/\s+/g, '_');
  return parsed.ext ? `${stem}.${parsed.ext}` : stem;
}

function formatAudio(rawFilename) {
  return friendlyAudioFilename(parseAudioFilename(rawFilename));
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

const pageTitle = decodeURIComponent(location.pathname.split('/wiki/')[1] ?? '');

const AUDIO_MIMES = new Set([
  'application/ogg',    // Wiktionary returns this for OGG files
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

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return null;
  return response.json();
}

async function discoverViaRest(title) {
  const data = await fetchJson(
    `https://${location.host}/api/rest_v1/page/media-list/${encodeURIComponent(title)}`
  );
  if (!data) return [];
  return (data.items || [])
    .filter(item => (item.audio_type && item.audio_type !== 'unknown') || isAudioFile(item.title))
    .map(item => item.title);
}

async function resolveUrls(fileTitles) {
  if (!fileTitles.length) return [];
  const params = new URLSearchParams({
    action: 'query', titles: fileTitles.join('|'),
    prop: 'imageinfo', iiprop: 'url|mime', format: 'json', origin: '*'
  });
  const data = await fetchJson(`https://${location.host}/w/api.php?${params}`);
  return parseAudioPages(data?.query?.pages);
}

async function discoverViaActionApi(title) {
  const params = new URLSearchParams({
    action: 'query', titles: title, generator: 'images', gimlimit: 'max',
    prop: 'imageinfo', iiprop: 'url|mime', format: 'json', origin: '*'
  });
  const data = await fetchJson(`https://${location.host}/w/api.php?${params}`);
  return parseAudioPages(data?.query?.pages);
}

// ============== DOWNLOAD LOGIC ==============

async function sendDownload(item, mode) {
  const timeoutMs = mode === 'convert' ? 120000 : 90000;
  return safeSendMessage({
    type: 'DOWNLOAD_AUDIO',
    url: item.url,
    originalFilename: item.displayName || item.filename,
    mode
  }, { timeoutMs });
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

async function downloadFile(item, button) {
  const mode = await getMode();
  if (!mode) return;

  try {
    if (mode === 'convert') showFeedback(button, t.preparingConverter);
    const response = await sendDownload(item, mode);
    showFeedback(button, response?.ok ? `✓ ${t.downloaded}` : `✗ ${t.failed}`, response?.ok);
  } catch (error) {
    logError('Download failed:', error);
    showFeedback(button, `✗ ${t.failed}`, false);
    try { await sendDownload(item, 'original'); } catch {}
  }
}

async function downloadAll(items, button) {
  const mode = await getMode();
  if (!mode) return;

  let ok = 0;
  for (const item of items) {
    try {
      const res = await sendDownload(item, mode);
      if (res?.ok) ok++;
    } catch { /* counted as fail */ }
  }

  if (ok > 0) {
    showFeedback(button, `✓ ${ok}/${items.length} ${t.downloaded}`);
  } else {
    showFeedback(button, `✗ ${t.failed}`, false);
    // Fallback: retry all as original
    for (const item of items) {
      try { await sendDownload(item, 'original'); } catch {}
    }
  }
}

// ============== UI ==============

function createUI(items) {
  if (!items.length) return;

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px system-ui';
  panel.innerHTML = `
    <div id="audio-panel" data-testid="wad-panel" style="background:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);min-width:260px;max-width:360px">
      <div style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>${t.audioFiles}</span>
        <button id="minimize-btn" data-testid="wad-minimize" style="border:0;background:none;color:#666;cursor:pointer;font-size:16px;padding:4px;border-radius:4px" title="Minimize panel">\u2212</button>
      </div>
      <div class="audio-panel-body" style="max-height:260px;overflow:auto">
        ${items.map((item, i) => `
          <div data-testid="wad-audio-item" style="display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid #f6f6f6" title="${escapeHtml(item.filename)}">
            <div style="flex:1;word-break:break-all" data-testid="wad-audio-filename">${escapeHtml(item.displayName || item.filename)}</div>
            <button data-testid="wad-download" data-i="${i}" style="border:0;border-radius:8px;padding:6px 12px;background:#1a73e8;color:#fff;cursor:pointer">${t.downloadButton}</button>
          </div>`).join('')}
      </div>
      ${items.length > 1 ? `
      <div class="audio-panel-footer" style="display:flex;gap:8px;padding:10px 12px">
        <button id="dl-all" data-testid="wad-download-all" style="border:0;border-radius:8px;padding:8px 12px;background:#1a73e8;color:#fff;cursor:pointer">${t.downloadAllButton}</button>
      </div>` : ''}
    </div>`;

  // Download buttons
  panel.addEventListener('click', e => {
    const btn = e.target.closest('button[data-i]');
    if (btn) downloadFile(items[Number(btn.dataset.i)], btn);
  });

  // Batch button
  const batchBtn = panel.querySelector('#dl-all');
  if (batchBtn) batchBtn.onclick = () => downloadAll(items, batchBtn);

  // Minimize/restore
  const minimizeBtn = panel.querySelector('#minimize-btn');
  const body = panel.querySelector('.audio-panel-body');
  const footer = panel.querySelector('.audio-panel-footer');
  let minimized = false;

  minimizeBtn.onclick = () => {
    minimized = !minimized;
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
    // REST API discovery, then resolve URLs via Action API
    const fileTitles = await discoverViaRest(pageTitle);
    let audioFiles = fileTitles.length ? await resolveUrls(fileTitles) : [];

    // Fallback: direct Action API scan
    if (!audioFiles.length) audioFiles = await discoverViaActionApi(pageTitle);

    // Compute friendly display name once; UI + sendDownload both read it.
    audioFiles.forEach(item => { item.displayName = formatAudio(item.filename); });

    if (audioFiles.length) createUI(audioFiles);
  } catch (error) {
    logError('[Wiktionary Audio] Discovery failed:', error);
  }
})();
