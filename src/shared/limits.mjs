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

// dismissedUrls Set cap. Several pages worth of pronunciation audio.
export const DISMISSED_URLS_MAX = 512;

// Timeout budget. The panel's message timeout has to exceed the service
// worker's worst case or the panel reports "Failed" for a download that is
// still going to land on disk. Derived from the SW-side waits rather than
// hand-written alongside them, so the two can't drift; the invariant is
// asserted in tests/unit/test.mjs.
//
// Bound the audio fetch so a stalled connection can't pin an inflight entry
// (and the download claim guarding it) open indefinitely.
export const AUDIO_FETCH_TIMEOUT_MS = 30_000;
// Offscreen port budget for a full fetch + FFmpeg cold load + exec.
export const TRANSCODE_TIMEOUT_MS = 90_000;
// chrome.downloads.download resolves on initiation, not completion; this
// bounds the wait for the terminal state.
export const DOWNLOAD_WAIT_TIMEOUT_MS = 60_000;
// Slack for the message plumbing either side of the waits above.
const MESSAGE_SLACK_MS = 5_000;

export const ORIGINAL_MESSAGE_TIMEOUT_MS =
  AUDIO_FETCH_TIMEOUT_MS + DOWNLOAD_WAIT_TIMEOUT_MS + MESSAGE_SLACK_MS;
export const CONVERT_MESSAGE_TIMEOUT_MS =
  TRANSCODE_TIMEOUT_MS + DOWNLOAD_WAIT_TIMEOUT_MS + MESSAGE_SLACK_MS;
