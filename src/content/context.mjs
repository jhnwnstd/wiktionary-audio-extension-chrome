// Extension-context helpers used throughout the content script. Validates
// that chrome.runtime is still live (the extension can be unloaded or
// upgraded while a tab stays open, which invalidates every chrome.* call),
// renders an in-page notice when it isn't, and provides a Promise-flavored
// sendMessage with a timeout so callers never hang on a dead SW.

import { t } from '../shared/i18n.mjs';

export function isExtensionContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

export function showContextInvalidatedMessage() {
  if (document.querySelector('.wiktionary-audio-context-notice')) return;
  const notice = document.createElement('div');
  notice.className = 'wiktionary-audio-context-notice';
  notice.style.cssText = `
    position:fixed;top:20px;right:20px;z-index:2147483647;
    background:#f44336;color:#fff;padding:12px 16px;border-radius:8px;
    font:14px system-ui;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,.2)`;

  // Built with DOM APIs (not innerHTML) so the page's CSP can't block the
  // reload handler, and so future translation strings can't accidentally
  // introduce HTML they shouldn't.
  const strong = document.createElement('strong');
  strong.textContent = t.extensionReloaded;
  notice.appendChild(strong);
  notice.appendChild(document.createElement('br'));
  notice.appendChild(document.createTextNode(t.refreshMessage));

  const reloadBtn = document.createElement('button');
  reloadBtn.textContent = t.refreshButton;
  reloadBtn.style.cssText = 'margin-left:8px;padding:4px 8px;background:#fff;color:#f44336;border:none;border-radius:4px;cursor:pointer';
  reloadBtn.addEventListener('click', () => location.reload());
  notice.appendChild(reloadBtn);

  document.documentElement.appendChild(notice);
}

/**
 * Send a message to the service worker, race it against a timeout, and
 * surface chrome.runtime.lastError as a rejection. Resolves with whatever
 * the background's `sendResponse` produced.
 * @param {object} message
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<DownloadResponse | undefined>}
 */
export async function safeSendMessage(message, { timeoutMs = 90000 } = {}) {
  if (!isExtensionContextValid()) {
    showContextInvalidatedMessage();
    throw new Error('Extension context invalidated');
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
