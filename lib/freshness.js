// Age buckets for visible original posts and comments. The page stamps a card
// once; it does not recolor that same node as minutes pass.
(() => {
  function normalizeMinutes(value, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(24 * 60, n);
  }

  function normalizeColor(value, fallback) {
    const raw = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : fallback;
  }

  function tier(ageMs, hotMinutes, freshMinutes, warmMinutes) {
    if (!Number.isFinite(ageMs) || ageMs < 0) return '';
    const hot = normalizeMinutes(hotMinutes, 5);
    const fresh = Math.max(normalizeMinutes(freshMinutes, 10), hot);
    const warm = Math.max(normalizeMinutes(warmMinutes, 30), fresh);
    if (ageMs <= hot * 60000) return 'hot';
    if (ageMs <= fresh * 60000) return 'fresh';
    if (ageMs <= warm * 60000) return 'warm';
    return '';
  }

  function wash(hex, alpha = 0.12) {
    const color = normalizeColor(hex, '#1d9bf0');
    const n = Number.parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const api = { tier, normalizeMinutes, normalizeColor, wash };
  if (typeof window !== 'undefined') window.__xvmFreshness = api;
  if (typeof globalThis !== 'undefined') globalThis.__xvmFreshness = api;
})();
