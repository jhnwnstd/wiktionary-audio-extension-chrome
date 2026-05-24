// Factory for the per-tab mode cache. Dependency-injected so the same
// logic can run against `chrome.storage.sync` in the browser and against
// a fake in Node tests. The contract under test:
//
//   1. First call resolves by awaiting the injected `get` and caches the
//      result, so subsequent calls return synchronously.
//   2. A concurrent second call during the first's await shares the same
//      Promise (no double-fetch).
//   3. A transient `get` rejection returns 'original' for the failing
//      call but does NOT populate the cache; the next call retries.
//   4. The `onChanged` listener invalidates the cache when the user
//      changes their mode in the popup.
//   5. The returned value is always one of 'original' | 'convert' | 'both';
//      any other value coming back from storage gets coerced to 'original'.
//
/** @typedef {'original' | 'convert' | 'both'} Mode */

/**
 * @param {object} deps
 * @param {(defaults: { mode: Mode }) => Promise<{ mode?: unknown }>} deps.get
 * @param {((cb: (changes: any, area: string) => void) => void) | null} [deps.onChanged]
 * @returns {() => Promise<Mode>}
 */
export function createModeCache({ get, onChanged = null }) {
  /** @type {Mode | null} */
  let cachedMode = null;
  /** @type {Promise<Mode> | null} */
  let cachedModePromise = null;

  if (onChanged) {
    onChanged((changes, area) => {
      if (area !== 'sync') return;
      if (changes && changes.mode) {
        cachedMode = null;
        cachedModePromise = null;
      }
    });
  }

  return async function getMode() {
    if (cachedMode) return cachedMode;
    if (cachedModePromise) return cachedModePromise;
    cachedModePromise = (async () => {
      try {
        const got = await get({ mode: 'original' });
        const raw = got && typeof got.mode === 'string' ? got.mode : 'original';
        const m = raw === 'convert' || raw === 'both' ? raw : 'original';
        cachedMode = m;
        return m;
      } catch {
        // Default for this call so the download stays usable, but do NOT
        // populate cachedMode. Otherwise one transient failure would pin
        // the user to Original for the entire page session even after
        // their real preference came back online.
        return 'original';
      }
    })();
    try {
      return await cachedModePromise;
    } finally {
      cachedModePromise = null;
    }
  };
}
