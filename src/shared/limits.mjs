// Single source of truth for byte and concurrency caps. Previously these
// lived as duplicate literals across background.js, content-script.js, and
// offscreen.js, guarded by parity tests. Imported by SW and offscreen
// directly, and re-read from this file by content-script via dynamic import.

// Per-file cap. Wiktionary pronunciation audio is consistently 10-500 KB;
// anything bigger is either an anomaly or hostile, and we'd rather waste
// the round trip than blow the cache budget on a single file. Enforced
// independently in every context that fetches audio bytes.
export const PER_FILE_MAX_BYTES = 5 * 1024 * 1024;

// Offscreen-local output cap. PCM expands lossy sources, so the output cap
// is necessarily larger than the input. 16 MB covers the worst case from
// `-t 120` (~12 MB) with a safety margin if the duration flag misbehaves.
// Invariant `OUTPUT_MAX_BYTES > PER_FILE_MAX_BYTES` is asserted by tests.
export const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

// Total bytes the prefetch (raw audio) cache may hold. Bounded LRU; lost
// on SW restart. Sized to fit several pages worth of pronunciation files
// without blowing background memory on a long browsing session.
export const PREFETCH_CACHE_MAX_BYTES = 20 * 1024 * 1024;

// Same budget shape for the transcoded WAV cache. Output is ~96 KB/s mono
// PCM so 20 MB is ~3 minutes of accumulated speculative + user-requested
// conversions before eviction kicks in.
export const TRANSCODED_CACHE_MAX_BYTES = 20 * 1024 * 1024;

// Bounded concurrency for the prefetch worker pool. 3 keeps us well under
// Chrome's per-host connection limit while still overlapping handshakes.
export const PREFETCH_CONCURRENCY = 3;

// Original-mode threshold: cached files below this go out as a data URL
// (saves a network round-trip); larger files use the source URL directly
// so chrome.downloads' fetch hits the browser HTTP cache from our prefetch,
// avoiding base64 expansion + giant data URL string. 512 KB is well above
// typical pronunciation file size, so the common case stays cheap.
export const DATA_URL_THRESHOLD_BYTES = 512 * 1024;

// Cap on the dismissed-URL tombstone set. Without this, the set would grow
// monotonically across a long browsing session (every dismissed URL stays
// forever) which is a quiet memory leak. 512 is several pages worth of
// pronunciation audio; the only cost of evicting too early is that a
// late-arriving speculative transcode could repopulate the cache for a URL
// the user dismissed a very long time ago.
export const DISMISSED_URLS_MAX = 512;
