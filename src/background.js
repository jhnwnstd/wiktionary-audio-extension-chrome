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
const UTF8_DECODER = new TextDecoder();

/** @param {string} s */
function utf8ByteLength(s) {
  return UTF8_ENCODER.encode(s).length;
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte code point. Encode once, then walk back from the limit to
 * the nearest code-point boundary (a byte that is not a UTF-8
 * continuation byte: continuation bytes have the bit pattern 10xxxxxx).
 * O(n) instead of the previous O(n^2) per-char slice-and-reencode loop.
 *
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(s, maxBytes) {
  const bytes = UTF8_ENCODER.encode(s);
  if (bytes.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return UTF8_DECODER.decode(bytes.subarray(0, cut));
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
 * Send a TRANSCODE request to the offscreen FFmpeg worker. `srcUrl` may be
 * either a Wikimedia allowlisted https URL (offscreen fetches over the
 * network, browser HTTP cache permitting) or a SW-created blob: URL
 * (offscreen fetches from the extension origin, zero-copy via the browser's
 * Blob registry). Either way no audio bytes traverse the runtime port.
 *
 * @param {string} srcUrl
 * @param {string} baseName  filename without extension; offscreen appends `.wav`
 * @returns {Promise<{ filename: string, blobUrl: string, byteLength: number }>}
 */
async function transcodeToWav(srcUrl, baseName) {
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
      // Re-sanitize msg.filename on receive. We already sanitize outBase
      // before sending TRANSCODE, so offscreen returns a clean name today;
      // running sanitizeFilename again is defense in depth in case offscreen
      // ever drifts (or is tampered with) and tries to slip a path-traversal
      // segment into chrome.downloads.download.
      settle(true, {
        filename: sanitizeFilename(msg.filename),
        blobUrl: msg.blobUrl,
        byteLength: msg.byteLength || 0,
      });
    });
    port.postMessage({ type: 'TRANSCODE', srcUrl, outBase: baseName });
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

/**
 * Insertion-order LRU bounded by total bytes (not item count). The single
 * invariant being structurally enforced — `bytes()` equals the sum of all
 * entry byte costs — used to be five hand-coordinated mutations across
 * peek/add/dismiss; now no path outside this class can desync the counter.
 *
 * Eviction calls the optional `onEvict(value)` callback before removing
 * the entry, so the transcoded-cache instance can revoke its blob URL
 * automatically. The raw-bytes instance passes no callback (ArrayBuffers
 * are GC'd when references drop).
 *
 * Entries are wrapped internally as {v, b} so a single API works for both
 * ArrayBuffer payloads and richer structs.
 *
 * @template V
 */
class ByteBoundedCache {
  /** @type {Map<string, { v: V, b: number }>} */
  #map = new Map();
  #bytes = 0;
  #maxBytes;
  /** @type {((value: V) => void) | null} */
  #onEvict;

  /**
   * @param {number} maxBytes
   * @param {((value: V) => void) | null} [onEvict]
   */
  constructor(maxBytes, onEvict = null) {
    this.#maxBytes = maxBytes;
    this.#onEvict = onEvict;
  }

  size() { return this.#map.size; }
  bytes() { return this.#bytes; }
  /** @param {string} url */
  has(url) { return this.#map.has(url); }
  keys() { return this.#map.keys(); }

  /**
   * Return the value for `url` (refreshing recency) or null. Delete +
   * re-insert moves the URL to the tail so eviction (which pops the head)
   * targets older entries first.
   * @param {string} url
   * @returns {V | null}
   */
  peek(url) {
    const slot = this.#map.get(url);
    if (!slot) return null;
    this.#map.delete(url);
    this.#map.set(url, slot);
    return slot.v;
  }

  /**
   * Insert `value` with declared `byteCost`. Returns true on insert, false
   * if refused (already present, or alone larger than the cap). On refusal
   * the caller still owns the value and onEvict is NOT called for it.
   * Evicts oldest entries until the new entry fits.
   * @param {string} url
   * @param {V} value
   * @param {number} byteCost
   * @returns {boolean}
   */
  set(url, value, byteCost) {
    if (this.#map.has(url)) return false;
    if (byteCost > this.#maxBytes) return false;
    while (this.#bytes + byteCost > this.#maxBytes && this.#map.size > 0) {
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#map.get(oldestKey);
      if (!oldest) break;
      this.#bytes -= oldest.b;
      if (this.#onEvict) this.#onEvict(oldest.v);
      this.#map.delete(oldestKey);
    }
    this.#map.set(url, { v: value, b: byteCost });
    this.#bytes += byteCost;
    return true;
  }

  /**
   * Remove `url`'s entry if present (calling onEvict on the value).
   * @param {string} url
   * @returns {boolean}  whether an entry was removed
   */
  delete(url) {
    const slot = this.#map.get(url);
    if (!slot) return false;
    this.#bytes -= slot.b;
    if (this.#onEvict) this.#onEvict(slot.v);
    this.#map.delete(url);
    return true;
  }
}

/** @type {ByteBoundedCache<ArrayBuffer>} */
const audioCache = new ByteBoundedCache(PREFETCH_CACHE_MAX_BYTES);

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

/** @typedef {{ blobUrl: string, filename: string, byteLength: number }} TranscodedEntry */

/** @type {ByteBoundedCache<TranscodedEntry>} */
const transcodedCache = new ByteBoundedCache(
  TRANSCODED_CACHE_MAX_BYTES,
  // onEvict: revoke the blob URL automatically when the cache drops it.
  // Callers no longer need to remember to revoke on eviction; the only
  // remaining caller-side revoke is for blob URLs we DECIDE not to insert
  // (dismissed-while-transcoding, duplicate, over per-entry cap).
  entry => revokeBlobInOffscreen(entry.blobUrl),
);

/** @type {Map<string, Promise<{ filename: string, blobUrl: string, byteLength: number }>>} */
const transcodeInflight = new Map();

// Tombstones for URLs the user has dismissed since their last prefetch.
// A speculative transcode in flight when PANEL_DISMISSED arrives can't
// be cancelled (FFmpeg.wasm has no abort), so it will run to completion;
// without this guard it would addTranscoded() the result and silently
// repopulate the cache the user just asked us to clear. A subsequent
// PREFETCH_AUDIO for the same URL clears the tombstone (re-engagement).
//
// Bounded with insertion-order LRU eviction. JS Sets iterate in insertion
// order, so the first key is the oldest. Without this cap the set would
// grow monotonically across a long browsing session (every dismissed URL
// stays forever) which is a quiet memory leak. 512 is several pages worth
// of pronunciation audio; the only cost of evicting too early is that a
// late-arriving speculative transcode could repopulate the cache for a URL
// the user dismissed a very long time ago.
const DISMISSED_URLS_MAX = 512;
/** @type {Set<string>} */
const dismissedUrls = new Set();

/** @param {string} url */
function dismissUrl(url) {
  if (dismissedUrls.has(url)) {
    // Refresh recency: delete + re-add moves the key to the tail.
    dismissedUrls.delete(url);
  } else if (dismissedUrls.size >= DISMISSED_URLS_MAX) {
    const oldest = dismissedUrls.values().next().value;
    if (oldest !== undefined) dismissedUrls.delete(oldest);
  }
  dismissedUrls.add(url);
}

/**
 * @param {string} url
 * @returns {TranscodedEntry | null}
 */
function peekTranscoded(url) {
  return transcodedCache.peek(url);
}

/**
 * Store a transcoded WAV entry. The three "refused" paths (dismissed,
 * already cached, doesn't fit) revoke the orphan blob URL ourselves
 * because the cache never took ownership of it. Eviction inside the
 * cache automatically revokes blob URLs the cache DID own (via the
 * onEvict callback wired at construction).
 *
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
  if (!stored) {
    // Refused: entry by itself exceeds the cache cap. Revoke the orphan.
    revokeBlobInOffscreen(blobUrl);
  }
}

/**
 * Transcode `url` to WAV and cache the result. Dedupes by url so concurrent
 * calls (e.g., user click + speculative) share one ffmpeg.exec. Returns
 * immediately if the WAV is already cached. Always passes the original https
 * URL to offscreen; offscreen's fetch lands in the browser HTTP cache from
 * the SW prefetch issued earlier, so no byte marshaling and no extra
 * network round trip in the common case. The SW audioCache exists for the
 * Original-mode small-file data URL path; the Convert path doesn't touch it
 * because Chrome MV3 service workers don't expose URL.createObjectURL, so
 * a SW-side Blob handoff isn't possible today.
 *
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
  // Gate on prefetch completion: only speculate after the source bytes have
  // landed in audioCache. This is our signal that the user is engaging
  // (panel rendered, prefetch completed) and that transcodeForUrl will
  // take the fast Blob-URL handoff path.
  if (!audioCache.has(url)) return;

  const baseName = sanitizeFilename(String(downloadName || '').replace(/\.[^.]+$/, ''));
  log('[Background] Speculative transcode:', baseName);
  try {
    await transcodeForUrl(url, baseName);
  } catch (e) {
    logError('[Background] Speculative transcode failed:', e?.message || e);
  }
}

/**
 * Look up the cached bytes for `url`, refreshing recency. Returns the bytes
 * or null. This is a peek, not a take in the Rust sense: the entry stays
 * cached so subsequent clicks for the same URL also hit.
 * @param {string} url
 * @returns {ArrayBuffer | null}
 */
function peekCached(url) {
  return audioCache.peek(url);
}

/**
 * Add bytes to the cache if eligible. The dismissedUrls guard is the
 * deterministic version of the abort-controller race (PANEL_DISMISSED
 * aborts in-flight fetches but completion can land first); a tombstoned
 * URL is never repopulated. The per-file cap is enforced upstream in
 * prefetchAudio, repeated here so this single ingress preserves the
 * invariant on its own.
 * @param {string} url
 * @param {ArrayBuffer} bytes
 */
function addToCache(url, bytes) {
  if (audioCache.has(url)) return;
  if (dismissedUrls.has(url)) return;
  if (bytes.byteLength > PER_FILE_MAX_BYTES) return;
  audioCache.set(url, bytes, bytes.byteLength);
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

  // One mode lookup, two consumers: pre-warm (fires immediately) and the
  // speculative top-item transcode after prefetch settles. Reused instead
  // of querying chrome.storage.sync twice in the same scope. The lookup
  // runs in parallel with prefetch, so prefetch start is not delayed.
  // Pre-warm catches the common case where the user has Convert set as
  // their default and never opens the popup; the ~350-650ms wasm load
  // overlaps the network fetches instead of being charged to the click.
  // Opportunistic throughout: failures fall back to the cold path.
  const modePromise = chrome.storage.sync.get({ mode: 'original' })
    .then(({ mode }) => (mode === 'convert' || mode === 'both' ? mode : 'original'))
    .catch(() => 'original');
  modePromise.then(mode => {
    if (mode === 'convert' || mode === 'both') {
      prewarmFFmpeg().catch(() => { /* opportunistic */ });
    }
  });

  // Skip URLs already cached OR already in flight, AND drop anything
  // outside the Wikimedia allowlist. The inflight check prevents repeated
  // PREFETCH_AUDIO messages from spawning duplicate fetches and overwriting
  // each other's AbortControllers (which would make PANEL_DISMISSED abort
  // the wrong one). Set-based dedup catches duplicate URLs in a single batch
  // (different file titles that resolve to the same canonical asset).
  const todo = Array.from(new Set(
    items
      .filter(i => i && isAllowedAudioUrl(i.url))
      .map(i => i.url)
  )).filter(u => !audioCache.has(u) && !inflightPrefetches.has(u));

  if (todo.length) {
    // Shared cursor across workers. Array.shift() would be O(n) per dequeue
    // because it re-indexes the whole array; a cursor is O(1) and avoids
    // the per-message churn on busy pages.
    let cursor = 0;
    const workers = Array.from({ length: PREFETCH_CONCURRENCY }, async () => {
      while (cursor < todo.length) {
        const url = todo[cursor++];
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
          // Enforce the documented invariant ("we cache audio"): drop a
          // response whose Content-Type isn't audio. Not a security guard
          // (Wikimedia is allowlisted by host), but it prevents a hypothetical
          // Wikimedia bug from landing non-audio bytes in the user's Downloads
          // folder under an audio extension. application/ogg is included
          // because Wikimedia serves .ogg with that legacy MIME, not audio/ogg.
          const ct = (r.headers.get('Content-Type') || '').toLowerCase();
          if (!ct.startsWith('audio/') && ct.split(';')[0].trim() !== 'application/ogg') continue;
          // Cheap defense against pathological inputs: bail before reading
          // the body if Wikimedia reports a size larger than any real
          // pronunciation file. Saves bandwidth and prevents cache thrash.
          // Number.isFinite filters out NaN (parseInt on a non-numeric
          // header) and Infinity; on either we just fall through and let
          // the post-read length check do the work.
          const declared = parseInt(r.headers.get('Content-Length') || '0', 10);
          if (Number.isFinite(declared) && declared > PER_FILE_MAX_BYTES) {
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
    log(`[Background] Prefetch done. Cache: ${audioCache.size()} items, ${(audioCache.bytes() / 1024).toFixed(0)} KB`);
  }

  // Speculative top-item transcode. Fire and forget; the result populates
  // transcodedCache so the eventual click on item 0 skips ffmpeg.exec.
  // Reuses the modePromise resolved above; never a second storage round-trip.
  const top = items[0];
  if (top && top.url && top.downloadName) {
    const mode = await modePromise;
    if (mode === 'convert' || mode === 'both') {
      triggerSpeculativeTranscode(top.url, top.downloadName);
    }
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
    dismissUrl(url);
    const ctrl = inflightPrefetches.get(url);
    if (ctrl) ctrl.abort();
    // Both caches handle byte-counter bookkeeping internally; transcoded
    // additionally revokes the blob URL via its onEvict callback. No
    // caller-side counter arithmetic to drift.
    audioCache.delete(url);
    transcodedCache.delete(url);
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
  // Validate message shape before doing privileged work. Even though
  // sender is internal (isAllowedSender already filtered), defensive shape
  // checks make invalid states unrepresentable instead of silently falling
  // through into the wrong branch.
  if (!isAllowedAudioUrl(url)) {
    sendResponse({ ok: false, error: 'url not allowed' });
    return false;
  }
  if (typeof originalFilename !== 'string' || !originalFilename) {
    sendResponse({ ok: false, error: 'invalid filename' });
    return false;
  }
  if (mode !== 'original' && mode !== 'convert' && mode !== 'both') {
    sendResponse({ ok: false, error: 'invalid mode' });
    return false;
  }
  if (folder !== undefined && typeof folder !== 'string') {
    sendResponse({ ok: false, error: 'invalid folder' });
    return false;
  }
  const baseName = sanitizeFilename(originalFilename.replace(/\.[^.]+$/, ''));

  (async () => {
    /** @type {{ url: string, filename: string, saveAs: boolean }} */
    let opts;
    if (mode === 'convert') {
      // transcodeForUrl returns immediately if the WAV is cached (speculative
      // pre-transcode already ran), awaits any in-flight transcode, or kicks
      // off a fresh one. Internally it uses a SW-created blob: URL to hand
      // prefetched bytes to offscreen, so no audio data ever traverses the
      // runtime port.
      log('[Background] Converting:', originalFilename, folder ? `-> ${folder}/` : '');
      const { filename, blobUrl } = await transcodeForUrl(url, baseName);
      opts = {
        url: blobUrl,
        filename: pathWithFolder(folder, filename),
        saveAs: false,
      };
    } else {
      const cached = peekCached(url);
      if (cached && cached.byteLength <= DATA_URL_THRESHOLD_BYTES) {
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

// Read-only introspection of the prefetch + transcoded caches, used by the
// Playwright suite to wait deterministically for prefetch and speculative
// transcode without fixed timeouts. Gated on globalThis.__WAD_TEST__ so the
// list of currently-cached audio URLs (a low-sensitivity leak of which
// Wiktionary entries the user has loaded) is not reachable in normal
// production use. Tests set the flag in their context setup; nothing the
// extension exposes to pages can flip it.
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

})();
