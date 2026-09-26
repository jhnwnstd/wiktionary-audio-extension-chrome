// Refcounted set of URLs with a user-initiated download in flight.
//
// PANEL_DISMISSED is a disengagement signal: it tombstones a URL, aborts its
// prefetch, and evicts its caches so speculative work can't repopulate them.
// None of that may touch a download the user explicitly asked for. Minimizing
// the panel while a conversion runs is not a cancel, and tombstoning there
// would make addTranscoded revoke the very blob URL the convert path is about
// to hand to chrome.downloads.
//
// Refcounted rather than a plain Set because one URL can carry two concurrent
// downloads: `both` mode fans out to an original and a convert request, and a
// row click can land while Download All is already working through that item.
//
// Pure module: no chrome.* or DOM, so it unit tests directly.

export function createDownloadClaims() {
  /** @type {Map<string, number>} url -> outstanding claims */
  const counts = new Map();

  return {
    /** @param {string} url */
    retain(url) {
      counts.set(url, (counts.get(url) || 0) + 1);
    },

    /**
     * Drop one claim. Returns true only when that was the last outstanding
     * claim, which is the caller's cue to run post-download cleanup. An
     * unbalanced release (no claim held) is a no-op and returns false, so a
     * stray call can't trigger cleanup for someone else's download.
     * @param {string} url
     * @returns {boolean}
     */
    release(url) {
      const held = counts.get(url) || 0;
      if (held > 1) {
        counts.set(url, held - 1);
        return false;
      }
      counts.delete(url);
      return held === 1;
    },

    /** @param {string} url */
    has(url) { return counts.has(url); },

    /** Test/inspection only. */
    size() { return counts.size; },
  };
}
