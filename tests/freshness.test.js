import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../lib/freshness.js', import.meta.url), 'utf8');
const sandbox = { window: {}, globalThis: {} };
vm.runInNewContext(src, sandbox);
const api = sandbox.window.__xvmFreshness;

describe('freshness tiers', () => {
  it('marks 5 minutes as hot, 10 as fresh, and 30 as warm', () => {
    expect(api.tier(5 * 60000, 5, 10, 30)).toBe('hot');
    expect(api.tier(5 * 60000 + 1, 5, 10, 30)).toBe('fresh');
    expect(api.tier(10 * 60000, 5, 10, 30)).toBe('fresh');
    expect(api.tier(10 * 60000 + 1, 5, 10, 30)).toBe('warm');
    expect(api.tier(30 * 60000, 5, 10, 30)).toBe('warm');
    expect(api.tier(30 * 60000 + 1, 5, 10, 30)).toBe('');
  });

  it('rejects missing or future timestamps', () => {
    expect(api.tier(Number.NaN, 5, 10, 30)).toBe('');
    expect(api.tier(-1, 5, 10, 30)).toBe('');
  });

  it('keeps a color only when it is a 6-digit hex', () => {
    expect(api.normalizeColor('#F7B928', '#1d9bf0')).toBe('#f7b928');
    expect(api.normalizeColor('red', '#1d9bf0')).toBe('#1d9bf0');
  });
});
