// background.js -- Service worker for Wiktionary audio downloads

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  try {
    if (bytes.length < 65536) return btoa(String.fromCharCode(...bytes));
  } catch {}
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

// Cross-platform filename sanitizer covering the union of Windows, macOS, and
// Linux filesystem restrictions. Preserves Unicode (e.g. 水, café) but enforces
// a 255-byte UTF-8 cap, since most real filesystems use byte-length not
// codepoint-length -- a 100-character Chinese filename is ~300 bytes on disk.
//
// Rules enforced:
//   * forbidden chars: < > : " / \ | ? * and control chars 0x00-0x1F
//   * Windows reserved basenames: CON, PRN, AUX, NUL, COM1-9, LPT1-9
//   * Windows forbids trailing space or period
//   * leading dots stripped (avoids Unix hidden-file surprise)
//   * 255-byte UTF-8 cap, preserving extension when possible
//   * never empty -- falls back to "audio"

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(s) {
  return UTF8_ENCODER.encode(s).length;
}

function truncateToBytes(s, maxBytes) {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let result = s;
  while (result.length > 0 && utf8ByteLength(result) > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function sanitizeFilename(filename) {
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

// Ping offscreen via Port, returns a Promise that resolves on PONG
function pingOffscreen(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('ping timeout'));
    }, timeoutMs);

    port.onMessage.addListener(function onPong(msg) {
      if (msg.type === 'PONG') {
        clearTimeout(timer);
        port.onMessage.removeListener(onPong);
        port.disconnect();
        resolve();
      }
    });
    port.postMessage({ type: 'PING' });
  });
}

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run ffmpeg.wasm for audio conversion'
    });
  } catch {
    // Already exists -- Chrome enforces single offscreen doc
  }

  // Retry ping up to 4 times (handles slow module loading after createDocument)
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await pingOffscreen(3000);
      log('[Background] Offscreen ready (attempt', attempt + ')');
      return;
    } catch {
      log('[Background] Ping attempt', attempt, 'failed, retrying...');
      if (attempt < 4) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error('Offscreen document failed to respond after retries');
}

async function transcodeToWav(audioUrl, baseName) {
  log('[Background] Starting transcode...');
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    const timeout = setTimeout(() => {
      port.disconnect();
      reject(new Error('Transcoding timeout (90s)'));
    }, 90000);

    port.onMessage.addListener((msg) => {
      clearTimeout(timeout);
      port.disconnect();

      if (!msg.ok) {
        reject(new Error(msg.error || 'Transcode failed'));
        return;
      }

      if (!Array.isArray(msg.audioBytes) || !msg.audioBytes.length) {
        reject(new Error('Invalid audio data from conversion'));
        return;
      }

      const arrayBuffer = new Uint8Array(msg.audioBytes).buffer;
      resolve({ filename: msg.filename, arrayBuffer });
    });

    port.postMessage({ type: 'TRANSCODE', srcUrl: audioUrl, outBase: baseName });
  });
}

// Prepend an optional subfolder to a sanitized filename. Folder and file are
// sanitized independently so neither can inject a `/`; the separator is
// inserted after sanitization. chrome.downloads accepts forward slashes
// cross-platform and auto-creates intermediate directories.
function pathWithFolder(folder, filename) {
  const file = sanitizeFilename(filename);
  if (!folder) return file;
  return sanitizeFilename(folder) + '/' + file;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'DOWNLOAD_AUDIO') return false;

  const { url, originalFilename, mode, folder } = msg;
  const baseName = sanitizeFilename(originalFilename.replace(/\.[^.]+$/, ''));

  (async () => {
    if (mode === 'convert') {
      log('[Background] Converting:', originalFilename, folder ? `-> ${folder}/` : '');
      const { filename, arrayBuffer } = await transcodeToWav(url, baseName);
      const base64 = arrayBufferToBase64(arrayBuffer);
      const dataUrl = `data:audio/wav;base64,${base64}`;
      await chrome.downloads.download({
        url: dataUrl,
        filename: pathWithFolder(folder, filename),
        saveAs: false
      });
    } else {
      log('[Background] Downloading original:', originalFilename, folder ? `-> ${folder}/` : '');
      await chrome.downloads.download({
        url,
        filename: pathWithFolder(folder, originalFilename)
      });
    }
    sendResponse({ ok: true });
  })().catch(error => {
    logError('[Background] Download error:', error.message);
    sendResponse({ ok: false, error: error.message });
  });

  return true; // Keep channel open for async response
});
