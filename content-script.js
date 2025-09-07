// Content script for WAV-first Wiktionary audio downloads
// Based on production-grade plan with REST API discovery

// Debug logging (set to false for production)
const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console); // Always log errors

// ============== EXTENSION CONTEXT HELPERS ==============

function isExtensionContextValid() {
  try {
    return chrome.runtime && chrome.runtime.id;
  } catch (error) {
    return false;
  }
}

async function safeSendMessage(message, options = {}) {
  const { timeoutMs = 90000 } = options;
  
  try {
    if (!isExtensionContextValid()) {
      throw new Error("Extension context invalidated - please refresh the page");
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logError('[Wiktionary Audio] Message timeout after', timeoutMs, 'ms');
        reject(new Error(`Message timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timeout);
        
        if (chrome.runtime.lastError) {
          logError('[Wiktionary Audio] Runtime error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  } catch (error) {
    logError('[Wiktionary Audio] safeSendMessage error:', error);
    if (error.message.includes('Extension context invalidated')) {
      showContextInvalidatedMessage();
    }
    throw error;
  }
}

function showContextInvalidatedMessage() {
  const existingNotice = document.querySelector('.wiktionary-audio-context-notice');
  if (existingNotice) return;

  const notice = document.createElement('div');
  notice.className = 'wiktionary-audio-context-notice';
  notice.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 2147483647;
    background: #f44336; color: white; padding: 12px 16px;
    border-radius: 8px; font: 14px system-ui; max-width: 300px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  `;
  notice.innerHTML = `
    <strong>${t.extensionReloaded}</strong><br>
    ${t.refreshMessage}
    <button onclick="location.reload()" style="margin-left: 8px; padding: 4px 8px; background: white; color: #f44336; border: none; border-radius: 4px; cursor: pointer;">${t.refreshButton}</button>
  `;
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

// Get current language from URL
const getCurrentLanguage = () => {
  const match = location.hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const lang = match ? match[1] : 'en';
  return i18n[lang] ? lang : 'en'; // Fallback to English
};

const currentLang = getCurrentLanguage();
const t = i18n[currentLang];

// ============== API FUNCTIONS ==============

const title = decodeURIComponent(location.pathname.split("/wiki/")[1] || "");

// Enhanced audio format detection
function isAudioFile(filename, mimeType) {
  // Primary: MIME type detection
  if (mimeType) {
    const audioMimeTypes = [
      'audio/mpeg',     // MP3
      'audio/mp3',      // MP3 (alternative)
      'audio/ogg',      // OGG Vorbis/Opus
      'audio/wav',      // WAV
      'audio/wave',     // WAV (alternative)
      'audio/webm',     // WebM Audio
      'audio/mp4',      // M4A/AAC in MP4
      'audio/aac',      // AAC
      'audio/x-aac',    // AAC (alternative)
      'audio/flac',     // FLAC
      'audio/x-flac',   // FLAC (alternative)
      'audio/opus',     // Opus
      'audio/3gpp',     // 3GP audio
      'audio/amr',      // AMR
      'audio/x-ms-wma', // WMA
      'video/ogg',      // OGV with audio (Theora+Vorbis)
      'video/webm'      // WebM with audio
    ];
    if (audioMimeTypes.includes(mimeType.toLowerCase())) {
      return true;
    }
  }
  
  // Fallback: Extended file extension matching
  if (filename && typeof filename === "string") {
    return /\.(ogg|oga|opus|mp3|wav|wave|webm|m4a|aac|flac|wma|amr|3gp|3ga)$/i.test(filename);
  }
  
  return false;
}

async function listAudioFileTitles(pageTitle) {
  const rest = `https://${location.host}/api/rest_v1/page/media-list/${encodeURIComponent(pageTitle)}`;
  const r = await fetch(rest, { credentials: "omit" });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.items || [])
    .filter(it => {
      // Accept any item with audio_type or that looks like an audio file
      const hasAudioType = it.audio_type && it.audio_type !== "unknown";
      const looksLikeAudio = isAudioFile(it.title, null);
      return hasAudioType || looksLikeAudio;
    })
    .map(it => it.title);
}

async function resolveDirectUrls(fileTitles) {
  if (!fileTitles.length) return [];
  const api = `https://${location.host}/w/api.php`;
  const p = new URLSearchParams({
    action: "query",
    titles: fileTitles.join("|"),
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    format: "json",
    origin: "*"
  });
  
  log('[Wiktionary Audio] Resolving URLs for titles:', fileTitles);
  const r = await fetch(`${api}?${p}`, { credentials: "omit" });
  const j = await r.json();
  log('[Wiktionary Audio] Action API response:', j);
  
  const out = [];
  for (const pg of Object.values(j?.query?.pages || {})) {
    const ii = pg?.imageinfo?.[0];
    log('[Wiktionary Audio] Processing page:', pg.title, 'imageinfo:', ii);
    
    if (ii?.url && isAudioFile(ii.url, ii.mime)) {
      out.push({
        title: pg.title,
        url: ii.url,
        filename: decodeURIComponent(ii.url.split("/").pop() || "audio"),
        license: ii.extmetadata || {}
      });
    }
  }
  return out;
}

// ============== UI CREATION ==============

function createUI(items) {
  if (!items.length) return;
  
  const showDownloadAll = items.length > 1;
  
  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px system-ui";
  panel.innerHTML = `
    <div id="audio-panel" style="background:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);min-width:260px;max-width:360px;transition:transform 0.3s ease">
      <div style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>${t.audioFiles}</span>
        <button id="minimize-btn" style="border:0;background:none;color:#666;cursor:pointer;font-size:16px;padding:4px;border-radius:4px" title="Minimize panel">−</button>
      </div>
      <div style="max-height:260px;overflow:auto">
        ${items.map((it,i)=>`
          <div style="display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid #f6f6f6">
            <div style="flex:1;word-break:break-all">${it.filename}</div>
            <button data-i="${i}" style="border:0;border-radius:8px;padding:6px 12px;background:#1a73e8;color:#fff;cursor:pointer;transition:background 0.2s ease" onmouseover="this.style.background='#1557b0'" onmouseout="this.style.background='#1a73e8'">${t.downloadButton}</button>
          </div>`).join("")}
      </div>
      ${showDownloadAll ? `
      <div style="display:flex;gap:8px;padding:10px 12px">
        <button id="dl-all" style="border:0;border-radius:8px;padding:8px 12px;background:#1a73e8;color:#fff;cursor:pointer;transition:background 0.2s ease" onmouseover="this.style.background='#1557b0'" onmouseout="this.style.background='#1a73e8'">${t.downloadAllButton}</button>
      </div>` : ''}
    </div>`;
  
  // Individual file buttons
  panel.addEventListener("click", e => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    downloadFile(it, b);
  });
  
  // Batch button (only if multiple files)
  if (showDownloadAll) {
    const batchButton = panel.querySelector("#dl-all");
    batchButton.onclick = () => downloadAllFiles(items, batchButton);
  }
  
  // Minimize/restore functionality
  const minimizeBtn = panel.querySelector("#minimize-btn");
  const panelContent = panel.querySelector("#audio-panel");
  // Get all direct child divs after the header (more reliable than style attribute matching)  
  const contentDivs = Array.from(panelContent.children).slice(1); // All content after header
  let isMinimized = false;
  
  minimizeBtn.onclick = () => {
    isMinimized = !isMinimized;
    if (isMinimized) {
      // Hide all content divs, keeping only the header visible
      contentDivs.forEach(div => div.style.display = 'none');
      minimizeBtn.textContent = '+';
      minimizeBtn.title = 'Expand panel';
    } else {
      // Show all content divs again with their original display values
      contentDivs.forEach(div => {
        // Restore original display style (block for downloads list, flex for download all section)
        if (div.innerHTML.includes('dl-all')) {
          div.style.display = 'flex';
        } else {
          div.style.display = 'block';
        }
      });
      minimizeBtn.textContent = '−';
      minimizeBtn.title = 'Minimize panel';
    }
  };
  
  // Hover effect for minimize button
  minimizeBtn.onmouseover = () => minimizeBtn.style.background = '#f0f1f3';
  minimizeBtn.onmouseout = () => minimizeBtn.style.background = 'none';
  
  document.documentElement.appendChild(panel);
}

// Show download feedback
function showDownloadFeedback(button, message, isSuccess = true) {
  // Clear any existing timeout to prevent race conditions
  if (button._feedbackTimeout) {
    clearTimeout(button._feedbackTimeout);
  }
  
  // Store original text only if not already stored (for first call)
  if (!button._originalText) {
    button._originalText = button.textContent;
  }
  
  button.textContent = message;
  button.style.background = isSuccess ? '#34a853' : '#ea4335';
  button.disabled = true;
  
  button._feedbackTimeout = setTimeout(() => {
    button.textContent = button._originalText;
    button.style.background = '#1a73e8';
    button.disabled = false;
    // Clean up stored references
    delete button._originalText;
    delete button._feedbackTimeout;
  }, 2000);
}

// Download single file based on settings
async function downloadFile(item, buttonElement) {
  try {
    const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    
    // Show special feedback for convert mode (first-time may take longer)
    if (mode === 'convert') {
      showDownloadFeedback(buttonElement, `${t.preparingConverter || '⏳ Preparing converter...'}`, true);
    }
    
    // Use longer timeout for convert mode to handle cold FFmpeg loading
    const timeoutMs = mode === 'convert' ? 120000 : 90000; // 2 minutes for convert, 90s for others
    
    const response = await safeSendMessage({
      type: 'DOWNLOAD_AUDIO',
      url: item.url,
      originalFilename: item.filename,
      mode
    }, { timeoutMs });
    
    if (response && response.ok) {
      showDownloadFeedback(buttonElement, `✓ ${t.downloaded}`);
    } else {
      showDownloadFeedback(buttonElement, `✗ ${t.failed}`, false);
    }
  } catch (error) {
    console.error('Download failed:', error);
    showDownloadFeedback(buttonElement, `✗ ${t.failed}`, false);
    
    // Fallback to original download
    try {
      await safeSendMessage({
        type: 'DOWNLOAD_AUDIO',
        url: item.url,
        originalFilename: item.filename,
        mode: 'original'
      });
    } catch (fallbackError) {
      logError('Fallback download also failed:', fallbackError);
    }
  }
}

// Download all files based on settings
async function downloadAllFiles(items, buttonElement) {
  try {
    const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    
    // For batch downloads, process each item individually to support new mode system
    let successCount = 0;
    let failCount = 0;
    
    for (const item of items) {
      try {
        // Use longer timeout for convert mode to handle FFmpeg processing
        const timeoutMs = mode === 'convert' ? 120000 : 90000; // 2 minutes for convert, 90s for others
        
        const response = await safeSendMessage({
          type: 'DOWNLOAD_AUDIO',
          url: item.url,
          originalFilename: item.filename,
          mode
        }, { timeoutMs });
        
        if (response && response.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        logError('Individual download in batch failed:', error);
        failCount++;
      }
    }
    
    if (successCount > 0) {
      showDownloadFeedback(buttonElement, `✓ ${successCount}/${items.length} ${t.downloaded}`);
    } else {
      showDownloadFeedback(buttonElement, `✗ ${t.failed}`, false);
    }
  } catch (error) {
    logError('Batch download failed:', error);
    showDownloadFeedback(buttonElement, `✗ ${t.failed}`, false);
    
    // Fallback to original download for all items
    try {
      for (const item of items) {
        await safeSendMessage({
          type: 'DOWNLOAD_AUDIO',
          url: item.url,
          originalFilename: item.filename,
          mode: 'original'
        });
      }
    } catch (fallbackError) {
      logError('Fallback batch download also failed:', fallbackError);
    }
  }
}

// Fallback: Direct Action API discovery (like old approach)
async function fallbackActionApiDiscovery(pageTitle) {
  const api = `https://${location.host}/w/api.php`;
  const params = new URLSearchParams({
    action: "query",
    titles: pageTitle,
    generator: "images",
    gimlimit: "max",
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    format: "json",
    origin: "*"
  });

  const r = await fetch(`${api}?${params}`, { credentials: "omit" });
  const j = await r.json();
  const out = [];
  
  for (const pg of Object.values(j?.query?.pages || {})) {
    const ii = pg?.imageinfo?.[0];
    if (ii?.url && isAudioFile(ii.url, ii.mime)) {
      out.push({
        title: pg.title,
        url: ii.url,
        filename: decodeURIComponent(ii.url.split("/").pop() || "audio"),
        license: ii.extmetadata || {}
      });
    }
  }
  return out;
}

// ============== MAIN EXECUTION ==============

(async () => {
  if (!title) return;
  
  try {
    // Try REST API discovery first
    const files = await listAudioFileTitles(title);
    
    let resolved = [];
    if (files.length > 0) {
      // Resolve direct URLs and metadata via Action API
      resolved = await resolveDirectUrls(files);
    }
    
    // If REST API didn't find anything, try direct Action API approach
    if (resolved.length === 0) {
      resolved = await fallbackActionApiDiscovery(title);
    }
    
    if (resolved.length > 0) {
      createUI(resolved);
    }
  } catch (error) {
    console.error('[Wiktionary Audio] Failed to discover audio:', error);
  }
})();