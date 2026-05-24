// offscreen.js: FFmpeg.wasm audio conversion (MV3 module, CSP safe).

const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console);

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
// `aresample=dither_method=triangular` requires libavfilter + aresample in
// the wasm core build (default in upstream @ffmpeg/core). We deliberately
// do NOT runtime probe or fall back between filters: a failed `ffmpeg.exec`
// can poison the worker state and break subsequent calls. The live convert
// test verifies these args work against the vendored core.
async function runTranscode(inName, outName) {
  const args = [
    '-i', inName, '-vn',
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

    if (msg?.type !== 'TRANSCODE') {
      port.postMessage({ ok: false, error: 'Unknown message type' });
      return;
    }

    const { srcUrl, srcBytes, outBase } = msg;
    if (!srcUrl && !Array.isArray(srcBytes)) {
      port.postMessage({ ok: false, error: 'No audio source provided' });
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
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (!bytes.length) throw new Error('Empty audio data');
              return bytes;
            })();

        const [audioBytes] = await Promise.all([fetchBytes, loadFFmpeg()]);
        await ffmpeg.writeFile(inName, audioBytes);
        await runTranscode(inName, outName);

        const out = await ffmpeg.readFile(outName);
        log('[Offscreen] Converted:', out.buffer.byteLength, 'bytes');
        await cleanupFiles(inName, outName);

        port.postMessage({ ok: true, filename: outName, audioBytes: Array.from(out) });
      } catch (error) {
        logError('[Offscreen] Transcode error:', error.message);
        await cleanupFiles(inName, outName);
        port.postMessage({ ok: false, error: error.message });
      }
    });
  });
});
