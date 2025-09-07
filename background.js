// Background script for Wiktionary audio downloads

// Debug logging (set to false for production)
const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const logError = console.error.bind(console); // Always log errors

log('[Wiktionary Audio] Service worker loaded');

// Track offscreen readiness
let offscreenReady = false;

// Optimized ArrayBuffer to base64 conversion with hybrid approach
function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  
  try {
    // Use fast method for smaller files (avoids call stack limits)
    // Conservative threshold to avoid call stack overflow on large files
    if (bytes.length < 65536) { // 64KB threshold for safety
      return btoa(String.fromCharCode(...bytes));
    }
  } catch (error) {
    logError('[Background] Fast base64 conversion failed, falling back to chunked method:', error);
  }
  
  // Fall back to chunked method for larger files or if fast method fails
  let binary = '';
  const chunkSize = 8192; // Larger chunks for better performance
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// Sanitize filename to prevent download failures
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid characters
    .replace(/\s+/g, ' ')          // Normalize whitespace
    .replace(/^\.+/, '')           // Remove leading dots
    .trim()                        // Remove leading/trailing whitespace
    .substring(0, 255);            // Limit length
}

async function ensureOffscreenAndReady() {
  // Avoid multiple pages; close/recreate only if needed.
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run ffmpeg.wasm for audio conversion'
    });
    // Reset ready flag when creating new offscreen document
    offscreenReady = false;
  } catch (e) {
    // If already exists, ignore (Chrome enforces single offscreen doc).
  }
  
  // Ping the offscreen document to check if it's ready
  log('[Background] Pinging offscreen document to check readiness...');
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logError('[Background] Offscreen readiness check timed out');
      reject(new Error('Offscreen document failed to respond within 5 seconds'));
    }, 5000);
    
    // Send a ping message to check if offscreen is ready
    chrome.runtime.sendMessage({ 
      type: 'OFFSCREEN_PING' 
    }, (response) => {
      clearTimeout(timeout);
      
      if (chrome.runtime.lastError) {
        logError('[Background] Ping failed:', chrome.runtime.lastError.message);
        reject(new Error(`Offscreen ping failed: ${chrome.runtime.lastError.message}`));
      } else if (response?.ready) {
        log('[Background] Offscreen confirmed ready via ping');
        offscreenReady = true;
        resolve();
      } else {
        logError('[Background] Offscreen not ready:', response);
        reject(new Error('Offscreen document not ready'));
      }
    });
  });
}

async function transcodeToWav(audioUrl, baseName) {
  log('[Background] Starting transcode, ensuring offscreen...');
  await ensureOffscreenAndReady();
  log('[Background] Offscreen ready, sending URL to transcode...');
  
  // Add timeout to prevent hanging - longer timeout for cold FFmpeg loads
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logError('[Background] Transcoding timeout after 90s');
      reject(new Error('Transcoding timeout - FFmpeg load or conversion took too long'));
    }, 90000); // 90 second timeout for FFmpeg cold start
    
    log('[Background] Using URL-based transfer, audioUrl:', audioUrl.substring(0, 50) + '...');
    
    // Create Port connection for triggering the conversion
    const port = chrome.runtime.connect({ name: 'ffmpeg' });
    
    // Listen for the completion message via runtime.onMessage
    const messageListener = (message, sender, sendResponse) => {
      if (message.type === 'FFMPEG_TRANSCODE_COMPLETE') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(messageListener);
        
        log('[Background] Received transcode completion:', message?.ok);
        log('[Background] Message keys:', Object.keys(message || {}));
        
        const { ok, filename, audioBytes } = message || {};
        log('[Background] Response details:', {
          ok,
          filename,
          isArray: Array.isArray(audioBytes),
          arrayLength: audioBytes?.length,
          firstBytes: audioBytes?.slice(0, 10)
        });
        
        if (!ok) {
          logError('[Background] Transcode failed:', message.error);
          reject(new Error(message.error || 'Transcode failed'));
        } else if (!Array.isArray(audioBytes) || !audioBytes.length) {
          logError('[Background] No valid audio bytes array received:', message);
          reject(new Error('Invalid audio data received from conversion'));
        } else {
          try {
            // Convert regular array back to Uint8Array
            const uint8Array = new Uint8Array(audioBytes);
            log('[Background] Reconstructed Uint8Array, size:', uint8Array.length);
            log('[Background] About to resolve with ArrayBuffer');
            resolve({ ok: true, filename, arrayBuffer: uint8Array.buffer });
          } catch (reconstructError) {
            logError('[Background] Error during Uint8Array reconstruction:', reconstructError);
            reject(new Error(`Failed to reconstruct audio data: ${reconstructError.message}`));
          }
        }
      }
    };
    
    chrome.runtime.onMessage.addListener(messageListener);

    // Send URL for offscreen to fetch directly (avoids binary transfer issues)
    port.postMessage({
      type: 'FFMPEG_TRANSCODE_TO_WAV',
      srcUrl: audioUrl,
      outBase: baseName
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'DOWNLOAD_AUDIO') {
      log('[Background] Received DOWNLOAD_AUDIO message:', { url: msg.url?.substring(0, 50) + '...', mode: msg.mode, filename: msg.originalFilename });
      const { url, originalFilename, mode } = msg; // mode: 'original' | 'convert'
      const base = sanitizeFilename(originalFilename.replace(/\.[^.]+$/, ''));

      if (mode === 'convert') {
        log('[Background] Convert mode - sending URL to offscreen for transcoding...');
        // Pass URL directly to offscreen (avoids binary transfer issues)
        try {
          const { ok, filename, arrayBuffer, error } = await transcodeToWav(url, base);
          log('[Background] transcodeToWav returned:', { ok, filename, hasArrayBuffer: !!arrayBuffer, error });
          
          if (!ok) throw new Error(error || 'ffmpeg failed');
          if (!(arrayBuffer instanceof ArrayBuffer) || !arrayBuffer.byteLength) {
            throw new Error('Invalid audio data received from conversion');
          }
          
          log('[Background] Creating data URL from ArrayBuffer, size:', arrayBuffer.byteLength);
          
          // Convert ArrayBuffer to base64 using optimized hybrid approach
          const base64 = arrayBufferToBase64(arrayBuffer);
          const dataUrl = `data:audio/wav;base64,${base64}`;
          
          log('[Background] Data URL created, size:', dataUrl.length);
          
          const sanitizedFilename = sanitizeFilename(filename);
          log('[Background] Sanitized filename:', sanitizedFilename);
          
          log('[Background] Starting chrome.downloads.download...');
          const downloadId = await chrome.downloads.download({ 
            url: dataUrl, 
            filename: sanitizedFilename,
            saveAs: false 
          });
          log('[Background] Download initiated successfully, ID:', downloadId);
          log('[Background] WAV conversion download completed:', sanitizedFilename);
          
        } catch (conversionError) {
          logError('[Background] Conversion/download error:', conversionError);
          logError('[Background] Error stack:', conversionError.stack);
          throw conversionError;
        }
        sendResponse({ ok: true });
        return;
      }


      // 'original'
      log('[Background] Original mode - downloading with original filename');
      const sanitizedOriginal = sanitizeFilename(originalFilename);
      await chrome.downloads.download({ url, filename: sanitizedOriginal });
      sendResponse({ ok: true });
      return;
    }

    // Unknown message type
    sendResponse({ ok: false, error: 'Unknown message type' });
  })().catch(e => {
    logError('[Background] Message handler error:', e);
    sendResponse({ ok: false, error: String(e) });
  });

  return true; // async
});