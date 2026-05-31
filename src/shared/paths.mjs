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
 *   en.wiktionary.org/wiki/water        -> Wiktionary-en-water
 *   simple.wiktionary.org/wiki/water    -> Wiktionary-simple-water
 *   zh-yue.wiktionary.org/wiki/water    -> Wiktionary-zh-yue-water
 * The earlier `[a-z]{2,3}` pattern produced `Wiktionary-wiktionary-water`
 * on subdomains longer than 3 letters or with a hyphen, so editions like
 * simple, zh-yue, be-tarask, bat-smg, and roa-rup silently collapsed.
 * @param {string} hostname
 * @param {string} title
 * @returns {string}
 */
export function batchFolderName(hostname, title) {
  const match = typeof hostname === 'string'
    ? hostname.match(/^([a-z0-9-]+)\.wiktionary\.org$/i)
    : null;
  const edition = match?.[1].toLowerCase() || 'wiktionary';
  return `Wiktionary-${edition}-${title || 'audio'}`;
}
