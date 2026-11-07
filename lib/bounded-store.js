// Bounded FIFO stores for long-lived content-script state.
//
// content.js accumulates tweet metrics, promoted-ad ids and the two panel
// metadata maps for the whole lifetime of an X tab (X is a SPA; there is no
// full reload between timelines). Without a cap these grow without bound on
// long scrolling sessions. This helper installs a single global that:
//   * wraps a Map or Set in a FIFO eviction policy capped at `max` entries;
//   * keeps the ORIGINAL object type (callers keep using .get/.set/.has/
//     .delete/.add/.clear — no Proxy, no new type, no changed call sites);
//   * sweeps all registered stores on a 60s interval as a backstop.
//
// The cap matches the reciprocity ledger (RECIPROCITY_POSTS_MAX = 5000) and the
// rate-filter decision cache (DECISIONS_MAX = 5000). At that size real tabs
// effectively never hit eviction; it only prevents pathological runaway growth.
//
// Eviction uses the container's OWN native insertion order (Map/Set iterate
// oldest-first), so there is no parallel bookkeeping that can drift out of
// sync. Only the growth points (.set / .add) are wrapped; deletions and clears
// only shrink and need no interception.
//
// No import/export: classic content_scripts only. Loaded by manifest.json
// BEFORE content.js so the global is ready at content.js top level.
(() => {
  const DEFAULT_MAX = 5000;
  const SWEEP_INTERVAL_MS = 60 * 1000;
  const registered = [];

  // Normalize a user-supplied cap: must be a finite number >= 1. Illegal values
  // (undefined/NaN/Infinity/0/negative/null) fall back to DEFAULT_MAX; a
  // fractional value is floored; extremely large values are accepted (they
  // simply never evict). Exposed for tests / future callers.
  function normalizeMax(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX;
    return Math.floor(n);
  }

  // Delete oldest entries until `container.size <= max`. Works for both Map and
  // Set: .keys() yields the oldest entry first, and .delete(key) removes it.
  // For a Set, .keys() yields values, which is exactly what .delete() takes.
  function enforce(container, max) {
    while (container.size > max) {
      // Use .done (not `=== undefined`) so a legitimate stored `undefined`
      // key is still evictable, while an exhausted iterator can't spin.
      const next = container.keys().next();
      if (next.done) break;
      container.delete(next.value);
    }
    return container;
  }

  // Wrap a Map: intercept .set so a fresh insertion enforces the cap. Re-setting
  // an existing key keeps its original FIFO position (Map does not reorder on
  // overwrite), matching "oldest first" semantics. Everything else is untouched.
  function boundMap(map, options) {
    if (!(map instanceof Map)) return map;
    if (map.__xvmBounded) return map;
    const max = normalizeMax(options && options.max);
    const originalSet = map.set.bind(map);
    map.set = function (key, value) {
      const result = originalSet(key, value);
      enforce(map, max);
      return result;
    };
    try {
      Object.defineProperty(map, '__xvmBounded', { value: true, configurable: true });
    } catch (_) {}
    enforce(map, max); // trim an already-oversized container at registration
    registered.push({ container: map, max });
    return map;
  }

  // Wrap a Set: intercept .add so a fresh insertion enforces the cap.
  function boundSet(set, options) {
    if (!(set instanceof Set)) return set;
    if (set.__xvmBounded) return set;
    const max = normalizeMax(options && options.max);
    const originalAdd = set.add.bind(set);
    set.add = function (value) {
      const result = originalAdd(value);
      enforce(set, max);
      return result;
    };
    try {
      Object.defineProperty(set, '__xvmBounded', { value: true, configurable: true });
    } catch (_) {}
    enforce(set, max);
    registered.push({ container: set, max });
    return set;
  }

  // Periodically re-enforce on every registered store (backstop for any write
  // path that bypassed our wrappers). Idempotent: enforce() only deletes when
  // the container is actually over its cap.
  function sweep() {
    for (const entry of registered) enforce(entry.container, entry.max);
    return registered.length;
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.__xvmBoundedStore = {
    DEFAULT_MAX,
    SWEEP_INTERVAL_MS,
    normalizeMax,
    boundMap,
    boundSet,
    sweep,
    // Test seam: how many stores are currently registered.
    get size() { return registered.length; },
  };

  if (typeof setInterval === 'function') {
    try { setInterval(sweep, SWEEP_INTERVAL_MS); } catch (_) {}
  }
})();
