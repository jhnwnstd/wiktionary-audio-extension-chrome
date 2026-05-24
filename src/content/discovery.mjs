// @ts-check
// Audio discovery via MediaWiki Action API (generator=images +
// prop=imageinfo). One roundtrip per page, plus continuation. Filters by
// mediatype=AUDIO, falling back to MIME then file extension. Works on
// every Wiktionary edition because it bypasses per-edition DOM.

import { PER_FILE_MAX_BYTES } from '../shared/limits.mjs';
import { isAllowedAudioUrl } from '../shared/audio-allowlist.mjs';
import { isAudioInfo, validImageInfo, urlTail } from '../shared/audio-info.mjs';

/**
 * @typedef {object} AudioItem
 * @property {string} title
 * @property {string} url
 * @property {string} filename
 * @property {string|null} mime
 * @property {number|null} size
 * @property {string} downloadName
 * @property {string} displayName
 * @property {string|null} lang
 */

// Bare decodeURIComponent throws on malformed `%XX`; the fallback keeps
// a single bad URL from blowing up the whole page.
/** @param {string} s */
export function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); }
  catch { return String(s); }
}

// Filter `pages` to audio entries. Items are built with the full field set
// (downloadName/displayName/lang as defaults) so V8's hidden class stays
// stable when the caller fills them in.
/**
 * @param {any[]} pages
 * @returns {AudioItem[]}
 */
export function audioItemsFromPages(pages) {
  if (!Array.isArray(pages)) return [];
  const results = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!validImageInfo(info)) continue;
    if (!isAudioInfo(info)) continue;
    if (!isAllowedAudioUrl(info.url)) continue;
    // Authoritative size from imageinfo: drop oversize before prefetch.
    if (typeof info.size === 'number' && info.size > PER_FILE_MAX_BYTES) continue;
    results.push({
      title: page.title,
      url: info.url,
      filename: safeDecodeURIComponent(urlTail(info.url)),
      mime: info.mime ?? null,
      size: typeof info.size === 'number' ? info.size : null,
      downloadName: '',
      displayName: '',
      lang: null,
    });
  }
  return results;
}

/** @param {string} url */
async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return null;
  // Treat a JSON parse failure as a transport failure so one bad
  // continuation pass doesn't abort the whole panel.
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * True for ISO 639-1 `en` and 639-3 `eng` so English entries can be pinned
 * to the top of the panel regardless of where they appear on the page.
 * @param {string|null|undefined} lang
 * @returns {boolean}
 */
export function isEnglishLang(lang) {
  if (!lang) return false;
  const code = String(lang).toLowerCase();
  return code === 'en' || code === 'eng';
}

// Allowlisted continuation keys for our query (generator=images +
// prop=imageinfo). Anything else MediaWiki returns is silently dropped.
const CONTINUE_KEYS = new Set(['continue', 'gimcontinue']);

/** Plain-object check; rejects arrays, primitives, exotic prototypes.
 * @param {unknown} c */
export function isPlainContinue(c) {
  if (c === null || typeof c !== 'object') return false;
  if (Array.isArray(c)) return false;
  const proto = Object.getPrototypeOf(c);
  return proto === Object.prototype || proto === null;
}

/** @param {URLSearchParams} params @param {Record<string, unknown>} cont */
export function applyContinuation(params, cont) {
  for (const k of CONTINUE_KEYS) {
    const v = cont[k];
    if (typeof v === 'string') params.set(k, v);
  }
}

/**
 * Discover all audio files attached to a page via Action API. Handles
 * generator continuation up to MAX_PASSES passes (real entries like
 * fr/eau with 33+ items finish in one or two passes). Truncation past
 * the pass cap is unlikely in practice and surfaces as a console.warn
 * if it ever happens.
 *
 * @param {string} apiEndpoint  base `https://*.wiktionary.org/w/api.php`
 * @param {string} title  page title (e.g. `water`, `Wasser`, `水`)
 * @returns {Promise<AudioItem[]>}
 */
export async function discoverAudio(apiEndpoint, title) {
  const baseParams = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    titles: title,
    generator: 'images',
    gimlimit: 'max',
    prop: 'imageinfo',
    iiprop: 'url|mime|mediatype|size',
  };

  const results = [];
  const seen = new Set();
  let cont = null;
  // 5 passes × gimlimit=max(500) = 2500-item ceiling, well above any real
  // Wiktionary entry. Truncation past the ceiling is surfaced via warn().
  const MAX_PASSES = 5;
  let lastPassHadContinuation = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const params = new URLSearchParams(baseParams);
    if (cont) applyContinuation(params, cont);
    const data = await fetchJson(`${apiEndpoint}?${params}`);
    if (!data) break;

    // Dedupe by canonical URL: aliased File: titles can resolve to the
    // same asset, and we don't want duplicate rows or duplicate prefetches.
    for (const item of audioItemsFromPages(data.query?.pages)) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }

    cont = isPlainContinue(data.continue) ? data.continue : null;
    if (!cont) break;
    lastPassHadContinuation = pass === MAX_PASSES - 1;
  }
  if (lastPassHadContinuation) {
    console.warn(
      `[Wiktionary Audio] Discovery truncated at ${MAX_PASSES} continuation passes; ${results.length} items surfaced, more remain on the page.`,
    );
  }
  return results;
}
