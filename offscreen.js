// offscreen.js (MV3 module, CSP-safe)

// Debug logging (set to false for production)
const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console); // Always log errors

log('[Offscreen] Script loaded, starting import...');

import { FFmpeg } from "./vendor/ffmpeg/ffmpeg.mjs";

log('[Offscreen] FFmpeg imported successfully');

const isIsolated = self.crossOriginIsolated === true; // true if COOP/COEP applied
// Try single-thread first to avoid worker complications
const USE_MULTITHREAD = false; // Set to true to use multi-thread
const coreBase = USE_MULTITHREAD ? "vendor/ffmpeg/core-mt" : "vendor/ffmpeg/core";

const coreURL   = chrome.runtime.getURL(`${coreBase}/ffmpeg-core.js`);
const wasmURL   = chrome.runtime.getURL(`${coreBase}/ffmpeg-core.wasm`);
// Multi-thread core uses worker, single-thread doesn't
const workerURL = USE_MULTITHREAD ? chrome.runtime.getURL(`${coreBase}/ffmpeg-core.worker.js`) : undefined;

const ffmpeg = new FFmpeg();
let loaded = false;
let loadPromise = null; // Memoize the loading promise to avoid concurrent loads

async function loadFFmpeg() {
  // If already loaded, return immediately
  if (loaded) {
    log('[Offscreen] FFmpeg already loaded, skipping');
    return;
  }
  
  // If currently loading, wait for existing load promise
  if (loadPromise) {
    log('[Offscreen] FFmpeg load in progress, waiting for existing load...');
    await loadPromise;
    return;
  }
  
  // Create and cache the loading promise
  loadPromise = (async () => {
    log('[Offscreen] Starting FFmpeg load...');
    log('[Offscreen] Cross-origin isolated:', isIsolated);
    log('[Offscreen] Using core type:', USE_MULTITHREAD ? 'multi-thread (diagnostic)' : 'single-thread (optimized for compatibility)');
    log('[Offscreen] Core URLs:', { coreURL, wasmURL, workerURL });
    
    const startTime = Date.now();
    
    try {
      // Pre-flight checks: verify core files are accessible
      log('[Offscreen] Pre-flight: checking core file accessibility...');
      const coreUrls = { coreURL, wasmURL };
      if (workerURL) coreUrls.workerURL = workerURL;
      
      for (const [name, url] of Object.entries(coreUrls)) {
        if (!url) continue;
        log(`[Offscreen] Checking ${name}: ${url}`);
        
        try {
          const response = await fetch(url);
          const contentLength = response.headers.get('content-length');
          log(`[Offscreen] ${name} status=${response.status} length=${contentLength} type=${response.headers.get('content-type')}`);
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          
          if (!contentLength || parseInt(contentLength) === 0) {
            log(`[Offscreen] Warning: ${name} has no content-length or is empty`);
          }
        } catch (fetchError) {
          logError(`[Offscreen] Pre-flight failed for ${name}:`, fetchError);
          throw new Error(`Core file ${name} is not accessible: ${fetchError.message}`);
        }
      }
      
      // Pre-compile WASM to catch corruption/format issues early
      if (wasmURL) {
        log('[Offscreen] Pre-compiling WASM to verify integrity...');
        try {
          const wasmResponse = await fetch(wasmURL);
          const wasmBuffer = await wasmResponse.arrayBuffer();
          log(`[Offscreen] WASM buffer size: ${wasmBuffer.byteLength} bytes`);
          
          if (wasmBuffer.byteLength === 0) {
            throw new Error('WASM file is empty');
          }
          
          // This will throw if WASM is corrupt/invalid
          await WebAssembly.compile(wasmBuffer);
          log('[Offscreen] WASM pre-compilation successful');
        } catch (wasmError) {
          logError('[Offscreen] WASM pre-compilation failed:', wasmError);
          throw new Error(`WASM file is invalid: ${wasmError.message}`);
        }
      }
      
      log('[Offscreen] Pre-flight checks passed, calling ffmpeg.load()...');
      
      // Add read-only worker debugging (don't interfere with FFmpeg's worker creation)
      const NativeWorker = Worker;
      self.Worker = function(url, opts) {
        log('[Offscreen] 🔧 Worker created:', new URL(url, location.href).href, opts);
        const w = new NativeWorker(url, opts);  // Pass through unchanged
        w.addEventListener('error', e => {
          logError('[Offscreen] ❌ Worker error:', e);
        });
        w.addEventListener('message', e => {
          log('[Offscreen] 📨 Worker message:', e.data?.cmd || e.data?.type || 'unknown');
        });
        return w;
      };
      
      // Add timeout to prevent infinite hang
      const loadPromiseWithTimeout = new Promise(async (resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('FFmpeg load timeout after 60 seconds'));
        }, 60000);
        
        try {
          await ffmpeg.load({
            coreURL,
            wasmURL,
            workerURL
          });
          clearTimeout(timeoutId);
          resolve();
        } catch (error) {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      await loadPromiseWithTimeout;
      
      const loadTime = Date.now() - startTime;
      loaded = true;
      log(`[Offscreen] ✅ FFmpeg loaded successfully in ${loadTime}ms`);
      log(`[Offscreen] FFmpeg ready for transcoding operations`);
    } catch (error) {
      const loadTime = Date.now() - startTime;
      logError(`[Offscreen] FFmpeg load failed after ${loadTime}ms:`, error);
      logError('[Offscreen] Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      // Reset load promise on failure so future attempts can retry
      loadPromise = null;
      throw error;
    }
  })();
  
  // Wait for the load to complete
  await loadPromise;
}

// Listen for Port connections from background for zero-copy transfers
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ffmpeg') return;
  
  log('[Offscreen] FFmpeg Port connected');
  
  port.onMessage.addListener(async (msg) => {
    log('[Offscreen] Received Port message:', msg?.type);
    
    if (msg?.type !== "FFMPEG_TRANSCODE_TO_WAV") {
      log('[Offscreen] Ignoring non-transcode message:', msg?.type);
      port.postMessage({ ok: false, error: 'Unknown message type' });
      return;
    }

    // Handle URL-based data transfer (avoids binary serialization issues)
    const srcUrl = msg.srcUrl;
    log('[Offscreen] Received srcUrl:', srcUrl?.substring(0, 50) + '...');
    
    if (!srcUrl) {
      logError('[Offscreen] No srcUrl provided');
      port.postMessage({ ok: false, error: 'No audio URL provided' });
      return;
    }
    
    // Fetch audio data directly in offscreen context
    let audioBytes;
    let audioSize = 0;
    
    try {
      log('[Offscreen] Fetching audio data from URL...');
      const response = await fetch(srcUrl);
      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      audioBytes = new Uint8Array(arrayBuffer);
      audioSize = arrayBuffer.byteLength;
      log('[Offscreen] Audio fetched successfully, size:', audioSize, 'bytes');
    } catch (fetchError) {
      logError('[Offscreen] Failed to fetch audio:', fetchError);
      port.postMessage({ ok: false, error: `Failed to fetch audio: ${fetchError.message}` });
      return;
    }
    
    // Check for missing or empty audioData
    if (!audioBytes || audioSize === 0) {
      logError('[Offscreen] No audio bytes or empty audio data after fetch');
      port.postMessage({ ok: false, error: 'No audio data received after fetch' });
      return;
    }
    
    try {
      log('[Offscreen] Loading FFmpeg...');
      await loadFFmpeg();
      log('[Offscreen] ✅ FFmpeg load complete, writing input file...');

      const inName = "in.bin";
      const outName = (msg.outBase || "audio") + ".wav";

      await ffmpeg.writeFile(inName, audioBytes);
      log('[Offscreen] Input file written, starting conversion...');
      
      // Optimized command for OGG/Opus → WAV (pronunciation audio)
      await ffmpeg.exec([
        "-i", inName,         // Input file
        "-vn",               // No video (audio-only)
        "-ac", "1",          // Mono (enough for pronunciation)
        "-ar", "48000",      // Consistent sample rate (48kHz)
        "-sample_fmt", "s16", // 16-bit PCM (fastest)
        "-y",                // Overwrite output
        outName
      ]);
      log('[Offscreen] Conversion complete, reading output...');

      const out = await ffmpeg.readFile(outName);
      log('[Offscreen] Output file read, size:', out.buffer.byteLength, 'bytes');
      
      // Clean up temporary files from FFmpeg file system
      try {
        await ffmpeg.deleteFile(inName);
        await ffmpeg.deleteFile(outName);
        log('[Offscreen] Temporary files cleaned up successfully');
      } catch (cleanupError) {
        log('[Offscreen] File cleanup warning:', cleanupError.message);
      }
      
      // Convert Uint8Array to regular array for JSON serialization
      const outputBytes = Array.from(out);
      log('[Offscreen] Preparing to send via runtime.sendMessage:', {
        filename: outName,
        originalLength: out.length,
        arrayLength: outputBytes.length,
        firstBytes: outputBytes.slice(0, 10)
      });
      
      // Send response via chrome.runtime.sendMessage
      chrome.runtime.sendMessage({
        type: 'FFMPEG_TRANSCODE_COMPLETE',
        ok: true,
        filename: outName,
        audioBytes: outputBytes  // Send as regular array
      }, () => {
        log('[Offscreen] Response sent via runtime.sendMessage');
        port.disconnect(); // Clean up the port
      });
    } catch (error) {
      logError('[Offscreen] Transcode error:', error);
      logError('[Offscreen] Error type:', error.constructor.name);
      logError('[Offscreen] Error message:', error.message);
      
      // Clean up any files that may have been created before error
      try {
        const inName = "in.bin";
        const outName = (msg.outBase || "audio") + ".wav";
        await ffmpeg.deleteFile(inName).catch(() => {}); // Ignore if doesn't exist
        await ffmpeg.deleteFile(outName).catch(() => {}); // Ignore if doesn't exist
        log('[Offscreen] Error cleanup: temporary files removed');
      } catch (cleanupError) {
        log('[Offscreen] Error cleanup warning:', cleanupError.message);
      }
      
      port.postMessage({ ok: false, error: `${error.constructor.name}: ${error.message}` });
    }
  });
  
  port.onDisconnect.addListener(() => {
    log('[Offscreen] FFmpeg Port disconnected');
  });
});

// Keep ping message handler for readiness checks
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  log('[Offscreen] Received message:', msg?.type);
  
  // Handle ping messages to check readiness
  if (msg?.type === "OFFSCREEN_PING") {
    log('[Offscreen] Received ping, responding with readiness status');
    sendResponse({ ready: true, loaded: loaded });
    return true; // Keep message channel open for async response
  }
  
  // All other messages are ignored in the new Port-based system
  return false;
});