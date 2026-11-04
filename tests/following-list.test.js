// The following list is built from X's own Following pagination rather than a
// direct GraphQL call, so the part worth pinning is the merge: which accounts
// count as "someone I follow", and what happens when a later page omits the
// followed_by field.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const contentJs = readFileSync(resolve(repo, 'content.js'), 'utf8');
const bridgeJs = readFileSync(resolve(repo, 'bridge.js'), 'utf8');

function sliceFunction(name) {
  const start = contentJs.indexOf(`function ${name}(`);
  expect(start, `${name} should exist`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = contentJs.indexOf('{', start); i < contentJs.length; i += 1) {
    if (contentJs[i] === '{') depth += 1;
    else if (contentJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return contentJs.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function loadCapture({ onOwnPage = true } = {}) {
  const state = { dirty: 0 };
  const ctx = {
    followingIndex: new Map(),
    followingOrderSeq: 0,
    markFollowingDirty: () => { state.dirty += 1; },
    getLoggedInHandle: () => 'me',
    isOwnFollowingPage: () => onOwnPage,
    // Mirrors the real contract: screen_name lowercased, followed_by is null
    // when the payload does not carry it.
    readAuthorRelation: (user) => {
      const legacy = user?.legacy || {};
      return {
        screenName: String(legacy.screen_name || '').toLowerCase(),
        followedBy: legacy.followed_by === undefined ? null : legacy.followed_by,
      };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${sliceFunction('captureFollowingUsers')}; this.captureFollowingUsers = captureFollowingUsers;`, ctx);
  return { ctx, state };
}

function page(...legacies) {
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [{
                entries: legacies.map((legacy) => ({
                  entryId: `user-${legacy.screen_name}`,
                  content: {
                    itemContent: { user_results: { result: { legacy } } },
                  },
                })),
              }],
            },
          },
        },
      },
    },
  };
}

describe('capturing the Following timeline', () => {
  it('records each followed account with its followed_by answer', () => {
    const { ctx, state } = loadCapture();

    ctx.captureFollowingUsers(page(
      { screen_name: 'Alice', name: 'Alice A', followed_by: false },
      { screen_name: 'Bob', name: 'Bob B', followed_by: true },
    ));

    expect([...ctx.followingIndex.keys()].sort()).toEqual(['alice', 'bob']);
    expect(ctx.followingIndex.get('alice')).toMatchObject({ name: 'Alice A', followsMe: false });
    expect(ctx.followingIndex.get('bob')).toMatchObject({ name: 'Bob B', followsMe: true });
    expect(state.dirty).toBe(1);
  });

  it('never records the account owner as someone they follow', () => {
    const { ctx } = loadCapture();

    ctx.captureFollowingUsers(page({ screen_name: 'me', name: 'Me', followed_by: false }));

    expect(ctx.followingIndex.size).toBe(0);
  });

  it('numbers rows in the order X serves them and keeps that number', () => {
    const { ctx } = loadCapture();

    ctx.captureFollowingUsers(page(
      { screen_name: 'Zoe', name: 'Zoe Z', followed_by: false },
      { screen_name: 'Alice', name: 'Alice A', followed_by: false },
    ));
    expect(ctx.followingIndex.get('zoe').order).toBe(1);
    expect(ctx.followingIndex.get('alice').order).toBe(2);

    // Re-observing a row refreshes seenAt but must not move it to the end.
    ctx.captureFollowingUsers(page({ screen_name: 'Zoe', name: 'Zoe Z', followed_by: false }));
    expect(ctx.followingIndex.get('zoe').order).toBe(1);
    expect(ctx.followingIndex.get('alice').order).toBe(2);
  });

  it('keeps the last known answer when a later page omits followed_by', () => {
    // Pagination is not guaranteed to repeat the field; overwriting with null
    // would silently move people out of the 未回关 filter.
    const { ctx } = loadCapture();

    ctx.captureFollowingUsers(page({ screen_name: 'Alice', name: 'Alice A', followed_by: false }));
    const seenAt = ctx.followingIndex.get('alice').seenAt;
    ctx.captureFollowingUsers(page({ screen_name: 'Alice', name: 'Alice A' }));

    expect(ctx.followingIndex.get('alice')).toMatchObject({ followsMe: false });
    expect(ctx.followingIndex.get('alice').seenAt).toBeGreaterThanOrEqual(seenAt);
  });

  it('ignores the who-to-follow modules that ride along in the same response', () => {
    const { ctx } = loadCapture();

    ctx.captureFollowingUsers({
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [{
                  entries: [
                    { entryId: 'user-alice', content: { itemContent: { user_results: { result: { legacy: { screen_name: 'Alice', followed_by: false } } } } } },
                    { entryId: 'who-to-follow-1', content: { itemContent: { user_results: { result: { legacy: { screen_name: 'Mallory', followed_by: false } } } } } },
                  ],
                }],
              },
            },
          },
        },
      },
    });

    expect([...ctx.followingIndex.keys()]).toEqual(['alice']);
  });

  it('does nothing while looking at someone else’s Following page', () => {
    // The network hook is global; only my own list may be filed as mine.
    const { ctx } = loadCapture({ onOwnPage: false });

    ctx.captureFollowingUsers(page({ screen_name: 'Alice', name: 'Alice A', followed_by: false }));

    expect(ctx.followingIndex.size).toBe(0);
  });

  it('stays quiet when a re-scan sees the same facts', () => {
    const { ctx, state } = loadCapture();

    ctx.captureFollowingUsers(page({ screen_name: 'Alice', name: 'Alice A', followed_by: false }));
    ctx.captureFollowingUsers(page({ screen_name: 'Alice', name: 'Alice A', followed_by: false }));

    expect(state.dirty).toBe(1);
  });
});

describe('the following panel', () => {
  function loadRows(index, filter = 'all', query = '') {
    const ctx = { followingIndex: index, followingFilter: filter, followingQuery: query };
    vm.createContext(ctx);
    vm.runInContext(`${sliceFunction('followingRows')}; this.followingRows = followingRows;`, ctx);
    return ctx.followingRows();
  }

  const index = new Map([
    ['alice', { name: 'Alice A', followsMe: false, seenAt: 1 }],
    ['bob', { name: 'Bob B', followsMe: true, seenAt: 2 }],
    ['carol', { name: 'Carol C', followsMe: null, seenAt: 3 }],
  ]);

  it('defaults to the people who do not follow back', () => {
    expect(loadRows(index, 'no').map(([handle]) => handle)).toEqual(['alice']);
  });

  it('separates the three states instead of treating unknown as no', () => {
    expect(loadRows(index, 'yes').map(([handle]) => handle)).toEqual(['bob']);
    expect(loadRows(index, 'all').map(([handle]) => handle)).toEqual(['alice', 'bob', 'carol']);
  });

  it('keeps the served order instead of sorting by handle', () => {
    const ordered = new Map([
      ['zoe', { name: 'Zoe Z', followsMe: false, seenAt: 1, order: 1 }],
      ['alice', { name: 'Alice A', followsMe: false, seenAt: 2, order: 2 }],
    ]);
    expect(loadRows(ordered).map(([handle]) => handle)).toEqual(['zoe', 'alice']);
  });

  it('searches handle and display name, case-insensitively', () => {
    expect(loadRows(index, 'all', 'BOB').map(([handle]) => handle)).toEqual(['bob']);
    expect(loadRows(index, 'all', 'carol').map(([handle]) => handle)).toEqual(['carol']);
    expect(loadRows(index, 'all', 'nobody')).toEqual([]);
  });
});

describe('finding the scan button', () => {
  it('offers a chip on both of the account owner own pages', () => {
    // The first cut was reachable only by knowing the URL; that is the whole
    // reason this exists.
    expect(contentJs).toContain('function isOwnProfilePage() {');
    expect(contentJs).toContain('const canOpen = isOwnFollowingPage() || isOwnProfilePage();');
    expect(contentJs).toContain("if (launcher) launcher.style.display = canOpen ? 'flex' : 'none';");
  });

  it('opens itself when the Following page loads, and stays closed once dismissed', () => {
    expect(contentJs).toContain('let followingOpen = false;');
    expect(contentJs).toContain('if (isOwnFollowingPage() && followingAutoOpenedPath !== window.location.pathname) {');
    expect(contentJs).toContain("el.querySelector('.xvm-fp-close')?.addEventListener('click', () => {");
    expect(contentJs).toContain('followingOpen = false;');
  });

  it('renders before the rest of the tick, so a failure there cannot hide it', () => {
    const start = contentJs.indexOf('// First, and on its own: anything above it that throws');
    expect(start).toBeGreaterThan(-1);
    const tick = contentJs.slice(start, contentJs.indexOf('}, 2000);', start));
    expect(tick.indexOf('renderFollowingPanel();')).toBeGreaterThan(-1);
    expect(tick.indexOf('renderFollowingPanel();')).toBeLessThan(tick.indexOf('renderCommentBoard();'));
  });
});

describe('panel states', () => {
  it('tells "nothing scanned" apart from "this filter has no matches"', () => {
    expect(contentJs).toContain("i18n('contentFollowingEmptyFilter')");
    expect(contentJs).toContain('const message = followingIndex.size');
    expect(contentJs).toContain("? i18n('contentFollowingEmptyFilter')");
    expect(contentJs).toContain(": i18n('contentFollowingEmpty');");
  });

  it('draws its icons rather than leaning on unicode glyphs', () => {
    // The panel had text buttons and a stray ×; both are authored SVG now.
    expect(contentJs).toContain('class="xvm-fp-scan-icon"');
    expect(contentJs).toContain('class="xvm-fp-search-icon"');
    expect(contentJs).toContain('class="xvm-fp-empty-icon"');
    expect(contentJs).toContain('class="xvm-fp-launcher-icon"');
  });

  it('marks the scan button busy while the scan runs', () => {
    expect(contentJs).toContain('const spinning = followingScanRunning && !followingScanPaused;');
    expect(contentJs).toContain("scanBtn.classList.toggle('is-scanning', spinning);");
    expect(contentJs).toContain("scanBtn.setAttribute('aria-busy', spinning ? 'true' : 'false');");
  });

  it('pauses in place, resumes, and keeps the time budget for scanning only', () => {
    // A pause must not scroll, request, or burn the eight-minute budget.
    expect(contentJs).toContain('let followingScanPaused = false;');
    expect(contentJs).toContain('if (followingScanPaused) {');
    expect(contentJs).toContain('await sleep(400);');
    expect(contentJs).toContain('if (pausedAt) {');
    expect(contentJs).toContain('deadline += Date.now() - pausedAt;');
    expect(contentJs).toContain("followingScanPaused = !followingScanPaused;");
    // Stopping is a separate control, so pausing never ends the run.
    expect(contentJs).toContain('function stopFollowingScan() {');
    expect(contentJs).toContain("el.querySelector('.xvm-fp-stop')?.addEventListener('click', () => stopFollowingScan());");
  });

  it('cannot keep scrolling once the panel is closed or the page changes', () => {
    // Closing the panel used to leave the page scrolling with no visible stop.
    expect(contentJs).toContain('if (followingScanRunning) followingScanPaused = true;');
    // The scroll loop is only meaningful on the owner's own Following page.
    expect(contentJs).toContain('while (Date.now() < deadline && followingScanRunning && isOwnFollowingPage()) {');
  });

  it('dates old records instead of guessing who was unfollowed', () => {
    // A scan only proof-reads the pages X served, so a missing handle is not
    // evidence of an unfollow. Old rows are dated rather than deleted.
    expect(contentJs).toContain('const FOLLOWING_RECORD_STALE_MS = 7 * 24 * 60 * 60 * 1000;');
    expect(contentJs).toContain('Date.now() - entry.seenAt > FOLLOWING_RECORD_STALE_MS');
    expect(contentJs).toContain("i18n('contentFollowingLastSeen')");
    expect(contentJs).toContain('class="xvm-fp-seen"');
    expect(contentJs).toContain("class=\"xvm-fp-row${stale ? ' is-stale' : ''}\"");
    expect(bridgeJs).toContain("'contentFollowingLastSeen'");
  });

  it('keeps the filter state on the pressed filter for assistive tech', () => {
    expect(contentJs).toContain("btn.setAttribute('aria-pressed', active ? 'true' : 'false');");
  });

  it('does not keep a download action the list cannot act on', () => {
    expect(contentJs).not.toContain('exportFollowingCsv');
    expect(contentJs).not.toContain('xvm-fp-export');
  });
});

describe('rebuilding on scan', () => {
  function loadRebuild() {
    const ctx = {
      followingIndex: new Map([['alice', { name: 'Alice A', followsMe: false, seenAt: 1 }]]),
      followingOrderSeq: 7,
      followingSaveTimer: 0,
      followingHydrationBlocked: false,
      window: { postMessage: (msg) => ctx.sent.push(msg) },
      clearTimeout,
    };
    ctx.sent = [];
    vm.createContext(ctx);
    vm.runInContext(`${sliceFunction('beginFollowingRebuild')}; this.beginFollowingRebuild = beginFollowingRebuild;`, ctx);
    return ctx;
  }

  it('empties the list and asks the bridge to drop the stored copy', () => {
    const ctx = loadRebuild();
    ctx.followingSaveTimer = 1;
    ctx.beginFollowingRebuild();
    expect(ctx.followingIndex.size).toBe(0);
    expect(ctx.followingOrderSeq).toBe(0);
    expect(ctx.followingHydrationBlocked).toBe(true);
    expect(ctx.followingSaveTimer).toBe(0);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({ type: 'XVM_FOLLOWING_CLEAR' });
    expect(typeof ctx.sent[0].clearedAt).toBe('number');
  });

  it('ignores the load reply that was already in flight', () => {
    const ctx = {
      followingIndex: new Map(),
      followingOrderSeq: 0,
      followingHydrationBlocked: true,
      markFollowingDirty: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(`${sliceFunction('hydrateFollowingIndex')}; this.hydrateFollowingIndex = hydrateFollowingIndex;`, ctx);
    ctx.hydrateFollowingIndex({ alice: { name: 'Alice A', followsMe: false, seenAt: 1 } });
    expect(ctx.followingIndex.size).toBe(0);
  });

  it('keeps stored positions and numbers legacy rows after them', () => {
    const ctx = {
      followingIndex: new Map(),
      followingOrderSeq: 0,
      followingHydrationBlocked: false,
      markFollowingDirty: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(`${sliceFunction('hydrateFollowingIndex')}; this.hydrateFollowingIndex = hydrateFollowingIndex;`, ctx);
    ctx.hydrateFollowingIndex({
      bob: { name: 'Bob B', followsMe: true, seenAt: 1, order: 5 },
      alice: { name: 'Alice A', followsMe: false, seenAt: 2 },
    });
    expect(ctx.followingIndex.get('bob').order).toBe(5);
    expect(ctx.followingIndex.get('alice').order).toBe(6);
    expect(ctx.followingOrderSeq).toBe(6);
  });
});

describe('scan safety rails', () => {
  it('paces the scroll instead of hammering the endpoint', () => {
    expect(contentJs).toContain('await sleep(1500 + Math.random() * 900);');
    expect(contentJs).toContain('const FOLLOWING_SCAN_MAX_MS = 8 * 60 * 1000;');
    expect(contentJs).toContain('const FOLLOWING_SCAN_IDLE_ROUNDS = 6;');
  });

  it('only starts on the account owner own Following page', () => {
    expect(contentJs).toContain("const m = /^\\/([^/]+)\\/following\\/?$/.exec(window.location.pathname);");
    expect(contentJs).toContain("return !!m && m[1].toLowerCase() === me;");
    expect(contentJs).toContain("window.location.href = `https://x.com/${encodeURIComponent(me)}/following`;");
  });

  it('survives the navigation the scan needs', () => {
    expect(contentJs).toContain("const FOLLOWING_SCAN_PENDING_KEY = 'xvmFollowingScanPending';");
    expect(contentJs).toContain("sessionStorage.setItem(FOLLOWING_SCAN_PENDING_KEY, '1')");
    expect(contentJs).toContain("if (isOwnFollowingPage()) runFollowingScan();");
  });

  it('rebuilds from an empty index on every scan instead of extending the old one', () => {
    const start = contentJs.indexOf('function startFollowingScan(');
    expect(start).toBeGreaterThan(-1);
    const scan = contentJs.slice(start, contentJs.indexOf('function beginFollowingRebuild(', start));
    expect(scan).toContain('beginFollowingRebuild();');
    expect(scan).toContain('window.location.reload();');

    const rebuildStart = contentJs.indexOf('function beginFollowingRebuild(');
    const rebuild = contentJs.slice(rebuildStart, contentJs.indexOf('// A scan spans a full page navigation', rebuildStart));
    expect(rebuild).toContain('followingIndex.clear();');
    expect(rebuild).toContain('followingHydrationBlocked = true;');
    expect(rebuild).toContain("type: 'XVM_FOLLOWING_CLEAR'");
    // A delayed load reply must not put the replaced rows back.
    expect(contentJs).toContain('if (followingHydrationBlocked) return;');
    // The rebuild starts at the top because X may restore the old scroll.
    expect(contentJs).toContain('window.scrollTo(0, 0);');
    expect(bridgeJs).toContain("type === 'XVM_FOLLOWING_CLEAR'");
    expect(bridgeJs).toContain("chrome.storage.local.remove('xvmFollowingIndex')");
    expect(bridgeJs).toContain('if ((Number(event.data.savedAt) || 0) < followingClearedAt) return;');
  });

  it('never touches unfollow', () => {
    // The panel reads and exports; it must not grow a write action.
    const start = contentJs.indexOf('// ── Following list');
    const block = contentJs.slice(start, contentJs.indexOf('// Ranks whatever is mounted.', start));
    expect(block.length).toBeGreaterThan(1000);
    // Word boundary matters: runFollowingScan contains "unFollow" as a
    // substring, so a loose match would flag the scan itself.
    expect(block).not.toMatch(/\bunfollow\b|destroy|\.delete\(/i);
  });

  it('counts only rows that are actually accounts the user follows', () => {
    expect(contentJs).toContain("entry.entryId.startsWith('user-')");
    expect(contentJs).toContain('if (!isOwnFollowingPage()) return;');
  });

  it('caps what the bridge will store', () => {
    expect(bridgeJs).toContain('const FOLLOWING_MAX_ENTRIES = 20000;');
    expect(bridgeJs).toContain("type === 'XVM_FOLLOWING_SAVE'");
    expect(bridgeJs).toContain("type === 'XVM_FOLLOWING_REQUEST'");
  });
});
