// offscreen.js — FFmpeg.wasm audio conversion (MV3 module, CSP-safe)

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
      await ffmpeg.exec([
        '-i', inName, '-vn', '-ac', '1', '-ar', '48000', '-sample_fmt', 's16', '-y', outName
      ]);

      const out = await ffmpeg.readFile(outName);
      log('[Offscreen] Converted:', out.buffer.byteLength, 'bytes');
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
