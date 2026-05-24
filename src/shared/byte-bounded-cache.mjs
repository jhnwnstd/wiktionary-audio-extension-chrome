/**
 * Insertion-order LRU bounded by total bytes (not item count). The single
 * invariant being structurally enforced -- `bytes()` equals the sum of all
 * entry byte costs -- used to be five hand-coordinated mutations across
 * peek/add/dismiss; now no path outside this class can desync the counter.
 *
 * Eviction calls the optional `onEvict(value)` callback before removing
 * the entry, so a transcoded-cache instance can revoke its blob URL
 * automatically. A raw-bytes instance passes no callback (ArrayBuffers
 * are GC'd when references drop).
 *
 * Entries are wrapped internally as {v, b} so a single API works for both
 * ArrayBuffer payloads and richer structs.
 *
 * @template V
 */
export class ByteBoundedCache {
  /** @type {Map<string, { v: V, b: number }>} */
  #map = new Map();
  #bytes = 0;
  #maxBytes;
  /** @type {((value: V) => void) | null} */
  #onEvict;

  /**
   * @param {number} maxBytes
   * @param {((value: V) => void) | null} [onEvict]
   */
  constructor(maxBytes, onEvict = null) {
    this.#maxBytes = maxBytes;
    this.#onEvict = onEvict;
  }

  size() { return this.#map.size; }
  bytes() { return this.#bytes; }
  /** @param {string} url */
  has(url) { return this.#map.has(url); }
  keys() { return this.#map.keys(); }

  /**
   * Return the value for `url` (refreshing recency) or null. Delete +
   * re-insert moves the URL to the tail so eviction (which pops the head)
   * targets older entries first.
   * @param {string} url
   * @returns {V | null}
   */
  peek(url) {
    const slot = this.#map.get(url);
    if (!slot) return null;
    this.#map.delete(url);
    this.#map.set(url, slot);
    return slot.v;
  }

  /**
   * Insert `value` with declared `byteCost`. Returns true on insert, false
   * if refused (already present, or alone larger than the cap). On refusal
   * the caller still owns the value and onEvict is NOT called for it.
   * Evicts oldest entries until the new entry fits.
   * @param {string} url
   * @param {V} value
   * @param {number} byteCost
   * @returns {boolean}
   */
  set(url, value, byteCost) {
    if (this.#map.has(url)) return false;
    if (byteCost > this.#maxBytes) return false;
    while (this.#bytes + byteCost > this.#maxBytes && this.#map.size > 0) {
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#map.get(oldestKey);
      if (!oldest) break;
      this.#bytes -= oldest.b;
      if (this.#onEvict) this.#onEvict(oldest.v);
      this.#map.delete(oldestKey);
    }
    this.#map.set(url, { v: value, b: byteCost });
    this.#bytes += byteCost;
    return true;
  }

  /**
   * Remove `url`'s entry if present (calling onEvict on the value).
   * @param {string} url
   * @returns {boolean}  whether an entry was removed
   */
  delete(url) {
    const slot = this.#map.get(url);
    if (!slot) return false;
    this.#bytes -= slot.b;
    if (this.#onEvict) this.#onEvict(slot.v);
    this.#map.delete(url);
    return true;
  }
}
