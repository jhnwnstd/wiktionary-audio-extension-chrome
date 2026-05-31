// Discovery-boundary audio detection. Pure: no chrome.* or DOM, works in
// every context and in Node tests.

// Non-`audio/*` MIMEs to still treat as audio. Wikimedia serves .ogg with
// the legacy `application/ogg`, not `audio/ogg`.
export const AUDIO_MIMES = new Set([
  'application/ogg',
]);

// Unambiguously-audio extensions. .webm excluded: the container can carry
// video and Wikimedia doesn't serve audio in WebM, so mislabeling risk
// outweighs the chance of a real audio.webm slipping through.
export const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|flac|m4a|aac)$/i;

/**
 * Is this imageinfo entry audio?
 *   1. mediatype if present (AUDIO accepts; anything else rejects).
 *   2. MIME (audio/* or AUDIO_MIMES).
 *   3. Filename extension.
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
 * Schema check for the imageinfo fields we consume. Optional fields may
 * be absent/null; their presence requires the right type.
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

// One URL parse + one lastIndexOf. URL.pathname drops query/fragment.
// Falls back to 'audio' on malformed input.
/** @param {string} url @returns {string} */
export function urlTail(url) {
  try {
    const p = new URL(url).pathname;
    const i = p.lastIndexOf('/');
    const tail = i >= 0 ? p.slice(i + 1) : p;
    return tail || 'audio';
  } catch { return 'audio'; }
}

// Clamp a filename's trailing extension to an audio type. If the trailing
// extension already matches AUDIO_EXT_RE, returns the filename unchanged;
// otherwise strips any non-audio extension and appends `.ogg` (Wikimedia's
// legacy default). Defense in depth so an upstream mediatype misclass'n
// can't round-trip a non-audio extension to the user's disk.
/** @param {string} filename @returns {string} */
export function ensureAudioExtension(filename) {
  if (typeof filename !== 'string' || !filename) return 'audio.ogg';
  if (AUDIO_EXT_RE.test(filename)) return filename;
  const stripped = filename.replace(/\.[a-z0-9]+$/i, '');
  return (stripped || 'audio') + '.ogg';
}
