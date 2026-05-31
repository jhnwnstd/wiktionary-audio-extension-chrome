// Filename sanitizer covering Win/Mac/Linux restrictions. Preserves
// Unicode, enforces a 255-byte UTF-8 cap (most filesystems use bytes,
// not codepoints), and falls back to "audio" if the result would be empty.
//
// Rules:
//   forbidden chars: < > : " / \ | ? * and control chars 0x00-0x1F
//   Windows reserved basenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
//   no trailing space/period (Windows)
//   no leading dots (Unix hidden-file surprise)
//   255-byte UTF-8 cap, extension preserved when possible

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** @param {string} s */
export function utf8ByteLength(s) {
  return UTF8_ENCODER.encode(s).length;
}

/**
 * Truncate to `maxBytes` UTF-8 bytes without splitting a code point.
 * Encode once, walk back past continuation bytes (10xxxxxx) to a
 * boundary, decode the prefix. O(n).
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateToBytes(s, maxBytes) {
  const bytes = UTF8_ENCODER.encode(s);
  if (bytes.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return UTF8_DECODER.decode(bytes.subarray(0, cut));
}

/** @param {unknown} filename @returns {string} */
export function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename) return 'audio';

  let s = filename
    .split('?')[0].split('#')[0]
    .replace(FORBIDDEN_CHARS_RE, '_')
    .replace(/\s+/g, ' ')
    // Strip leading dots AND spaces in one pass. Earlier the two strip
    // steps could leak a leading dot back in: ". .foo" became "._foo"
    // after the inner space was trimmed away to expose the second dot.
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');

  if (WINDOWS_RESERVED_RE.test(s)) s = '_' + s;

  if (utf8ByteLength(s) > 255) {
    const extIdx = s.lastIndexOf('.');
    if (extIdx > 0 && s.length - extIdx <= 16) {
      const ext = s.slice(extIdx);
      s = truncateToBytes(s.slice(0, extIdx), 255 - utf8ByteLength(ext)) + ext;
    } else {
      s = truncateToBytes(s, 255);
    }
  }

  return s || 'audio';
}
