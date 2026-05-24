// Allowlisted hostnames for audio bytes. Wikimedia serves all Wiktionary
// pronunciation audio from upload.wikimedia.org. Every context (SW,
// offscreen, content) re-validates by importing this module.

export const AUDIO_HOST_ALLOWLIST = new Set(['upload.wikimedia.org']);

/** True iff `url` is https on an allowlisted host. Never throws.
 * @param {string} url @returns {boolean} */
export function isAllowedAudioUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUDIO_HOST_ALLOWLIST.has(u.hostname);
  } catch { return false; }
}
