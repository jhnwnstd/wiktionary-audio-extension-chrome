// @ts-check
// background.js: Service worker for Wiktionary audio downloads.
//
// IIFE keeps `DEBUG`, `log`, `logError` file scoped so they don't collide
// with the same identifiers in content-script.js under the project's
// jsconfig. Service worker behavior is unchanged.
(() => {

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

/** @param {ArrayBuffer} arrayBuffer */
function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // 8 KB chunks avoid `Maximum call stack size exceeded` from large spreads.
  // No "fast path" for small inputs since Convert output is 96 KB/sec PCM
  // and every real conversion exceeds the small payload threshold anyway.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

// Cross platform filename sanitizer covering the union of Windows, macOS,
// and Linux filesystem restrictions. Preserves Unicode (e.g. 水, café) but
// enforces a 255 byte UTF-8 cap, since most real filesystems use byte
// length not codepoint length. A 100 character Chinese filename is ~300
// bytes on disk.
//
// Rules enforced:
//   * forbidden chars: < > : " / \ | ? * and control chars 0x00-0x1F
//   * Windows reserved basenames: CON, PRN, AUX, NUL, COM1-9, LPT1-9
//   * Windows forbids trailing space or period
//   * leading dots stripped (avoids Unix hidden-file surprise)
//   * 255 byte UTF-8 cap, preserving extension when possible
//   * never empty: falls back to "audio"

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const UTF8_ENCODER = new TextEncoder();

/** @param {string} s */
function utf8ByteLength(s) {
  return UTF8_ENCODER.encode(s).length;
}

/**
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(s, maxBytes) {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let result = s;
  while (result.length > 0 && utf8ByteLength(result) > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Sanitize a filename to be safe across Windows, macOS, and Linux file
 * systems while preserving Unicode characters.
 * @param {unknown} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename) return 'audio';

  let s = filename
    .split('?')[0].split('#')[0]
    .replace(FORBIDDEN_CHARS_RE, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();

  if (WINDOWS_RESERVED_RE.test(s)) s = '_' + s;

  if (utf8ByteLength(s) > 255) {
    const extIdx = s.lastIndexOf('.');
    if (extIdx > 0 && s.length - extIdx <= 16) {
      const ext = s.slice(extIdx);
      s = truncateToBytes(s.slice(0, extIdx), 255 - utf8ByteLength(ext)) + ext;
    } else {
      s = truncateToBytes(s, 255);
    }
  }

  return s || 'audio';
}

/**
 * Open a port to the offscreen document, run `handler(port, settle)`, and
 * resolve/reject exactly once. `settle(true, value)` resolves; `settle(false,
 * error)` rejects. Handles timeout AND port.onDisconnect so a crashed
 * offscreen document doesn't leave the caller waiting for the full timeout.
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

/**
 * Ping the offscreen document and resolve when it responds with PONG.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function pingOffscreen(timeoutMs = 3000) {
  return withOffscreenPort(timeoutMs, (port, settle) => {
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'PONG') settle(true);
    });
    port.postMessage({ type: 'PING' });
  });
}

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run ffmpeg.wasm for audio conversion'
    });
  } catch {
    // Already exists. Chrome enforces single offscreen doc.
  }

  // Retry ping up to 4 times (handles slow module loading after createDocument)
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

/**
 * Speculative pre-warm: spin up the offscreen document and have it load the
 * FFmpeg wasm core without converting anything. Used when the user opens
 * the popup with Convert/Both selected, because they're about to download
 * and we have ~2-5 seconds of popup reading time to absorb the ~350-650 ms
 * cold start. Fire and forget from callers; failures are swallowed because
 * the user will just pay the load on their first real click.
 */
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
 * Send a TRANSCODE request to the offscreen FFmpeg worker. Accepts either
 * a URL (offscreen fetches) or an ArrayBuffer of pre-fetched bytes
 * (offscreen skips its own fetch). The bytes path is used when the
 * prefetch cache has the audio ready.
 *
 * @param {string | ArrayBuffer} src
 * @param {string} baseName  filename without extension; offscreen appends `.wav`
 * @returns {Promise<{ filename: string, arrayBuffer: ArrayBuffer }>}
 */
async function transcodeToWav(src, baseName) {
  log('[Background] Starting transcode...');
  await ensureOffscreen();

  return withOffscreenPort(90000, (port, settle) => {
    port.onMessage.addListener((msg) => {
      if (!msg?.ok) {
        settle(false, new Error(msg?.error || 'Transcode failed'));
        return;
      }
      if (typeof msg.blobUrl !== 'string' || !msg.blobUrl.startsWith('blob:')) {
        settle(false, new Error('Invalid blob URL from conversion'));
        return;
      }
      settle(true, {
        filename: msg.filename,
        blobUrl: msg.blobUrl,
        byteLength: msg.byteLength || 0,
      });
    });

    // chrome.runtime port serialization does NOT preserve typed array
    // shape in current Chrome (Uint8Array arrives as a plain Object), so
    // we materialize to a number Array. This is the documented "Rust/C"
    // smell from the security review; the right fix is a Blob URL handoff
    // that avoids marshaling the bytes through the message channel at all.
    // Tracked as a follow-up because correct trumps optimal here.
    const payload = src instanceof ArrayBuffer
      ? { type: 'TRANSCODE', srcBytes: Array.from(new Uint8Array(src)), outBase: baseName }
      : { type: 'TRANSCODE', srcUrl: src, outBase: baseName };
    port.postMessage(payload);
  });
}

// Fire-and-forget revocation: tell offscreen to release a Blob URL it
// created earlier. Used on transcoded-cache eviction and panel dismissal.
// We don't await the response since revocation is best-effort cleanup.
/** @param {string} blobUrl */
function revokeBlobInOffscreen(blobUrl) {
  if (typeof blobUrl !== 'string' || !blobUrl.startsWith('blob:')) return;
  try {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    port.postMessage({ type: 'REVOKE_BLOB', blobUrl });
    port.disconnect();
  } catch { /* opportunistic */ }
}

// ============== AUDIO PREFETCH CACHE ==============
//
// Once the content script discovers audio on a Wiktionary page it sends
// the URLs here for proactive fetching. We hold the ArrayBuffers in
// memory so the eventual download skips the network round trip on both
// Original and Convert paths. Bounded by total bytes; LRU evicted; lost
// on SW restart. The next click just refetches via the existing URL path.

const PREFETCH_CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const PREFETCH_CONCURRENCY = 3;

// Per-file cap. Wiktionary pronunciation audio is consistently 10-500 KB;
// anything bigger is either an anomaly or hostile, and we'd rather waste
// the round trip than blow the cache budget on a single file.
const PER_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Original-mode threshold: cached files below this go out as a data URL
// (saves a network round-trip); larger files use the source URL directly
// (chrome.downloads' fetch hits the browser HTTP cache from our prefetch,
// avoiding the base64 expansion + giant data URL string). 512 KB is well
// above typical pronunciation file size, so the common case stays cheap.
const DATA_URL_THRESHOLD_BYTES = 512 * 1024;

// Allowlist of hostnames that may serve audio bytes. Wikimedia serves all
// Wiktionary pronunciation audio from upload.wikimedia.org; nothing else
// should appear in any API response or message. Mirrored in
// content-script.js -- keep in sync.
const AUDIO_HOST_ALLOWLIST = new Set(['upload.wikimedia.org']);

/** @param {string} url */
function isAllowedAudioUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUDIO_HOST_ALLOWLIST.has(u.hostname);
  } catch { return false; }
}

/** @type {Map<string, { bytes: ArrayBuffer, lastUsedMs: number }>} */
const audioCache = new Map();
let audioCacheBytes = 0;

// In-flight prefetch AbortControllers, keyed by URL. Lets PANEL_DISMISSED
// abort an in-progress fetch instead of letting it run to completion and
// re-populate the cache we just tried to evict.
/** @type {Map<string, AbortController>} */
const inflightPrefetches = new Map();

// ============== TRANSCODE CACHE ==============
//
// When prefetch settles in Convert/Both mode we speculatively transcode the
// top (most likely to be clicked) item to WAV and stash the result here.
// On the eventual click, DOWNLOAD_AUDIO checks this cache first and skips
// ffmpeg.exec entirely. `transcodeInflight` dedupes by URL so that a user
// click during an in-flight speculative transcode (or vice versa) shares
// the same Promise instead of queuing duplicate work.
//
// Bounded by total bytes; LRU evicted; lost on SW restart. The WAV cache
// shares the same 20 MB budget shape as the source-bytes cache.

const TRANSCODED_CACHE_MAX_BYTES = 20 * 1024 * 1024;

/** @type {Map<string, { blobUrl: string, filename: string, byteLength: number, lastUsedMs: number }>} */
const transcodedCache = new Map();
let transcodedCacheBytes = 0;

/** @type {Map<string, Promise<{ filename: string, blobUrl: string, byteLength: number }>>} */
const transcodeInflight = new Map();

// Tombstones for URLs the user has dismissed since their last prefetch.
// A speculative transcode in flight when PANEL_DISMISSED arrives can't
// be cancelled (FFmpeg.wasm has no abort), so it will run to completion;
// without this guard it would addTranscoded() the result and silently
// repopulate the cache the user just asked us to clear. A subsequent
// PREFETCH_AUDIO for the same URL clears the tombstone (re-engagement).
/** @type {Set<string>} */
const dismissedUrls = new Set();

/**
 * @param {string} url
 * @returns {{ blobUrl: string, filename: string } | null}
 */
function takeTranscoded(url) {
  const entry = transcodedCache.get(url);
  if (!entry) return null;
  entry.lastUsedMs = Date.now();
  return { blobUrl: entry.blobUrl, filename: entry.filename };
}

/**
 * Store a transcoded WAV entry, evicting older entries as needed to stay
 * under the cap. Eviction also revokes the blob URL so the underlying
 * Blob can be GC'd in offscreen.
 *
 * @param {string} url
 * @param {string} filename
 * @param {string} blobUrl
 * @param {number} byteLength
 */
function addTranscoded(url, filename, blobUrl, byteLength) {
  if (dismissedUrls.has(url)) {
    // The user dismissed this page after we started the transcode. Don't
    // resurrect what they explicitly evicted; just release the blob.
    revokeBlobInOffscreen(blobUrl);
    return;
  }
  if (transcodedCache.has(url)) {
    // Already cached. Discard the new blob URL since we won't store it.
    revokeBlobInOffscreen(blobUrl);
    return;
  }
  if (byteLength > TRANSCODED_CACHE_MAX_BYTES) {
    revokeBlobInOffscreen(blobUrl);
    return;
  }
  while (transcodedCacheBytes + byteLength > TRANSCODED_CACHE_MAX_BYTES && transcodedCache.size > 0) {
    let oldestUrl = null;
    let oldestTs = Infinity;
    for (const [u, e] of transcodedCache) {
      if (e.lastUsedMs < oldestTs) { oldestUrl = u; oldestTs = e.lastUsedMs; }
    }
    if (!oldestUrl) break;
    const old = transcodedCache.get(oldestUrl);
    transcodedCacheBytes -= old.byteLength;
    revokeBlobInOffscreen(old.blobUrl);
    transcodedCache.delete(oldestUrl);
  }
  transcodedCache.set(url, { blobUrl, filename, byteLength, lastUsedMs: Date.now() });
  transcodedCacheBytes += byteLength;
}

/**
 * Transcode `src` (URL or bytes) to WAV and cache by `url`. Dedupes by url
 * so concurrent calls (e.g., user click + speculative) share one ffmpeg.exec.
 * If the URL is already in the WAV cache, returns it directly without
 * touching the offscreen document.
 *
 * @param {string} url  cache key
 * @param {string | ArrayBuffer} src  passed to transcodeToWav
 * @param {string} baseName
 * @returns {Promise<{ filename: string, arrayBuffer: ArrayBuffer }>}
 */
async function transcodeForUrl(url, src, baseName) {
  const pre = takeTranscoded(url);
  if (pre) return { filename: pre.filename, blobUrl: pre.blobUrl };

  const existing = transcodeInflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const result = await transcodeToWav(src, baseName);
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

/**
 * Speculatively transcode a single item's source bytes to WAV. Skips when
 * the result is already cached, the transcode is already in flight, or the
 * source bytes aren't in the prefetch cache (we don't want to fetch just to
 * speculate; that's what the user-triggered Convert path is for).
 *
 * @param {string} url
 * @param {string} downloadName
 */
async function triggerSpeculativeTranscode(url, downloadName) {
  if (transcodedCache.has(url)) return;
  if (transcodeInflight.has(url)) return;
  const sourceBytes = takeCached(url);
  if (!sourceBytes) return;
  if (sourceBytes.byteLength > PER_FILE_MAX_BYTES) return;

  const baseName = sanitizeFilename(String(downloadName || '').replace(/\.[^.]+$/, ''));
  log('[Background] Speculative transcode:', baseName);
  try {
    await transcodeForUrl(url, sourceBytes, baseName);
  } catch (e) {
    logError('[Background] Speculative transcode failed:', e?.message || e);
  }
}

/**
 * Look up a cached entry and bump its lastUsed timestamp. Returns the bytes
 * or null. Touching on read gives us LRU eviction without a separate access
 * counter.
 * @param {string} url
 * @returns {ArrayBuffer | null}
 */
function takeCached(url) {
  const entry = audioCache.get(url);
  if (!entry) return null;
  entry.lastUsedMs = Date.now();
  return entry.bytes;
}

/**
 * Add bytes to the cache, evicting oldest entries until we fit under the cap.
 * Skips URLs already present and entries that wouldn't fit even alone.
 * @param {string} url
 * @param {ArrayBuffer} bytes
 */
function addToCache(url, bytes) {
  if (audioCache.has(url)) return;
  // If the user dismissed this URL since the fetch began, don't repopulate
  // the cache they just asked us to evict. (PANEL_DISMISSED also aborts
  // the controller, but that's racy; this is the deterministic check.)
  if (dismissedUrls.has(url)) return;
  // Hard per-file cap. Invariant enforced here even though prefetchAudio
  // also checks; addToCache is the single ingress to audioCache so anything
  // that lands here is guaranteed below the limit.
  if (bytes.byteLength > PER_FILE_MAX_BYTES) return;
  while (audioCacheBytes + bytes.byteLength > PREFETCH_CACHE_MAX_BYTES && audioCache.size > 0) {
    let oldestUrl = null;
    let oldestTs = Infinity;
    for (const [u, e] of audioCache) {
      if (e.lastUsedMs < oldestTs) { oldestUrl = u; oldestTs = e.lastUsedMs; }
    }
    if (!oldestUrl) break;
    audioCacheBytes -= audioCache.get(oldestUrl).bytes.byteLength;
    audioCache.delete(oldestUrl);
  }
  audioCache.set(url, { bytes, lastUsedMs: Date.now() });
  audioCacheBytes += bytes.byteLength;
}

/**
 * Fetch a batch of items with bounded concurrency and stash bytes in the
 * source cache. Items carry both the URL (what to fetch) and the
 * downloadName (used for the speculative-transcode filename if mode is
 * Convert/Both). Best-effort: per-URL failures are swallowed.
 *
 * @param {Array<{ url: string, downloadName: string }>} items
 */
async function prefetchAudio(items) {
  if (!Array.isArray(items) || !items.length) return;

  // PREFETCH_AUDIO is the re-engagement signal: any URL the user dismissed
  // earlier is now in scope again. Clear its tombstone so an addToCache or
  // addTranscoded result can land normally.
  for (const i of items) {
    if (i && typeof i.url === 'string') dismissedUrls.delete(i.url);
  }

  // Skip URLs already cached OR already in flight, AND drop anything
  // outside the Wikimedia allowlist. The inflight check prevents repeated
  // PREFETCH_AUDIO messages from spawning duplicate fetches and overwriting
  // each other's AbortControllers (which would make PANEL_DISMISSED abort
  // the wrong one).
  const todo = items
    .filter(i => i && isAllowedAudioUrl(i.url))
    .map(i => i.url)
    .filter(u => !audioCache.has(u) && !inflightPrefetches.has(u));

  if (todo.length) {
    const queue = todo.slice();
    const workers = Array.from({ length: PREFETCH_CONCURRENCY }, async () => {
      while (queue.length) {
        const url = queue.shift();
        if (!url) continue;
        const controller = new AbortController();
        inflightPrefetches.set(url, controller);
        try {
          // Wikimedia uses internal redirects (e.g., CDN routing), so
          // redirect: 'follow' is necessary for the fetch to land at all.
          // The security guarantee comes from re-checking the final
          // response.url: an attacker-controlled redirect chain that
          // bounces through allowed Wikimedia URLs and ends elsewhere
          // would fail this check and the bytes get discarded.
          const r = await fetch(url, {
            credentials: 'omit',
            signal: controller.signal,
          });
          if (!r.ok) continue;
          if (!isAllowedAudioUrl(r.url)) continue;
          // Cheap defense against pathological inputs: bail before reading
          // the body if Wikimedia reports a size larger than any real
          // pronunciation file. Saves bandwidth and prevents cache thrash.
          const declared = parseInt(r.headers.get('Content-Length') || '0', 10);
          if (declared > PER_FILE_MAX_BYTES) {
            controller.abort();
            continue;
          }
          const bytes = await r.arrayBuffer();
          if (bytes.byteLength === 0 || bytes.byteLength > PER_FILE_MAX_BYTES) continue;
          addToCache(url, bytes);
        } catch { /* best effort. One URL failing (or AbortError) shouldn't block others. */ }
        finally {
          inflightPrefetches.delete(url);
        }
      }
    });
    await Promise.allSettled(workers);
    log(`[Background] Prefetch done. Cache: ${audioCache.size} items, ${(audioCacheBytes / 1024).toFixed(0)} KB`);
  }

  // Speculative top-item transcode. Fire and forget; the result populates
  // transcodedCache so the eventual click on item 0 skips ffmpeg.exec.
  const top = items[0];
  if (top && top.url && top.downloadName) {
    try {
      const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
      if (mode === 'convert' || mode === 'both') {
        triggerSpeculativeTranscode(top.url, top.downloadName);
      }
    } catch { /* opportunistic */ }
  }
}

/**
 * Evict the given URLs from the cache and abort any in-flight prefetches
 * for them. Called when the user dismisses the panel: a strong signal that
 * they aren't going to download from this page, so holding the bytes is
 * wasted RAM and any pending network work is wasted bandwidth.
 * @param {string[]} urls
 */
function dismissUrls(urls) {
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    // Tombstone the URL so any in-flight prefetch or speculative transcode
    // that completes after this point won't repopulate the cache we're
    // about to clear. A subsequent PREFETCH_AUDIO clears the tombstone.
    dismissedUrls.add(url);
    const ctrl = inflightPrefetches.get(url);
    if (ctrl) ctrl.abort();
    const entry = audioCache.get(url);
    if (entry) {
      audioCacheBytes -= entry.bytes.byteLength;
      audioCache.delete(url);
    }
    const trans = transcodedCache.get(url);
    if (trans) {
      transcodedCacheBytes -= trans.byteLength;
      revokeBlobInOffscreen(trans.blobUrl);
      transcodedCache.delete(url);
    }
  }
}

/**
 * Prepend an optional subfolder to a sanitized filename. Folder and file
 * are sanitized independently so neither can inject a `/`. chrome.downloads
 * accepts forward slashes cross-platform and creates intermediate dirs.
 *
 * @param {string | undefined | null} folder
 * @param {string} filename
 * @returns {string}
 */
function pathWithFolder(folder, filename) {
  const file = sanitizeFilename(filename);
  if (!folder) return file;
  return sanitizeFilename(folder) + '/' + file;
}

/**
 * Wait for a chrome.downloads download to reach a terminal state. Resolves
 * with the final state string (e.g. 'complete' or 'interrupted') so callers
 * can distinguish "the file actually landed" from "the user cancelled the
 * Save As dialog" or "the browser blocked the download".
 *
 * @param {number} downloadId
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function waitForDownloadComplete(downloadId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    /** @param {any} delta */
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      const next = delta.state?.current;
      if (next === 'complete' || next === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        clearTimeout(timer);
        resolve(next);
      }
    };
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error(`download timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    // Race: download might already be terminal before our listener attached.
    // search() is the authoritative current state.
    chrome.downloads.search({ id: downloadId }, /** @param {any[]} items */ (items) => {
      const item = items?.[0];
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        chrome.downloads.onChanged.removeListener(onChanged);
        clearTimeout(timer);
        resolve(item.state);
      }
    });
  });
}

/**
 * Validate that a runtime message came from one of OUR contexts: our own
 * popup/offscreen page, or a content script running on a Wiktionary tab.
 * Without `externally_connectable` in the manifest, cross-extension messages
 * can't even reach us; this is defense in depth in case that ever changes.
 *
 * @param {any} sender
 */
function isAllowedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // Extension pages (popup, offscreen) have a URL but no tab.
  const extPrefix = chrome.runtime.getURL('');
  if (typeof sender.url === 'string' && sender.url.startsWith(extPrefix)) return true;
  // Content scripts: require HTTPS Wiktionary tab. HTTP would mean either
  // a misconfigured site or a downgrade attack, neither of which we want
  // to grant the privileged background surface to.
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

  // Fire-and-forget prefetch. Respond immediately so the content script
  // doesn't await network work that's meant to be opportunistic.
  if (msg?.type === 'PREFETCH_AUDIO') {
    prefetchAudio(Array.isArray(msg.items) ? msg.items : []);
    sendResponse({ ok: true });
    return false;
  }

  // User dismissed the panel: clear the bytes we were holding for them and
  // cancel any in-flight prefetch. If they re-open later, the content
  // script will send PREFETCH_AUDIO again.
  if (msg?.type === 'PANEL_DISMISSED') {
    dismissUrls(Array.isArray(msg.urls) ? msg.urls : []);
    sendResponse({ ok: true });
    return false;
  }

  // User opened the popup (or changed mode). Strong "download imminent"
  // signal: pre-warm FFmpeg in the background if mode requires it, so
  // the next Convert click skips the cold load entirely.
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
  // Final allowlist gate before we hand a URL to chrome.downloads.download
  // (which doesn't honor host_permissions) or to FFmpeg. A compromised or
  // misbehaving content script can't trigger a download from an arbitrary
  // origin.
  if (!isAllowedAudioUrl(url)) {
    sendResponse({ ok: false, error: 'url not allowed' });
    return false;
  }
  if (typeof originalFilename !== 'string' || !originalFilename) {
    sendResponse({ ok: false, error: 'invalid filename' });
    return false;
  }
  const baseName = sanitizeFilename(originalFilename.replace(/\.[^.]+$/, ''));

  (async () => {
    const cached = takeCached(url);
    /** @type {chrome.downloads.DownloadOptions} */
    let opts;
    if (mode === 'convert') {
      // transcodeForUrl returns immediately if the WAV is cached (speculative
      // pre-transcode already ran), awaits any in-flight transcode for this
      // URL, or runs a fresh transcode otherwise. The result is a Blob URL
      // we pass straight to chrome.downloads; no byte marshaling through
      // base64/data URL.
      log('[Background] Converting:', originalFilename, folder ? `-> ${folder}/` : '');
      const { filename, blobUrl } = await transcodeForUrl(url, cached || url, baseName);
      opts = {
        url: blobUrl,
        filename: pathWithFolder(folder, filename),
        saveAs: false,
      };
    } else if (cached && cached.byteLength <= DATA_URL_THRESHOLD_BYTES) {
      // Original mode with small cached bytes: data URL is cheap for small
      // payloads and saves the network round-trip. application/octet-stream
      // is fine; the saved file's extension comes from `filename`, not the
      // data URL's MIME.
      log('[Background] Downloading original (cached, data URL):', originalFilename, folder ? `-> ${folder}/` : '');
      opts = {
        url: `data:application/octet-stream;base64,${arrayBufferToBase64(cached)}`,
        filename: pathWithFolder(folder, originalFilename),
        saveAs: false,
      };
    } else {
      // Original mode for large files (or no cache): pass the source URL.
      // chrome.downloads' fetch typically hits the browser HTTP cache from
      // our earlier prefetch, so we avoid the base64 expansion + giant data
      // URL string for free.
      log('[Background] Downloading original:', originalFilename, folder ? `-> ${folder}/` : '');
      opts = {
        url,
        filename: pathWithFolder(folder, originalFilename),
        saveAs: false,
      };
    }

    // chrome.downloads.download resolves once the download is INITIATED
    // (returns the downloadId), not when the file actually lands. We then
    // wait for the terminal state so the panel only flips to "Downloaded"
    // when a file actually reached disk; user cancellations and policy
    // blocks become 'interrupted' and surface as a failure.
    const downloadId = await chrome.downloads.download(opts);
    const state = await waitForDownloadComplete(downloadId);
    if (state === 'complete') {
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: state });
    }
  })().catch(error => {
    logError('[Background] Download error:', error.message);
    sendResponse({ ok: false, error: error.message });
  });

  return true; // Keep channel open for async response
});

// Read-only introspection of the prefetch + transcoded caches, exposed for
// tests. Lets a Playwright spec deterministically wait for prefetch and the
// speculative transcode to finish without resorting to fixed timeouts.
// Side-effect free; safe to keep in production.
/** @returns {{ cachedCount: number, cachedUrls: string[], totalBytes: number, transcodedCount: number, transcodedUrls: string[], transcodedBytes: number, transcodeInflight: string[] }} */
globalThis._wadInspectAudioCache = () => ({
  cachedCount: audioCache.size,
  cachedUrls: Array.from(audioCache.keys()),
  totalBytes: audioCacheBytes,
  transcodedCount: transcodedCache.size,
  transcodedUrls: Array.from(transcodedCache.keys()),
  transcodedBytes: transcodedCacheBytes,
  transcodeInflight: Array.from(transcodeInflight.keys()),
});

})();
