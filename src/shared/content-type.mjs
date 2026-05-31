// "Looks like audio?" predicate. Imported by SW prefetch and offscreen
// fetch; future MIMEs are a one-file edit.
//
// audio/* + application/ogg (Wikimedia's legacy MIME for .ogg).
// Parameters tolerated by splitting on `;`.
//
// Security note: application/ogg is shared between audio (Vorbis/Opus)
// and video (Theora). The load-bearing defense against a Theora-Ogg
// slipping in is the upstream mediatype=AUDIO check in isAudioInfo
// (src/shared/audio-info.mjs), which runs at the discovery boundary
// before URLs ever reach this predicate. If Wikimedia ever loosens that
// classification, narrow this to audio/ogg only plus an Ogg-page codec
// sniff for Vorbis/Opus magic bytes.

/** @param {string | null | undefined} header */
export function isAudioContentType(header) {
  const ct = (header || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  return ct.split(';')[0].trim() === 'application/ogg';
}
