// Single predicate for "this looks like an audio response we should accept."
// Centralized so a future MIME addition (Opus container migration, FLAC
// rollout from Wikimedia) is a one-file edit instead of three. Mirrored
// nowhere; imported by background.js prefetch and offscreen.js fetch.
//
// `audio/*` covers all audio MIMEs in current registry. `application/ogg`
// is the legacy MIME Wikimedia still serves for `.ogg` audio files (the
// audio/ogg alias was added later but the upload pipeline didn't switch).
// Parameters (e.g. `audio/ogg; codecs=opus`) are tolerated by splitting
// on `;` before equality-checking the legacy form.

/** @param {string | null | undefined} header */
export function isAudioContentType(header) {
  const ct = (header || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  return ct.split(';')[0].trim() === 'application/ogg';
}
