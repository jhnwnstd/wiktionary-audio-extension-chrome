// Audio-shape detection used at the discovery boundary. Decides whether a
// MediaWiki imageinfo entry refers to a pronunciation audio file we can
// surface to the user. Pure functions; no chrome.* dependencies so it works
// in content script, SW, offscreen, and Node tests.

// Non-audio-prefix MIMEs that should still be treated as audio. The broad
// `audio/*` check below already covers all audio MIMEs; this set only holds
// the few that don't start with `audio/` (Wiktionary serves .ogg files with
// `application/ogg`, not `audio/ogg`).
export const AUDIO_MIMES = new Set([
  'application/ogg',
]);

// Extensions that are unambiguously audio by file format or convention.
// `.m4a` is the audio-only naming variant of MPEG-4 Part 14; `.aac` is a
// raw AAC stream (no container, so no video). `.webm` is excluded because
// the WebM container can carry video and Wiktionary doesn't serve audio
// in WebM, so a mislabeled .webm slipping through here would risk treating
// a video file as audio.
export const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|flac|m4a|aac)$/i;

/**
 * Decide whether an imageinfo entry refers to audio.
 *   1. mediatype, when present, is authoritative (AUDIO accepts, anything
 *      else rejects). Stops video files from slipping through on a
 *      .ogg/.opus extension.
 *   2. Otherwise fall back to MIME (`audio/*` or AUDIO_MIMES).
 *   3. Last resort: filename extension on info.url.
 *
 * @param {any} info
 */
export function isAudioInfo(info) {
  if (!info) return false;
  if (typeof info.mediatype === 'string' && info.mediatype.length > 0) {
    return info.mediatype.toUpperCase() === 'AUDIO';
  }
  if (typeof info.mime === 'string') {
    const m = info.mime.toLowerCase();
    if (m.startsWith('audio/')) return true;
    if (AUDIO_MIMES.has(m)) return true;
  }
  if (typeof info.url === 'string' && AUDIO_EXT_RE.test(info.url)) return true;
  return false;
}

/**
 * Explicit acceptance check for the MediaWiki imageinfo shape we depend on.
 * Returns true only when every consumed field has a type we can act on;
 * falsy/absent optional fields are tolerated. Runs at the boundary so
 * downstream code operates on a known-shape entry.
 *
 * @param {any} info
 */
export function validImageInfo(info) {
  if (!info || typeof info !== 'object') return false;
  if (typeof info.url !== 'string' || info.url.length === 0) return false;
  if (info.mime !== undefined && info.mime !== null && typeof info.mime !== 'string') return false;
  if (info.mediatype !== undefined && info.mediatype !== null && typeof info.mediatype !== 'string') return false;
  if (info.size !== undefined && info.size !== null) {
    if (typeof info.size !== 'number' || !Number.isFinite(info.size) || info.size < 0) return false;
  }
  return true;
}

/**
 * Extract the filename tail from a URL via a single URL parse + one split,
 * dropping query/fragment automatically (URL.pathname has neither). Falls
 * back to 'audio' if pathname has no tail or URL parsing fails.
 *
 * @param {string} url
 * @returns {string}
 */
export function urlTail(url) {
  try {
    const p = new URL(url).pathname;
    const i = p.lastIndexOf('/');
    const tail = i >= 0 ? p.slice(i + 1) : p;
    return tail || 'audio';
  } catch { return 'audio'; }
}
