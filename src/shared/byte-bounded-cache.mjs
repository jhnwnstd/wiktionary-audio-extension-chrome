/**
 * Insertion-order LRU bounded by total bytes. Enforced invariant:
 * `bytes()` == sum of entry byte costs. Internal mutation only, so no
 * external code path can desync the counter.
 *
 * `onEvict(value)` is called AFTER internal state mutates, so a throwing
 * callback can't leave `#bytes` and `#map` inconsistent — the error
 * propagates to set/delete; the cache stays intact.
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

  /** Return value or null; delete+re-insert refreshes LRU recency.
   * @param {string} url @returns {V | null} */
  peek(url) {
    const slot = this.#map.get(url);
    if (!slot) return null;
    this.#map.delete(url);
    this.#map.set(url, slot);
    return slot.v;
  }

  /**
   * Insert with declared cost. Returns false (and doesn't call onEvict)
   * if refused: NaN/negative cost, duplicate, or alone over the cap.
   * Evicts oldest entries until the new entry fits.
   * @param {string} url
   * @param {V} value
   * @param {number} byteCost
   * @returns {boolean}
   */
  set(url, value, byteCost) {
    // NaN comparisons are always false, so a bare `> maxBytes` would let
    // NaN land in `#bytes` and never recover.
    if (!Number.isFinite(byteCost) || byteCost < 0) return false;
    if (this.#map.has(url)) return false;
    if (byteCost > this.#maxBytes) return false;
    while (this.#bytes + byteCost > this.#maxBytes && this.#map.size > 0) {
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#map.get(oldestKey);
      if (!oldest) break;
      // Mutate first, callback last (throw-safe).
      this.#bytes -= oldest.b;
      this.#map.delete(oldestKey);
      if (this.#onEvict) this.#onEvict(oldest.v);
    }
    this.#map.set(url, { v: value, b: byteCost });
    this.#bytes += byteCost;
    return true;
  }

  /** Remove entry if present, calling onEvict. @param {string} url */
  delete(url) {
    const slot = this.#map.get(url);
    if (!slot) return false;
    this.#bytes -= slot.b;
    this.#map.delete(url);
    if (this.#onEvict) this.#onEvict(slot.v);
    return true;
  }
}
