// @ts-check
// background.js -- Service worker for Wiktionary audio downloads
//
// Wrapped in an IIFE so `DEBUG`, `log`, `logError` are function-scoped
// rather than file-scoped, avoiding cross-file collisions with the same
// identifiers in content-script.js when both files are type-checked under
// the project's jsconfig. Service-worker behavior is unchanged.
(() => {

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

/** @param {ArrayBuffer} arrayBuffer */
function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // 8 KB chunks avoid `Maximum call stack size exceeded` from large spreads.
  // No "fast path" for small inputs -- Convert output is 96 KB/sec PCM, so
  // every real conversion exceeds that threshold anyway.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

// Cross-platform filename sanitizer covering the union of Windows, macOS, and
// Linux filesystem restrictions. Preserves Unicode (e.g. 水, café) but enforces
// a 255-byte UTF-8 cap, since most real filesystems use byte-length not
// codepoint-length -- a 100-character Chinese filename is ~300 bytes on disk.
//
// Rules enforced:
//   * forbidden chars: < > : " / \ | ? * and control chars 0x00-0x1F
//   * Windows reserved basenames: CON, PRN, AUX, NUL, COM1-9, LPT1-9
//   * Windows forbids trailing space or period
//   * leading dots stripped (avoids Unix hidden-file surprise)
//   * 255-byte UTF-8 cap, preserving extension when possible
//   * never empty -- falls back to "audio"

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
 * Ping the offscreen document and resolve when it responds with PONG.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function pingOffscreen(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('ping timeout'));
    }, timeoutMs);

    port.onMessage.addListener(/** @param {any} msg */ function onPong(msg) {
      if (msg.type === 'PONG') {
        clearTimeout(timer);
        port.onMessage.removeListener(onPong);
        port.disconnect();
        resolve();
      }
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
    // Already exists -- Chrome enforces single offscreen doc
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
 * FFmpeg wasm core without converting anything. Used when the user opens the
 * popup with Convert/Both selected -- they're about to download and we have
 * ~2-5 seconds of popup-reading time to absorb the ~350-650 ms cold start.
 * Fire-and-forget from callers; failures are swallowed because the user will
 * just pay the load on their first real click.
 */
async function prewarmFFmpeg() {
  log('[Background] Pre-warming FFmpeg...');
  await ensureOffscreen();
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    const timer = setTimeout(() => {
      port.disconnect();
      resolve();
    }, 30000);
    port.onMessage.addListener(/** @param {any} m */ (m) => {
      if (m.type === 'PREWARMED') {
        clearTimeout(timer);
        port.disconnect();
        resolve();
      }
    });
    port.postMessage({ type: 'PREWARM' });
  });
}

/**
 * Send a TRANSCODE request to the offscreen FFmpeg worker. Accepts either a
 * URL (offscreen fetches) or an ArrayBuffer of pre-fetched bytes (offscreen
 * skips the fetch -- used when the prefetch cache has the bytes ready).
 * @param {string | ArrayBuffer} src
 * @param {string} baseName - filename without extension; offscreen appends `.wav`
 * @returns {Promise<{ filename: string, arrayBuffer: ArrayBuffer }>}
 */
async function transcodeToWav(src, baseName) {
  log('[Background] Starting transcode...');
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    const timeout = setTimeout(() => {
      port.disconnect();
      reject(new Error('Transcoding timeout (90s)'));
    }, 90000);

    port.onMessage.addListener(/** @param {any} msg */ (msg) => {
      clearTimeout(timeout);
      port.disconnect();

      if (!msg.ok) {
        reject(new Error(msg.error || 'Transcode failed'));
        return;
      }

      if (!Array.isArray(msg.audioBytes) || !msg.audioBytes.length) {
        reject(new Error('Invalid audio data from conversion'));
        return;
      }

      const arrayBuffer = new Uint8Array(msg.audioBytes).buffer;
      resolve({ filename: msg.filename, arrayBuffer });
    });

    const payload = src instanceof ArrayBuffer
      ? { type: 'TRANSCODE', srcBytes: Array.from(new Uint8Array(src)), outBase: baseName }
      : { type: 'TRANSCODE', srcUrl: src, outBase: baseName };
    port.postMessage(payload);
  });
}

// ============== AUDIO PREFETCH CACHE ==============
//
// Once the content script discovers audio on a Wiktionary page it sends the
// URLs here for proactive fetching. We hold the ArrayBuffers in memory so the
// eventual download skips the network round-trip on both Original and Convert
// paths. Bounded by total bytes; LRU-evicted; lost on SW restart (acceptable
// -- next click just refetches via the existing URL path).

const PREFETCH_CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const PREFETCH_CONCURRENCY = 3;

/** @type {Map<string, { bytes: ArrayBuffer, lastUsedMs: number }>} */
const audioCache = new Map();
let audioCacheBytes = 0;

// In-flight prefetch AbortControllers, keyed by URL. Lets PANEL_DISMISSED
// abort an in-progress fetch instead of letting it run to completion and
// re-populate the cache we just tried to evict.
/** @type {Map<string, AbortController>} */
const inflightPrefetches = new Map();

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
  if (bytes.byteLength > PREFETCH_CACHE_MAX_BYTES) return; // pathological single file
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
 * Fetch a batch of URLs with bounded concurrency and stash results in the
 * cache. Best-effort: per-URL failures are swallowed so one bad URL doesn't
 * starve the others. Skips URLs already cached.
 * @param {string[]} urls
 */
async function prefetchAudioUrls(urls) {
  const todo = urls.filter(u => typeof u === 'string' && !audioCache.has(u));
  if (!todo.length) return;
  const queue = todo.slice();
  const workers = Array.from({ length: PREFETCH_CONCURRENCY }, async () => {
    while (queue.length) {
      const url = queue.shift();
      if (!url) continue;
      const controller = new AbortController();
      inflightPrefetches.set(url, controller);
      try {
        const r = await fetch(url, { credentials: 'omit', signal: controller.signal });
        if (!r.ok) continue;
        const bytes = await r.arrayBuffer();
        if (bytes.byteLength) addToCache(url, bytes);
      } catch { /* best-effort -- one URL failing (or AbortError) shouldn't block others */ }
      finally {
        inflightPrefetches.delete(url);
      }
    }
  });
  await Promise.allSettled(workers);
  log(`[Background] Prefetch done. Cache: ${audioCache.size} items, ${(audioCacheBytes / 1024).toFixed(0)} KB`);
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
    const ctrl = inflightPrefetches.get(url);
    if (ctrl) ctrl.abort();
    const entry = audioCache.get(url);
    if (entry) {
      audioCacheBytes -= entry.bytes.byteLength;
      audioCache.delete(url);
    }
  }
}

// Prepend an optional subfolder to a sanitized filename. Folder and file are
// sanitized independently so neither can inject a `/`; the separator is
// inserted after sanitization. chrome.downloads accepts forward slashes
// cross-platform and auto-creates intermediate directories.
/**
 * @param {string | undefined | null} folder
 * @param {string} filename
 * @returns {string}
 */
function pathWithFolder(folder, filename) {
  const file = sanitizeFilename(filename);
  if (!folder) return file;
  return sanitizeFilename(folder) + '/' + file;
}

chrome.runtime.onMessage.addListener(
  /**
   * @param {any} msg - arbitrary content; we narrow on `msg.type`
   * @param {any} _sender
   * @param {(response: DownloadResponse) => void} sendResponse
   */
  (msg, _sender, sendResponse) => {
  // Fire-and-forget prefetch. Respond immediately so the content script
  // doesn't await network work that's meant to be opportunistic.
  if (msg?.type === 'PREFETCH_AUDIO') {
    prefetchAudioUrls(Array.isArray(msg.urls) ? msg.urls : []);
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
  // signal -- pre-warm FFmpeg in the background if mode requires it, so
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
  const baseName = sanitizeFilename(originalFilename.replace(/\.[^.]+$/, ''));

  (async () => {
    const cached = takeCached(url);
    if (mode === 'convert') {
      log('[Background] Converting:', originalFilename, folder ? `-> ${folder}/` : '', cached ? '(cached)' : '');
      // Pass cached bytes when we have them so offscreen skips its own fetch.
      const { filename, arrayBuffer } = await transcodeToWav(cached || url, baseName);
      const base64 = arrayBufferToBase64(arrayBuffer);
      const dataUrl = `data:audio/wav;base64,${base64}`;
      await chrome.downloads.download({
        url: dataUrl,
        filename: pathWithFolder(folder, filename),
        saveAs: false
      });
    } else if (cached) {
      // Original mode with cached bytes: skip the chrome.downloads URL fetch
      // by handing it a data URL built from the bytes we already have.
      // application/octet-stream is fine; the saved file's extension comes
      // from `filename`, not the data URL's MIME.
      log('[Background] Downloading original (cached):', originalFilename, folder ? `-> ${folder}/` : '');
      const base64 = arrayBufferToBase64(cached);
      const dataUrl = `data:application/octet-stream;base64,${base64}`;
      await chrome.downloads.download({
        url: dataUrl,
        filename: pathWithFolder(folder, originalFilename)
      });
    } else {
      log('[Background] Downloading original:', originalFilename, folder ? `-> ${folder}/` : '');
      await chrome.downloads.download({
        url,
        filename: pathWithFolder(folder, originalFilename)
      });
    }
    sendResponse({ ok: true });
  })().catch(error => {
    logError('[Background] Download error:', error.message);
    sendResponse({ ok: false, error: error.message });
  });

  return true; // Keep channel open for async response
});

// Read-only introspection of the prefetch cache, exposed for tests. Lets a
// Playwright spec deterministically wait for prefetch to finish without
// resorting to fixed timeouts. Side-effect free; safe to keep in production.
/** @returns {{ cachedCount: number, cachedUrls: string[], totalBytes: number }} */
globalThis._wadInspectAudioCache = () => ({
  cachedCount: audioCache.size,
  cachedUrls: Array.from(audioCache.keys()),
  totalBytes: audioCacheBytes,
});

})();
