// @ts-check
// Wiktionary audio discovery via the MediaWiki Action API.
//
// Single discovery path: generator=images + prop=imageinfo. One roundtrip
// per page (more for long entries via continuation). Filters by
// `mediatype=AUDIO` from imageinfo, falling back to MIME and then the
// filename extension. Works across all Wiktionary editions because it
// bypasses per-edition template/DOM differences.

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

// decodeURIComponent throws URIError on malformed `%XX` sequences. Wrapping
// it once means a single bad URL or title can't disable the extension on
// the whole page. Falls back to the raw string so we still produce
// something usable downstream.
/** @param {string} s */
export function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); }
  catch { return String(s); }
}

/**
 * Filter an Action API `pages` array down to audio entries with the fields
 * we care about. The shape validator runs at the boundary so downstream
 * code operates on a known-shape AudioItem.
 *
 * Every result is built with the full AudioItem field set (downloadName,
 * displayName, lang as their empty/null defaults) so the V8 hidden class
 * stays stable when the entry script fills them in. Adding properties
 * later would force a second shape transition per item.
 *
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
    // Drop oversized files reported by the API before they ever reach
    // prefetch. Wikimedia's imageinfo size is authoritative; we only pay
    // the network round trip for files within budget.
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
  // response.json() rejects on a malformed body. Without this catch, a
  // single bad continuation pass would propagate out of discoverAudio's
  // 5-pass loop and abort the entire panel for the page. Treat parse
  // failure like a transport failure: return null and let the caller
  // continue with whatever it already has.
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

// Only the continuation keys our specific query (generator=images +
// prop=imageinfo) can legitimately produce. The MediaWiki Action API uses
// `continue` as an indicator string plus per-module keys; for us the only
// module emitting a continuation is the `images` generator (`gimcontinue`).
// Anything else returned by the API is silently dropped instead of being
// spread into URLSearchParams.
const CONTINUE_KEYS = new Set(['continue', 'gimcontinue']);

/**
 * True iff `c` is a non-null plain object (not an array, not a primitive,
 * no exotic prototype). Defensive against an API response that returns
 * `continue` as a string, array, or null.
 * @param {unknown} c
 */
export function isPlainContinue(c) {
  if (c === null || typeof c !== 'object') return false;
  if (Array.isArray(c)) return false;
  const proto = Object.getPrototypeOf(c);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy allowed continuation parameters from `cont` into `params`. Keys not
 * in the allowlist are ignored; values must be strings (MediaWiki always
 * returns string continuation tokens).
 * @param {URLSearchParams} params
 * @param {Record<string, unknown>} cont
 */
export function applyContinuation(params, cont) {
  for (const k of CONTINUE_KEYS) {
    const v = cont[k];
    if (typeof v === 'string') params.set(k, v);
  }
}

/**
 * Discover all audio files attached to a page via Action API. Handles
 * generator continuation so long entries (e.g. fr/eau with 33+ items)
 * aren't truncated.
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
  // Hard cap on continuation passes to avoid pathological loops.
  for (let pass = 0; pass < 5; pass++) {
    const params = new URLSearchParams(baseParams);
    if (cont) applyContinuation(params, cont);
    const data = await fetchJson(`${apiEndpoint}?${params}`);
    if (!data) break;

    // Dedupe by canonical URL: different File: titles can resolve to the
    // same upload.wikimedia.org asset (redirects, file aliases). Deduping
    // by title would still surface those as separate panel rows and trigger
    // redundant prefetches.
    for (const item of audioItemsFromPages(data.query?.pages)) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }

    cont = isPlainContinue(data.continue) ? data.continue : null;
    if (!cont) break;
  }
  return results;
}
