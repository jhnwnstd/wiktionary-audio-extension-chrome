// offscreen.js -- FFmpeg.wasm audio conversion (MV3 module, CSP-safe)

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
      if (DEBUG) {
        const NativeWorker = Worker;
        self.Worker = function(url, opts) {
          log('[Offscreen] Worker created:', new URL(url, location.href).href, opts);
          const w = new NativeWorker(url, opts);
          w.addEventListener('error', e => logError('[Offscreen] Worker error:', e));
          w.addEventListener('message', e => log('[Offscreen] Worker msg:', e.data?.cmd || e.data?.type));
          return w;
        };
      }

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

// Conversion profile pinned to the vendored FFmpeg.wasm core's capabilities.
// We deliberately do NOT runtime-probe or fall back between commands inside
// the worker -- a failed `ffmpeg.exec` can poison the worker state and break
// subsequent execs. Instead this constant is the single source of truth; the
// live convert test verifies it works against the vendored core.
//
// Profiles, from best to safest:
//   'soxr'     -af aresample=resampler=soxr:precision=28:dither_method=triangular
//              (needs libsoxr in the build; not in upstream @ffmpeg/core)
//   'aresample' -af aresample=dither_method=triangular
//              (needs libavfilter + aresample in the build; default upstream)
//   'safe'      no -af filter, bare PCM conversion
//
// Output is always 16-bit PCM WAV, mono, 48 kHz. No normalization, gain,
// denoise, or silence trim. Lossy source audio can't be restored to higher
// fidelity; this command standardizes container + rate for analysis tools.
const FFMPEG_CORE_PROFILE = 'aresample';

const ARGS_BY_PROFILE = {
  safe: (inName, outName) => [
    '-i', inName, '-vn',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
    '-y', outName,
  ],
  aresample: (inName, outName) => [
    '-i', inName, '-vn',
    '-af', 'aresample=dither_method=triangular',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
    '-y', outName,
  ],
  soxr: (inName, outName) => [
    '-i', inName, '-vn',
    '-af', 'aresample=resampler=soxr:precision=28:dither_method=triangular',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
    '-y', outName,
  ],
};

async function runTranscode(inName, outName) {
  const buildArgs = ARGS_BY_PROFILE[FFMPEG_CORE_PROFILE] || ARGS_BY_PROFILE.safe;
  const args = buildArgs(inName, outName);
  log('[Offscreen] ffmpeg', args.join(' '), '(profile=' + FFMPEG_CORE_PROFILE + ')');
  await ffmpeg.exec(args);
}

function logOutputWavHeader(buffer) {
  if (!DEBUG) return;
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44) return;
    const riff = String.fromCharCode.apply(null, new Uint8Array(buffer, 0, 4));
    const wave = String.fromCharCode.apply(null, new Uint8Array(buffer, 8, 4));
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    log('[Offscreen] output WAV header:', { riff, wave, channels, sampleRate, bitsPerSample, bytes: view.byteLength });
  } catch { /* header decoded best-effort */ }
}

// All communication uses Port-based messaging
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ffmpeg') return;
  log('[Offscreen] Port connected');

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'PING') {
      port.postMessage({ type: 'PONG', loaded });
      return;
    }

    if (msg?.type !== 'TRANSCODE') {
      port.postMessage({ ok: false, error: 'Unknown message type' });
      return;
    }

    const { srcUrl, outBase } = msg;
    if (!srcUrl) {
      port.postMessage({ ok: false, error: 'No audio URL provided' });
      return;
    }

    const inName = 'in.bin';
    const outName = (outBase || 'audio') + '.wav';

    try {
      // Fetch audio
      log('[Offscreen] Fetching:', srcUrl.substring(0, 60));
      const response = await fetch(srcUrl);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const audioBytes = new Uint8Array(await response.arrayBuffer());
      if (!audioBytes.length) throw new Error('Empty audio data');

      // Load FFmpeg and convert
      await loadFFmpeg();
      await ffmpeg.writeFile(inName, audioBytes);
      await runTranscode(inName, outName);

      const out = await ffmpeg.readFile(outName);
      log('[Offscreen] Converted:', out.buffer.byteLength, 'bytes');
      logOutputWavHeader(out.buffer);
      await cleanupFiles(inName, outName);

      // Send result as regular array (JSON-serializable over Port)
      port.postMessage({ ok: true, filename: outName, audioBytes: Array.from(out) });
    } catch (error) {
      logError('[Offscreen] Transcode error:', error.message);
      await cleanupFiles(inName, outName);
      port.postMessage({ ok: false, error: error.message });
    }
  });
});
