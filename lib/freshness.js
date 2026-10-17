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

  function tier(ageMs, freshMinutes, warmMinutes) {
    if (!Number.isFinite(ageMs) || ageMs < 0) return '';
    const freshMs = normalizeMinutes(freshMinutes, 10) * 60000;
    const warmMinutesNorm = normalizeMinutes(warmMinutes, 30);
    const warmMs = Math.max(warmMinutesNorm, normalizeMinutes(freshMinutes, 10)) * 60000;
    if (ageMs <= freshMs) return 'fresh';
    if (ageMs <= warmMs) return 'warm';
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
