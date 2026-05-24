// @ts-check
// Minimal content-script entry. Parses pageTitle, dynamic-imports the
// discovery module, and only loads the filename parser + UI modules if
// discovery actually returns items. Pages without audio (talk, category,
// special, non-entry) skip ~20 KB of code.
//
// Classic script (MV3 content_scripts can't be modules), so imports go
// through chrome.runtime.getURL and the .mjs files are listed in the
// manifest's web_accessible_resources.

(async () => {
  const pageTitle = safeDecode(location.pathname.split('/wiki/')[1] ?? '');
  if (!pageTitle) return;

  const base = chrome.runtime.getURL('');
  /** @param {string} rel */
  const load = (rel) => import(base + rel);

  try {
    const apiEndpoint = `${location.origin}/w/api.php`;
    const { discoverAudio, isEnglishLang } = await load('content/discovery.mjs');

    const audioFiles = await discoverAudio(apiEndpoint, pageTitle);
    if (!audioFiles.length) return;

    const [{ parseAudioFilename, friendlyAudioFilename, humanReadableName },
            { createUI },
            { safeSendMessage }] = await Promise.all([
      load('content/filename.mjs'),
      load('content/ui.mjs'),
      load('content/context.mjs'),
    ]);

    // pageTitle anchors the parser so hyphenated speakers vs compound
    // words (e.g. well-known) disambiguate correctly.
    audioFiles.forEach(item => {
      const parsed = parseAudioFilename(item.filename, pageTitle);
      item.downloadName = friendlyAudioFilename(parsed);
      item.displayName = humanReadableName(parsed, item.filename);
      item.lang = parsed.lang;
    });

    // English first, then alphabetical by displayName. Collator built
    // outside the comparator (localeCompare allocates one per call).
    const collator = new Intl.Collator('en');
    audioFiles.sort((a, b) => {
      const aEn = isEnglishLang(a.lang);
      const bEn = isEnglishLang(b.lang);
      if (aEn !== bEn) return aEn ? -1 : 1;
      return collator.compare(a.displayName || '', b.displayName || '');
    });

    createUI(audioFiles, pageTitle);

    // Fire-and-forget prefetch. Bytes usually land before the user clicks.
    safeSendMessage({
      type: 'PREFETCH_AUDIO',
      items: audioFiles.map(item => ({
        url: item.url,
        downloadName: item.downloadName,
      })),
    }, { timeoutMs: 5000 }).catch(() => { /* opportunistic */ });
  } catch (error) {
    console.error('[Wiktionary Audio] Discovery failed:', error);
  }
})();

// Inlined: this entry runs before discovery.mjs loads.
/** @param {string} s */
function safeDecode(s) {
  try { return decodeURIComponent(s); }
  catch { return String(s); }
}
