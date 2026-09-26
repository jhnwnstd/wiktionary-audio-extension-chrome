// @ts-check
// Service worker entry. Manifest declares "type": "module"; shared logic
// imported from src/shared/.

import {
  PER_FILE_MAX_BYTES,
  PREFETCH_CACHE_MAX_BYTES,
  PREFETCH_CONCURRENCY,
  TRANSCODED_CACHE_MAX_BYTES,
  DISMISSED_URLS_MAX,
  AUDIO_FETCH_TIMEOUT_MS,
  TRANSCODE_TIMEOUT_MS,
  DOWNLOAD_WAIT_TIMEOUT_MS,
} from './shared/limits.mjs';
import { isAllowedAudioUrl } from './shared/audio-allowlist.mjs';
import { sanitizeFilename } from './shared/sanitize-filename.mjs';
import { pathWithFolder } from './shared/paths.mjs';
import { ByteBoundedCache } from './shared/byte-bounded-cache.mjs';
import { isAudioContentType } from './shared/content-type.mjs';
import { originalDownloadName, convertedBaseName } from './shared/download-names.mjs';
import { createDownloadClaims } from './shared/download-claims.mjs';

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

/** @param {ArrayBuffer} arrayBuffer */
function arrayBufferToBase64(arrayBuffer) {
  // Chunked to avoid `Maximum call stack size exceeded` on large spreads.
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/**
 * Open an offscreen port, run `handler(port, settle)`, settle exactly once.
 * Settled on timeout OR port.onDisconnect, so a crashed offscreen doesn't
 * leave the caller hanging for the full timeout.
 *
 * @template T
 * @param {number} timeoutMs
 * @param {(port: any, settle: (ok: boolean, value?: any) => void) => void} handler
 * @returns {Promise<T>}
 */
function withOffscreenPort(timeoutMs, handler) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    let settled = false;
    const settle = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.disconnect();
      if (ok) resolve(value);
      else reject(value instanceof Error ? value : new Error(String(value)));
    };
    const timer = setTimeout(() => settle(false, new Error(`port timeout (${timeoutMs}ms)`)), timeoutMs);
    port.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message || 'offscreen disconnected';
      settle(false, new Error(why));
    });
    handler(port, settle);
  });
}

/** @param {number} [timeoutMs] @returns {Promise<void>} */
function pingOffscreen(timeoutMs = 3000) {
  return withOffscreenPort(timeoutMs, (port, settle) => {
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'PONG') settle(true);
    });
    port.postMessage({ type: 'PING' });
  });
}

async function ensureOffscreen() {
  // WORKERS covers ffmpeg.wasm's worker; BLOBS (Chrome 116+) covers the
  // URL.createObjectURL calls in the transcode success path. Feature-detect
  // BLOBS so the call doesn't fail on Chrome 109-115, which doesn't know
  // the enum value.
  const reasons = [chrome.offscreen.Reason.WORKERS];
  if ('BLOBS' in chrome.offscreen.Reason) {
    reasons.push(chrome.offscreen.Reason.BLOBS);
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons,
      justification: 'Run ffmpeg.wasm for audio conversion and mint blob URLs for converted output'
    });
  } catch { /* already exists; Chrome enforces single offscreen doc */ }

  // Retry: createDocument can return before the module is ready to respond.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await pingOffscreen(3000);
      log('[Background] Offscreen ready (attempt', attempt + ')');
      return;
    } catch {
      log('[Background] Ping attempt', attempt, 'failed, retrying...');
      if (attempt < 4) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error('Offscreen document failed to respond after retries');
}

// Load the FFmpeg wasm core without transcoding. Fired on popup-open or
// prefetch-settle when mode is Convert/Both so the ~350-650 ms cold start
// overlaps user-think time. Fire-and-forget; cold load on first click is
// the fallback.
async function prewarmFFmpeg() {
  log('[Background] Pre-warming FFmpeg...');
  await ensureOffscreen();
  try {
    await withOffscreenPort(30000, (port, settle) => {
      port.onMessage.addListener((msg) => {
        if (msg?.type === 'PREWARMED') settle(true);
      });
      port.postMessage({ type: 'PREWARM' });
    });
  } catch { /* opportunistic */ }
}

/**
 * Send a TRANSCODE request to the offscreen FFmpeg worker. `srcUrl` is a
 * Wikimedia allowlisted https URL; offscreen fetches it (typically served
 * by Chrome's HTTP cache from our earlier SW prefetch, no second network
 * round-trip). Only the URL travels over the runtime port; a blob URL
 * pointing to the WAV output comes back.
 *
 * @param {string} srcUrl
 * @param {string} baseName  filename without extension; offscreen appends `.wav`
 * @returns {Promise<{ filename: string, blobUrl: string, byteLength: number }>}
 */
async function transcodeToWav(srcUrl, baseName) {
  log('[Background] Starting transcode...');
  await ensureOffscreen();

  return withOffscreenPort(TRANSCODE_TIMEOUT_MS, (port, settle) => {
    port.onMessage.addListener((msg) => {
      if (!msg?.ok) {
        settle(false, new Error(msg?.error || 'Transcode failed'));
        return;
      }
      if (typeof msg.blobUrl !== 'string' || !msg.blobUrl.startsWith('blob:')) {
        settle(false, new Error('Invalid blob URL from conversion'));
        return;
      }
      // Re-sanitize on receive: defense in depth against an offscreen
      // drift slipping a path-traversal segment into chrome.downloads.
      settle(true, {
        filename: sanitizeFilename(msg.filename),
        blobUrl: msg.blobUrl,
        byteLength: msg.byteLength || 0,
      });
    });
    port.postMessage({ type: 'TRANSCODE', srcUrl, outBase: baseName });
  });
}

// Fire-and-forget: release an offscreen-owned Blob URL. Best-effort cleanup.
/** @param {string} blobUrl */
function revokeBlobInOffscreen(blobUrl) {
  if (typeof blobUrl !== 'string' || !blobUrl.startsWith('blob:')) return;
  try {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    port.postMessage({ type: 'REVOKE_BLOB', blobUrl });
    port.disconnect();
  } catch { /* opportunistic */ }
}

// Prefetched audio bytes, populated on PREFETCH_AUDIO. SW-restart loses it;
// content script will re-send.
/** @type {ByteBoundedCache<ArrayBuffer>} */
const audioCache = new ByteBoundedCache(PREFETCH_CACHE_MAX_BYTES);

// .controller lets PANEL_DISMISSED abort in-flight prefetches; .done lets
// the click path await an in-flight prefetch instead of issuing a redundant
// fetch. Which fetches are abortable is decided by `claims`, not per entry.
/** @type {Map<string, { controller: AbortController, done: Promise<void> }>} */
const inflightPrefetches = new Map();

// URLs a user-initiated download currently owns. dismissUrls consults this;
// see src/shared/download-claims.mjs for why it exists and why it refcounts.
const claims = createDownloadClaims();

// Speculatively transcoded WAVs, keyed by source URL. `transcodeInflight`
// dedupes concurrent transcodes (user click vs speculative) so they share
// one ffmpeg.exec. Eviction revokes the blob URL automatically via the
// onEvict callback; caller-side revokes only fire when we DECIDE not to
// insert (dismissed, duplicate, oversized).
/** @typedef {{ blobUrl: string, filename: string, byteLength: number }} TranscodedEntry */
/** @type {ByteBoundedCache<TranscodedEntry>} */
const transcodedCache = new ByteBoundedCache(
  TRANSCODED_CACHE_MAX_BYTES,
  entry => revokeBlobInOffscreen(entry.blobUrl),
);

/** @type {Map<string, Promise<{ filename: string, blobUrl: string, byteLength: number }>>} */
const transcodeInflight = new Map();

// Tombstones for dismissed URLs. FFmpeg.wasm has no abort, so a speculative
// transcode in flight when dismissal arrives runs to completion; this guard
// keeps its result from repopulating the cleared cache. A subsequent
// PREFETCH_AUDIO clears the tombstone. Set iterates in insertion order →
// front-of-set = oldest, for the LRU cap.
/** @type {Set<string>} */
const dismissedUrls = new Set();

/** @param {string} url */
function dismissUrl(url) {
  // delete+re-add refreshes recency for a repeat dismissal.
  if (dismissedUrls.has(url)) {
    dismissedUrls.delete(url);
  } else if (dismissedUrls.size >= DISMISSED_URLS_MAX) {
    const oldest = dismissedUrls.values().next().value;
    if (oldest !== undefined) dismissedUrls.delete(oldest);
  }
  dismissedUrls.add(url);
}

/** @param {string} url @returns {TranscodedEntry | null} */
function peekTranscoded(url) {
  return transcodedCache.peek(url);
}

// Refused inserts (dismissed, duplicate, oversized) revoke the orphan blob
// URL caller-side; eviction inside the cache revokes via onEvict.
/**
 * @param {string} url
 * @param {string} filename
 * @param {string} blobUrl
 * @param {number} byteLength
 */
function addTranscoded(url, filename, blobUrl, byteLength) {
  if (dismissedUrls.has(url) || transcodedCache.has(url)) {
    revokeBlobInOffscreen(blobUrl);
    return;
  }
  const stored = transcodedCache.set(url, { blobUrl, filename, byteLength }, byteLength);
  if (!stored) revokeBlobInOffscreen(blobUrl);
}

// Transcode `url` to WAV and cache. Returns cached entry if present;
// otherwise shares one ffmpeg.exec across concurrent callers via
// transcodeInflight. The https URL is passed straight to offscreen
// (MV3 SW lacks URL.createObjectURL, so no SW-side Blob handoff);
// offscreen's fetch typically hits Chrome's HTTP cache from prefetch.
/**
 * @param {string} url  cache key
 * @param {string} baseName
 * @returns {Promise<{ filename: string, blobUrl: string, byteLength: number }>}
 */
async function transcodeForUrl(url, baseName) {
  const pre = peekTranscoded(url);
  if (pre) return pre;

  const existing = transcodeInflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const result = await transcodeToWav(url, baseName);
    addTranscoded(url, result.filename, result.blobUrl, result.byteLength);
    return result;
  })();
  transcodeInflight.set(url, promise);
  try {
    return await promise;
  } finally {
    transcodeInflight.delete(url);
  }
}

// Speculative WAV transcode of the top item once prefetch lands. Skipped
// if already cached, already in flight, or not yet prefetched (no engaged-
// user signal yet, and we don't want to fetch just to speculate).
/** @param {string} url @param {string} downloadName */
async function triggerSpeculativeTranscode(url, downloadName) {
  if (transcodedCache.has(url)) return;
  if (transcodeInflight.has(url)) return;
  if (!audioCache.has(url)) return;

  const baseName = sanitizeFilename(convertedBaseName(downloadName));
  log('[Background] Speculative transcode:', baseName);
  try {
    await transcodeForUrl(url, baseName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('[Background] Speculative transcode failed:', msg);
  }
}

/** Peek with LRU recency refresh; entry stays cached for the next click.
 * @param {string} url @returns {ArrayBuffer | null} */
function peekCached(url) {
  return audioCache.peek(url);
}

// Single ingress to audioCache. dismissedUrls guard handles the abort-vs-
// completion race deterministically; per-file cap repeated for invariant.
/** @param {string} url @param {ArrayBuffer} bytes */
function addToCache(url, bytes) {
  if (audioCache.has(url)) return;
  if (dismissedUrls.has(url)) return;
  if (bytes.byteLength > PER_FILE_MAX_BYTES) return;
  audioCache.set(url, bytes, bytes.byteLength);
}

// One validated fetch: status, post-redirect allowlist, Content-Type,
// Content-Length, and post-read byte length all checked before the bytes
// are returned. Returns null on any rejection (caller decides how to
// react). Shared between the prefetch worker pool and the click-path
// fallback in ensureValidatedBytes.
/**
 * @param {string} url
 * @param {AbortController} controller
 * @returns {Promise<ArrayBuffer | null>}
 */
async function fetchValidatedAudio(url, controller) {
  // Bound the whole exchange. Without this a stalled connection pins the
  // inflight entry (and, on the click path, the download claim protecting
  // it) open for as long as the socket lives.
  const timer = setTimeout(() => controller.abort(), AUDIO_FETCH_TIMEOUT_MS);
  try {
    // redirect:'follow' is required (Wikimedia CDN routing); the post-fetch
    // allowlist re-check is what makes that safe.
    const r = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!r.ok) return null;
    if (!isAllowedAudioUrl(r.url)) return null;
    if (!isAudioContentType(r.headers.get('Content-Type'))) return null;
    // Number.isFinite filters NaN/Infinity from a malformed header.
    const declared = parseInt(r.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(declared) && declared > PER_FILE_MAX_BYTES) {
      controller.abort();
      return null;
    }
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > PER_FILE_MAX_BYTES) return null;
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

// Cache hit, await in-flight prefetch, or do our own validated fetch.
// Used by the Original-mode click path so chrome.downloads only ever
// writes pre-validated bytes (via data URL); chrome.downloads never
// issues its own network fetch for audio. Returns null on any failure.
/**
 * @param {string} url
 * @returns {Promise<ArrayBuffer | null>}
 */
async function ensureValidatedBytes(url) {
  let cached = peekCached(url);
  if (cached) return cached;
  const inflight = inflightPrefetches.get(url);
  if (inflight) {
    await inflight.done;
    cached = peekCached(url);
    if (cached) return cached;
  }
  // No cache and nothing in flight; fetch it ourselves. Register an
  // inflight entry so a concurrent second click on the same URL shares
  // this fetch via the await branch above. The caller holds a download
  // claim, which is what keeps PANEL_DISMISSED from aborting this.
  const controller = new AbortController();
  /** @type {(value?: void) => void} */
  let resolveDone = () => {};
  const done = new Promise(r => { resolveDone = r; });
  inflightPrefetches.set(url, { controller, done });
  try {
    const bytes = await fetchValidatedAudio(url, controller);
    if (bytes) addToCache(url, bytes);
    return bytes;
  } catch {
    return null;
  } finally {
    inflightPrefetches.delete(url);
    resolveDone();
  }
}

// Fetch a batch with bounded concurrency, stash bytes in audioCache, and
// fire a speculative top-item transcode if mode is Convert/Both. Best-
// effort throughout; per-URL failures are swallowed.
/** @param {Array<{ url: string, downloadName: string }>} items */
async function prefetchAudio(items) {
  if (!Array.isArray(items) || !items.length) return;

  // Re-engagement: clear tombstones so addToCache/addTranscoded can land.
  for (const i of items) {
    if (i && typeof i.url === 'string') dismissedUrls.delete(i.url);
  }

  // One mode read; consumed by pre-warm (immediately) and speculative
  // transcode (after prefetch settles). Runs in parallel with fetches.
  const modePromise = chrome.storage.sync.get({ mode: 'original' })
    .then(({ mode }) => (mode === 'convert' || mode === 'both' ? mode : 'original'))
    .catch(() => 'original');
  modePromise.then(mode => {
    if (mode === 'convert' || mode === 'both') {
      prewarmFFmpeg().catch(() => { /* opportunistic */ });
    }
  });

  // Set-dedupe catches duplicate URLs in one batch (different File: titles
  // resolving to the same asset); inflight check prevents repeat messages
  // from spawning a second AbortController PANEL_DISMISSED can't target.
  const todo = Array.from(new Set(
    items
      .filter(i => i && isAllowedAudioUrl(i.url))
      .map(i => i.url)
  )).filter(u => !audioCache.has(u) && !inflightPrefetches.has(u));

  if (todo.length) {
    // Shared cursor across workers: O(1) dequeue (vs Array.shift's O(n)).
    let cursor = 0;
    const workers = Array.from({ length: PREFETCH_CONCURRENCY }, async () => {
      while (cursor < todo.length) {
        const url = todo[cursor++];
        if (!url) continue;
        const controller = new AbortController();
        /** @type {(value?: void) => void} */
        let resolveDone = () => {};
        const done = new Promise(r => { resolveDone = r; });
        inflightPrefetches.set(url, { controller, done });
        try {
          const bytes = await fetchValidatedAudio(url, controller);
          if (bytes) addToCache(url, bytes);
        } catch { /* per-URL best effort; one failure doesn't block others */ }
        finally {
          inflightPrefetches.delete(url);
          resolveDone();
        }
      }
    });
    await Promise.allSettled(workers);
    log(`[Background] Prefetch done. Cache: ${audioCache.size()} items, ${(audioCache.bytes() / 1024).toFixed(0)} KB`);
  }

  const top = items[0];
  if (top && top.url && top.downloadName) {
    const mode = await modePromise;
    if (mode === 'convert' || mode === 'both') {
      triggerSpeculativeTranscode(top.url, top.downloadName);
    }
  }
}

// PANEL_DISMISSED: tombstone, abort, evict. Tombstone goes first so late-
// landing work can't repopulate. Cache.delete() handles byte bookkeeping
// and (for transcoded) blob revocation via onEvict.
//
// Claimed URLs are skipped wholesale. Dismissal only ever means "stop doing
// speculative work for me"; it is never a cancel for a download the user
// asked for. Skipping the tombstone is the load-bearing part: with one set,
// a transcode that finishes after this point gets refused by addTranscoded,
// which revokes the very blob URL the convert path is about to hand to
// chrome.downloads.
/** @param {string[]} urls */
function dismissUrls(urls) {
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    if (claims.has(url)) continue;
    dismissUrl(url);
    inflightPrefetches.get(url)?.controller.abort();
    audioCache.delete(url);
    transcodedCache.delete(url);
  }
}

// Module-scope map keyed by chrome.downloads.download id. The top-level
// chrome.downloads.onChanged listener below routes terminal events into
// the matching entry's resolve. Per-call listener registration would die
// with MV3 SW idle eviction during the wait window; top-level registration
// survives because MV3 re-runs the SW module on event delivery.
/** @type {Map<number, { resolve: (state: string) => void, timer: ReturnType<typeof setTimeout> }>} */
const pendingDownloads = new Map();

chrome.downloads.onChanged.addListener(/** @param {any} delta */ delta => {
  const pending = pendingDownloads.get(delta.id);
  if (!pending) return;
  const next = delta.state?.current;
  if (next === 'complete' || next === 'interrupted') {
    pendingDownloads.delete(delta.id);
    clearTimeout(pending.timer);
    pending.resolve(next);
  }
});

// Resolve when a download reaches a terminal state. Returns 'complete' or
// 'interrupted' so callers distinguish a real save from a cancel / block.
/**
 * @param {number} downloadId
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function waitForDownloadComplete(downloadId, timeoutMs = DOWNLOAD_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDownloads.delete(downloadId);
      reject(new Error(`download timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    pendingDownloads.set(downloadId, { resolve, timer });
    // Race guard: download may already be terminal before the listener
    // would have seen its delta. Re-check current state once and self-
    // resolve from the map.
    chrome.downloads.search({ id: downloadId }, /** @param {any[]} items */ (items) => {
      // chrome.runtime.lastError on search means the downloads database
      // is busy or unavailable. The onChanged listener and timeout still
      // provide the safety net; a no-op here is correct.
      if (chrome.runtime.lastError) return;
      const item = items?.[0];
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        const p = pendingDownloads.get(downloadId);
        if (p) {
          pendingDownloads.delete(downloadId);
          clearTimeout(p.timer);
          p.resolve(item.state);
        }
      }
    });
  });
}

// Build chrome.downloads options for the two modes. Split out of the message
// handler so it reads as claim -> build -> download -> wait -> release.

/**
 * Convert mode. A cached WAV returns instantly; otherwise transcodeForUrl
 * shares any in-flight transcode or starts a fresh one. transcodedCache owns
 * the returned blob URL until the handler's claim release evicts it.
 * @param {string} url
 * @param {string} originalFilename
 * @param {string | undefined} folder
 * @returns {Promise<{ url: string, filename: string, saveAs: boolean }>}
 */
async function convertDownloadOptions(url, originalFilename, folder) {
  log('[Background] Converting:', originalFilename, folder ? `-> ${folder}/` : '');
  const baseName = sanitizeFilename(convertedBaseName(originalFilename));
  const { filename, blobUrl } = await transcodeForUrl(url, baseName);
  return { url: blobUrl, filename: pathWithFolder(folder, filename), saveAs: false };
}

/**
 * Original mode. Routing every download through audioCache means
 * chrome.downloads only ever writes pre-validated bytes (URL allowlist +
 * Content-Type + size cap, all enforced inside ensureValidatedBytes);
 * chrome.downloads itself never issues a network fetch for audio, and the
 * data URL is just the handoff. The saved file's extension comes from
 * `filename`, not the data URL MIME.
 * @param {string} url
 * @param {string} originalFilename
 * @param {string | undefined} folder
 * @returns {Promise<{ url: string, filename: string, saveAs: boolean }>}
 */
async function originalDownloadOptions(url, originalFilename, folder) {
  const bytes = await ensureValidatedBytes(url);
  if (!bytes) throw new Error('audio fetch failed');
  log('[Background] Downloading original (data URL):', originalFilename, folder ? `-> ${folder}/` : '');
  return {
    url: `data:application/octet-stream;base64,${arrayBufferToBase64(bytes)}`,
    // Clamps the trailing extension to an audio type before it hits disk
    // (fetchValidatedAudio already confirmed the bytes are audio; this is
    // belt and braces against an upstream mediatype slip round-tripping a
    // deceptive .exe-suffixed name) and adds the `_raw` tag when the source
    // is itself a WAV, so it can't collide with the conversion.
    filename: pathWithFolder(folder, originalDownloadName(originalFilename)),
    saveAs: false,
  };
}

// Accept messages only from our own extension pages or content scripts on
// HTTPS Wiktionary tabs. HTTP is rejected (downgrade defense).
/** @param {any} sender */
function isAllowedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const extPrefix = chrome.runtime.getURL('');
  if (typeof sender.url === 'string' && sender.url.startsWith(extPrefix)) return true;
  const tabUrl = sender.tab?.url;
  if (typeof tabUrl !== 'string') return false;
  try {
    const u = new URL(tabUrl);
    return u.protocol === 'https:' && /\.wiktionary\.org$/.test(u.hostname);
  } catch { return false; }
}

chrome.runtime.onMessage.addListener(
  /**
   * @param {any} msg  arbitrary content; we narrow on `msg.type`
   * @param {any} sender
   * @param {(response: DownloadResponse) => void} sendResponse
   */
  (msg, sender, sendResponse) => {
  if (!isAllowedSender(sender)) {
    sendResponse({ ok: false, error: 'sender not allowed' });
    return false;
  }

  // Fire-and-forget; respond immediately, the network work is opportunistic.
  if (msg?.type === 'PREFETCH_AUDIO') {
    prefetchAudio(Array.isArray(msg.items) ? msg.items : []);
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'PANEL_DISMISSED') {
    dismissUrls(Array.isArray(msg.urls) ? msg.urls : []);
    sendResponse({ ok: true });
    return false;
  }

  // Popup open == "download imminent"; pre-warm FFmpeg if mode requires it.
  if (msg?.type === 'POPUP_OPENED') {
    (async () => {
      try {
        const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
        if (mode === 'convert' || mode === 'both') {
          prewarmFFmpeg().catch(() => { /* opportunistic */ });
        }
      } catch { /* opportunistic */ }
    })();
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type !== 'DOWNLOAD_AUDIO') return false;

  const { url, originalFilename, mode, folder } = msg;
  // Shape checks at the privileged boundary. isAllowedSender already
  // filtered the source; these prevent malformed internal messages from
  // dropping into the wrong branch.
  if (!isAllowedAudioUrl(url)) {
    sendResponse({ ok: false, error: 'url not allowed' });
    return false;
  }
  if (typeof originalFilename !== 'string' || !originalFilename) {
    sendResponse({ ok: false, error: 'invalid filename' });
    return false;
  }
  // One message, one file. 'both' is a panel-level preference that the panel
  // fans out into an 'original' and a 'convert' request (subModesFor in
  // content/ui.mjs), so it is not a valid mode here. Accepting it previously
  // routed it to the Original branch, silently downloading one file for a
  // request that asked for two.
  if (mode !== 'original' && mode !== 'convert') {
    sendResponse({ ok: false, error: 'invalid mode' });
    return false;
  }
  if (folder !== undefined && typeof folder !== 'string') {
    sendResponse({ ok: false, error: 'invalid folder' });
    return false;
  }
  // Claim the URL before the first await. A PANEL_DISMISSED arriving while
  // this download runs must not tombstone, abort or evict any of it; the
  // claim is released in the finally below, however this settles.
  claims.retain(url);

  (async () => {
    const opts = mode === 'convert'
      ? await convertDownloadOptions(url, originalFilename, folder)
      : await originalDownloadOptions(url, originalFilename, folder);
    // chrome.downloads.download resolves once the download is INITIATED
    // (returns the downloadId), not when the file actually lands. We then
    // wait for the terminal state so the panel only flips to "Downloaded"
    // when a file actually reached disk; user cancellations and policy
    // blocks become 'interrupted' and surface as a failure.
    const downloadId = await chrome.downloads.download(opts);
    return waitForDownloadComplete(downloadId);
  })().then(
    state => sendResponse(state === 'complete' ? { ok: true } : { ok: false, error: state }),
    error => {
      logError('[Background] Download error:', error.message);
      sendResponse({ ok: false, error: error.message });
    },
  ).finally(() => {
    // Last claim released: the transcoded WAV has served its purpose, so
    // evict it now (onEvict revokes the blob URL in offscreen) rather than
    // letting it sit until LRU pressure. A re-click pays a re-transcode,
    // which the persistent "Downloaded" button state makes rare. Keyed on
    // the claim rather than on `mode` so `both` mode cleans up whichever
    // of its two requests finishes last; a no-op on the Original path,
    // which never caches a WAV.
    if (claims.release(url)) transcodedCache.delete(url);
  });

  return true; // Keep channel open for async response
});

// Test-only cache introspection. Gated on globalThis.__WAD_TEST__, which
// only the Playwright harness sets; pages can't reach it.
/** @returns {{ cachedCount: number, cachedUrls: string[], totalBytes: number, transcodedCount: number, transcodedUrls: string[], transcodedBytes: number, transcodeInflight: string[] } | null} */
globalThis._wadInspectAudioCache = () => {
  if (!globalThis.__WAD_TEST__) return null;
  return {
    cachedCount: audioCache.size(),
    cachedUrls: [...audioCache.keys()],
    totalBytes: audioCache.bytes(),
    transcodedCount: transcodedCache.size(),
    transcodedUrls: [...transcodedCache.keys()],
    transcodedBytes: transcodedCache.bytes(),
    transcodeInflight: [...transcodeInflight.keys()],
  };
};
