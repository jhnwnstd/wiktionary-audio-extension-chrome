// @ts-check
// On-page audio panel: rendering, preview controls, per-row downloads, and
// the Download All flow. Dynamic-imported from the content script entry
// after discovery returns items, so this whole module's parse cost is
// skipped on pages with no pronunciation audio.

import { t } from '../shared/i18n.mjs';
import { batchFolderName } from '../shared/paths.mjs';
import { isExtensionContextValid, safeSendMessage } from './context.mjs';

/** @typedef {import('./discovery.mjs').AudioItem} AudioItem */

/**
 * @param {AudioItem} item
 * @param {'original' | 'convert' | 'both'} mode
 * @param {string} [folder]
 */
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
  if (!isExtensionContextValid()) return null;
  if (cachedMode) return cachedMode;
  if (cachedModePromise) return cachedModePromise;
  cachedModePromise = (async () => {
    // chrome.storage.sync.get can reject on transport errors (sync disabled,
    // profile transition, quota). The missing-value path already defaults to
    // 'original'; defaulting on rejection keeps the download button usable
    // instead of leaving the caller with an unhandled rejection.
    let mode = 'original';
    try {
      const got = await chrome.storage.sync.get({ mode: 'original' });
      if (got && typeof got.mode === 'string') mode = got.mode;
    } catch { /* fall through with 'original' */ }
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
      console.error('Download failed:', settled.find(s => s.status === 'rejected').reason);
    }
    showFeedback(button, t.failed, 'error');
    return false;
  } else {
    // Partial: only meaningful in `both` mode when one sub-mode succeeded.
    showFeedback(button, `${okCount}/${subModes.length} ${t.downloaded}`, 'partial');
    return false;
  }
}

/**
 * @param {AudioItem[]} items
 * @param {HTMLButtonElement} button
 * @param {string} pageTitle
 */
async function downloadAll(items, button, pageTitle) {
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

/**
 * Build the on-page panel and attach it to document.documentElement.
 * @param {AudioItem[]} items
 * @param {string} pageTitle  used for the batch-download folder name
 */
export function createUI(items, pageTitle) {
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
  minimizeBtn.textContent = '−';
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
      downloadAll(items, batchBtn, pageTitle);
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
    minimizeBtn.textContent = minimized ? '+' : '−';
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
