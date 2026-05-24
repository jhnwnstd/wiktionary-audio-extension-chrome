// Filename + folder path helpers shared between background.js (writes the
// chrome.downloads request) and the content script (chooses the batch
// folder name from the page URL). Pure functions; no chrome.* or DOM.

import { sanitizeFilename } from './sanitize-filename.mjs';

/**
 * Prepend an optional subfolder to a sanitized filename. Folder and file
 * are sanitized independently so neither can inject a `/`. chrome.downloads
 * accepts forward slashes cross-platform and creates intermediate dirs.
 *
 * @param {string | undefined | null} folder
 * @param {string} filename
 * @returns {string}
 */
export function pathWithFolder(folder, filename) {
  const file = sanitizeFilename(filename);
  if (!folder) return file;
  return sanitizeFilename(folder) + '/' + file;
}

/**
 * Subfolder name used when the user clicks Download All. Distinctive
 * enough to find in the Downloads folder and tied to the source page.
 *   en.wiktionary.org/wiki/water  -> Wiktionary-en-water
 *   de.wiktionary.org/wiki/Wasser -> Wiktionary-de-Wasser
 *   ja.wiktionary.org/wiki/水     -> Wiktionary-ja-水
 *
 * @param {string} hostname
 * @param {string} title
 * @returns {string}
 */
export function batchFolderName(hostname, title) {
  const match = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const edition = match?.[1] || 'wiktionary';
  return `Wiktionary-${edition}-${title || 'audio'}`;
}
