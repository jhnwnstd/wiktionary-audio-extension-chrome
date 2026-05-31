// @ts-check
// On-page panel: rendering, preview, per-row + batch downloads. Dynamic-
// imported only after discovery returns items, so pages without audio skip
// the parse cost.

import { t } from '../shared/i18n.mjs';
import { batchFolderName } from '../shared/paths.mjs';
import { createModeCache } from '../shared/mode-cache.mjs';
import { isExtensionContextValid, safeSendMessage, showContextInvalidatedMessage } from './context.mjs';

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

// Button feedback. progress + success persist (re-download stays clickable
// on success); error + partial auto-clear after FEEDBACK_RESET_MS. Lifetime
// is per panel render; page refresh wipes everything.
const FEEDBACK_COLORS = {
  progress: '#fbbc04',
  success:  '#34a853',
  error:    '#ea4335',
  partial:  '#fb8c00',
};
const FEEDBACK_IDLE_BG = '#1a73e8';
const FEEDBACK_RESET_MS = 2000;

// Capture once at button creation so the timer always restores to the
// real idle label rather than whatever showFeedback set on a previous
// call. The lazy-capture pattern previously here could, after a
// success-then-error sequence, restore the button to "Downloaded"
// instead of "Download".
function captureIdleLabel(button) {
  if (button._originalText === undefined) {
    button._originalText = button.textContent;
  }
}

// createUI installs the panel's live region updater here. Default is a
// no-op so callers in non-panel contexts (tests, future SW usage) stay
// safe. Screen readers ignore button text changes inside shadow DOM; the
// live region is what surfaces success/failure to assistive tech.
/** @type {(msg: string) => void} */
let liveAnnounce = () => {};

function showFeedback(button, message, kind = 'success') {
  if (button._feedbackTimer) clearTimeout(button._feedbackTimer);
  captureIdleLabel(button);

  button.textContent = message;
  button.style.background = FEEDBACK_COLORS[kind] || FEEDBACK_COLORS.success;
  button.disabled = kind !== 'success';

  if (kind === 'success' || kind === 'error' || kind === 'partial') {
    liveAnnounce(message);
  }

  if (kind === 'progress' || kind === 'success') return;

  button._feedbackTimer = setTimeout(() => {
    button.textContent = button._originalText;
    button.style.background = FEEDBACK_IDLE_BG;
    button.disabled = false;
    delete button._feedbackTimer;
  }, FEEDBACK_RESET_MS);
}

// Cache the mode locally so download clicks don't await storage.sync.
// State lives in createModeCache; here we inject the chrome.* deps.
const _getMode = createModeCache({
  get: (defaults) => chrome.storage.sync.get(defaults),
  onChanged: (cb) => {
    try { chrome.storage.onChanged.addListener(cb); }
    catch { /* extension context not yet ready */ }
  },
});

async function getMode() {
  if (!isExtensionContextValid()) {
    showContextInvalidatedMessage();
    return null;
  }
  return _getMode();
}

// 'both' fans out to original + convert in parallel.
function subModesFor(mode) {
  return mode === 'both' ? ['original', 'convert'] : [mode];
}

// Returns true iff every sub-mode succeeded; caller uses this for the
// per-panel "all downloaded" auto-flip.
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
    const rejected = settled.find(s => s.status === 'rejected');
    if (rejected) console.error('Download failed:', rejected.reason);
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
 * @param {(item: AudioItem) => void} [onItemSuccess]  per-item success hook;
 *   createUI uses this to flip the row's individual Download button green,
 *   mirroring the click-each-then-all-flips direction.
 */
async function downloadAll(items, button, pageTitle, onItemSuccess) {
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
    if (settled.every(s => s.status === 'fulfilled' && s.value?.ok)) {
      okItems++;
      if (onItemSuccess) onItemSuccess(items[i]);
    }
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

const PLAY_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>`;
const PREVIEW_IDLE_BG = '#eef2f7';
const PREVIEW_IDLE_COLOR = '#1a73e8';

// Preview buttons use SVG icons (not text), so showFeedback's text-swap
// would obliterate the icon. Brief background + title change instead, so
// a play() rejection or audio load error still gives the user something
// to see and screen readers something to announce.
function showPreviewError(button) {
  if (button._previewErrorTimer) clearTimeout(button._previewErrorTimer);
  if (button._previewIdleTitle === undefined) button._previewIdleTitle = button.title;
  button.style.background = FEEDBACK_COLORS.error;
  button.style.color = '#fff';
  button.title = t.failed;
  button._previewErrorTimer = setTimeout(() => {
    button.style.background = PREVIEW_IDLE_BG;
    button.style.color = PREVIEW_IDLE_COLOR;
    button.title = button._previewIdleTitle;
    delete button._previewIdleTitle;
    delete button._previewErrorTimer;
  }, FEEDBACK_RESET_MS);
}

// One shared Audio element: switching previews swaps src, so we don't pile
// up listeners across N elements and can explicitly tear down the previous
// src instead of waiting for GC.
const previewState = {
  /** @type {HTMLAudioElement | null} */
  audio: null,
  /** @type {HTMLButtonElement | null} */
  button: null,
};

function ensurePreviewAudio() {
  if (previewState.audio) return previewState.audio;
  const a = new Audio();
  // Listeners read from previewState so the active button can swap freely.
  a.addEventListener('play', () => {
    if (previewState.button) {
      previewState.button.innerHTML = PAUSE_SVG;
      previewState.button.setAttribute('aria-pressed', 'true');
    }
  });
  a.addEventListener('pause', () => {
    if (previewState.button) {
      previewState.button.innerHTML = PLAY_SVG;
      previewState.button.setAttribute('aria-pressed', 'false');
    }
  });
  a.addEventListener('ended', () => {
    if (previewState.button) {
      previewState.button.innerHTML = PLAY_SVG;
      previewState.button.setAttribute('aria-pressed', 'false');
    }
    previewState.button = null;
  });
  a.addEventListener('error', () => {
    if (previewState.button) {
      previewState.button.innerHTML = PLAY_SVG;
      previewState.button.setAttribute('aria-pressed', 'false');
      showPreviewError(previewState.button);
    }
    previewState.button = null;
  });
  previewState.audio = a;
  return a;
}

function previewAudio(item, button) {
  const audio = ensurePreviewAudio();

  // Same button = toggle play/pause.
  if (previewState.button === button) {
    if (audio.paused) audio.play().catch(() => { showPreviewError(button); });
    else audio.pause();
    return;
  }

  // Different button: tear down previous src so the browser stops decoding.
  if (previewState.button) previewState.button.innerHTML = PLAY_SVG;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  previewState.button = button;
  audio.src = item.url;
  audio.play().catch(() => {
    if (previewState.button === button) {
      button.innerHTML = PLAY_SVG;
      showPreviewError(button);
      previewState.button = null;
    }
  });
}

// Warm TCP+TLS to upload.wikimedia.org so the first real fetch skips the
// handshake. Idempotent via the data attribute.
function preconnectToUploadWikimedia() {
  if (document.querySelector('link[data-wad-preconnect="upload-wikimedia"]')) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = 'https://upload.wikimedia.org';
  link.crossOrigin = 'anonymous';
  link.dataset.wadPreconnect = 'upload-wikimedia';
  document.head.appendChild(link);
}

// Inline styles, defined once. Inside the shadow root page CSS can't reach
// them, so no ID prefixing.
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

  // Shadow root (open, for test tooling reach) + closure-bound item per
  // button is the security primitive: no DOM attribute a page could rewrite
  // can retarget a click. event.isTrusted on each handler blocks synthetic
  // clicks too.
  const host = document.createElement('div');
  host.style.cssText = HOST_STYLE;
  const root = host.attachShadow({ mode: 'open' });

  const panel = document.createElement('div');
  panel.id = 'audio-panel';
  panel.setAttribute('data-testid', 'wad-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', t.audioFiles);
  panel.style.cssText = PANEL_STYLE;

  const header = document.createElement('div');
  header.style.cssText = HEADER_STYLE;
  const headerText = document.createElement('span');
  headerText.textContent = t.audioFiles;
  const bodyId = 'wad-body-' + Math.random().toString(36).slice(2, 8);
  const minimizeBtn = document.createElement('button');
  minimizeBtn.setAttribute('data-testid', 'wad-minimize');
  minimizeBtn.setAttribute('aria-expanded', 'true');
  minimizeBtn.setAttribute('aria-controls', bodyId);
  minimizeBtn.setAttribute('aria-label', 'Minimize panel');
  minimizeBtn.style.cssText = MINIMIZE_STYLE;
  minimizeBtn.title = 'Minimize panel';
  minimizeBtn.textContent = '−';
  header.append(headerText, minimizeBtn);

  const body = document.createElement('div');
  body.id = bodyId;
  body.className = 'audio-panel-body';
  body.style.cssText = BODY_STYLE;

  // Visually-hidden live region for assistive tech. showFeedback writes
  // here on terminal states (success/error/partial) so screen readers
  // hear "Downloaded" or "Failed" without focus tracking.
  const statusLive = document.createElement('div');
  statusLive.setAttribute('aria-live', 'polite');
  statusLive.setAttribute('role', 'status');
  statusLive.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap';
  /** @type {ReturnType<typeof setTimeout> | null} */
  let liveTimer = null;
  liveAnnounce = (msg) => {
    if (liveTimer) clearTimeout(liveTimer);
    // Clear-then-set forces re-announcement when message repeats.
    statusLive.textContent = '';
    liveTimer = setTimeout(() => { statusLive.textContent = msg; liveTimer = null; }, 30);
  };

  // When every per-item download succeeds, the Download All button auto-
  // flips to "Downloaded"; symmetrically, when Download All succeeds for
  // an item, that row's button auto-flips. Both directions use this Set
  // (keyed on AudioItem object, no integer index a page could spoof) and
  // the itemButtons map below.
  /** @type {Set<unknown>} */
  const downloadedItems = new Set();
  /** @type {Map<AudioItem, HTMLButtonElement>} */
  const itemButtons = new Map();
  /** @type {HTMLButtonElement | null} */
  let batchBtn = null;

  for (const item of items) {
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'wad-audio-item');
    row.style.cssText = ROW_STYLE;
    row.title = item.filename;

    const previewBtn = document.createElement('button');
    previewBtn.setAttribute('data-testid', 'wad-preview');
    previewBtn.setAttribute('aria-label', 'Preview ' + (item.displayName || item.filename));
    previewBtn.setAttribute('aria-pressed', 'false');
    previewBtn.style.cssText = PREVIEW_STYLE;
    previewBtn.title = 'Preview';
    previewBtn.innerHTML = PLAY_SVG;
    previewBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;  // reject synthetic clicks
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
    itemButtons.set(item, dlBtn);
    dlBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
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

  panel.append(header, body, statusLive);

  let footer = /** @type {HTMLElement | null} */ (null);
  if (items.length > 1) {
    footer = document.createElement('div');
    footer.className = 'audio-panel-footer';
    footer.style.cssText = FOOTER_STYLE;
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'wad-download-all');
    btn.style.cssText = DOWNLOAD_ALL_STYLE;
    btn.textContent = t.downloadAllButton;
    btn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      downloadAll(items, btn, pageTitle, (item) => {
        downloadedItems.add(item);
        const rowBtn = itemButtons.get(item);
        if (rowBtn) showFeedback(rowBtn, t.downloaded, 'success');
      });
    });
    footer.appendChild(btn);
    panel.appendChild(footer);
    batchBtn = btn;
  }

  // Minimize pauses preview. Minimize >2s sends PANEL_DISMISSED (evicts
  // SW caches for these URLs). Restore after dismiss sends PREFETCH_AUDIO.
  let minimized = false;
  const itemUrls = items.map(i => i.url);
  const prefetchItems = items.map(i => ({ url: i.url, downloadName: i.downloadName }));
  /** @type {number | null} */
  let dismissTimer = null;
  let dismissed = false;

  /** @param {boolean} next */
  function setMinimized(next) {
    minimized = next;
    if (minimized && previewState.audio) previewState.audio.pause();
    body.style.display = minimized ? 'none' : '';
    if (footer) footer.style.display = minimized ? 'none' : 'flex';
    minimizeBtn.textContent = minimized ? '+' : '−';
    minimizeBtn.title = minimized ? 'Expand panel' : 'Minimize panel';
    minimizeBtn.setAttribute('aria-label', minimized ? 'Expand panel' : 'Minimize panel');
    minimizeBtn.setAttribute('aria-expanded', minimized ? 'false' : 'true');
  }

  function startMinimize() {
    setMinimized(true);
    dismissTimer = /** @type {any} */ (setTimeout(() => {
      dismissTimer = null;
      dismissed = true;
      safeSendMessage({ type: 'PANEL_DISMISSED', urls: itemUrls }, { timeoutMs: 5000 })
        .catch(() => { /* opportunistic */ });
    }, 2000));
  }

  function startExpand() {
    setMinimized(false);
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

  minimizeBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (minimized) startExpand();
    else startMinimize();
  });

  // Escape from anywhere inside the panel pauses the preview if it is
  // playing, otherwise minimizes the panel (which queues PANEL_DISMISSED
  // via the existing 2-second timer). Scoped to the panel so we never
  // preempt the page's own Escape handlers.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (previewState.audio && !previewState.audio.paused) {
      previewState.audio.pause();
      e.preventDefault();
      return;
    }
    if (!minimized) {
      startMinimize();
      e.preventDefault();
    }
  });
  minimizeBtn.addEventListener('mouseover', () => { minimizeBtn.style.background = '#f0f1f3'; });
  minimizeBtn.addEventListener('mouseout', () => { minimizeBtn.style.background = 'none'; });

  // SW restart detection via visibilitychange. The SW's audioCache lives
  // in module scope and is reclaimed on SW idle eviction. If the user
  // tabs away from a Wiktionary page longer than the SW idle timeout
  // (~30 s in practice), the prefetched bytes are gone but the panel
  // doesn't know, so the next click pays full network latency. Re-issue
  // PREFETCH_AUDIO on visibility-becomes-visible after a long invisible
  // gap so the cache is warm by the time the user clicks. Background
  // dedupes via inflightPrefetches and audioCache.has, so a redundant
  // send is cheap. Skipped while the panel is minimized-and-dismissed
  // (PANEL_DISMISSED already aborted; un-minimize is the trigger there).
  const VISIBILITY_REPRIME_GAP_MS = 25000;
  let lastHiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      lastHiddenAt = Date.now();
      return;
    }
    if (document.visibilityState !== 'visible') return;
    if (dismissed) return;
    if (!lastHiddenAt) return;
    const gap = Date.now() - lastHiddenAt;
    lastHiddenAt = 0;
    if (gap < VISIBILITY_REPRIME_GAP_MS) return;
    if (!isExtensionContextValid()) return;
    safeSendMessage({ type: 'PREFETCH_AUDIO', items: prefetchItems }, { timeoutMs: 5000 })
      .catch(() => { /* opportunistic */ });
  });

  root.appendChild(panel);
  document.documentElement.appendChild(host);
}
