// Cross-platform filename sanitizer covering the union of Windows, macOS,
// and Linux filesystem restrictions. Preserves Unicode (e.g. 水, café) but
// enforces a 255 byte UTF-8 cap, since most real filesystems use byte
// length not codepoint length. A 100 character Chinese filename is ~300
// bytes on disk.
//
// Rules enforced:
//   * forbidden chars: < > : " / \ | ? * and control chars 0x00-0x1F
//   * Windows reserved basenames: CON, PRN, AUX, NUL, COM1-9, LPT1-9
//   * Windows forbids trailing space or period
//   * leading dots stripped (avoids Unix hidden-file surprise)
//   * 255 byte UTF-8 cap, preserving extension when possible
//   * never empty: falls back to "audio"

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** @param {string} s */
export function utf8ByteLength(s) {
  return UTF8_ENCODER.encode(s).length;
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte code point. Encode once, then walk back from the limit to
 * the nearest code-point boundary (a byte that is not a UTF-8
 * continuation byte: continuation bytes have the bit pattern 10xxxxxx).
 * O(n) instead of the previous O(n^2) per-char slice-and-reencode loop.
 *
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

/**
 * Sanitize a filename to be safe across Windows, macOS, and Linux file
 * systems while preserving Unicode characters.
 * @param {unknown} filename
 * @returns {string}
 */
export function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename) return 'audio';

  let s = filename
    .split('?')[0].split('#')[0]
    .replace(FORBIDDEN_CHARS_RE, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();

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
