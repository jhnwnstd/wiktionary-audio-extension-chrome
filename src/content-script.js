// @ts-check
// content-script.js: minimal entry.
//
// On every Wiktionary page load, this script does only what's strictly
// needed before we know whether the page has pronunciation audio:
//   1. Parse the page title from the URL.
//   2. Dynamic-import the discovery module and call the MediaWiki API.
//   3. If items came back, parallel-import the filename parser and UI
//      modules and render the panel.
//
// The filename + UI modules are 20+ KB of code that only matter when the
// page actually has audio. Loading them lazily keeps the passive footprint
// on talk/category/special/non-entry pages down to this entry plus the
// discovery module plus one API call.
//
// Classic script (MV3 content_scripts can't be modules), so dynamic imports
// resolve against the extension origin via chrome.runtime.getURL and the
// imported files are listed in manifest.json's web_accessible_resources.

(async () => {
  const pageTitle = safeDecode(location.pathname.split('/wiki/')[1] ?? '');
  if (!pageTitle) return;

  // Dynamic-import resolves against the extension origin. The shared base
  // is captured once so the import paths read cleanly below.
  const base = chrome.runtime.getURL('');
  /** @param {string} rel */
  const load = (rel) => import(base + rel);

  try {
    const apiEndpoint = `${location.origin}/w/api.php`;
    const { discoverAudio, isEnglishLang } = await load('content/discovery.mjs');

    const audioFiles = await discoverAudio(apiEndpoint, pageTitle);
    if (!audioFiles.length) return;

    // Filename parser and UI module both live downstream of discovery.
    // Load them in parallel: parser supplies the enrichment that UI reads.
    const [{ parseAudioFilename, friendlyAudioFilename, humanReadableName },
            { createUI },
            { safeSendMessage }] = await Promise.all([
      load('content/filename.mjs'),
      load('content/ui.mjs'),
      load('content/context.mjs'),
    ]);

    // Precompute names once per item:
    //   downloadName: sanitized friendly filename used for the actual save
    //   displayName:  human readable form for the on-page panel
    //   lang:         parsed language code, used by the English first sort
    // Pass pageTitle as the word anchor so hyphenated speakers and compound
    // words (e.g. "well-known") both parse correctly.
    audioFiles.forEach(item => {
      const parsed = parseAudioFilename(item.filename, pageTitle);
      item.downloadName = friendlyAudioFilename(parsed);
      item.displayName = humanReadableName(parsed, item.filename);
      item.lang = parsed.lang;
    });

    // Display order: English entries first (Wiktionary's primary user base),
    // then everything else alphabetically by the displayed name. Within each
    // group, displayName comparison gives a stable, intuitive ordering.
    // One Intl.Collator built outside the comparator: String.localeCompare
    // constructs an Intl.Collator per call internally, which would be ~N
    // log N collators for an N-item page.
    const collator = new Intl.Collator('en');
    audioFiles.sort((a, b) => {
      const aEn = isEnglishLang(a.lang);
      const bEn = isEnglishLang(b.lang);
      if (aEn !== bEn) return aEn ? -1 : 1;
      return collator.compare(a.displayName || '', b.displayName || '');
    });

    createUI(audioFiles, pageTitle);

    // Fire and forget prefetch: tell background to start pulling the
    // audio bytes into its cache while the user reads the panel. By the
    // time they click Download, the bytes are usually ready and both
    // Original and Convert paths skip their network round trip. Pass
    // downloadName along so background can speculatively transcode item 0
    // in Convert/Both mode. Not awaited; panel UX doesn't depend on
    // prefetch finishing.
    safeSendMessage({
      type: 'PREFETCH_AUDIO',
      items: audioFiles.map(item => ({
        url: item.url,
        downloadName: item.downloadName,
      })),
    }, { timeoutMs: 5000 }).catch(() => { /* opportunistic; ignore failures */ });
  } catch (error) {
    console.error('[Wiktionary Audio] Discovery failed:', error);
  }
})();

// decodeURIComponent throws URIError on malformed `%XX` sequences. Inline
// here so the entry stays self-contained for the rare pre-discovery use.
/** @param {string} s */
function safeDecode(s) {
  try { return decodeURIComponent(s); }
  catch { return String(s); }
}
