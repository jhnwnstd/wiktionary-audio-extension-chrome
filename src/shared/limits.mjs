// Byte and concurrency caps. Imported by SW/offscreen statically and by
// the content script via dynamic import.

// Per-file input cap. Real Wiktionary audio is 10-500 KB; anything larger
// is anomalous or hostile.
export const PER_FILE_MAX_BYTES = 5 * 1024 * 1024;

// Offscreen-local output cap; PCM expands lossy sources so it's larger
// than the input cap. Invariant `OUTPUT > PER_FILE` asserted by tests.
export const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

// Prefetch (raw bytes) cache. Bounded LRU; lost on SW restart.
export const PREFETCH_CACHE_MAX_BYTES = 20 * 1024 * 1024;

// Transcoded WAV cache. ~96 KB/s mono PCM -> 20 MB ≈ 3 minutes of output.
export const TRANSCODED_CACHE_MAX_BYTES = 20 * 1024 * 1024;

// Prefetch worker pool size. 3 stays well under Chrome's per-host limit.
export const PREFETCH_CONCURRENCY = 3;

// Original-mode cached-file threshold for the data URL fast path. Larger
// files pass the source URL to chrome.downloads (browser HTTP cache hit).
export const DATA_URL_THRESHOLD_BYTES = 512 * 1024;

// dismissedUrls Set cap. Several pages worth of pronunciation audio.
export const DISMISSED_URLS_MAX = 512;
