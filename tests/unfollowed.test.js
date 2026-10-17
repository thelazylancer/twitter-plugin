import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../lib/unfollowed.js', import.meta.url), 'utf8');
const sandbox = { window: {}, globalThis: {} };
vm.runInNewContext(src, sandbox);
const api = sandbox.window.__xvmUnfollowed;

describe('unfollowed comment labels', () => {
  it('labels only people the viewer does not follow', () => {
    expect(api.label({ following: true, followers: 5000, followingCount: 10 })).toBeNull();
    expect(api.label({ following: null, followers: 5000, followingCount: 10 })).toBeNull();
    expect(api.label({ following: false, followers: 120, followingCount: 80 }).text).toBe('未关注 · 关注 80 · 粉丝 120');
    expect(api.label({ following: false, followers: 120 }).text).toBe('未关注 · 粉丝 120');
    expect(api.label({ following: false, followers: 120 }).hasCounts).toBe(false);
    expect(api.label({ following: false, blueVerified: false }, { blueOnly: true })).toBeNull();
    expect(api.label({ following: false, blueVerified: true }, { blueOnly: true }).text).toBe('未关注');
    expect(api.label({ following: false, blueVerified: false }, { blueOnly: false }).text).toBe('未关注');
  });

  it('marks unlikely follow-back only when followers are at least 10x and 1000', () => {
    expect(api.unlikelyFollowBack(999, 10)).toBe(false);
    expect(api.unlikelyFollowBack(5000, 600)).toBe(false);
    expect(api.unlikelyFollowBack(84000, 120)).toBe(true);
    expect(api.label({ following: false, followers: 84000, followingCount: 120 }).hard).toBe(true);
    expect(api.label({ following: false, followers: 84000, followingCount: 120 }).text)
      .toBe('未关注 · 难回关 · 关注 120 · 粉丝 8.4万');
  });
});
