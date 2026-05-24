// "Looks like audio?" predicate. Imported by SW prefetch and offscreen
// fetch; future MIMEs are a one-file edit.
//
// audio/* + application/ogg (Wikimedia's legacy MIME for .ogg).
// Parameters tolerated by splitting on `;`.

/** @param {string | null | undefined} header */
export function isAudioContentType(header) {
  const ct = (header || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  return ct.split(';')[0].trim() === 'application/ogg';
}
