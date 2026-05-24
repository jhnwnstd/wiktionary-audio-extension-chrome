// offscreen.js: FFmpeg.wasm audio conversion (MV3 module, CSP safe).

import { PER_FILE_MAX_BYTES, OUTPUT_MAX_BYTES } from "./shared/limits.mjs";
import { isAllowedAudioUrl } from "./shared/audio-allowlist.mjs";
import { isAudioContentType } from "./shared/content-type.mjs";
import { FFmpeg } from "./vendor/ffmpeg/ffmpeg.mjs";

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

const coreURL = chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js");
const wasmURL = chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm");

const ffmpeg = new FFmpeg();
let loaded = false;
let loadPromise = null;

async function loadFFmpeg() {
  if (loaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    log('[Offscreen] Loading FFmpeg...');
    const start = Date.now();

    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('FFmpeg load timeout (60s)')), 60000)
      );
      await Promise.race([ffmpeg.load({ coreURL, wasmURL }), timeout]);

      loaded = true;
      log(`[Offscreen] FFmpeg loaded in ${Date.now() - start}ms`);
    } catch (error) {
      logError('[Offscreen] FFmpeg load failed:', error);
      loadPromise = null;
      throw error;
    }
  })();

  return loadPromise;
}

async function cleanupFiles(...names) {
  for (const name of names) {
    try { await ffmpeg.deleteFile(name); } catch {}
  }
}

// Fixed recipe: 16-bit PCM WAV, mono, 48 kHz, TPDF dither. No normalization
// or trimming (lossy source, can't restore fidelity). `-t 120` caps output
// at ~12 MB as a DoS guard. `aresample=dither_method=triangular` requires
// libavfilter+aresample (default in upstream @ffmpeg/core); no runtime
// probe or filter fallback because a failed exec can poison the worker.
async function runTranscode(inName, outName) {
  const args = [
    '-i', inName, '-vn',
    '-t', '120',
    '-af', 'aresample=dither_method=triangular',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
    '-y', outName,
  ];
  log('[Offscreen] ffmpeg', args.join(' '));
  await ffmpeg.exec(args);
}

// Serialize TRANSCODE: FFmpeg's in-memory FS is shared, so concurrent
// exec would race on `in.bin` / `${outBase}.wav`. PING and PREWARM bypass
// the queue (loadFFmpeg has its own loadPromise guard).
/** @type {Promise<void>} */
let transcodeQueue = Promise.resolve();

/** @param {() => Promise<void>} task */
function serializeTranscode(task) {
  const next = transcodeQueue.then(task, task);
  transcodeQueue = next.catch(() => {});
  return next;
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ffmpeg') return;
  log('[Offscreen] Port connected');

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'PING') {
      port.postMessage({ type: 'PONG', loaded });
      return;
    }

    if (msg?.type === 'PREWARM') {
      // Load FFmpeg without transcoding. Cold load on first real click is
      // the fallback if this fails.
      loadFFmpeg().then(
        () => port.postMessage({ type: 'PREWARMED', ok: true }),
        () => port.postMessage({ type: 'PREWARMED', ok: false }),
      );
      return;
    }

    if (msg?.type === 'REVOKE_BLOB') {
      const url = msg.blobUrl;
      if (typeof url === 'string') {
        try { URL.revokeObjectURL(url); } catch { /* already gone */ }
      }
      return;
    }

    if (msg?.type !== 'TRANSCODE') {
      port.postMessage({ ok: false, error: 'Unknown message type' });
      return;
    }

    const { srcUrl, outBase } = msg;
    // Defense in depth: re-validate even though background already did.
    if (!isAllowedAudioUrl(srcUrl)) {
      port.postMessage({ ok: false, error: 'srcUrl not allowed' });
      return;
    }

    const inName = 'in.bin';
    const outName = (outBase || 'audio') + '.wav';

    await serializeTranscode(async () => {
      try {
        // Fetch concurrently with FFmpeg load. The fetch typically lands
        // on Chrome's HTTP cache from the SW prefetch (no network round
        // trip); falls back to a fresh network fetch on cache miss. Per-
        // file caps apply either way.
        const fetchBytes = (async () => {
          log('[Offscreen] Fetching:', srcUrl.substring(0, 60));
          // Allow internal Wikimedia redirects; enforce allowlist + audio
          // Content-Type on the final response so a redirect chain can't
          // sneak in non-audio.
          const response = await fetch(srcUrl, { credentials: 'omit' });
          if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
          if (!isAllowedAudioUrl(response.url)) throw new Error('redirect outside allowlist');
          if (!isAudioContentType(response.headers.get('Content-Type'))) {
            throw new Error('non-audio Content-Type');
          }
          // Number.isFinite filters NaN/Infinity from a malformed header.
          const declared = parseInt(response.headers.get('Content-Length') || '0', 10);
          if (Number.isFinite(declared) && declared > PER_FILE_MAX_BYTES) throw new Error('declared size over limit');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (!bytes.length) throw new Error('Empty audio data');
          if (bytes.length > PER_FILE_MAX_BYTES) throw new Error('input over limit');
          return bytes;
        })();

        const [audioBytes] = await Promise.all([fetchBytes, loadFFmpeg()]);
        await ffmpeg.writeFile(inName, audioBytes);
        await runTranscode(inName, outName);

        const out = await ffmpeg.readFile(outName);
        // .byteLength (view), NOT .buffer.byteLength: Emscripten can
        // return a sub-view of HEAPU8, and Blob([out]) ships the view.
        const outBytes = out.byteLength;
        log('[Offscreen] Converted:', outBytes, 'bytes');
        // Final DoS guard if `-t 120` didn't bound output.
        if (outBytes > OUTPUT_MAX_BYTES) {
          await cleanupFiles(inName, outName);
          port.postMessage({ ok: false, error: 'output over limit' });
          return;
        }
        await cleanupFiles(inName, outName);

        // Blob URL handoff: bytes stay in offscreen heap until background
        // sends REVOKE_BLOB, avoiding the ~10x bloat of marshaling
        // Array.from(Uint8Array) + base64 through the runtime port.
        const blob = new Blob([out], { type: 'audio/wav' });
        const blobUrl = URL.createObjectURL(blob);
        port.postMessage({
          ok: true,
          filename: outName,
          blobUrl,
          byteLength: outBytes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('[Offscreen] Transcode error:', message);
        await cleanupFiles(inName, outName);
        port.postMessage({ ok: false, error: message });
      }
    });
  });
});
