// Per-tab mode cache, DI'd for testability. Contract:
//   1. First call awaits get(); subsequent calls return cached value.
//   2. Concurrent calls share the in-flight Promise (no double-fetch).
//   3. Transient get() rejection returns 'original' but does NOT cache;
//      next call retries.
//   4. onChanged invalidates the cache when popup writes a new mode.
//   5. Return value is always 'original' | 'convert' | 'both'; unknown
//      storage values coerce to 'original'.
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
        // Default for THIS call; do not poison cachedMode.
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
