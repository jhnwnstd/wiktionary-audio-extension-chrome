// Path helpers. Pure: no chrome.* or DOM.

import { sanitizeFilename } from './sanitize-filename.mjs';

/**
 * Prepend an optional subfolder. Folder and file are sanitized
 * independently so neither can inject a `/`.
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
 * Subfolder name for Download All.
 *   en.wiktionary.org/wiki/water -> Wiktionary-en-water
 * @param {string} hostname
 * @param {string} title
 * @returns {string}
 */
export function batchFolderName(hostname, title) {
  const match = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const edition = match?.[1] || 'wiktionary';
  return `Wiktionary-${edition}-${title || 'audio'}`;
}
