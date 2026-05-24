// LRU+TTL registry of blob URLs owned by the offscreen document. Backstop
// against orphan blobs when the SW restarts between speculative transcode
// and user click: SW loses its transcodedCache bookkeeping, but the blob
// stays in offscreen heap unreferenced. The registry sweeps on every
// register call so any new transcode also cleans up older orphans.
//
// Dependency-injected so tests can drive it with a fake revoke + clock.

/**
 * @param {object} deps
 * @param {(url: string) => void} deps.revoke
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]
 * @param {number} [deps.maxEntries]
 */
export function createBlobRegistry({
  revoke,
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,    // 10 minutes
  maxEntries = 32,           // hard count cap regardless of TTL
}) {
  /** @type {Map<string, number>} url -> createdAt (insertion order = LRU) */
  const created = new Map();

  function sweep() {
    const cutoff = now() - ttlMs;
    // TTL sweep first.
    for (const [url, ts] of created) {
      if (ts > cutoff) break;  // map is insertion-ordered; rest are newer
      try { revoke(url); } catch { /* already revoked or invalid */ }
      created.delete(url);
    }
    // Count cap.
    while (created.size > maxEntries) {
      const oldest = created.keys().next().value;
      if (oldest === undefined) break;
      try { revoke(oldest); } catch { /* already revoked or invalid */ }
      created.delete(oldest);
    }
  }

  return {
    /** @param {string} url */
    register(url) {
      // delete+set if reregistering, so the URL moves to the tail (newest).
      created.delete(url);
      created.set(url, now());
      sweep();
    },
    /** Caller-initiated revoke (SW asked us to drop it). */
    /** @param {string} url */
    unregister(url) {
      created.delete(url);
    },
    /** Test/inspection only. */
    size() { return created.size; },
    has(/** @type {string} */ url) { return created.has(url); },
    _sweep() { sweep(); },
  };
}
