// offscreen.js: FFmpeg.wasm audio conversion (MV3 module, CSP safe).

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

// Hard size caps. Mirror of background.js PER_FILE_MAX_BYTES. The output
// cap is 16 MB which covers the worst case from `-t 120` (~12 MB) with a
// safety margin in case the duration flag misbehaves.
const INPUT_MAX_BYTES = 5 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

// Allowlist for srcUrl when offscreen fetches directly (no cached bytes
// path). Mirror of background.js / content-script.js. Mirrored locally
// because offscreen is a privileged context that should not implicitly
// trust a URL just because background forwarded it.
const AUDIO_HOST_ALLOWLIST = new Set(['upload.wikimedia.org']);
/** @param {string} url */
function isAllowedAudioUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUDIO_HOST_ALLOWLIST.has(u.hostname);
  } catch { return false; }
}

import { FFmpeg } from "./vendor/ffmpeg/ffmpeg.mjs";

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

// Output is always 16 bit PCM WAV, mono, 48 kHz, with triangular dither on
// quantization. No normalization, gain, denoise, or silence trim: lossy
// source audio can't be restored to higher fidelity, so this command just
// standardizes container plus rate for downstream analysis tools.
//
// `-t 120` caps output at 120 seconds (~12 MB WAV at 96 KB/s). Wiktionary
// pronunciation audio is consistently under 10 seconds; the cap is a DoS
// guard against pathological inputs (a 60-minute source would otherwise
// produce a ~350 MB WAV before we even reach the messaging layer).
//
// `aresample=dither_method=triangular` requires libavfilter + aresample in
// the wasm core build (default in upstream @ffmpeg/core). We deliberately
// do NOT runtime probe or fall back between filters: a failed `ffmpeg.exec`
// can poison the worker state and break subsequent calls. The live convert
// test verifies these args work against the vendored core.
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

// FFmpeg's single in memory filesystem and worker are shared across calls,
// so concurrent transcodes would race on `in.bin` and `${outBase}.wav`.
// Serialize TRANSCODE requests through this chain. PING and PREWARM bypass
// the queue: ping is just a health check, and loadFFmpeg already dedupes
// via its own loadPromise guard.
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
      // Trigger FFmpeg.load() without converting anything. Caller resolves
      // when PREWARMED arrives (or times out). Failures are swallowed; the
      // user will pay the load on first real click if pre-warm failed.
      loadFFmpeg().then(
        () => port.postMessage({ type: 'PREWARMED', ok: true }),
        () => port.postMessage({ type: 'PREWARMED', ok: false }),
      );
      return;
    }

    if (msg?.type === 'REVOKE_BLOB') {
      // Background asks us to release a Blob URL (cache eviction or panel
      // dismiss). The Blob itself gets GC'd once its URL is revoked and no
      // other references remain.
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

    const { srcUrl, srcBytes, outBase } = msg;
    if (!srcUrl && !Array.isArray(srcBytes)) {
      port.postMessage({ ok: false, error: 'No audio source provided' });
      return;
    }
    // Defense in depth. Background already enforces these but a privileged
    // context shouldn't trust an upstream caller; bad input rejected here
    // saves FFmpeg from ever seeing it.
    if (srcUrl && !isAllowedAudioUrl(srcUrl)) {
      port.postMessage({ ok: false, error: 'srcUrl not allowed' });
      return;
    }
    if (Array.isArray(srcBytes) && srcBytes.length > INPUT_MAX_BYTES) {
      port.postMessage({ ok: false, error: 'srcBytes too large' });
      return;
    }

    const inName = 'in.bin';
    const outName = (outBase || 'audio') + '.wav';

    await serializeTranscode(async () => {
      try {
        // Two paths:
        //   srcBytes: background's prefetch cache already has the bytes, so
        //     skip the fetch. Wrap as Uint8Array; FFmpeg loads in parallel.
        //   srcUrl: no cached bytes. Fetch concurrently with FFmpeg load.
        const fetchBytes = srcBytes
          ? Promise.resolve(new Uint8Array(srcBytes))
          : (async () => {
              log('[Offscreen] Fetching:', srcUrl.substring(0, 60));
              const response = await fetch(srcUrl);
              if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
              const declared = parseInt(response.headers.get('Content-Length') || '0', 10);
              if (declared > INPUT_MAX_BYTES) throw new Error('declared size over limit');
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (!bytes.length) throw new Error('Empty audio data');
              if (bytes.length > INPUT_MAX_BYTES) throw new Error('input over limit');
              return bytes;
            })();

        const [audioBytes] = await Promise.all([fetchBytes, loadFFmpeg()]);
        await ffmpeg.writeFile(inName, audioBytes);
        await runTranscode(inName, outName);

        const out = await ffmpeg.readFile(outName);
        log('[Offscreen] Converted:', out.buffer.byteLength, 'bytes');
        // Final DoS guard: if `-t 120` somehow didn't bound the output,
        // refuse to ship megabytes back through the message channel.
        if (out.buffer.byteLength > OUTPUT_MAX_BYTES) {
          await cleanupFiles(inName, outName);
          port.postMessage({ ok: false, error: 'output over limit' });
          return;
        }
        await cleanupFiles(inName, outName);

        // Hand the WAV back as a Blob URL instead of marshaling the bytes
        // through the message channel. `Array.from(Uint8Array)` would
        // allocate ~8 bytes per sample as JS numbers (10x bloat), then JSON
        // serialize through the port, then base64 in background, then a
        // ~6.7 MB data URL. Blob URLs avoid all of it: the bytes stay in
        // offscreen's heap until background sends REVOKE_BLOB on cache
        // eviction. Both contexts share the chrome-extension origin so
        // chrome.downloads.download in background can resolve the URL.
        const blob = new Blob([out], { type: 'audio/wav' });
        const blobUrl = URL.createObjectURL(blob);
        port.postMessage({
          ok: true,
          filename: outName,
          blobUrl,
          byteLength: out.buffer.byteLength,
        });
      } catch (error) {
        logError('[Offscreen] Transcode error:', error.message);
        await cleanupFiles(inName, outName);
        port.postMessage({ ok: false, error: error.message });
      }
    });
  });
});
