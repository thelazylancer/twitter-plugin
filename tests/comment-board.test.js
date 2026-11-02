// The comment hotspot panel ranks the replies under the open status page by
// engagement, so the busiest threads are the easiest place to find people to
// follow back. Ordering is deliberately lexicographic — each key is something
// the user can see in the panel, unlike a blended score.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const contentJs = readFileSync(resolve(here, '..', 'content.js'), 'utf8');
const bridgeJs = readFileSync(resolve(here, '..', 'bridge.js'), 'utf8');
const styles = readFileSync(resolve(here, '..', 'styles.css'), 'utf8');

// Pull the pure helpers out of the monolith and run them for real.
function loadHelpers() {
  const names = ['collectCommentRanked'];
  const ctx = {};
  for (const name of names) {
    const start = contentJs.indexOf(`function ${name}(`);
    expect(start, `${name} should exist`).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = contentJs.indexOf('{', start); i < contentJs.length; i += 1) {
      if (contentJs[i] === '{') depth += 1;
      else if (contentJs[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    vm.runInNewContext(`${contentJs.slice(start, end)}; this.${name} = ${name};`, ctx);
  }
  return ctx;
}

// The scoring block is a run of top-level function declarations plus a few
// constants. Slice from the first constant to the end of cbStatusScore and run
// the whole thing, so the tests see the shipped weights and half-lives.
function loadScoring() {
  const start = contentJs.indexOf('const CB_FEED_HALF_LIFE_HOURS');
  const endMarker = 'function cbStatusScore(entry) {';
  const endStart = contentJs.indexOf(endMarker);
  expect(start, 'scoring block should exist').toBeGreaterThan(-1);
  expect(endStart, 'cbStatusScore should exist').toBeGreaterThan(-1);
  let depth = 0;
  let end = endStart;
  for (let i = contentJs.indexOf('{', endStart); i < contentJs.length; i += 1) {
    if (contentJs[i] === '{') depth += 1;
    else if (contentJs[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const src = contentJs.slice(start, end);
  const ctx = {};
  vm.runInNewContext(
    `${src}; this.cbFeedScore = cbFeedScore; this.cbStatusScore = cbStatusScore;`
    + ' this.cbFollowRatio = cbFollowRatio; this.cbRecency = cbRecency;'
    + ' this.cbDisplayRatio = cbDisplayRatio; this.cbRatioIsHot = cbRatioIsHot;'
    + ' this.cbOneRowPerAuthor = cbOneRowPerAuthor;'
    + ' this.cbReplierIsRecent = cbReplierIsRecent;'
    + ' this.cbInteractionKinds = cbInteractionKinds;'
    + ' this.CB_RATIO_HOT = CB_RATIO_HOT;'
    + ' this.CB_REPLIER_TTL_MS = CB_REPLIER_TTL_MS;'
    + ' this.CB_INTERACTION_TTL_MS = CB_INTERACTION_TTL_MS;'
    + ' this.CB_FEED_REPLIER_BOOST = CB_FEED_REPLIER_BOOST;',
    ctx,
  );
  return ctx;
}

// Run the shipped reply-attribution helpers with a stubbed payload store, so
// the "only my own post counts" rule is exercised, not just grepped for.
function loadReplierObserver() {
  const calls = [];
  const ctx = {
    getLoggedInHandle: () => 'me',
    tweetDataStore: new Map(),
    getStatusIdFromLocation: () => '',
    isOwnStatusPage: () => false,
    recordInteraction: (handle, kind, at) => calls.push([handle, kind, at]),
  };
  const sliceFunction = (name) => {
    const start = contentJs.indexOf(`function ${name}(`);
    expect(start, `${name} should exist`).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = contentJs.indexOf('{', start); i < contentJs.length; i += 1) {
      if (contentJs[i] === '{') depth += 1;
      else if (contentJs[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    return contentJs.slice(start, end);
  };
  vm.runInNewContext(`
    ${sliceFunction('replyRootId')}
    ${sliceFunction('ownReplyRootId')}
    ${sliceFunction('isReplyUnderMyOwnPost')}
    ${sliceFunction('observeReplierFromPayload')}
    this.observe = observeReplierFromPayload;
  `, ctx);
  ctx.calls = calls;
  return ctx;
}

describe('comment board scope', () => {
  it('ranks every mounted tweet, not just replies', () => {
    // The feed side of the panel is "which post drew the most replies", so a
    // top-level post is a candidate exactly like a reply is. Filtering on
    // inReplyToStatusId was a misreading of the requirement.
    expect(contentJs).not.toContain('function isCommentData(');
    expect(contentJs).not.toContain('if (!isCommentData(data)) continue;');
    expect(contentJs).toContain('if (!data) continue;');
  });

  it('uses the same candidate set as the leaderboard', () => {
    expect(contentJs).toContain('if (isLeaderboardArticleHidden(article)) continue;');
    expect(contentJs).toContain('if (promotedTweetIds.has(id) || isPromotedArticle(article)) continue;');
  });

  it('drops yourself and people you already follow on a status page', () => {
    // In a thread the panel is a list of people to act on; a row you cannot
    // follow is a wasted slot.
    expect(contentJs).toContain('if (selfHandle && author && author === selfHandle) continue;');
    expect(contentJs).toContain('if (relation?.following === true) continue;');
  });

  it('switches scoring by page type', () => {
    expect(contentJs).toContain('function isCommentBoardStatusPage()');
    expect(contentJs).toContain("entry.score = statusPage ? cbStatusScore(entry) : cbFeedScore(entry);");
  });

  it('reads blue membership through the shared resolver', () => {
    // The 未关注 chip and this panel must never disagree about who is a
    // member, so both go through unfollowedApi().isBlueMember.
    expect(contentJs).toContain('unfollowedApi().isBlueMember(relation, blueVerifiedFromDom(article))');
    expect(contentJs).toContain("const blue = entry.blueVerified === true ? 1 : 0;");
  });
});

describe('comment ranking', () => {
  // Pull the real scoring helpers out of content.js rather than reimplementing
  // them here, so the weights and the decay curve are exercised as shipped.
  const ctx = loadScoring();
  const { cbFeedScore, cbStatusScore, cbFollowRatio, cbRecency, cbDisplayRatio, cbRatioIsHot, cbOneRowPerAuthor, cbReplierIsRecent, CB_RATIO_HOT, CB_REPLIER_TTL_MS, CB_FEED_REPLIER_BOOST } = ctx;
  const hoursAgo = (h) => Date.now() - h * 3_600_000;

  describe('feed / search', () => {
    it('puts a busy fresh post above an older post with more replies', () => {
      // The whole point on the feed is "where is the crowd right now". A
      // 3-day-old post with 500 replies is a dead room.
      const fresh = cbFeedScore({ replies: 80, createdAtMs: hoursAgo(2) });
      const stale = cbFeedScore({ replies: 500, createdAtMs: hoursAgo(72) });
      expect(fresh).toBeGreaterThan(stale);
    });

    it('puts a busier post above a quieter one of the same age', () => {
      const busy = cbFeedScore({ replies: 50, createdAtMs: hoursAgo(1) });
      const quiet = cbFeedScore({ replies: 5, createdAtMs: hoursAgo(1) });
      expect(busy).toBeGreaterThan(quiet);
    });

    it('scores an unknown timestamp at zero rather than assuming it is fresh', () => {
      expect(cbFeedScore({ replies: 500, createdAtMs: 0 })).toBe(0);
    });

    it('halves the score every six hours', () => {
      const now = cbRecency(hoursAgo(0), 6);
      const six = cbRecency(hoursAgo(6), 6);
      expect(now).toBeCloseTo(1, 5);
      expect(six).toBeCloseTo(0.5, 5);
    });
  });

  describe('someone who just replied to one of your own posts', () => {
    it('expires exactly at the two-hour mark', () => {
      // Short on purpose: this describes a browsing session, not a
      // relationship, so the boundary is the whole feature.
      expect(CB_REPLIER_TTL_MS).toBe(2 * 60 * 60 * 1000);
      const now = 1_700_000_000_000;
      expect(cbReplierIsRecent(now - CB_REPLIER_TTL_MS + 1, now)).toBe(true);
      expect(cbReplierIsRecent(now - CB_REPLIER_TTL_MS, now)).toBe(false);
      expect(cbReplierIsRecent(now - CB_REPLIER_TTL_MS - 1, now)).toBe(false);
    });

    it('treats a missing timestamp as not recent', () => {
      // A payload X never timestamped must not read as "just now", or every
      // unreadable reply would sit at the top of the feed panel forever.
      const now = Date.now();
      expect(cbReplierIsRecent(0, now)).toBe(false);
      expect(cbReplierIsRecent(undefined, now)).toBe(false);
      expect(cbReplierIsRecent(NaN, now)).toBe(false);
    });

    it('lifts the post in feed mode', () => {
      const base = { replies: 40, createdAtMs: hoursAgo(1) };
      expect(cbFeedScore({ ...base, repliedYou: true }))
        .toBeGreaterThan(cbFeedScore({ ...base, repliedYou: false }));
    });

    it('is a nudge, not a takeover', () => {
      // 40 replies x 1.6 = 64, so it edges past 60 and still loses to 100. The
      // feed panel is about where the crowd is; this only breaks near-ties.
      const busy = { createdAtMs: hoursAgo(1) };
      expect(cbFeedScore({ ...busy, replies: 40, repliedYou: true }))
        .toBeGreaterThan(cbFeedScore({ ...busy, replies: 60, repliedYou: false }));
      expect(cbFeedScore({ ...busy, replies: 40, repliedYou: true }))
        .toBeLessThan(cbFeedScore({ ...busy, replies: 100, repliedYou: false }));
      expect(CB_FEED_REPLIER_BOOST).toBeGreaterThan(1);
    });

    it('does not leak into the status score', () => {
      // 互关机会 was deliberately left alone: it already carries four terms and
      // an invariant behind them, and rebalancing is a separate decision. This
      // pins that the flag is inert there rather than quietly scoring.
      const base = { followedBy: false, followingCount: 1000, followers: 1000, createdAtMs: hoursAgo(1) };
      expect(cbStatusScore({ ...base, repliedYou: true }))
        .toBe(cbStatusScore({ ...base, repliedYou: false }));
    });
  });

  describe('status page', () => {
    it('ranks someone who already follows you above a bigger account who does not', () => {
      // followedBy is the only certain follow-back, so it carries the most
      // weight — even against a much friendlier ratio.
      const followsMe = cbStatusScore({
        followedBy: true, followingCount: 300, followers: 5000, createdAtMs: hoursAgo(1),
      });
      const stranger = cbStatusScore({
        followedBy: false, followingCount: 4000, followers: 800, createdAtMs: hoursAgo(1),
      });
      expect(followsMe).toBeGreaterThan(stranger);
    });

    it('lets no combination of the other signals outrank "follows you"', () => {
      // The weight is above the sum of the other three, so this is structural
      // rather than a lucky set of inputs.
      const followsMeWorstCase = cbStatusScore({
        followedBy: true, followingCount: 0, followers: 1_000_000,
        blueVerified: false, createdAtMs: hoursAgo(200),
      });
      const strangerBestCase = cbStatusScore({
        followedBy: false, followingCount: 1_000_000, followers: 100,
        blueVerified: true, createdAtMs: hoursAgo(0),
      });
      expect(followsMeWorstCase).toBeGreaterThan(strangerBestCase);
    });

    it('prefers a high following/followers ratio over a large follower count', () => {
      // 5k following / 800 followers beats 200 following / 100k followers:
      // the first follows liberally, the second almost never follows back.
      const liberal = cbStatusScore({
        followedBy: false, followingCount: 5000, followers: 800, createdAtMs: hoursAgo(1),
      });
      const celebrity = cbStatusScore({
        followedBy: false, followingCount: 200, followers: 100_000, createdAtMs: hoursAgo(1),
      });
      expect(liberal).toBeGreaterThan(celebrity);
    });

    it('prefers a recent reply over an old one, all else equal', () => {
      const base = { followedBy: false, followingCount: 1000, followers: 1000 };
      const recent = cbStatusScore({ ...base, createdAtMs: hoursAgo(1) });
      const old = cbStatusScore({ ...base, createdAtMs: hoursAgo(48) });
      expect(recent).toBeGreaterThan(old);
    });

    it('prefers a blue member over a non-member, all else equal', () => {
      // Paid accounts are active users rather than lurkers, so membership is
      // its own weighted term.
      const base = { followedBy: false, followingCount: 1000, followers: 1000, createdAtMs: hoursAgo(1) };
      const blue = cbStatusScore({ ...base, blueVerified: true });
      const plain = cbStatusScore({ ...base, blueVerified: false });
      expect(blue).toBeGreaterThan(plain);
    });

    it('does not award the blue term when membership is unknown', () => {
      // null means "X never told us"; it must score the same as a confirmed
      // non-member rather than earning a free boost.
      const base = { followedBy: false, followingCount: 1000, followers: 1000, createdAtMs: hoursAgo(1) };
      expect(cbStatusScore({ ...base, blueVerified: null }))
        .toBe(cbStatusScore({ ...base, blueVerified: false }));
    });

    it('floors the ratio denominator so a zero-follower account cannot win outright', () => {
      // Without the floor this would be Infinity.
      expect(cbFollowRatio(1000, 0)).toBe(1);
      expect(cbFollowRatio(1000, 100)).toBe(1);
      expect(cbFollowRatio(100, 1000)).toBeCloseTo(0.02, 5);
    });

    it('scores an unknown ratio as zero, not as a perfect one', () => {
      expect(cbFollowRatio(-1, -1)).toBe(0);
      expect(cbFollowRatio(undefined, 500)).toBe(0);
    });
  });

  describe('likely follow-back marker', () => {
    it('marks the ratio at the threshold, not just above it', () => {
      expect(CB_RATIO_HOT).toBe(0.9);
      expect(cbRatioIsHot(0.9)).toBe(true);
      expect(cbRatioIsHot(1.4)).toBe(true);
      expect(cbRatioIsHot(0.8)).toBe(false);
    });

    it('never prints 0.9x without the marker', () => {
      // 890/1000 is a raw 0.89, which the cell rounds to "0.9x". Deciding the
      // highlight on the raw value would leave that cell reading 0.9x unmarked
      // — indistinguishable from a bug to anyone looking at the panel.
      const shown = cbDisplayRatio({ followingCount: 890, followers: 1000 });
      expect(shown.toFixed(1)).toBe('0.9');
      expect(cbRatioIsHot(shown)).toBe(true);
      // And the converse: a cell that reads 0.8x is never filled.
      expect(cbRatioIsHot(cbDisplayRatio({ followingCount: 849, followers: 1000 }))).toBe(false);
    });

    it('prints the ratio it scored, floor included', () => {
      // 90 following / 50 followers is a raw 1.8, but the panel shows the
      // floored 0.9 it actually ranked on. The marker follows the number on
      // screen, so a reader can always re-derive why a row is highlighted.
      expect(cbDisplayRatio({ followingCount: 90, followers: 50 })).toBeCloseTo(0.9, 5);
      expect(cbDisplayRatio({ followingCount: 90, followers: 100 })).toBeCloseTo(0.9, 5);
    });

    it('returns null rather than the -1 sentinel for unknown counts', () => {
      // The counts are stored as -1 when X never told us. -1 is finite, so
      // without the guard this would render "-0.0x" and mark it hot.
      expect(cbDisplayRatio({ followingCount: -1, followers: 1000 })).toBeNull();
      expect(cbDisplayRatio({ followingCount: 1000, followers: -1 })).toBeNull();
      expect(cbDisplayRatio({})).toBeNull();
      expect(cbRatioIsHot(null)).toBe(false);
    });

    it('renders the filled pill only when the ratio clears the bar', () => {
      expect(contentJs).toContain('const hot = cbRatioIsHot(ratio);');
      expect(contentJs).toContain("${hot ? ' xvm-cb-ratio--hot' : ''}");
      expect(styles).toContain('.xvm-cb .xvm-cb-ratio--hot {');
      expect(styles).toContain('.xvm-lb[data-theme="dark"] .xvm-cb .xvm-cb-ratio--hot');
    });
  });

  describe('one row per person', () => {
    const row = (authorHandle, createdAtMs, score = 0) => ({ authorHandle, createdAtMs, score });

    it('keeps the author\'s newest reply, not their best-scoring one', () => {
      // The panel is a list of people; which of their replies it points at
      // matters less than pointing at the most recent thing they said. Keeping
      // the top-scoring row instead would link to an older reply than the one
      // the reader can see them having just posted.
      const kept = cbOneRowPerAuthor([
        row('ann', 100, 0.9), row('bob', 500, 0.8), row('ann', 900, 0.1),
      ]);
      expect(kept).toHaveLength(2);
      expect(kept[0].authorHandle).toBe('ann');
      expect(kept[0].createdAtMs).toBe(900);
      expect(kept[0].score).toBe(0.1);
    });

    it('decides a timestamp tie on score rather than on DOM order', () => {
      // X does not always give us a time, and two unknowns are not a tie the
      // reader can resolve — falling through to DOM order would make the row
      // depend on virtualisation.
      const kept = cbOneRowPerAuthor([row('ann', 0, 0.2), row('ann', 0, 0.7)]);
      expect(kept).toHaveLength(1);
      expect(kept[0].score).toBe(0.7);
    });

    it('matches handles case-insensitively', () => {
      // articleHandle lowercases, but the payload's screen_name is not
      // guaranteed to, and the same person must not take two rows.
      expect(cbOneRowPerAuthor([row('Ann', 1), row('ann', 2)])).toHaveLength(1);
    });

    it('does not collapse rows whose author is unknown', () => {
      // '' is not an identity. Treating it as one would hide every author we
      // could not read behind a single row — the opposite of de-duplicating.
      expect(cbOneRowPerAuthor([row('', 3), row('', 2), row('', 1)])).toHaveLength(3);
      expect(cbOneRowPerAuthor([row(undefined, 1), row(null, 2)])).toHaveLength(2);
    });

    it('applies to 互关机会 only, leaving 回复热点 per-post', () => {
      // 互关机会 is a list of people; 回复热点 is a list of posts, where two
      // posts by one author are two separate crowds to go read.
      expect(contentJs).toContain('const ranked = statusPage ? cbOneRowPerAuthor(out) : out;');
    });

    it('still ranks the survivors by score', () => {
      // De-duplicating must not decide the order: the newest reply is what the
      // row points at, the score is still what places it.
      expect(contentJs).toContain('return ranked.sort((a, b) => (');
    });
  });
});

describe('comment board wiring', () => {
  it('ranks whatever is mounted, like the leaderboard — not just one status page', () => {
    // The panel used to bail out when the URL had no /status/<id>. That made it
    // useless on the home timeline, where the leaderboard still works.
    expect(contentJs).not.toContain('function commentBoardRootId()');
    expect(contentJs).not.toContain("contentCommentBoardNoThread");
    expect(contentJs).toContain('const top = collectCommentRanked().slice(0, commentBoardCount);');
  });

  it('refreshes on its own trigger, not through renderBadges', () => {
    // renderBadges early-returns when badges are off, so piggy-backing on it
    // would leave this panel stale.
    expect(contentJs).toContain('if (commentBoardEnabled) renderCommentBoard();');
  });

  it('sits flush under the leaderboard until the user moves it', () => {
    // "紧贴着流速榜" — no gap, and the seam is squared off so the two panels
    // read as one column.
    expect(contentJs).toContain('function repositionCommentBoardIfAnchored()');
    expect(contentJs).toContain('if (!commentBoardEl || commentBoardPos) return;');
    expect(contentJs).toContain("const top = clampToViewport(anchor.bottom - 1, 'y', commentBoardEl);");
    expect(contentJs).toContain('function syncLeaderboardStacking()');
    expect(contentJs).toContain("leaderboardEl?.classList.toggle('xvm-lb-stacked', joined)");
    expect(contentJs).toContain("commentBoardEl?.classList.toggle('xvm-cb-stacked', joined)");
  });

  it('matches the leaderboard footprint', () => {
    // Width and height defaults are aliased to the leaderboard's constants so
    // the two panels cannot drift apart.
    expect(contentJs).toContain('const CB_DEFAULT_WIDTH = LB_DEFAULT_WIDTH;');
    expect(contentJs).toContain('const CB_DEFAULT_HEIGHT = LB_DEFAULT_HEIGHT;');
    expect(contentJs).toContain("list.style.height = px;");
    expect(contentJs).toContain("list.style.minHeight = px;");
    expect(contentJs).toContain("list.style.maxHeight = px;");
  });

  it('hides with the leaderboard when it is tucked against an edge', () => {
    expect(contentJs).toContain('if (!top.length || (leaderboardEnabled && leaderboardHiddenEdge)) {');
    expect(contentJs).toContain('if (leaderboardHiddenEdge) hideCommentBoard();');
  });

  it('measures its own bounds, not the leaderboard\'s', () => {
    // clampToViewport defaults to leaderboardEl; the comment panel must pass
    // itself or its position is clamped against the wrong rect.
    expect(contentJs).toContain('function clampToViewport(v, axis, el = leaderboardEl)');
    expect(contentJs).toContain("clampToViewport(pendingX - dragState.offsetX, 'x', commentBoardEl)");
  });

  it('persists position and size together', () => {
    expect(contentJs).toContain("type: 'XVM_CB_STATE_SAVE'");
    expect(bridgeJs).toContain("type === 'XVM_CB_STATE_SAVE'");
    expect(bridgeJs).toContain("type === 'XVM_CB_STATE_REQUEST'");
  });

  it('can be turned off from the panel itself', () => {
    expect(contentJs).toContain("type: 'XVM_COMMENT_BOARD_DISABLE'");
    expect(bridgeJs).toContain('featureCommentBoard: false');
  });

  it('keeps its own column vocabulary', () => {
    expect(bridgeJs).toContain('KNOWN_CB_COLUMN_IDS');
    expect(bridgeJs).toContain('normalizeCommentBoardColumns');
  });
});

describe('people who interacted with your own posts', () => {
  it('reads replies off the payload, so any timeline counts', () => {
    // scanForTweets walks every GraphQL response X sends, so the notifications
    // timeline needs no reader of its own — and no testid is guessed at.
    expect(contentJs).toContain('observeReplierFromPayload(data)');
    expect(contentJs).toContain('if (!me || data.inReplyToScreenName.toLowerCase() !== me) return;');
    // The immediate parent being mine is not enough: a reply under the other
    // person's post is still their thread.
    expect(contentJs).toContain('if (!isReplyUnderMyOwnPost(data)) return;');
    // The guard keeps the DOM lookup out of the hot path for non-replies.
    expect(contentJs).toContain('if (!data?.inReplyToScreenName || !data.screenName) return;');
  });

  it('ignores a reply to my reply inside someone else’s thread', () => {
    const ctx = loadReplierObserver();
    ctx.tweetDataStore.set('alice-root', { id: 'alice-root', screenName: 'alice' });
    ctx.tweetDataStore.set('my-reply', {
      id: 'my-reply', screenName: 'me', inReplyToStatusId: 'alice-root',
    });
    ctx.observe({
      id: 'alice-answer',
      screenName: 'alice',
      inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-reply',
      conversationId: 'alice-root',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(ctx.calls).toEqual([]);
  });

  it('records a reply under my own post', () => {
    const ctx = loadReplierObserver();
    ctx.tweetDataStore.set('my-root', { id: 'my-root', screenName: 'me' });
    ctx.observe({
      id: 'alice-answer',
      screenName: 'alice',
      inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-root',
      conversationId: 'my-root',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(ctx.calls).toEqual([['alice', 'reply', Date.parse('2026-01-01T00:00:00Z')]]);
  });

  it('timestamps the reply, not the moment it was seen', () => {
    // "他们的访问时间是要根据回复的时间来着" — the window has to measure when
    // they replied, or scrolling past the same reply would keep it alive.
    expect(contentJs).toContain("const createdAt = data.createdAt ? new Date(data.createdAt).getTime() : 0;");
    expect(contentJs).toContain("recordInteraction(data.screenName, 'reply', Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now());");
  });

  it('is declared before the code that writes to it can run', () => {
    // scanForTweets can fire on a response that lands while this script is still
    // executing; a const beside the panel code would still be in its temporal
    // dead zone at that point, and the write would throw.
    const decl = contentJs.indexOf('const recentInteractions = new Map();');
    const scanner = contentJs.indexOf('function scanForTweets(');
    const writer = contentJs.indexOf('function observeReplierFromPayload(');
    expect(decl).toBeGreaterThan(-1);
    expect(scanner).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(scanner);
    expect(decl).toBeLessThan(writer);
  });

  it('still has the page-level fallback for payloads missing the target', () => {
    expect(contentJs).toContain('if (!isCommentBoardStatusPage() || !isOwnStatusPage()) return;');
    expect(contentJs).toContain('if (!data || data.inReplyToStatusId !== rootId) continue;');
  });

  it('gives every kind its own clock and makes re-observation a no-op', () => {
    // Both observers run on every tick, so a write that is not idempotent would
    // push the expiry out on every pass and the entry would never age out.
    expect(contentJs).toContain('if (Number.isFinite(prev?.[kind]) && prev[kind] >= at) return;');
    expect(contentJs).toContain('return cbReplierIsRecent(recentInteractions.get(key)?.reply, Date.now());');
  });

  it('persists through the bridge, debounced', () => {
    expect(contentJs).toContain("type: 'XVM_INTERACTIONS_SAVE'");
    expect(contentJs).toContain("type: 'XVM_INTERACTIONS_REQUEST'");
    expect(bridgeJs).toContain("type === 'XVM_INTERACTIONS_SAVE'");
    expect(bridgeJs).toContain("type === 'XVM_INTERACTIONS_REQUEST'");
    expect(bridgeJs).toContain('INTERACTIONS_MAX_ENTRIES');
    expect(contentJs).toContain('setTimeout(flushRecentInteractions, 5000)');
  });

  it('folds the old one-timestamp map into the new shape on read', () => {
    // An upgrade must not throw away what the user had already observed.
    expect(bridgeJs).toContain('function withLegacyRepliers(');
    expect(bridgeJs).toContain('chrome.storage.local.get({ xvmInteractions: null, xvmRecentRepliers: null }');
  });

  it('drops what has expired before it is written', () => {
    // The stored map has to describe the same window the reader applies, or it
    // outgrows the three days it claims to cover.
    expect(contentJs).toContain('if (Number.isFinite(at) && now - at < CB_INTERACTION_TTL_MS) kept[kind] = at;');
  });

  it('keeps observing even when the panel is off', () => {
    // Observing is not displaying, and the panel can be switched on later.
    expect(contentJs).toContain('observeRepliersToMe();');
    expect(contentJs).toContain('observeInteractionsFromNotifications();');
    expect(contentJs).not.toContain('if (commentBoardEnabled) observeRepliersToMe();');
    expect(contentJs).not.toContain('if (commentBoardEnabled) observeInteractionsFromNotifications();');
  });

  it('boosts feed mode only, and only on the short reply window', () => {
    expect(contentJs).toContain('repliedYou: !statusPage && isRecentReplier(author),');
    expect(contentJs).toContain('return entry.repliedYou ? base * CB_FEED_REPLIER_BOOST : base;');
    expect(contentJs).toContain('const CB_REPLIER_TTL_MS = 2 * 60 * 60 * 1000;');
  });

  it('marks the row for every kind still inside the three-day window', () => {
    expect(contentJs).toContain('interactions: statusPage ? [] : interactionKindsFor(author),');
    expect(contentJs).toContain('xvm-cb-interact--${kind}');
    expect(styles).toContain('.xvm-cb .xvm-cb-interact {');
    expect(styles).toContain('.xvm-lb[data-theme="dark"] .xvm-cb .xvm-cb-interact--reply');
    expect(contentJs).toContain('const CB_INTERACTION_TTL_MS = 3 * 24 * 60 * 60 * 1000;');
  });

  it('reads likes and reposts off the notifications page', () => {
    // They never appear in a tweet payload, so the page is the only source —
    // and the cell's own <time> is the timestamp that matters.
    expect(contentJs).toContain("if (window.location.pathname !== '/notifications') return;");
    expect(contentJs).toContain("const stampValue = stamp?.getAttribute('datetime') || '';");
    expect(contentJs).toContain('const at = Date.parse(stampValue);');
    expect(contentJs).toContain("['like', /liked|赞了|いいねしました/i],");
    expect(contentJs).toContain("['repost', /reposted|retweeted|转推了|リポストしました/i],");
  });
});

describe('interaction window', () => {
  it('keeps each kind only while it is inside the three-day window', () => {
    const { cbInteractionKinds, CB_INTERACTION_TTL_MS } = loadScoring();
    const now = 1_800_000_000_000;
    const fresh = now - 60 * 60 * 1000;
    const stale = now - CB_INTERACTION_TTL_MS - 1;

    expect(cbInteractionKinds({ reply: fresh, like: stale, repost: fresh }, now))
      .toEqual(['reply', 'repost']);
    expect(cbInteractionKinds({ like: stale }, now)).toEqual([]);
    expect(cbInteractionKinds(null, now)).toEqual([]);
    expect(CB_INTERACTION_TTL_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('a stale like does not keep a fresh reply inside the window, or the reverse', () => {
    // The whole point of per-kind timestamps: one kind expiring must not delete
    // the entry, and one kind being fresh must not resurrect another.
    const { cbInteractionKinds } = loadScoring();
    const now = 1_800_000_000_000;
    const stale = now - 10 * 24 * 60 * 60 * 1000;
    expect(cbInteractionKinds({ reply: now, like: stale }, now)).toEqual(['reply']);
    expect(cbInteractionKinds({ reply: stale, like: now }, now)).toEqual(['like']);
  });
});

describe('replies without a view count still reach the store', () => {
  it('relaxes the views gate for replies only', () => {
    // Comments routinely arrive with no view count; dropping them would empty
    // the comment panel entirely.
    expect(contentJs).toContain('const isReply = !!legacy.in_reply_to_status_id_str;');
    expect(contentJs).toContain("if (!isReply && (!viewCount || tweet.views?.state !== 'EnabledWithCount')) return null;");
  });
});
