// Allowlist of hostnames that may serve audio bytes to this extension.
// Wikimedia serves all Wiktionary pronunciation audio from
// upload.wikimedia.org; nothing else should ever appear in an API response
// or message. Each context (content script, SW, offscreen) re-validates
// independently: defense in depth degrades silently if one layer drifts,
// so importing the same module here keeps all three honest by construction.

export const AUDIO_HOST_ALLOWLIST = new Set(['upload.wikimedia.org']);

/**
 * True iff `url` is an https URL on an allowlisted host. Reject non-string
 * input and anything URL parsing chokes on; never throws.
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedAudioUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUDIO_HOST_ALLOWLIST.has(u.hostname);
  } catch { return false; }
}
