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
    originalFilename: item.filename,
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
          <div data-testid="wad-audio-item" style="display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid #f6f6f6">
            <div style="flex:1;word-break:break-all" data-testid="wad-audio-filename">${item.filename}</div>
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

    if (audioFiles.length) createUI(audioFiles);
  } catch (error) {
    logError('[Wiktionary Audio] Discovery failed:', error);
  }
})();
